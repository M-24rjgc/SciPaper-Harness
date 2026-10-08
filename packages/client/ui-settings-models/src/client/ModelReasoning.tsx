/** Per-model reasoning capabilities for compatible provider endpoints. */
import type { ReactNode } from 'react'
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DeepSeekModelDraft } from './DeepSeekModelsEditor.tsx'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type Level = typeof LEVELS[number]
const LABELS = {
  off: 'reasoningOff', minimal: 'reasoningMinimal', low: 'reasoningLow',
  medium: 'reasoningMedium', high: 'reasoningHigh', xhigh: 'reasoningXhigh', max: 'reasoningMax',
} as const

/** One-click level sets, from the common trio to every level pi-ai can dispatch. */
const PRESETS: readonly { id: ModelsKey; levels: readonly Level[] }[] = [
  { id: 'reasoningPresetStandard', levels: ['low', 'medium', 'high'] },
  { id: 'reasoningPresetExtended', levels: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'reasoningPresetFull', levels: LEVELS },
]

/**
 * Validate declared levels before either provider editor writes the profile.
 * @param value - drafted model reasoning capability.
 * @returns whether the adapter can accept this declaration.
 */
export function validReasoningEfforts(value: unknown): boolean {
  if (value === undefined || value === false) return true
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return entries.some(([level]) => level !== 'off') && entries.every(([level, wire]) =>
    LEVELS.some(known => known === level)
    && ((level === 'off' && wire === null) || (typeof wire === 'string' && wire.trim().length > 0)))
}

/**
 * Edit supported reasoning levels without changing other model fields. The mode
 * line is always visible on the model row, because a model outside the built-in
 * catalog offers no reasoning menu until levels are declared here.
 * @param props - model draft, row identity, locale, and replacement callback.
 * @returns the capability mode and supported level controls.
 */
export function ModelReasoning({ model, position, disabled, t, onChange }: {
  model: DeepSeekModelDraft
  position: number
  disabled: boolean
  t: (key: ModelsKey) => string
  onChange: (model: DeepSeekModelDraft) => void
}): ReactNode {
  const value = model['reasoningEfforts']
  const mode = value === undefined ? 'inherit' : value === false ? 'disabled' : 'custom'
  const efforts: Record<string, unknown> = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : {}
  const replace = (next: false | Record<string, unknown> | undefined): void => {
    const row = { ...model }
    if (next === undefined) delete row['reasoningEfforts']
    else row['reasoningEfforts'] = next
    onChange(row)
  }
  /** Select exactly these levels, keeping any API value already renamed for a level that stays. */
  const choose = (levels: readonly Level[]): void => {
    const next: Record<string, unknown> = {}
    for (const level of levels) {
      next[level] = Object.hasOwn(efforts, level) ? efforts[level] : level === 'off' ? null : level
    }
    replace(next)
  }
  return (
    <fieldset className={styles['modelReasoning']}>
      <legend className={styles['modelFieldLabel']}>{t('modelReasoning')}</legend>
      <select
        className={`${styles['input']} ${styles['selectInput']}`} aria-label={`${t('modelReasoning')} ${String(position)}`}
        value={mode} disabled={disabled}
        onChange={(event) => {
          replace(event.target.value === 'inherit' ? undefined : event.target.value === 'disabled'
            ? false : { low: 'low', medium: 'medium', high: 'high' })
        }}
      >
        <option value="inherit">{t('reasoningInherit')}</option>
        <option value="disabled">{t('reasoningDisabled')}</option>
        <option value="custom">{t('reasoningCustom')}</option>
      </select>
      {mode === 'inherit' && <p className={styles['advancedHint']}>{t('reasoningInheritHint')}</p>}
      {mode === 'custom' && <>
        <p className={styles['advancedHint']}>{t('reasoningHint')}</p>
        <div className={styles['reasoningPresets']} role="group" aria-label={`${t('reasoningPresets')} ${String(position)}`}>
          <span className={styles['advancedHint']}>{t('reasoningPresets')}</span>
          {PRESETS.map(preset => (
            <button
              key={preset.id} type="button" className={styles['linkButton']} disabled={disabled}
              onClick={() => { choose(preset.levels) }}
            >
              {t(preset.id)}
            </button>
          ))}
        </div>
        {LEVELS.map(level => (
          <div key={level} className={styles['reasoningLevel']}>
            <Checkbox
              label={t(LABELS[level])} checked={Object.hasOwn(efforts, level)} disabled={disabled}
              onChange={(checked) => {
                const next = { ...efforts }
                if (checked) next[level] = level === 'off' ? null : level
                else Reflect.deleteProperty(next, level)
                replace(next)
              }}
            />
            {Object.hasOwn(efforts, level) && <input
              className={styles['input']} type="text" disabled={disabled}
              aria-label={`${t('reasoningWireValue')} ${t(LABELS[level])} ${String(position)}`}
              placeholder={level === 'off' ? t('reasoningOmit') : level}
              value={typeof efforts[level] === 'string' ? efforts[level] : ''}
              onChange={(event) => { replace({ ...efforts, [level]: level === 'off' && event.target.value === '' ? null : event.target.value }) }}
            />}
          </div>
        ))}
      </>}
    </fieldset>
  )
}
