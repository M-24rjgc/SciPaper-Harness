// @vitest-environment jsdom

/**
 * The draw.io editor tab for a `.drawio` file of the conversation's research.
 * Every command it sends goes through the validator the service parses
 * commands with. The frame's messages are posted from its own window, as the
 * embedded editor posts them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type { ArtifactId, ArtifactRecord, ResearchCommand, ResearchProject, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { diagramTitle, ResearchDiagramTab } from '../src/client/Diagram.tsx'
import type { SessionDirectories } from '../src/client/contract.ts'
import type { ResearchTabProps } from '../src/client/Tabs.tsx'
import type { Translate } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const SESSION = 'session-diagram'
const ROOT = 'C:\\research\\sparse'
const ADDRESS = `dsh-resource://file/session/${SESSION}/figures/architecture.drawio`
const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as Translate
const failed = (reason: string): string => t('actionFailed', { reason })

function diagram(revision = 2): ArtifactRecord {
  return {
    id: 'arch' as ArtifactId, path: 'figures/architecture.drawio', kind: 'diagram', revision, sha256: 's', evidence: [], claimIds: ['c'],
    inputArtifacts: [], stale: false, updatedAt: '', author: 'agent',
  }
}

function research(options: { registered?: boolean; example?: boolean } = {}): ResearchProject {
  const project = newProject({ root: ROOT, title: 'Sparse', brief: '' }, 'w' as WorkspaceId)
  project.sessionId = SESSION
  project.claims.push({ id: 'c', text: 'claim', kind: 'method', state: 'proposed', evidence: [], artifactIds: [] })
  if (options.registered !== false) project.artifacts.push(diagram())
  if (options.example === true) project.example = true
  return project
}

interface Harness {
  props: ResearchTabProps
  commands: ResearchCommand[]
  installs: string[]
  view: ReturnType<typeof render>
  /** Draw the tab again after the record changed, as the store does. */
  redraw: () => void
}

function mount(project: ResearchProject | undefined, options: {
  address?: string
  directories?: SessionDirectories
  installed?: boolean
  respond?: (command: ResearchCommand) => ResearchResponse | Promise<ResearchResponse> | undefined
  install?: () => Promise<void>
} = {}): Harness {
  const commands: ResearchCommand[] = []
  const installs: string[] = []
  const snapshot = {
    projects: project === undefined ? [] : [project], preferences: {}, modes: [],
    components: [{ id: 'drawio' as const, installed: options.installed ?? true, path: '', version: '' }],
  }
  const view = { snapshot, tasks: [] }
  const props = {
    sessionId: SESSION,
    t,
    useResearch: (select: (value: typeof view) => unknown) => select(view),
    useDirectories: (select: (value: SessionDirectories) => unknown) => select(options.directories ?? { [SESSION]: ROOT }),
    useTabInfo: () => ({ tab: { contentId: options.address ?? ADDRESS } }),
    run: (command: ResearchCommand) => {
      commands.push(command)
      expect(commandSchema.parse(command)).toBeTruthy()
      const answer = options.respond?.(command)
      if (answer !== undefined) return Promise.resolve(answer)
      if (command.action === 'read-artifact') return Promise.resolve({ message: '', content: '<mxfile>arch</mxfile>' })
      if (command.action === 'save-artifact') return Promise.resolve({ message: '', project: { ...project, artifacts: [diagram(3)] } })
      return Promise.resolve({ message: '' })
    },
    install: (component: string) => { installs.push(component); return options.install?.() ?? Promise.resolve() },
  } as ResearchTabProps
  const rendered = render(<ResearchDiagramTab {...props} />)
  return { props, commands, installs, view: rendered, redraw: () => { rendered.rerender(<ResearchDiagramTab {...props} />) } }
}

const settle = async (): Promise<void> => { await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }) }

/** The editor's frame, a way to post a message from it, and what the tab posted to it. */
interface Frame { frame: HTMLIFrameElement; post: (data: unknown, source?: unknown) => void; posted: unknown[] }

function editor(view: ReturnType<typeof render>): Frame {
  const frame = view.getByTitle(zh.diagram) as HTMLIFrameElement
  const posted: unknown[] = []
  const window_ = frame.contentWindow!
  window_.postMessage = ((message: unknown) => { posted.push(message) }) as typeof window_.postMessage
  const post = (data: unknown, source: unknown = frame.contentWindow): void => {
    act(() => { window.dispatchEvent(new MessageEvent('message', { data, source: source as Window })) })
  }
  return { frame, post, posted }
}

describe('the draw.io editor tab', () => {
  it('names its chip after the file', () => {
    expect(diagramTitle(ADDRESS)).toBe('architecture.drawio')
    expect(diagramTitle('dsh-resource://file/absolute/C:/r/a%20b.drawio')).toBe('a b.drawio')
    expect(diagramTitle('sidebar://nothing')).toBe('sidebar://nothing')
  })

  it('loads the research\'s diagram into the editor and saves an edit against the revision it loaded', async () => {
    const project = research()
    const { view, commands } = mount(project)
    await settle()
    expect(view.getByText('figures/architecture.drawio')).toBeTruthy()
    const { frame, post, posted } = editor(view)
    expect(frame.getAttribute('src')).toContain('noSaveBtn=0')
    post(JSON.stringify({ event: 'init' }))
    expect(JSON.parse(String(posted[0]))).toEqual({ action: 'load', xml: '<mxfile>arch</mxfile>', autosave: 1 })
    post({ event: 'save', xml: '<mxfile>edited</mxfile>' })
    await settle()
    post({ event: 'save', xml: '<mxfile>again</mxfile>' })
    await settle()
    expect(commands).toEqual([
      { action: 'read-artifact', projectId: project.id, artifactId: 'arch' },
      {
        action: 'save-artifact', projectId: project.id, path: 'figures/architecture.drawio', kind: 'diagram', content: '<mxfile>edited</mxfile>',
        expectedRevision: 2, evidence: [], claimIds: ['c'], inputArtifacts: [],
      },
      expect.objectContaining({ action: 'save-artifact', content: '<mxfile>again</mxfile>', expectedRevision: 3 }) as unknown,
    ])
  })

  it('keeps the revision it has when a save answers without the diagram', async () => {
    const project = research()
    const { view, commands } = mount(project, { respond: command => command.action === 'save-artifact' ? { message: 'saved' } : undefined })
    await settle()
    const { post } = editor(view)
    post({ event: 'save', xml: 'one' })
    await settle()
    post({ event: 'save', xml: 'two' })
    await settle()
    expect(commands.filter(command => command.action === 'save-artifact').map(command => command.action === 'save-artifact' && command.expectedRevision)).toEqual([2, 2])
  })

  it('debounces autosaves into one save at a time, the latest winning, and writes one still waiting when the tab closes', async () => {
    let release: () => void = () => {}
    const saves: string[] = []
    const { view } = mount(research(), {
      respond: (command) => {
        if (command.action !== 'save-artifact') return undefined
        saves.push(command.content)
        return new Promise<ResearchResponse>((resolve) => { release = () => { resolve({ message: '' }) } })
      },
    })
    await settle()
    const { post } = editor(view)
    // Messages that are not the editor's, or carry no text to save, change nothing.
    post('{broken')
    post(JSON.stringify(null))
    post(JSON.stringify(7))
    post(JSON.stringify({ xml: 'no event' }))
    post(JSON.stringify({ event: 'save' }))
    post(JSON.stringify({ event: 'save', xml: 5 }))
    post(JSON.stringify({ event: 'save', xml: 'x' }), window)
    post({ event: 'export', xml: '<svg/>' })
    vi.useFakeTimers()
    post(JSON.stringify({ event: 'autosave', xml: 'first' }))
    post(JSON.stringify({ event: 'autosave', xml: 'second' }))
    act(() => { vi.advanceTimersByTime(1500) })
    // One save in flight; the next ones queue behind it and only the latest is written.
    post({ event: 'save', xml: 'third' })
    post({ event: 'save', xml: 'fourth' })
    vi.useRealTimers()
    await settle()
    await act(async () => { release(); await Promise.resolve() })
    await settle()
    await act(async () => { release(); await Promise.resolve() })
    await settle()
    expect(saves).toEqual(['second', 'fourth'])
    // An autosave still waiting when the tab goes is written then.
    post({ event: 'autosave', xml: 'closing' })
    view.unmount()
    await settle()
    expect(saves).toEqual(['second', 'fourth', 'closing'])
  })

  it('shows a refused save under the editor, and the next edit tries again', async () => {
    let refusals = 1
    const { view, commands } = mount(research(), {
      respond: (command) => {
        if (command.action !== 'save-artifact' || refusals === 0) return undefined
        refusals -= 1
        return Promise.reject(new Error('Revision conflict'))
      },
    })
    await settle()
    const { post } = editor(view)
    post({ event: 'save', xml: 'refused' })
    await settle()
    expect(view.getByRole('alert').textContent).toBe(failed('Revision conflict'))
    post({ event: 'save', xml: 'kept' })
    await settle()
    expect(view.queryByRole('alert')).toBeNull()
    expect(commands.filter(command => command.action === 'save-artifact')).toHaveLength(2)
  })

  it('registers a diagram the record does not know yet before it loads it, and starts an empty one blank', async () => {
    const project = research({ registered: false })
    const { view, commands } = mount(project, {
      respond: (command) => {
        if (command.action === 'register-artifact') return { message: '', project: { ...project, artifacts: [diagram(1)] } }
        if (command.action === 'read-artifact') return { message: '' }
        return undefined
      },
    })
    await settle()
    expect(commands).toEqual([
      { action: 'register-artifact', projectId: project.id, path: 'figures/architecture.drawio', kind: 'diagram', evidence: [], claimIds: [], inputArtifacts: [] },
      { action: 'read-artifact', projectId: project.id, artifactId: 'arch' },
    ])
    const { post, posted } = editor(view)
    post(JSON.stringify({ event: 'init' }))
    expect(String(posted[0])).toContain('Architecture')
  })

  it('says why a diagram could not be loaded', async () => {
    const project = research({ registered: false })
    const unlisted = mount(project, { respond: command => command.action === 'register-artifact' ? { message: '' } : undefined })
    await settle()
    expect(unlisted.view.getByRole('alert').textContent).toBe(failed(zh.diagramNotRecorded))
    expect(unlisted.view.queryByTitle(zh.diagram)).toBeNull()
    cleanup()
    const locked = mount(research(), { respond: command => command.action === 'read-artifact' ? Promise.reject(new Error('the file is locked')) : undefined })
    await settle()
    expect(locked.view.getByRole('alert').textContent).toBe(failed('the file is locked'))
  })

  it('opens an example\'s diagram without saving, and registers nothing among the examples', async () => {
    const { view, commands } = mount(research({ example: true }))
    await settle()
    expect(view.getByText(zh.exampleBanner)).toBeTruthy()
    const { frame, post, posted } = editor(view)
    expect(frame.getAttribute('src')).toContain('noSaveBtn=1')
    post(JSON.stringify({ event: 'init' }))
    expect(JSON.parse(String(posted[0]))).toMatchObject({ autosave: 0 })
    post({ event: 'save', xml: 'ignored' })
    post({ event: 'autosave', xml: 'ignored' })
    view.unmount()
    await settle()
    expect(commands.map(command => command.action)).toEqual(['read-artifact'])
    const unknown = mount(research({ example: true, registered: false }))
    await settle()
    expect(unknown.view.getByRole('alert').textContent).toBe(failed(zh.diagramNotRecorded))
    expect(unknown.commands).toEqual([])
  })

  it('drops a read that answers after the tab closed', async () => {
    let answer: (value: ResearchResponse) => void = () => {}
    const { view } = mount(research(), {
      respond: command => command.action === 'read-artifact' ? new Promise<ResearchResponse>((resolve) => { answer = resolve }) : undefined,
    })
    await settle()
    view.unmount()
    await act(async () => { answer({ message: '', content: 'too late' }); await Promise.resolve() })
  })

  it('offers the editor\'s install until it is installed, loads the editor afresh after it, and says why an install failed', async () => {
    let fail: (reason: Error) => void = () => {}
    const refused = mount(research(), { installed: false, install: () => new Promise((_resolve, reject) => { fail = reject }) })
    await settle()
    expect(refused.view.getByText(zh.diagramInstallHint)).toBeTruthy()
    expect(refused.view.queryByTitle(zh.diagram)).toBeNull()
    fireEvent.click(refused.view.getByRole('button', { name: zh.install }))
    expect(refused.view.getByRole('button', { name: zh.installing })).toHaveProperty('disabled', true)
    await settle()
    await act(async () => { fail(new Error('network down')); await Promise.resolve() })
    await settle()
    expect(refused.installs).toEqual(['drawio'])
    expect(refused.view.getByRole('alert').textContent).toBe(failed('network down'))
    cleanup()
    const installing = mount(research(), { installed: false })
    await settle()
    // The install lands, and the record read after it lists the component.
    const read = installing.props.useResearch((view: unknown) => view) as { snapshot: { components: { installed: boolean }[] } }
    const components = read.snapshot.components
    fireEvent.click(installing.view.getByRole('button', { name: zh.install }))
    components[0]!.installed = true
    await settle()
    installing.redraw()
    expect(installing.view.getByTitle(zh.diagram)).toBeTruthy()
    expect(installing.view.queryByRole('button', { name: zh.install })).toBeNull()
  })

  it('names what it cannot edit: a file outside the research, in a conversation whose folder is unknown, or no file at all', () => {
    const outside = mount(research(), { address: 'dsh-resource://file/absolute/D:/elsewhere/x.drawio' })
    expect(outside.view.getByText(zh.diagramOutside)).toBeTruthy()
    cleanup()
    expect(mount(research(), { directories: {} }).view.getByText(zh.diagramOutside)).toBeTruthy()
    cleanup()
    expect(mount(research(), { address: 'sidebar://research-drawio' }).view.getByText(zh.diagramOutside)).toBeTruthy()
    cleanup()
    expect(mount(undefined).view.getByText(zh.railNoProject)).toBeTruthy()
  })

  it('opens a file named by an absolute path, in either scope', async () => {
    const project = research()
    const absolute = mount(project, { address: 'dsh-resource://file/absolute/C:/research/sparse/figures/architecture.drawio', directories: {} })
    await settle()
    expect(absolute.commands).toEqual([{ action: 'read-artifact', projectId: project.id, artifactId: 'arch' }])
    cleanup()
    const inSession = mount(project, { address: `dsh-resource://file/session/${SESSION}/C:/research/sparse/figures/architecture.drawio`, directories: {} })
    await settle()
    expect(inSession.commands).toEqual([{ action: 'read-artifact', projectId: project.id, artifactId: 'arch' }])
  })

  it('does not treat a remote file address as an artifact in the local ledger', () => {
    const project = research()
    project.environments.push({
      id: 'environment-ssh' as never, name: 'Lab', kind: 'existing', target: 'ssh', python: 'python3',
      sshHost: 'lab', remoteRoot: '/srv/sparse', requirements: [], fingerprint: 'remote', status: 'ready', details: '', isDefault: true,
    })
    const directories = { [SESSION]: { kind: 'ssh' as const, host: 'lab', cwd: '/srv/sparse' } }
    const inSession = mount(project, { address: `dsh-resource://file/session/${SESSION}/C:/research/sparse/figures/architecture.drawio`, directories })
    expect(inSession.view.getByText(zh.diagramOutside)).toBeTruthy()
    expect(inSession.commands).toEqual([])
    cleanup()
    const absolute = mount(project, { address: 'dsh-resource://file/absolute/C:/research/sparse/figures/architecture.drawio', directories })
    expect(absolute.view.getByText(zh.diagramOutside)).toBeTruthy()
    expect(absolute.commands).toEqual([])
  })
})
