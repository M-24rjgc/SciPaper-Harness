// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelListEditor, type ModelDraft } from '../src/client/ModelListEditor.tsx'
import { validateDeepSeekModels } from '../src/client/DeepSeekModelsEditor.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

it('configures custom model levels and wire names, preserves hidden fields, and can restore inheritance', () => {
  let saved: readonly ModelDraft[] = []
  function Editor() {
    const [models, setModels] = useState<ModelDraft[]>([{ id: 'custom-model', compat: { supportsDeveloperRole: false } }])
    return <ModelListEditor models={models} onChange={(next) => { saved = next; setModels(next) }}
      probe={{ settingsNs: 'llm-pi-ai', baseURL: 'https://example.test/v1' }}
      disabled={false} t={key => en[key]} onBusyChange={() => {}}
      operations={{ discoverModels: vi.fn(), describeCredential: vi.fn(), storeCredential: vi.fn(),
        removeCredential: vi.fn(), writeSettings: vi.fn() }}
    />
  }
  render(<Editor />)
  // The mode line is visible on the row itself, with the hint a catalog-less model needs.
  expect(screen.getByText(en.reasoningInheritHint)).toBeTruthy()
  const mode =screen.getByRole('combobox', { name: `${en.modelReasoning} 1` })
  fireEvent.change(mode, { target: { value: 'custom' } })
  fireEvent.click(screen.getByRole('checkbox', { name: en.reasoningLow }))
  fireEvent.click(screen.getByRole('checkbox', { name: en.reasoningMedium }))
  fireEvent.click(screen.getByRole('checkbox', { name: en.reasoningMax }))
  fireEvent.change(screen.getByLabelText(`${en.reasoningWireValue} ${en.reasoningMax} 1`), { target: { value: 'ultra' } })
  fireEvent.click(screen.getByRole('checkbox', { name: en.reasoningOff }))
  expect(saved).toEqual([{ id: 'custom-model', compat: { supportsDeveloperRole: false }, reasoningEfforts: { off: null, high: 'high', max: 'ultra' } }])
  expect(validateDeepSeekModels(saved)).toBeUndefined()
  fireEvent.change(screen.getByLabelText(`${en.reasoningWireValue} ${en.reasoningMax} 1`), { target: { value: '' } })
  expect(validateDeepSeekModels(saved)?.key).toBe('modelReasoningInvalid')
  fireEvent.change(mode, { target: { value: 'disabled' } })
  expect(saved[0]?.['reasoningEfforts']).toBe(false)
  fireEvent.change(mode, { target: { value: 'inherit' } })
  expect(saved).toEqual([{ id: 'custom-model', compat: { supportsDeveloperRole: false } }])
})

it('offers one-click level sets that keep API values already renamed', () => {
  let saved: readonly ModelDraft[] = []
  function Editor() {
    const [models, setModels] = useState<ModelDraft[]>([{ id: 'gateway-model' }])
    return <ModelListEditor models={models} onChange={(next) => { saved = next; setModels(next) }}
      probe={{ settingsNs: 'llm-pi-ai', baseURL: 'https://example.test/v1' }}
      disabled={false} t={key => en[key]} onBusyChange={() => {}}
      operations={{ discoverModels: vi.fn(), describeCredential: vi.fn(), storeCredential: vi.fn(),
        removeCredential: vi.fn(), writeSettings: vi.fn() }}
    />
  }
  render(<Editor />)
  fireEvent.change(screen.getByRole('combobox', { name: `${en.modelReasoning} 1` }), { target: { value: 'custom' } })
  const group = screen.getByRole('group', { name: `${en.reasoningPresets} 1` })
  expect(group).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: en.reasoningPresetFull }))
  expect(saved[0]?.['reasoningEfforts']).toEqual({
    off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  })

  // Off may name a value ("none") or go back to omitting the parameter.
  const offValue = screen.getByLabelText(`${en.reasoningWireValue} ${en.reasoningOff} 1`)
  fireEvent.change(offValue, { target: { value: 'none' } })
  expect(saved[0]?.['reasoningEfforts']).toMatchObject({ off: 'none' })
  fireEvent.change(offValue, { target: { value: '' } })
  expect(saved[0]?.['reasoningEfforts']).toMatchObject({ off: null })

  fireEvent.change(screen.getByLabelText(`${en.reasoningWireValue} ${en.reasoningXhigh} 1`), { target: { value: 'very-high' } })
  fireEvent.click(screen.getByRole('button', { name: en.reasoningPresetExtended }))
  expect(saved[0]?.['reasoningEfforts']).toEqual({ low: 'low', medium: 'medium', high: 'high', xhigh: 'very-high' })

  fireEvent.click(screen.getByRole('button', { name: en.reasoningPresetStandard }))
  expect(saved[0]?.['reasoningEfforts']).toEqual({ low: 'low', medium: 'medium', high: 'high' })
  expect(validateDeepSeekModels(saved)).toBeUndefined()
})

it.each([{}, { off: null }, { high: ' ' }, { medium: null }, { unknown: 'high' }, null, ['high'], 'high', true])('refuses unusable level declarations %j', (reasoningEfforts) => {
  expect(validateDeepSeekModels([{ id: 'model', reasoningEfforts }])?.key).toBe('modelReasoningInvalid')
})
