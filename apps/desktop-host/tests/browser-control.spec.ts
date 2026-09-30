import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import { ToolCallId, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { expect, it, vi } from 'vitest'
import { DesktopBrowserChannel, authorizedStorageKey } from '../src/browser-control.ts'
import * as browserControl from '../src/browser-control.ts'

class BrowserIpcFixture extends EventEmitter {
  connected = true
  readonly sent: object[] = []

  send(message: object, callback: (error?: Error | null) => void): boolean {
    this.sent.push(message)
    callback(undefined)
    return true
  }
}

class FakePtcRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test'

  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }

  run(_request: PtcRunRequest): Promise<PtcRunResult> { return Promise.resolve({ logs: [] }) }
}

class BrowserImageStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 4 * 1024 * 1024, maxImagesPerMessage: 4,
    maxMessageImageBytes: 8 * 1024 * 1024, maxImagePixels: 8_000_000,
    maxImageDimension: 5000, mediaTypes: ['image/png'],
  }
  readonly saved: SaveImageAttachment[] = []
  validateImage(_input: SaveImageAttachment): Promise<void> { return Promise.resolve() }
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    return Promise.resolve({ attachmentId: AttachmentId(`sha256:${'1'.repeat(64)}`),
      mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 })
  }
  readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> { throw new Error('not used') }
}

class BrowserVisionAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model,
      inputModalities: model === 'vision' ? ['text', 'image'] : ['text'] })
  }
  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { throw new Error('not used') }
}

it('derives storage from Host Session and Workspace records, separating SSH hosts', async () => {
  const records = [
    { header: { id: 'local' } }, { header: { id: 'ssh-a', execution: { kind: 'ssh', host: 'alpha' } } },
    { header: { id: 'ssh-b', execution: { kind: 'ssh', host: 'beta' } } },
    { header: { id: 'solo' } }, { header: { id: 'child', origin: 'subagent' } },
  ]
  const workspaces = [
    { sessionIds: ['local'], location: { kind: 'local', path: '/lab' } },
    { sessionIds: ['ssh-a'], location: { kind: 'ssh', host: 'alpha', path: '/lab' } },
    { sessionIds: ['ssh-b'], location: { kind: 'ssh', host: 'beta', path: '/lab' } },
  ]
  const host = { get(name: string) {
    if (name === 'sessionQuery') return { listSessions: async () => records }
    if (name === 'workspaceRegistry') return { list: () => workspaces }
    return undefined
  } } as never
  expect(await authorizedStorageKey(host, 'local')).toBe('cwd:/lab')
  const alpha = await authorizedStorageKey(host, 'ssh-a')
  const beta = await authorizedStorageKey(host, 'ssh-b')
  expect(alpha).not.toBe(beta)
  expect(alpha).not.toBe('cwd:/lab')
  expect(await authorizedStorageKey(host, 'solo')).toBe('session:solo')
  workspaces.splice(0, 1)
  expect(await authorizedStorageKey(host, 'local')).toBe('session:local')
  await expect(authorizedStorageKey(host, 'missing')).rejects.toThrow('conversation is unavailable')
  await expect(authorizedStorageKey(host, 'child')).rejects.toThrow('conversation is unavailable')
})

it('waits for the correlated Electron result after IPC accepts a send', async () => {
  const ipc = new BrowserIpcFixture()
  const channel = new DesktopBrowserChannel(ipc)
  try {
    const signal = new AbortController().signal
    let settled = false
    const pending = channel.request({ action: 'list', sessionId: 'session-a' }, signal)
      .then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(ipc.sent).toEqual([{ type: 'browser-operation', requestId: 1,
      operation: { action: 'list', sessionId: 'session-a' } }])
    ipc.emit('message', { type: 'browser-operation-result', requestId: 1, value: [{ tabId: 'tab-a' }] })
    expect(await pending).toEqual([{ tabId: 'tab-a' }])
    const aborter = new AbortController()
    const canceled = channel.request({ action: 'list', sessionId: 'session-a' }, aborter.signal)
    aborter.abort()
    await expect(canceled).rejects.toThrow('may have completed, so inspect before retrying')
    expect(ipc.sent.at(-1)).toEqual({ type: 'browser-operation-cancel', requestId: 2 })
    ipc.emit('message', { type: 'browser-operation-result', requestId: 2, value: [] })
    const waiting = channel.request({ action: 'list', sessionId: 'session-a' }, signal)
    channel.dispose()
    expect(ipc.sent.at(-1)).toEqual({ type: 'browser-operation-cancel', requestId: 3 })
    await expect(waiting).rejects.toThrow('channel closed')
  } finally {
    channel.dispose()
  }
})

it.each(['native', 'ptc', 'both'] as const)('registers the Browser tool in the %s model presentation', async (mode) => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode })
    await ctx.plugin(AgentRegistry)
    if (mode !== 'native') await ctx.plugin(FakePtcRuntime)
    const request = vi.fn(async () => [{ tabId: 'tab-a', url: 'https://example.test/' }])
    await ctx.plugin(browserControl, { request })
    const assembly = await ctx.systemPrompt.assemble()
    if (mode === 'ptc') {
      expect(assembly.tools.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
      expect(assembly.sections.find(section => section.name === 'tools:sdk')?.text).toContain('desktop_browser: {')
    } else {
      expect(assembly.tools.map(tool => tool.name)).toContain('desktop_browser')
    }
    if (mode === 'ptc') return
    const local = { session: { id: 'session-a', header: {} } } as never
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId(`browser-${mode}`), name: 'desktop_browser', arguments: { action: 'list' }, agent: local })
    expect(result.isError).toBe(false)
    expect(request).toHaveBeenCalledWith({ action: 'list', sessionId: 'session-a' }, expect.any(AbortSignal))
    const remote = { session: { id: 'session-ssh', header: { execution: { kind: 'ssh', host: 'lab' } } } } as never
    const denied = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId(`browser-ssh-${mode}`), name: 'desktop_browser', arguments: { action: 'list' }, agent: remote })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('remote conversations cannot operate')
    expect(request).toHaveBeenCalledTimes(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('projects a Browser screenshot into a durable image visible to a vision Agent', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(BrowserImageStore)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['fixture'], new BrowserVisionAdapter())
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
    await ctx.plugin(browserControl, { request: async () => ({ tabId: 'tab-a', url: 'https://example.test/', png }) })
    const agent = { options: { provider: 'fixture', model: 'vision' },
      session: { id: 'session-a', header: {}, requestHeader: () => undefined } } as never
    const result = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('browser-screenshot'), name: 'desktop_browser',
      arguments: { action: 'screenshot' }, agent })
    expect(result.isError).toBe(false)
    expect(result.content.map(block => block.type)).toEqual(['text', 'image'])
    const image = result.content[1]
    if (image?.type !== 'image') throw new Error('screenshot was not admitted to model context')
    expect(image.attachment.mediaType).toBe('image/png')
    const saved = (ctx.attachments as BrowserImageStore).saved[0]
    if (saved === undefined) throw new Error('screenshot attachment was not saved')
    expect(Buffer.from(saved.data).toString('base64')).toBe(png)
    expect(JSON.stringify(result.content)).not.toContain(png)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('hides the local Browser tool from SSH Agent schemas while retaining it for local Agents', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'native' })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(browserControl, { request: async () => [] })
    const localSession = { id: SessionId('browser-local'), header: {} }
    const remoteSession = { id: SessionId('browser-ssh'), header: { execution: { kind: 'ssh', host: 'lab' } } }
    const local = { id: localSession.id, session: localSession, ctx: new Context() } as never
    const remote = { id: remoteSession.id, session: remoteSession, ctx: new Context() } as never
    const releaseLocal = await ctx.agents.register(local)
    const releaseRemote = await ctx.agents.register(remote)
    expect(ctx.tools.schemas(local).map(tool => tool.name)).toContain('desktop_browser')
    expect(ctx.tools.schemas(remote).map(tool => tool.name)).not.toContain('desktop_browser')
    await releaseRemote()
    await releaseLocal()
  } finally {
    await ctx.fiber.dispose()
  }
})
