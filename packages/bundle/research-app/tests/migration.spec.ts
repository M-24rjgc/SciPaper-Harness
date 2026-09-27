/** Migration fixtures contain synthetic credential references, never user credentials. */
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { parse, parseDocument } from 'yaml'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import Settings from '../../../settings/settings/src/index.ts'
import { assemble } from '../../../llm/llm-pi-ai/tests/assemble.ts'
import { closeMockServers, mockServer, textEvents } from '../../../llm/llm-pi-ai/tests/mock-server.ts'
import { migrateResearchProfile } from '../src/migration.ts'

const roots: string[] = []

function at(value: unknown, ...path: Array<string | number>): unknown {
  for (const key of path) {
    if (value === null || typeof value !== 'object') return undefined
    value = Reflect.get(value, key)
  }
  return value
}
afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(settings?: string, patch = '[]\n') {
  const home = await mkdtemp(join(tmpdir(), 'research-migration-'))
  roots.push(home)
  const profileDir = join(home, 'profiles', 'desktop')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'cordis.patch.yml'), patch)
  if (settings !== undefined) await writeFile(join(home, 'settings.yaml'), settings)
  const readSettings = async () => parse(await readFile(join(home, 'settings.yaml'), 'utf8')) as Record<string, unknown>
  const readPatch = async () => parse(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')) as Array<Record<string, unknown>>
  return { home, profileDir, readSettings, readPatch }
}

it('leaves a modern empty profile byte-identical and creates no migration artifact', async () => {
  const f = await fixture()
  await migrateResearchProfile(f)
  expect(await readFile(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  expect(await readdir(f.home)).toEqual(['profiles'])
})

it('preserves Messages credentials, endpoint, catalog and unrelated settings with exclusive backups', async () => {
  const source = `# synthetic
llm-deepseek:
  protocol: messages
  apiKeyEnv: SYNTHETIC_KEY
  baseURL: https://synthetic.invalid/anthropic
  models: [{id: custom, name: Custom, contextWindow: 8192}]
agent-default-model: {provider: deepseek-official, model: custom}
future-plugin: {future-field: [one, two]}
permission: {defaultPreset: full-access}
`
  const f = await fixture(source)
  await migrateResearchProfile(f)
  const settings = await f.readSettings()
  expect(settings['llm-deepseek']).toEqual({ apiKeyEnv: 'SYNTHETIC_KEY', baseURL: 'https://synthetic.invalid/anthropic', models: [{ id: 'custom', name: 'Custom', contextWindow: 8192 }] })
  expect(settings['future-plugin']).toEqual({ 'future-field': ['one', 'two'] })
  expect(settings['permission']).toEqual({ defaultPreset: 'full-access' })
  const backup = (await readdir(f.home)).filter(path => path.includes('.before-'))
  expect(backup).toHaveLength(1)
  expect(await readFile(join(f.home, backup[0]!), 'utf8')).toBe(source)
  const first = await readFile(join(f.home, 'settings.yaml'), 'utf8')
  await migrateResearchProfile(f)
  expect(await readFile(join(f.home, 'settings.yaml'), 'utf8')).toBe(first)
  expect((await readdir(f.home)).filter(path => path.includes('.before-'))).toEqual(backup)
})

it('moves Chat Completions into pi-ai without changing provider/model/key references or sibling routes', async () => {
  const f = await fixture(`llm-deepseek:
  protocol: chat-completions
  baseURL: https://synthetic.invalid/v1
  apiKeyEnv: SYNTHETIC_CHAT_KEY
  reasoningEffort: max
  maxTokens: 4096
  models: [{id: historical-model, inputModalities: [text, image]}]
llm-pi-ai:
  providers:
    other: {api: openai-completions, baseURL: https://other.invalid/v1, models: [{id: other-model}]}
agent-default-model: {provider: deepseek-official, model: historical-model, reasoningEffort: max}
`)
  await migrateResearchProfile(f)
  const settings = await f.readSettings()
  expect(settings['llm-deepseek']).toBeUndefined()
  expect(settings['agent-default-model']).toEqual({ provider: 'deepseek-official', model: 'historical-model', reasoningEffort: 'max' })
  expect(at(settings, 'llm-pi-ai', 'providers', 'other', 'baseURL')).toBe('https://other.invalid/v1')
  expect(at(settings, 'llm-pi-ai', 'providers', 'deepseek-official')).toMatchObject({
    api: 'openai-completions', apiKeyEnv: 'SYNTHETIC_CHAT_KEY', baseURL: 'https://synthetic.invalid/v1', reasoning: 'max',
    models: [{ id: 'historical-model', maxTokens: 4096, input: ['text', 'image'], reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } }],
  })
  expect(await f.readPatch()).toContainEqual({ id: 'llm-deepseek', disabled: true })
  const before = await readFile(join(f.profileDir, 'cordis.patch.yml'), 'utf8')
  await migrateResearchProfile(f)
  expect(await readFile(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(before)
})

it.each([
  ['conflicting route', 'llm-deepseek: {protocol: chat-completions}\nllm-pi-ai: {providers: {deepseek-official: {baseURL: https://conflict.invalid}}}\n', /conflicting.*route/],
  ['unknown provider field', 'llm-deepseek: {protocol: messages, futureSafetyPolicy: keep}\n', /unsupported fields/],
  ['unsupported files policy', 'llm-deepseek: {protocol: chat-completions, maxImagesPerRequest: 7}\n', /files policy/],
  ['unknown preset policy', 'agent-presets: {default: research, unknown: keep}\n', /unsupported fields/],
] as const)('rejects %s before changing any source file', async (_name, source, error) => {
  const f = await fixture(source)
  await expect(migrateResearchProfile(f)).rejects.toThrow(error)
  expect(await readFile(join(f.home, 'settings.yaml'), 'utf8')).toBe(source)
  expect(await readFile(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  expect(await readdir(f.home)).toEqual(['profiles', 'settings.yaml'])
})

it.each([true, false])('preserves the old enabled=%s preset-default semantics and subagent alias', async (enabled) => {
  const f = await fixture(`agent-presets: {default: custom, modeSelectionEnabled: ${enabled}}\nsubagent-model-selection: {enabled: true, allowedModels: [{provider: deepseek-official, model: deepseek-v4-flash}]}\n`)
  await migrateResearchProfile(f)
  const settings = await f.readSettings()
  expect(settings['agent-presets']).toBeUndefined()
  expect(settings['agent-preset-registry']).toEqual(enabled ? { selectedDefault: 'custom' } : undefined)
  expect(settings['subagent-model-selection']).toBeUndefined()
  expect(at(settings, 'subagent-model-selection-settings', 'allowedModels', 0, 'model')).toBe('deepseek-v4-flash')
  const provider = (await f.readPatch()).find(row => row.id === 'llm-deepseek')!
  expect(at(provider, 'config', 'models')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'deepseek-v4-flash' })]))
})

it('rewrites explicit legacy module names in profile and home patches, preserving other fields', async () => {
  const f = await fixture(undefined, `- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config: {protocol: messages, apiKeyEnv: SYNTHETIC, baseURL: https://messages.invalid}
- id: custom
  config: {unknown: keep}
`)
  await writeFile(join(f.home, 'cordis.patch.yml'), `- id: llm-deepseek
  config: {protocol: messages, streamIdleTimeoutMs: 12345}
`)
  await migrateResearchProfile(f)
  expect((await f.readPatch())[0]).toMatchObject({ name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: { apiKeyEnv: 'SYNTHETIC', baseURL: 'https://messages.invalid' } })
  expect((await f.readPatch())[1]).toEqual({ id: 'custom', config: { unknown: 'keep' } })
  const homePatch: unknown = parse(await readFile(join(f.home, 'cordis.patch.yml'), 'utf8'))
  expect(at(homePatch, 0, 'config', 'protocol')).toBeUndefined()
  expect(at(homePatch, 0, 'config', 'streamIdleTimeoutMs')).toBe(12345)
})

it('converts custom preset discovery to declarations with stable ids and original relative bases', async () => {
  const f = await fixture()
  const base = join(f.home, '.agent-presets', 'my-science')
  await mkdir(base, { recursive: true })
  const source = `- id: local
  name: ./plugin.mjs
  config: {unknown: keep}
- id: skills
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    customSkillDirs:
      - ./skills
      - !!js new URL('./dynamic-skills', baseUrl).pathname
- id: research-tools
  name: '@deepseek-ai/dsh-research-workbench/tools'
`
  await writeFile(join(base, 'agent.cordis.yml'), source)
  await writeFile(join(base, 'preset.yml'), 'name: My Science\ndescription: Synthetic fixture\norder: 4\n')
  await migrateResearchProfile(f)
  const raw = await readFile(join(f.profileDir, 'cordis.patch.yml'), 'utf8')
  const document = parseDocument(raw, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  const declaration = at(document.toJS(), 0, 'insert', 0)
  expect(at(declaration, 'config')).toMatchObject({ id: 'my-science', name: 'My Science', order: 4 })
  expect(at(declaration, 'config', 'plugins', 0, 'name')).toBe(pathToFileURL(join(base, 'plugin.mjs')).href)
  expect(at(declaration, 'config', 'plugins', 0, 'config', 'unknown')).toBe('keep')
  expect(at(declaration, 'config', 'plugins', 1, 'config', 'customSkillDirs', 0)).toBe(join(base, 'skills'))
  expect(at(declaration, 'config', 'plugins', 1, 'config', 'customSkillDirs', 1)).toContain(pathToFileURL(base + '/').href)
  expect(at(declaration, 'config', 'plugins', 3, 'name')).toBe('@deepseek-ai/dsh-research-workbench/mode-skills')
  expect(raw).toContain('!!js')
  expect(await readFile(join(base, 'agent.cordis.yml'), 'utf8')).toBe(source)
  await migrateResearchProfile(f)
  expect(await readFile(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(raw)
})

it('does not overwrite a new declaration with an old preset directory', async () => {
  const f = await fixture(undefined, '- insert:\n    - id: own-preset\n      name: "@deepseek-ai/dsh-agent-preset"\n      config: {id: custom, plugins: []}\n')
  const base = join(f.home, '.agent-presets', 'custom')
  await mkdir(base, { recursive: true })
  await writeFile(join(base, 'agent.cordis.yml'), '[]\n')
  await expect(migrateResearchProfile(f)).rejects.toThrow(/already has a declaration/)
})

it('preserves provider fields inherited from old patches when a settings override selects the chat protocol', async () => {
  const f = await fixture('llm-deepseek: {protocol: chat-completions}\n', '- id: llm-deepseek\n  name: "@deepseek-ai/dsh-llm-deepseek"\n  config: {apiKeyEnv: FROM_PATCH, baseURL: https://patch.invalid, models: [{id: patch-model}]}\n')
  await migrateResearchProfile(f)
  expect(at(await f.readSettings(), 'llm-pi-ai', 'providers', 'deepseek-official')).toMatchObject({
    apiKeyEnv: 'FROM_PATCH', baseURL: 'https://patch.invalid', models: [{ id: 'patch-model' }],
  })
})

it('refuses an existing conflicting Pi route in another profile layer before any write', async () => {
  const source = 'llm-deepseek: {protocol: chat-completions, baseURL: https://legacy.invalid}\n'
  const patch = '- id: llm-pi-ai\n  config: {providers: {deepseek-official: {api: openai-completions, baseURL: https://existing.invalid}}}\n'
  const f = await fixture(source, patch)
  await expect(migrateResearchProfile(f)).rejects.toThrow(/conflicting.*another layer/)
  expect(await readFile(join(f.home, 'settings.yaml'), 'utf8')).toBe(source)
  expect(await readFile(join(f.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
})

it('disables the native route when a second research profile encounters already-converted Chat settings', async () => {
  const f = await fixture('llm-deepseek: {protocol: chat-completions}\n')
  await migrateResearchProfile(f)
  const profileDir = join(f.home, 'profiles', 'second')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'cordis.patch.yml'), '[]\n')
  await migrateResearchProfile({ home: f.home, profileDir })
  const patch: unknown = parse(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'))
  expect(patch).toContainEqual({ id: 'llm-deepseek', disabled: true })
})

it('refuses a conflicting exclusive backup without altering input or the earlier backup', async () => {
  const source = 'llm-deepseek: {protocol: messages}\n'
  const f = await fixture(source)
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const backup = join(f.home, `settings.yaml.before-dsh-v0.1.7-rc.2-${digest}`)
  await writeFile(backup, 'older backup must survive')
  await expect(migrateResearchProfile(f)).rejects.toThrow()
  expect(await readFile(backup, 'utf8')).toBe('older backup must survive')
  expect(await readFile(join(f.home, 'settings.yaml'), 'utf8')).toBe(source)
})

it.each([false, true])('resumes an interrupted transaction only when its remaining inputs are unchanged (conflict=%s)', async (conflict) => {
  const f = await fixture()
  const settingsPath = join(f.home, 'settings.yaml')
  const profilePath = join(f.profileDir, 'cordis.patch.yml')
  const journalPath = join(f.home, `.research-migration-dsh-v0.1.7-rc.2-${createHash('sha256').update(f.profileDir).digest('hex').slice(0, 16)}.json`)
  const before = 'llm-deepseek: {protocol: messages}\n'
  const after = 'llm-deepseek: {models: [{id: preserved}]}\n'
  const patch = '- id: harmless\n  disabled: true\n'
  await writeFile(settingsPath, after)
  await writeFile(profilePath, conflict ? '# user edit\n[]\n' : '[]\n')
  await writeFile(journalPath, JSON.stringify({ version: 'dsh-v0.1.7-rc.2', changes: [
    { path: settingsPath, before, after }, { path: profilePath, before: '[]\n', after: patch },
  ] }))
  if (conflict) {
    await expect(migrateResearchProfile(f)).rejects.toThrow(/changed during recovery/)
    expect(await readFile(profilePath, 'utf8')).toBe('# user edit\n[]\n')
  } else {
    await migrateResearchProfile(f)
    expect(await readFile(profilePath, 'utf8')).toBe(patch)
    expect((await readdir(f.home)).some(path => path.endsWith('.json'))).toBe(false)
    const backup = (await readdir(f.home)).find(path => path.startsWith('settings.yaml.before-'))!
    expect(await readFile(join(f.home, backup), 'utf8')).toBe(before)
  }
})

it.each(['messages', 'chat-completions'] as const)('boots the converted %s profile, imports legacy settings and serves the selected historical model', async (protocol) => {
  const server = await mockServer([{ events: textEvents }])
  const f = await fixture(`llm-deepseek:\n  protocol: ${protocol}\n  apiKeyEnv: SYNTHETIC_MIGRATION_KEY\n  baseURL: ${server.url}\nagent-default-model: {provider: deepseek-official, model: deepseek-v4-flash, reasoningEffort: max}\nfuture-plugin: {future-field: preserve}\n`)
  vi.stubEnv('SYNTHETIC_MIGRATION_KEY', '')
  await writeFile(join(f.home, '.credentials.yaml'), 'version: 1\nrefs:\n  SYNTHETIC_MIGRATION_KEY: synthetic-secret\n')
  initProfile(f.profileDir, ['migration-fixture-bundle'])
  const bundle = join(f.profileDir, 'node_modules', 'migration-fixture-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(f.home, 'package.json'), '{"name":"migration-fixture"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'migration-fixture-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'llm', name: 'cordis:llm' },
    { id: 'credentials', name: 'cordis:credentials', config: { path: join(f.home, '.credentials.yaml'), watch: false } },
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'llm-deepseek', name: 'cordis:deepseek' },
    { id: 'llm-pi-ai', name: 'cordis:pi' },
    { id: 'agent-default-model', name: 'cordis:model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  ] }]))
  await writeFile(join(f.profileDir, 'cordis.yml'), '[]\n')
  await migrateResearchProfile(f)
  const profile: ProfileContext = {
    name: 'migration', startedBundles: ['migration-fixture-bundle'], dir: f.profileDir, patchPath: join(f.profileDir, 'cordis.patch.yml'),
    installAnchor: join(f.home, 'package.json'), cwd: f.home, home: f.home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('migration', join(f.profileDir, 'cordis.yml'), readProfilePatches('migration', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, {
      llm: LlmRuntime, credentials: LocalCredentialProvider, editor: ConfigEditor,
      settings: Settings, deepseek: DeepSeek, pi: LlmPiAi, model: DefaultModel,
    })
  })
  try {
    await vi.waitFor(() => { expect(ctx.agentDefaultModel.currentSelection().model).toBe('deepseek-v4-flash') })
    await vi.waitFor(() => { expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek-official']) })
    expect((await ctx.llm.listModels('deepseek-official')).map(model => model.id)).toContain('deepseek-v4-flash')
    await vi.waitFor(async () => { expect(await f.readSettings()).toEqual({ 'future-plugin': { 'future-field': 'preserve' } }) })
    if (protocol === 'chat-completions') {
      const result = await assemble(ctx, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: ReasoningEffortId('max'), messages: [] })
      expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
      expect(server.headers[0]?.authorization).toBe('Bearer synthetic-secret')
      expect(server.requests[0]).toMatchObject({ model: 'deepseek-v4-flash', reasoning_effort: 'max', thinking: { type: 'enabled' } })
    }
  } finally { await ctx.fiber.dispose() }
})
