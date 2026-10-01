/**
 * 本项目文献中的空白 (blanks in this project's literature): the methods against the tasks, datasets or settings the
 * research's own sources name, each cell shaded by how much those sources report. The matrix reads only the
 * project's imported sources and says so; it never says that nobody tested a pair or that the field has a gap.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { RelationGapCell, RelationGapPage } from '@deepseek-ai/dsh-research-workbench/types'
import { ActionError } from './Action.tsx'
import type { ResearchKey } from './locales.ts'
import { failure, type PanelProps } from './RelationsPanels.tsx'
import { coverageText, gapCounts, gapSentence, gapShort, gapTakeaway, statesIn } from './relationsValues.ts'
import styles from './RelationsView.module.css'

type Axis = RelationGapPage['axis']

const AXIS_KEYS: Record<Axis, ResearchKey> = { task: 'relationsAxisTask', dataset: 'relationsAxisDataset', setting: 'relationsAxisSetting' }
const AXES = Object.keys(AXIS_KEYS) as Axis[]

/**
 * The gap matrix card.
 * @param props - the cards' shared props.
 * @returns the card with its axis choice, grid, key and the line under it.
 */
export function GapCard(props: PanelProps): ReactNode {
  const { t, project } = props
  const [axis, setAxis] = useState<Axis>('task')
  const [page, setPage] = useState<RelationGapPage | undefined>()
  const [error, setError] = useState('')
  const latest = useRef(0)
  useEffect(() => {
    const ticket = ++latest.current
    props.run({ action: 'relations-gaps', projectId: project.id, axis }).then((response) => {
      if (ticket !== latest.current) return
      if (!response.relationGaps) throw new Error(t('kgNoResponse'))
      setPage(response.relationGaps); setError('')
    }).catch((reason: unknown) => { if (ticket === latest.current) setError(failure(reason)) })
    return () => { latest.current++ }
  }, [project.id, project.revision, props.tick, axis])
  const empty = page !== undefined && (page.rows.length === 0 || page.columns.length === 0)
  return <section className={styles.card} data-relations-gaps aria-busy={page === undefined && error === ''}>
    <div className={styles.cardHead}>
      <h4 className={styles.cardTitle}>{t('relationsGapHeading')}</h4>
      <span className={styles.meta}>{t('relationsGapSubtitle', { axis: t(AXIS_KEYS[axis]) })}</span>
    </div>
    <label className={styles.field}><span>{t('relationsGapAxis')}</span>
      <select value={axis} onChange={(event) => { setAxis(event.target.value as Axis) }}>
        {AXES.map(item => <option key={item} value={item}>{t(AXIS_KEYS[item])}</option>)}
      </select>
    </label>
    <ActionError t={t} error={error} />
    {page === undefined && error === '' && <p className={styles.line} role="status">{t('kgLoading')}</p>}
    {page !== undefined && <>
      {empty && <p className={styles.line}>{t('relationsGapNone')}</p>}
      {!empty && <>
        <div className={styles.matrix} data-relations-matrix>
          <table>
            <thead><tr>
              <th scope="col" />
              {page.columns.map(column => <th key={column.id} scope="col" title={column.name}>{column.name}</th>)}
            </tr></thead>
            <tbody>
              {page.rows.map((row, at) => <tr key={row.id}>
                <th scope="row" title={row.name}>{row.name}</th>
                {page.columns.map((column, to) => {
                  const cell = (page.cells[at] as RelationGapCell[])[to] as RelationGapCell
                  return <td key={column.id} data-state={cell.state} title={gapCounts(cell, t)} aria-label={`${row.name} × ${column.name}: ${gapSentence(cell.state, cell, t)}`}>
                    {gapShort(cell, t)}
                  </td>
                })}
              </tr>)}
            </tbody>
          </table>
        </div>
        <ul className={styles.gapKey}>
          {statesIn(page).map(state => <li key={state} data-state={state}>
            <span className={styles.swatch} data-state={state} aria-hidden="true" />{gapSentence(state, undefined, t)}
          </li>)}
        </ul>
        <p className={styles.takeaway}>{gapTakeaway(page, t)}</p>
      </>}
      <p className={styles.meta}>{coverageText(page.basis, t)}</p>
    </>}
  </section>
}
