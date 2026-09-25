/** The patch layers the Desktop Host composes over a loaded plugin profile. */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadOverlayPatches, type Profile } from '@deepseek-ai/dsh-app-boot'
import { TELEMETRY_ROW_ID, telemetrySwitchPatch } from './telemetry.ts'

/** The Desktop overlay, applied after the profile's own patch. */
export const DESKTOP_PATCH = fileURLToPath(new URL('../config/desktop.cordis.patch.yml', import.meta.url))

/**
 * Stack the Desktop Host's patch layers in composition order: the profile's
 * bundles, the profile's own patch, the Desktop overlay, the installed preset
 * root as the only agent-preset root, and last the telemetry switch.
 * @param profile - the loaded Desktop plugin profile.
 * @param dshRoot - directory of the installed `@deepseek-ai/dsh` package, whose `config/agent-presets` holds the presets.
 * @param telemetryDisabled - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @returns the layers, first to last.
 */
export function desktopPatchLayers(profile: Profile, dshRoot: string, telemetryDisabled: string | undefined): PatchOptions[][] {
  const layers = [
    ...profile.layers.map(layer => layer.patches),
    profile.patches,
    loadOverlayPatches('dsh desktop', DESKTOP_PATCH),
  ]
  const rows = new Map(composeEntries(layers).flatMap(row => typeof row.id === 'string' ? [[row.id, row] as const] : []))
  const agentPresets = rows.get('agent-presets')
  if (agentPresets !== undefined) {
    layers.push([{
      id: 'agent-presets',
      config: {
        ...(agentPresets.config ?? {}) as Record<string, unknown>,
        roots: [{ path: join(dshRoot, 'config', 'agent-presets'), trust: 'system' }],
      },
    }])
  }
  const telemetryPatch = telemetrySwitchPatch(telemetryDisabled, rows.has(TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) layers.push([telemetryPatch])
  return layers
}
