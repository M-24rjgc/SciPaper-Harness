/** Research preset defaults from the live agent-preset registry settings. */
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The settings namespace the agent-preset roster registers its default in. */
export const PRESET_SETTINGS_NAMESPACE = 'agent-preset-registry'
/** The field of that namespace that names the default preset. */
export const DEFAULT_PRESET_FIELD = 'selectedDefault'

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
 * @param scope - the `agent-preset-registry` namespace as the settings mirror holds it.
 * @returns the presets, or null while the namespace is not read or not exposed, or names no composition default.
 */
export function presetDefaults(scope: Pick<ConfigFormSnapshot<unknown>, 'status' | 'base' | 'user' | 'value'>): PresetDefaults | null {
  const research = field(scope.base, 'default')
  if (scope.status !== 'ready' || typeof research !== 'string') return null
  const saved = field(scope.user, DEFAULT_PRESET_FIELD)
  return typeof saved === 'string' && saved !== research ? { research, saved } : { research }
}
