/** Telemetry and feedback in the shipped Desktop composition, through the Host's own layer assembly. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadProfileDirectory, PROFILE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'
import { desktopPatchLayers } from '../../desktop-host/src/layers.ts'
import { TELEMETRY_ROW_ID, telemetrySwitchPatch } from '../../desktop-host/src/telemetry.ts'
import { TELEMETRY_ROWS } from '../../../packages/bundle/web-app/tests/research-edition-rows.ts'
import { createPluginProfile } from '../src/project-manager.ts'

const homes: string[] = []
const INSTALL_ANCHOR = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
const DSH_ROOT = fileURLToPath(new URL('../../cli', import.meta.url))

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/**
 * The Desktop Host's layers over a fresh plugin profile.
 * @param telemetryDisabled - the `DSH_TELEMETRY_DISABLED` value the Host reads.
 * @param profilePatch - the profile's own patch file, a layer before the Desktop overlay and the switch.
 */
function desktopLayers(telemetryDisabled: string | undefined, profilePatch?: string): PatchOptions[][] {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-telemetry-'))
  homes.push(home)
  const profileDir = join(home, 'profiles', 'desktop')
  createPluginProfile(profileDir)
  if (profilePatch !== undefined) writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), profilePatch)
  const profile = loadProfileDirectory('dsh desktop', profileDir, INSTALL_ANCHOR)
  return desktopPatchLayers(profile, DSH_ROOT, telemetryDisabled)
}

function disabledOf(layers: PatchOptions[][], id: string): unknown {
  const row = composeEntries(layers).find(candidate => candidate.id === id)
  if (row === undefined) throw new Error(`the Desktop composition has no ${id} row`)
  return row.disabled
}

describe('the Desktop composition', () => {
  it.each(TELEMETRY_ROWS)('keeps the %s row disabled without the switch', (id) => {
    expect(disabledOf(desktopLayers(undefined), id)).toBe(true)
  })

  it('disables the telemetry row last under the switch, even when the profile patch enables it', () => {
    const enabling = `- id: ${TELEMETRY_ROW_ID}\n  disabled: false\n`
    expect(disabledOf(desktopLayers(undefined, enabling), TELEMETRY_ROW_ID)).toBe(false)
    const layers = desktopLayers('1', enabling)
    expect(layers.at(-1)).toEqual([{ id: TELEMETRY_ROW_ID, disabled: true }])
    expect(disabledOf(layers, TELEMETRY_ROW_ID)).toBe(true)
  })

  it('roots the agent presets at the installed package only', () => {
    const presets = composeEntries(desktopLayers(undefined)).find(row => row.id === 'agent-presets')
    expect(presets?.config).toMatchObject({ roots: [{ path: join(DSH_ROOT, 'config', 'agent-presets'), trust: 'system' }] })
  })
})

describe('the DSH_TELEMETRY_DISABLED switch', () => {
  it.each(['1', '0', 'false'])('treats %j as the opt-out', (value) => {
    expect(telemetrySwitchPatch(value, true)).toEqual({ id: TELEMETRY_ROW_ID, disabled: true })
  })

  it('needs no patch when the value is unset or empty, or the composition has no telemetry row', () => {
    expect(telemetrySwitchPatch(undefined, true)).toBeUndefined()
    expect(telemetrySwitchPatch('', true)).toBeUndefined()
    expect(telemetrySwitchPatch('1', false)).toBeUndefined()
  })
})
