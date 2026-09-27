/**
 * The Web composition (the `web` profile, and the Desktop Host over the same
 * bundles) exports no telemetry, reaches DeepSeek services only for the model
 * requests and web searches a person configures, and ships no developer controls.
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { DEVELOPER_ROWS, OPEN_IN_APP_ROWS, TELEMETRY_ROWS } from './research-edition-rows.ts'

const BASE_PATCH = fileURLToPath(new URL('../../base/cordis.patch.yml', import.meta.url))
const WEB_PATCH = fileURLToPath(new URL('../../web-app/cordis.patch.yml', import.meta.url))

const rows = composeEntries([
  loadOverlayPatches('web-app spec', BASE_PATCH),
  loadOverlayPatches('web-app spec', WEB_PATCH),
  loadOverlayPatches('research-app spec', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))),
])

function row(id: string): (typeof rows)[number] {
  const found = rows.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`the Web composition has no ${id} row`)
  return found
}

describe('the Web composition of the research edition', () => {
  it.each([...TELEMETRY_ROWS, ...OPEN_IN_APP_ROWS, ...DEVELOPER_ROWS])('keeps the %s row disabled', (id) => {
    expect(row(id).disabled).toBe(true)
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
