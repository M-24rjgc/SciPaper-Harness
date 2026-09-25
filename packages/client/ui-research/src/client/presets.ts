/**
 * Which agent preset conversations compose from, as the research record reads
 * it from the `agent-presets` settings namespace. The deployment names the
 * research assistant's preset as the namespace's composition default; a
 * `default` saved in the person's settings (the preset settings of an earlier
 * build wrote one) overrides it for every new conversation while preset
 * selection is on, and this edition ships no control that shows it.
 */
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The settings namespace the agent-preset roster registers its default in. */
export const PRESET_SETTINGS_NAMESPACE = 'agent-presets'
/** The field of that namespace that names the default preset. */
export const DEFAULT_PRESET_FIELD = 'default'

/** The research assistant's preset, and a saved default that replaces it for new conversations. */
export interface PresetDefaults {
  /** The preset the deployment composes conversations from: the research assistant's. */
  research: string
  /** A default saved in the settings that names another preset; new conversations compose from it. */
  saved?: string | undefined
}

/** One field of a settings layer, when the layer is an object. */
function field(layer: unknown, name: string): unknown {
  return typeof layer === 'object' && layer !== null ? (layer as Record<string, unknown>)[name] : undefined
}

/**
 * The research assistant's preset and any saved default that overrides it.
 * @param scope - the `agent-presets` namespace as the settings mirror holds it.
 * @returns the presets, or null while the namespace is not read or not exposed, or names no composition default.
 */
export function presetDefaults(scope: Pick<SettingsScopeSnapshot<unknown>, 'status' | 'base' | 'user' | 'value'>): PresetDefaults | null {
  const research = field(scope.base, DEFAULT_PRESET_FIELD)
  if (scope.status !== 'ready' || typeof research !== 'string') return null
  const saved = field(scope.user, DEFAULT_PRESET_FIELD)
  // With preset selection off the roster composes the deployment's default whatever is saved.
  const selecting = field(scope.value, 'modeSelectionEnabled') !== false
  return selecting && typeof saved === 'string' && saved !== research ? { research, saved } : { research }
}
