/** Lossless, restartable conversion of the research application's pre-0.1.7 profile files. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, isScalar, isSeq, parseDocument, visit, type Document, type YAMLMap, type YAMLSeq } from 'yaml'

const OLD_PROVIDER = '@deepseek-ai/dsh-llm-deepseek'
const NEW_PROVIDER = '@deepseek-ai/dsh-llm-deepseek-api-key'
const JS_TAG = 'tag:yaml.org,2002:js'
const VERSION = 'dsh-v0.1.7-rc.2'
const ROUTE = 'deepseek-official'
const DEEPSEEK_FIELDS = new Set([
  'protocol', 'apiKeyEnv', 'baseURL', 'thinking', 'reasoningEffort', 'maxTokens',
  'defaultContextWindow', 'models', 'streamIdleTimeoutMs', 'maxRequestFilesBytes',
  'maxInlineRequestImageBytes', 'maxImagesPerRequest', 'imageOffloadByteQuantum',
  'inlineImageOffloadByteQuantum', 'imageOffloadCountQuantum', 'filesApiTimeoutMs',
  'fileExpiresAfterSeconds', 'fileRefreshMarginSeconds', 'fileQuotaCleanupBatch', 'retryPolicy',
])
const LEGACY_MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', contextWindow: 1_000_000, inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', contextWindow: 1_000_000, inputModalities: ['text', 'image'] },
]

interface InputFile { path: string; before: string | null; document: Document }
interface Change { path: string; before: string | null; after: string }
interface Journal { version: string; changes: Change[] }

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parse(source: string, path: string): Document {
  const document = parseDocument(source, { customTags: [{ tag: JS_TAG, resolve: (value: string) => value }] })
  if (document.errors.length > 0) throw new Error(`Research profile migration: invalid YAML in ${path}`)
  if (document.warnings.length > 0) throw new Error(`Research profile migration: unsupported YAML tag in ${path}`)
  return document
}

async function input(path: string, empty: string): Promise<InputFile> {
  const before = await readOptional(path)
  return { path, before, document: parse(before ?? empty, path) }
}

function map(value: unknown, label: string): YAMLMap {
  if (!isMap(value)) throw new Error(`Research profile migration: ${label} must be a mapping`)
  return value
}

function sequence(value: unknown, label: string): YAMLSeq {
  if (!isSeq(value)) throw new Error(`Research profile migration: ${label} must be a sequence`)
  return value
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Research profile migration: ${label} must be a mapping`)
  }
  return value as Record<string, unknown>
}

function config(row: YAMLMap, document: Document): YAMLMap {
  if (!row.has('config')) row.set('config', document.createNode({}))
  return map(row.get('config'), 'plugin config')
}

function assertKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unsupported = Object.keys(value).filter(key => !allowed.has(key))
  if (unsupported.length > 0) throw new Error(`Research profile migration: ${label} has unsupported fields: ${unsupported.join(', ')}`)
}

/** Convert the old OpenAI-compatible transport while preserving the provider route and model identifiers. */
function chatProvider(source: Record<string, unknown>): Record<string, unknown> {
  assertKeys(source, DEEPSEEK_FIELDS, 'llm-deepseek')
  // These settings control the removed transport's files API. pi-ai has no
  // equivalent, so an explicit deployment policy needs an explicit repair.
  const unsupported = ['maxRequestFilesBytes', 'maxImagesPerRequest', 'imageOffloadByteQuantum',
    'inlineImageOffloadByteQuantum', 'imageOffloadCountQuantum', 'filesApiTimeoutMs',
    'fileExpiresAfterSeconds', 'fileRefreshMarginSeconds', 'fileQuotaCleanupBatch']
  if (unsupported.some(key => source[key] !== undefined)) {
    throw new Error(`Research profile migration: chat-completions files policy cannot be converted automatically (${unsupported.filter(key => source[key] !== undefined).join(', ')})`)
  }
  if (source.thinking !== undefined && source.thinking !== 'enabled' && source.thinking !== 'disabled') {
    throw new Error('Research profile migration: invalid DeepSeek thinking policy')
  }
  const models = source.models ?? LEGACY_MODELS
  if (!Array.isArray(models)) throw new Error('Research profile migration: DeepSeek models must be an array')
  const converted = models.map((value) => {
    const model = object(value, 'DeepSeek model')
    assertKeys(model, new Set(['id', 'name', 'description', 'contextWindow', 'maxTokens', 'inputModalities', 'systemPromptUpdate']), 'DeepSeek model')
    if (typeof model.id !== 'string' || model.id.length === 0) throw new Error('Research profile migration: missing model id')
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      contextWindow: model.contextWindow ?? source.defaultContextWindow ?? 1_000_000,
      maxTokens: model.maxTokens ?? source.maxTokens ?? 256_000,
      input: model.inputModalities ?? ['text'],
      reasoningEfforts: source.thinking === 'disabled' ? false : { off: null, low: 'low', high: 'high', max: 'max' },
    }
  })
  const result: Record<string, unknown> = {
    api: 'openai-completions', apiKeyEnv: source.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
    baseURL: source.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    models: converted, compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true },
    reasoning: source.thinking === 'disabled' ? 'off' : source.reasoningEffort ?? (source.thinking === 'enabled' ? 'high' : 'off'),
  }
  for (const key of ['defaultContextWindow', 'streamIdleTimeoutMs', 'retryPolicy']) {
    if (source[key] !== undefined) result[key] = source[key]
  }
  if (source.maxInlineRequestImageBytes !== undefined) result.maxRequestImageBytes = source.maxInlineRequestImageBytes
  return result
}

function migrateDeepSeek(
  section: YAMLMap,
  document: Document,
  inherited: Record<string, unknown> = {},
  preserveCatalog = true,
): Record<string, unknown> | undefined {
  const source = { ...inherited, ...object(section.toJSON(), 'llm-deepseek') }
  assertKeys(source, DEEPSEEK_FIELDS, 'llm-deepseek')
  const protocol = source.protocol ?? 'messages'
  if (protocol === 'chat-completions') return chatProvider(source)
  if (protocol !== 'messages') throw new Error('Research profile migration: unsupported DeepSeek protocol')
  section.delete('protocol')
  if (preserveCatalog && !section.has('models')) section.set('models', document.createNode(source.models ?? LEGACY_MODELS))
  return undefined
}

function mergeRoute(section: YAMLMap, route: Record<string, unknown>, document: Document): void {
  if (!section.has('providers')) section.set('providers', document.createNode({}))
  const providers = map(section.get('providers'), 'llm-pi-ai.providers')
  if (providers.has(ROUTE)) {
    if (!isDeepStrictEqual(map(providers.get(ROUTE), ROUTE).toJSON(), route)) {
      throw new Error(`Research profile migration: llm-pi-ai already defines a conflicting ${ROUTE} route`)
    }
    return
  }
  providers.set(ROUTE, document.createNode(route))
}

function patchRow(rows: YAMLSeq, id: string, document: Document): YAMLMap {
  const matches = rows.items.filter(row => isMap(row) && row.get('id') === id)
  if (matches.length > 1) throw new Error(`Research profile migration: duplicate patch entry ${id}`)
  if (matches.length === 1) return map(matches[0], id)
  const row = document.createNode({ id })
  rows.add(row)
  return map(row, id)
}

function disableNative(rows: YAMLSeq, document: Document): void {
  patchRow(rows, 'llm-deepseek', document).set('disabled', true)
}

function settingsHasChatRoute(sections: YAMLMap): boolean {
  const pi = sections.get('llm-pi-ai')
  if (!isMap(pi)) return false
  const providers = pi.get('providers')
  return isMap(providers) && providers.has(ROUTE)
}

function assertRouteCompatible(route: Record<string, unknown>, existing: readonly Record<string, unknown>[]): void {
  if (existing.some(profile => !isDeepStrictEqual(profile, route))) {
    throw new Error(`Research profile migration: llm-pi-ai already defines a conflicting ${ROUTE} route in another layer`)
  }
}

function migrateSettings(
  file: InputFile,
  profile: InputFile,
  inherited: Record<string, unknown>,
  existingRoutes: readonly Record<string, unknown>[],
): void {
  if (file.before === null) return
  const sections = map(file.document.contents, 'settings.yaml')
  const patches = sequence(profile.document.contents, 'profile patch')
  if (sections.has('agent-presets')) {
    const old = map(sections.get('agent-presets'), 'agent-presets')
    assertKeys(object(old.toJSON(), 'agent-presets'), new Set(['default', 'modeSelectionEnabled']), 'agent-presets')
    if (old.has('modeSelectionEnabled') && typeof old.get('modeSelectionEnabled') !== 'boolean') {
      throw new Error('Research profile migration: invalid modeSelectionEnabled')
    }
    if (old.get('modeSelectionEnabled') !== false && old.has('default')) {
      const selected = old.get('default')
      if (typeof selected !== 'string' || selected.length === 0) throw new Error('Research profile migration: invalid default preset')
      if (!sections.has('agent-preset-registry')) sections.set('agent-preset-registry', file.document.createNode({}))
      const registry = map(sections.get('agent-preset-registry'), 'agent-preset-registry')
      if (registry.has('selectedDefault') && registry.get('selectedDefault') !== selected) {
        throw new Error('Research profile migration: conflicting default presets')
      }
      registry.set('selectedDefault', selected)
    }
    sections.delete('agent-presets')
  }
  if (sections.has('subagent-model-selection')) {
    const old = sections.get('subagent-model-selection')
    if (sections.has('subagent-model-selection-settings')
      && !isDeepStrictEqual(map(old, 'subagent-model-selection').toJSON(), map(sections.get('subagent-model-selection-settings'), 'subagent-model-selection-settings').toJSON())) {
      throw new Error('Research profile migration: conflicting subagent model settings')
    }
    sections.set('subagent-model-selection-settings', old)
    sections.delete('subagent-model-selection')
  }
  if (sections.has('llm-deepseek')) {
    const route = migrateDeepSeek(map(sections.get('llm-deepseek'), 'llm-deepseek'), file.document, inherited)
    if (route !== undefined) {
      assertRouteCompatible(route, existingRoutes)
      if (!sections.has('llm-pi-ai')) sections.set('llm-pi-ai', file.document.createNode({}))
      mergeRoute(map(sections.get('llm-pi-ai'), 'llm-pi-ai'), route, file.document)
      sections.delete('llm-deepseek')
      disableNative(patches, profile.document)
    }
  } else if (!settingsHasChatRoute(sections) && inherited.models === undefined && inherited.protocol !== 'chat-completions') {
    // A settings file predates this release. Keep old catalog selections even
    // when the user never customized the provider's own settings page.
    const native = config(patchRow(patches, 'llm-deepseek', profile.document), profile.document)
    if (!native.has('models')) native.set('models', profile.document.createNode(LEGACY_MODELS))
  }
  if (settingsHasChatRoute(sections)) disableNative(patches, profile.document)
}

function migratePatch(file: InputFile, existingRoutes: readonly Record<string, unknown>[]): void {
  const rows = sequence(file.document.contents, file.path)
  const routes: Record<string, unknown>[] = []
  const walk = (list: YAMLSeq): void => {
    for (const value of [...list.items]) {
      const row = map(value, 'patch entry')
      if (row.has('insert')) walk(sequence(row.get('insert'), 'insert'))
      const name = row.get('name')
      if (name === OLD_PROVIDER || row.get('id') === 'llm-deepseek' && isMap(row.get('config')) && map(row.get('config'), 'config').has('protocol')) {
        if (name === OLD_PROVIDER) row.set('name', NEW_PROVIDER)
        const route = migrateDeepSeek(config(row, file.document), file.document, {}, false)
        if (route !== undefined) {
          row.set('disabled', true)
          row.delete('config')
          routes.push(route)
        }
      }
      if (name === '@deepseek-ai/dsh-agent-presets' || row.get('id') === 'agent-presets') {
        const fields = config(row, file.document)
        // Additional discovery roots need an explicit declaration, otherwise
        // a migration could silently hide presets outside the standard root.
        assertKeys(object(fields.toJSON(), 'agent-presets config'), new Set(['default', 'includeShippedRoot', 'includeUserRoot', 'roots']), 'agent-presets config')
        const roots = fields.get('roots')
        if (roots !== undefined && (!isSeq(roots) || roots.items.length > 0)
          || fields.get('includeShippedRoot') === false || fields.get('includeUserRoot') === false) {
          throw new Error('Research profile migration: custom preset discovery roots require explicit preset declarations')
        }
        fields.delete('roots'); fields.delete('includeShippedRoot'); fields.delete('includeUserRoot')
        if (name !== undefined) row.set('name', '@deepseek-ai/dsh-agent-preset-registry')
        if (row.get('id') === 'agent-presets') row.set('id', 'agent-preset-registry')
      }
    }
  }
  walk(rows)
  for (const route of routes) {
    assertRouteCompatible(route, existingRoutes)
    mergeRoute(config(patchRow(rows, 'llm-pi-ai', file.document), file.document), route, file.document)
    disableNative(rows, file.document)
  }
}

function inheritedProvider(files: InputFile[]): { config: Record<string, unknown>; legacy: boolean } {
  const result: Record<string, unknown> = {}
  let legacy = false
  for (const file of files) visit(file.document, { Map(_key, row) {
    if (row.get('id') !== 'llm-deepseek' && row.get('name') !== OLD_PROVIDER) return
    const fields = row.get('config')
    if (row.get('name') === OLD_PROVIDER || isMap(fields) && fields.has('protocol')) legacy = true
    if (isMap(fields)) Object.assign(result, fields.toJSON())
  } })
  return { config: result, legacy }
}

function existingPiRoutes(settings: InputFile, patches: InputFile[]): Record<string, unknown>[] {
  const routes: Record<string, unknown>[] = []
  const collect = (section: unknown): void => {
    if (!isMap(section)) return
    const providers = section.get('providers')
    if (isMap(providers) && providers.has(ROUTE)) routes.push(object(map(providers.get(ROUTE), ROUTE).toJSON(), ROUTE))
  }
  if (isMap(settings.document.contents)) collect(settings.document.contents.get('llm-pi-ai'))
  for (const file of patches) visit(file.document, { Map(_key, row) {
    if (row.get('id') === 'llm-pi-ai' || row.get('name') === '@deepseek-ai/dsh-llm-pi-ai') collect(row.get('config'))
  } })
  return routes
}

function anchorPreset(plugins: YAMLSeq, base: string, document: Document): void {
  const baseURL = pathToFileURL(base + sep).href
  visit(plugins, {
    Scalar(_key, node) {
      if (node.tag === JS_TAG && typeof node.value === 'string') node.value = `(baseUrl => (${node.value}))(${JSON.stringify(baseURL)})`
    },
    Map(_key, row) {
      const name = row.get('name')
      if (typeof name !== 'string') return
      if (name.startsWith('./') || name.startsWith('../')) row.set('name', pathToFileURL(resolve(base, name)).href)
      const fields = row.get('config')
      if (name === OLD_PROVIDER) {
        const route = migrateDeepSeek(config(row, document), document)
        if (route === undefined) row.set('name', NEW_PROVIDER)
        else {
          row.set('name', '@deepseek-ai/dsh-llm-pi-ai')
          row.set('config', document.createNode({ providers: { [ROUTE]: route } }))
        }
      }
      if (!isMap(fields)) return
      if (name === '@deepseek-ai/dsh-skill-filesystem') {
        const dirs = fields.get('customSkillDirs')
        if (isSeq(dirs)) for (const dir of dirs.items) {
          if (isScalar(dir) && dir.tag !== JS_TAG && typeof dir.value === 'string' && !isAbsolute(dir.value)) dir.value = resolve(base, dir.value)
        }
      }
      if (name === 'cordis:include') {
        const path = fields.get('path', true)
        if (isScalar(path) && path.tag !== JS_TAG && typeof path.value === 'string' && !isAbsolute(path.value) && !/^[a-z][a-z\d+.-]*:/i.test(path.value)) {
          path.value = pathToFileURL(resolve(base, path.value)).href
        }
      }
    },
  })
  if (plugins.items.some(row => isMap(row) && row.get('name') === '@deepseek-ai/dsh-research-workbench/tools')
    && !plugins.items.some(row => isMap(row) && row.get('name') === '@deepseek-ai/dsh-research-workbench/mode-skills')) {
    plugins.add(document.createNode({ id: 'research-mode-skills', name: '@deepseek-ai/dsh-research-workbench/mode-skills' }))
  }
}

async function migratePresets(home: string, profile: InputFile): Promise<void> {
  const root = join(home, '.agent-presets')
  const directories = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  const rows = sequence(profile.document.contents, 'profile patch')
  const declarations = new Map<string, YAMLMap>()
  visit(rows, { Map(_key, row) {
    if (row.get('name') === '@deepseek-ai/dsh-agent-preset' && isMap(row.get('config'))) {
      const id = map(row.get('config'), 'preset').get('id')
      if (typeof id === 'string') declarations.set(id, row)
    }
  } })
  for (const directory of directories.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!directory.isDirectory() && !directory.isSymbolicLink()) continue
    const id = directory.name
    // The old registry gave shipped definitions precedence over user copies.
    if (['standard', 'research', 'minimal', 'cordis', 'ptc'].includes(id)) continue
    const base = join(root, id)
    const source = await readOptional(join(base, 'agent.cordis.yml'))
    if (source === null) continue
    const entryId = `research-migrated-preset-${hash(id).slice(0, 16)}`
    const existing = declarations.get(id)
    if (existing !== undefined) {
      if (existing.get('id') === entryId) continue
      throw new Error(`Research profile migration: preset ${id} already has a declaration`)
    }
    const metadataSource = await readOptional(join(base, 'preset.yml'))
    const metadata = metadataSource === null ? {} : object(parse(metadataSource, 'preset.yml').toJS(), 'preset metadata')
    assertKeys(metadata, new Set(['name', 'description', 'order']), 'preset metadata')
    const plugins = sequence(parse(source, 'agent.cordis.yml').contents, 'preset plugins')
    anchorPreset(plugins, base, profile.document)
    const declaration = map(profile.document.createNode({ id: entryId, name: '@deepseek-ai/dsh-agent-preset', config: { id, ...metadata } }), 'preset declaration')
    config(declaration, profile.document).set('plugins', plugins)
    const insertion = map(profile.document.createNode({ insert: [] }), 'insertion')
    sequence(insertion.get('insert'), 'insertion').add(declaration)
    rows.add(insertion)
  }
}

async function backup(change: Change): Promise<void> {
  if (change.before === null) return
  const path = `${change.path}.before-${VERSION}-${hash(change.before).slice(0, 16)}`
  try { await writeFile(path, change.before, { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readOptional(path) !== change.before) throw error
  }
}

async function finish(journal: Journal, journalPath: string, allowed: Set<string>): Promise<void> {
  if (journal.version !== VERSION || !Array.isArray(journal.changes)) throw new Error('Research profile migration: invalid recovery journal')
  // Inspect every target before the first write; a user edit must never be
  // overwritten merely because a preceding process stopped midway through.
  for (const change of journal.changes) {
    if (!allowed.has(change.path) || typeof change.after !== 'string' || change.before !== null && typeof change.before !== 'string') {
      throw new Error('Research profile migration: invalid recovery target')
    }
    const current = await readOptional(change.path)
    if (current !== change.before && current !== change.after) throw new Error(`Research profile migration: file changed during recovery: ${change.path}`)
  }
  for (const change of journal.changes) await backup(change)
  for (const change of journal.changes) {
    if (await readOptional(change.path) !== change.after) await writeFileAtomic(change.path, change.after, { mode: 0o600, dirMode: 0o700 })
  }
  await rm(journalPath)
}

/** Locations of the existing research profile; no credential document is read. */
export interface ResearchProfileMigrationOptions {
  /** Harness home containing legacy settings and user presets. */
  home: string
  /** Selected profile directory containing its Cordis patch. */
  profileDir: string
}

/**
 * Convert recognized legacy research configuration before the Loader starts.
 * Validates all conversions, exclusively backs up original bytes, and atomically
 * replaces each changed file. An interrupted commit resumes from its journal;
 * conflicting user edits and unrepresentable policies stop startup explicitly.
 * @param options - resolved home and selected profile directories.
 */
export async function migrateResearchProfile(options: ResearchProfileMigrationOptions): Promise<void> {
  const home = resolve(options.home)
  const profileDir = resolve(options.profileDir)
  await mkdir(home, { recursive: true, mode: 0o700 })
  const journalPath = join(home, `.research-migration-${VERSION}-${hash(profileDir).slice(0, 16)}.json`)
  const settingsPath = join(home, 'settings.yaml')
  const profilePath = join(profileDir, 'cordis.patch.yml')
  const homePath = join(home, 'cordis.patch.yml')
  const allowed = new Set([settingsPath, profilePath, homePath])
  await withFileLock(join(home, `.research-migration-${VERSION}`), async () => {
    const pending = await readOptional(journalPath)
    if (pending !== null) await finish(JSON.parse(pending) as Journal, journalPath, allowed)
    const settings = await input(settingsPath, '{}\n')
    const profile = await input(profilePath, '[]\n')
    const homePatch = profilePath === homePath ? profile : await input(homePath, '[]\n')
    const files = [...new Set([settings, profile, homePatch])]
    const original = new Map(files.map(file => [file, file.document.toString()]))
    const patchFiles = [...new Set([profile, homePatch])]
    const inherited = inheritedProvider(patchFiles)
    const existingRoutes = existingPiRoutes(settings, patchFiles)
    migratePatch(profile, existingRoutes)
    if (homePatch !== profile) migratePatch(homePatch, existingRoutes)
    migrateSettings(settings, profile, inherited.config, existingRoutes)
    if (inherited.legacy && inherited.config.models === undefined && inherited.config.protocol !== 'chat-completions') {
      const fields = config(patchRow(sequence(profile.document.contents, 'profile patch'), 'llm-deepseek', profile.document), profile.document)
      if (!fields.has('models')) fields.set('models', profile.document.createNode(LEGACY_MODELS))
    }
    await migratePresets(home, profile)
    const changes = files.flatMap((file): Change[] => {
      const after = file.document.toString()
      return after === original.get(file) ? [] : [{ path: file.path, before: file.before, after }]
    })
    if (changes.length === 0) return
    for (const change of changes) {
      await mkdir(dirname(change.path), { recursive: true, mode: 0o700 })
      await backup(change)
    }
    const journal: Journal = { version: VERSION, changes }
    await writeFile(journalPath, JSON.stringify(journal), { flag: 'wx', mode: 0o600 })
    await finish(journal, journalPath, allowed)
  })
}
