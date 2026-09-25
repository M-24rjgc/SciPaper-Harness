/**
 * Which agent preset conversations compose from, as the research record
 * reads it from the `agent-presets` settings namespace: the deployment's
 * default, the research assistant's, and a saved default that replaces it.
 */
import { describe, expect, it } from 'vitest'
import { presetDefaults } from '../src/client/presets.ts'

/** The namespace as the settings mirror holds it once read. */
function scope(user: unknown, value: unknown = { default: 'research', modeSelectionEnabled: true }, base: unknown = { default: 'research', modeSelectionEnabled: true }) {
  return { status: 'ready' as const, base, user, value }
}

describe('the agent presets conversations compose from', () => {
  it('names the research assistant\'s preset, and a saved default only while it names another one and selection is on', () => {
    expect(presetDefaults(scope(undefined))).toEqual({ research: 'research' })
    expect(presetDefaults(scope({ default: 'research' }))).toEqual({ research: 'research' })
    expect(presetDefaults(scope({ default: 'standard' }, { default: 'standard', modeSelectionEnabled: true }))).toEqual({ research: 'research', saved: 'standard' })
    // With preset selection off the roster composes the deployment's default whatever is saved.
    expect(presetDefaults(scope({ default: 'standard', modeSelectionEnabled: false }, { default: 'standard', modeSelectionEnabled: false })))
      .toEqual({ research: 'research' })
    // A saved field that is not a preset id replaces nothing.
    expect(presetDefaults(scope({ default: 7 }))).toEqual({ research: 'research' })
  })

  it('knows nothing before the namespace is read, where it is not exposed, or without a composition default', () => {
    expect(presetDefaults({ ...scope(undefined), status: 'loading' })).toBeNull()
    expect(presetDefaults({ ...scope(undefined), status: 'unavailable' })).toBeNull()
    expect(presetDefaults({ status: 'ready', base: undefined, user: undefined, value: undefined })).toBeNull()
    expect(presetDefaults(scope(undefined, null, null))).toBeNull()
    expect(presetDefaults(scope(undefined, {}, { modeSelectionEnabled: true }))).toBeNull()
  })
})
