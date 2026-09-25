/** The `DSH_TELEMETRY_DISABLED` switch for the Desktop Host composition, with the `dsh` launcher's semantics. */

import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

/** The session-telemetry row id the switch disables. */
export const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/**
 * Resolve the telemetry opt-out into the patch applied after every other
 * layer. Any non-empty value disables, including `'0'` and `'false'`; a
 * composition without the row exports nothing and needs no patch.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composed rows carry the telemetry row.
 * @returns the disable patch, or `undefined` when none is required.
 */
export function telemetrySwitchPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}
