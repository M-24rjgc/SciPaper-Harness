/**
 * The Web composition (the `web` profile, and the Desktop Host over the same
 * bundles) exports no telemetry, reaches DeepSeek services only for the model
 * requests and web searches a person configures, and keeps developer controls
 * separate from the user-facing terminal, trajectory, and native file opening.
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { DEVELOPER_ROWS, TELEMETRY_ROWS, USER_SURFACE_ROWS } from './research-edition-rows.ts'

const BASE_PATCH = fileURLToPath(new URL('../../base/cordis.patch.yml', import.meta.url))
const WEB_PATCH = fileURLToPath(new URL('../../web-app/cordis.patch.yml', import.meta.url))
const RESEARCH_PRESET_PATCH = fileURLToPath(new URL('../presets/research.patch.yml', import.meta.url))

const layers = [
  loadOverlayPatches('web-app spec', BASE_PATCH),
  loadOverlayPatches('web-app spec', WEB_PATCH),
  loadOverlayPatches('research-app spec', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))),
]
const rows = composeEntries(layers)

function row(id: string): (typeof rows)[number] {
  const found = rows.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`the Web composition has no ${id} row`)
  return found
}

describe('the Web composition of the research edition', () => {
  it.each([...TELEMETRY_ROWS, ...DEVELOPER_ROWS])('keeps the %s row disabled', (id) => {
    expect(row(id).disabled).toBe(true)
  })

  it.each(USER_SURFACE_ROWS)('keeps the official %s capability enabled', (id) => {
    expect(row(id).disabled).not.toBe(true)
  })

  it('starts a visible, session-owned browser with a persistent profile', () => {
    expect(row('browser-use').name).toBe('@deepseek-ai/dsh-browser-use')
    expect(row('browser-use-playwright')).toMatchObject({
      name: '@deepseek-ai/dsh-browser-use-playwright-mcp',
      config: { mode: 'launch', headless: false, persistentProfile: true },
    })
  })

  it('loads the SSH workspace backend for verified remote files, terminal and LSP presets', () => {
    expect(row('remote-workspace-presets').name).toBe('@deepseek-ai/dsh-remote-workspace-presets')
    expect(row('remote-workspace-presets').disabled).not.toBe(true)
  })

  it('keeps DeepSeek search selected until a person enables another backend bundle', () => {
    expect(row('web').config).toMatchObject({ searchProvider: 'deepseek-official' })
    expect(rows.map(candidate => candidate.id)).not.toContain('web-search-exa')
    expect(rows.map(candidate => candidate.id)).not.toContain('web-search-perplexity')
  })

  it('keeps research trajectory visible even when an older profile disabled Coding Tools', () => {
    expect(row('ui-conversation').config).toMatchObject({ showTrajectoryWithoutDeveloperTools: true })
  })

  it('provides the research agent with packaged TypeScript and JavaScript code navigation', () => {
    expect(row('lsp').name).toBe('@deepseek-ai/dsh-lsp')
    expect(row('lsp-stdio')).toMatchObject({
      name: '@deepseek-ai/dsh-lsp-stdio',
      config: { servers: { typescript: {
        extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript' },
      } } },
    })
    const preset = composeEntries([...layers,
      loadOverlayPatches('research preset spec', RESEARCH_PRESET_PATCH)])
      .find(candidate => candidate.id === 'preset-research')
    expect((preset?.config as { plugins?: Array<{ id: string; name: string }> })?.plugins)
      .toContainEqual(expect.objectContaining({ id: 'tool-lsp', name: '@deepseek-ai/dsh-tool-lsp' }))
  })

  it('sends no Session log with official DeepSeek model requests', () => {
    expect(row('session-log-deepseek')).toMatchObject({ config: { enabled: false } })
    expect(row('session-log-deepseek').disabled).toBeUndefined()
  })

  it('leaves no enabled row configured with the DeepSeek telemetry endpoint', () => {
    const enabled = rows.filter(candidate => candidate.disabled !== true)
    expect(enabled.map(candidate => candidate.id)).not.toContain('session-telemetry-otel')
    expect(JSON.stringify(enabled)).not.toContain('deepseeksvc')
  })

  it('introduces the agent by its persona alone, with no harness identity opener', () => {
    expect(row('system-prompt')).toMatchObject({ config: { includeHarnessIdentity: false } })
  })

  it('has the research client shadow the shell\'s developer cells', () => {
    expect(row('ui-research')).toMatchObject({ config: { hideDeveloperCells: true } })
  })

  it('hands startup and the unscoped New Session to the entry policy, and keeps the brand row plain', () => {
    expect(row('ui-workspace')).toMatchObject({ config: { entry: 'policy' } })
    expect(row('ui-sidebar')).toMatchObject({ config: { brandAction: 'none' } })
  })

  it('searches conversation content from an in-memory index opened at the first search', () => {
    // The patch replaces the row's whole config, so the base row's `path` is restated with it.
    expect(row('session-query-sqlite').config).toEqual({ path: ':memory:', openAt: 'first-search' })
    expect(row('session-query-sqlite').disabled).toBeUndefined()
  })

  it('gives the automatic autonomy preset a display name', () => {
    const presets = (row('permission').config as { presets?: Record<string, unknown> } | undefined)?.presets
    expect(presets?.['research-auto']).toMatchObject({
      name: '全自动 · Automatic',
      sandbox: 'workspace-write',
      approval: 'never',
    })
  })
})
