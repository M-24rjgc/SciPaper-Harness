/** Shipped skill rows pass through the real Loader and the workspace policy services. */
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import Approval from '@deepseek-ai/dsh-user-approval'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Document, isMap, isSeq, isScalar, parseDocument } from 'yaml'
import { afterEach, expect, it, vi } from 'vitest'
import { ModeRegistry } from '../../../research/workbench/src/modes.ts'
import * as ModeSkills from '../../../research/workbench/src/mode-skills.ts'

const WORKBENCH = join(import.meta.dirname, '../../../research/workbench')
const PRESET = join(import.meta.dirname, '../presets/research.patch.yml')
const JS_TAG = 'tag:yaml.org,2002:js'
let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true })
  root = undefined
})

/** Only the project lookup is a fixture; providers load the actual installed pack. */
class ModeProject extends Service {
  modes!: ModeRegistry
  constructor(ctx: Context) { super(ctx, 'research') }
  protected async [Service.init](): Promise<void> {
    this.modes = await ModeRegistry.load([join(WORKBENCH, 'runtime/modes')], this.ctx.logger)
  }
  async projectAt(cwd: string) { return cwd === root ? { mode: 'spark-to-paper' } : undefined }
}

/** A real Session carries the workspace and policy lookup; no model request runs. */
function agent(cwd: string): Agent {
  const id = SessionId('research-skills-composition')
  return {
    id, ctx: context!, options: {}, status: 'idle', inbox: unsupportedInbox(),
    session: Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, cwd, createdAt: 0, isSeeded: false }),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
}

it('lists, resolves and loads packaged research and mode skills with workspace-write and approval never while custom roots keep their filesystem fence', async () => {
  root = await mkdtemp(join(tmpdir(), 'research-packaged-skills-'))
  const custom = join(root, 'custom-skills')
  await mkdir(join(custom, 'custom-probe'), { recursive: true })
  await writeFile(join(custom, 'custom-probe/SKILL.md'), '---\nname: custom-probe\ndescription: A synthetic custom skill\n---\nCustom body.\n')
  const preset: Document = parseDocument(await readFile(PRESET, 'utf8'), { customTags: [{ tag: JS_TAG, resolve: (value: string) => value }] })
  if (!isSeq(preset.contents)) throw new Error('Preset must be patch entries')
  const insertion = preset.contents.items[0]
  if (!isMap(insertion)) throw new Error('Preset insertion must be a mapping')
  const insert = insertion.get('insert')
  if (!isSeq(insert) || !isMap(insert.items[0])) throw new Error('Preset insertion is missing')
  const fields = insert.items[0].get('config')
  if (!isMap(fields) || !isSeq(fields.get('plugins'))) throw new Error('Preset plugins are missing')
  const plugins = fields.get('plugins')
  if (!isSeq(plugins)) throw new Error('Preset plugins must be a sequence')
  const selected = plugins.items.filter(row => isMap(row) && ['skill-filesystem', 'tool-skill', 'research-mode-skills'].includes(String(row.get('id'))))
  expect(selected).toHaveLength(3)
  const filesystem = selected.find(row => isMap(row) && row.get('id') === 'skill-filesystem')
  if (!isMap(filesystem) || !isMap(filesystem.get('config'))) throw new Error('Skill provider config is missing')
  const config = filesystem.get('config')
  if (!isMap(config)) throw new Error('Skill config must be a mapping')
  const bundled = config.get('bundledSkillDir', true)
  if (!isScalar(bundled) || bundled.tag !== JS_TAG || typeof bundled.value !== 'string') throw new Error('Bundled root must resolve the installed workbench')
  // A temporary include retains the shipped expression's package resolution base.
  bundled.value = `(baseUrl => (${bundled.value}))(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..') + sep).href)})`
  config.set('watch', false)
  config.set('includeDefaultRoots', false)
  config.set('customSkillDirs', preset.createNode([custom]))

  const document = new Document([
    { name: 'system-prompt' }, { name: 'tools' }, { name: 'agents' }, { name: 'skills' },
    { name: 'session-projection' }, { name: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: root } },
    { name: 'approval', config: { policy: 'never' } }, { name: 'fs', config: { cwd: root } }, { name: 'project-fixture' },
  ])
  if (!isSeq(document.contents)) throw new Error('Composition must be a sequence')
  for (const row of selected) document.contents.add(row)
  const path = join(root, 'cordis.yml')
  await writeFile(path, String(document))
  context = new Context()
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['system-prompt', SystemPrompt], ['tools', ToolRuntime], ['agents', AgentRegistry], ['skills', SkillRegistry],
    ['session-projection', SessionProjection], ['sandbox-policy', SandboxPolicy], ['approval', Approval],
    ['fs', SandboxedFileSystem], ['project-fixture', ModeProject],
    ['@deepseek-ai/dsh-skill-filesystem', SkillFilesystem], ['@deepseek-ai/dsh-tool-skill', ToolSkill],
    ['@deepseek-ai/dsh-research-workbench/mode-skills', ModeSkills],
  ])
  if (context.loader.internal === undefined) throw new Error('Loader has no module resolver')
  context.loader.internal.import = async (name: string) => {
    if (!modules.has(name)) throw new Error(`Unmapped composition module: ${name}`)
    return modules.get(name)
  }
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await context.loader.await()
  const caller = agent(root)
  expect(context.sandboxPolicy.resolve({ session: caller.session })).toMatchObject({ mode: 'workspace-write', workspaceRoot: root })
  expect(context.approval.config.policy).toBe('never')
  const lookup = { cwd: root, scope: caller }
  const catalog = await context.skills.list(lookup)
  expect(catalog.find(skill => skill.name === 'research-modes')).toMatchObject({ source: 'bundled', provider: 'filesystem' })
  const mode = catalog.find(skill => skill.provider === 'research-modes')
  expect(mode).toBeDefined()
  expect(catalog.find(skill => skill.name === 'custom-probe')).toMatchObject({ source: 'custom' })
  expect((await context.skills.get('custom-probe', lookup))?.content).toBe('Custom body.')
  const read = context.fs.readText.bind(context.fs)
  const seen: string[] = []
  vi.spyOn(context.fs, 'readText').mockImplementation(async (target, ...args) => {
    seen.push(target.displayPath)
    if (target.displayPath.includes('custom-probe')) throw Object.assign(new Error('Synthetic custom read denied'), { code: 'FS_SANDBOX_DENIED' })
    return read(target, ...args)
  })
  for (const name of ['research-modes', mode!.name]) {
    const loaded = await context.skills.get(name, lookup)
    expect(loaded?.source).toBe('bundled')
    expect(loaded?.content.length).toBeGreaterThan(50)
    const result = await context.tools.execute({ name: 'skill', arguments: { name }, agent: caller, callId: ToolCallId(`load-${name}`), signal: new AbortController().signal })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result.content)).toContain(name)
  }
  expect(seen).toEqual([])
  await expect(context.skills.get('custom-probe', lookup)).rejects.toThrow('Synthetic custom read denied')
  expect(seen).toHaveLength(1)
})
