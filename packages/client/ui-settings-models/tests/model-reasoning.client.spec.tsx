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
  fireEvent.click(screen.getByLabelText(`${en.modelAdvanced} 1`))
  const mode = screen.getByRole('combobox', { name: `${en.modelReasoning} 1` })
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

it.each([{}, { off: null }, { high: ' ' }, { medium: null }, { unknown: 'high' }])('refuses unusable level declarations %j', (reasoningEfforts) => {
  expect(validateDeepSeekModels([{ id: 'model', reasoningEfforts }])?.key).toBe('modelReasoningInvalid')
})
