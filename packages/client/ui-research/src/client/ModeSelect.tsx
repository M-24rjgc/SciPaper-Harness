/**
 * The one control that chooses a project's mode and route, shared by the rail
 * and both creation forms. Its options come from the installed mode packs, so
 * a new pack appears here without a code change.
 */
import type { ReactNode } from 'react'
import type { ModeSummary } from '@deepseek-ai/dsh-research-workbench/types'
import { modeChoice, packText, type Translate } from './format.ts'

/** Where the select gets its options and how its choice leaves it. */
interface ModeSelectProps {
  modes: readonly ModeSummary[]
  t: Translate
  className?: string | undefined
  /** Form field name, when the select sits in a form. */
  name?: string | undefined
  /** The current choice, for a controlled select. */
  value?: string | undefined
  /** The initial choice, for a form field. */
  defaultValue?: string | undefined
  /** Receives the chosen value, which `parseModeChoice` splits into mode and route. */
  onChoose?: ((value: string) => void) | undefined
}

/** One option per mode without routes, one per route (grouped under its mode) otherwise. */
export function ModeSelect(props: ModeSelectProps): ReactNode {
  const { modes, t, value } = props
  const choices = modes.flatMap(mode => mode.routes.length ? mode.routes.map(route => modeChoice(mode.id, route.id)) : [mode.id])
  return <select
    className={props.className}
    name={props.name}
    value={value}
    defaultValue={props.defaultValue}
    onChange={(event) => { props.onChoose?.(event.target.value) }}
  >
    {value !== undefined && !choices.includes(value) && <option value={value} disabled>{value}</option>}
    {modes.map(mode => mode.routes.length === 0
      ? <option key={mode.id} value={mode.id} title={packText(mode.summary, t)}>{packText(mode.name, t)}</option>
      : <optgroup key={mode.id} label={packText(mode.name, t)}>
        {mode.routes.map(route => <option key={route.id} value={modeChoice(mode.id, route.id)} title={packText(route.summary, t)}>
          {packText(mode.name, t)} · {packText(route.name, t)}
        </option>)}
      </optgroup>)}
  </select>
}
