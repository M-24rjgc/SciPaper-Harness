/**
 * The form field that chooses a new project's mode and route, shared by both
 * creation forms. Its options come from the installed mode packs, so a new pack
 * appears here without a code change. After creation the mode is the
 * assistant's to set; no control here changes it.
 */
import type { ReactNode } from 'react'
import type { ModeSummary } from '@deepseek-ai/dsh-research-workbench/types'
import { modeChoice, packText, type Translate } from './format.ts'

/** Where the field gets its options, and its name and first value in the form. */
interface ModeSelectProps {
  modes: readonly ModeSummary[]
  t: Translate
  /** Form field name; `chosenMode` reads the submitted value. */
  name: string
  defaultValue: string
}

/** One option per mode without routes, one per route (grouped under its mode) otherwise. */
export function ModeSelect(props: ModeSelectProps): ReactNode {
  const { modes, t } = props
  return <select name={props.name} defaultValue={props.defaultValue}>
    {modes.map(mode => mode.routes.length === 0
      ? <option key={mode.id} value={mode.id} title={packText(mode.summary, t)}>{packText(mode.name, t)}</option>
      : <optgroup key={mode.id} label={packText(mode.name, t)}>
        {mode.routes.map(route => <option key={route.id} value={modeChoice(mode.id, route.id)} title={packText(route.summary, t)}>
          {packText(mode.name, t)} · {packText(route.name, t)}
        </option>)}
      </optgroup>)}
  </select>
}
