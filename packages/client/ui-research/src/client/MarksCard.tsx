/**
 * 你的标注 (Your marks): every mark the research holds on the knowledge graph, each with a way to take it off, and
 * the person's switch that tells the agent to follow the marks or to rank by the graph alone. The 对话 view adds the
 * relations the person recorded beside the marks, and its own sentences about what following means.
 */
import type { ReactNode } from 'react'
import type { KnowledgeMarkView } from '@deepseek-ai/dsh-research-workbench/types'
import type { Translate } from './format.ts'
import { clipped } from './mapValues.ts'
import styles from './KnowledgeMap.module.css'

/** A relation the person recorded, listed with the marks. */
export interface MarksCardRelation {
  id: string
  /** The relation read between its ends: `A —对比→ B`. */
  sentence: string
}

/** What the card shows and the two things it can do. */
export interface MarksCardProps {
  t: Translate
  marks: readonly KnowledgeMarkView[]
  /** Whether the agent follows the marks. */
  honour: boolean
  /** A change is under way; the card waits for the host's answer. */
  pending: boolean
  /** An example research can be looked at, not changed. */
  readOnly: boolean
  /** Take one mark off. */
  undo: (mark: KnowledgeMarkView) => void
  /** Turn the agent's following of the marks on or off. */
  setHonour: (honour: boolean) => void
  /** Relations the person recorded, counted and listed with the marks. */
  relations?: readonly MarksCardRelation[] | undefined
  /** Take one relation off; absent where the relation graph is off. */
  undoRelation?: ((relation: MarksCardRelation) => void) | undefined
  /** The sentence under the card, when the owner words what following means itself. */
  notes?: { on: string; off: string } | undefined
}

const VERDICT_KEYS = { pin: 'kmTagPin', irrelevant: 'kmTagIrrelevant' } as const

/**
 * The card of the research's marks.
 * @param props - the marks, the switch and what the person can do.
 * @returns the card, or nothing while the research holds no mark.
 */
export function MarksCard(props: MarksCardProps): ReactNode {
  const { t, marks, honour } = props
  const relations = props.relations ?? []
  if (marks.length + relations.length === 0) return null
  const locked = props.pending || props.readOnly
  return <section className={styles.card} data-map-marks>
    <div className={styles.cardHead}>
      <h4 className={styles.cardTitle}>{t('kmMarksTitle', { n: marks.length + relations.length })}</h4>
      <button type="button" role="switch" className={styles.switch} aria-checked={honour} disabled={locked}
        title={props.readOnly ? t('kmExampleReadOnly') : undefined} onClick={() => { props.setHonour(!honour) }}>
        <span className={styles.knob} aria-hidden="true" />{t('kmHonour')}
      </button>
    </div>
    <ul className={styles.markList}>
      {marks.map(mark => <li key={mark.id} className={styles.markRow} data-verdict={mark.verdict} data-paused={!honour}>
        <span className={styles.tag} data-verdict={mark.verdict}>{t(VERDICT_KEYS[mark.verdict])}</span>
        <span className={styles.markText}>
          <span className={styles.markName} title={mark.title ?? mark.target.id}>{mark.title ?? mark.target.id}</span>
          {mark.note !== undefined && <span className={styles.markNote}>{t('kmMarkNote', { note: clipped(mark.note, 80) })}</span>}
          {mark.by === 'agent' && <span className={styles.markNote}>{t('kmMarkByAgent')}</span>}
        </span>
        <button type="button" className={styles.undo} disabled={locked} onClick={() => { props.undo(mark) }}>{t('kmUndo')}</button>
      </li>)}
      {relations.map(relation => <li key={relation.id} className={styles.markRow} data-verdict="relation" data-paused={!honour}>
        <span className={styles.tag} data-verdict="relation">{t('kfTagRelation')}</span>
        <span className={styles.markText}><span className={styles.markName} title={relation.sentence}>{relation.sentence}</span></span>
        {props.undoRelation !== undefined && <button type="button" className={styles.undo} disabled={locked}
          onClick={() => { props.undoRelation?.(relation) }}>{t('kmUndo')}</button>}
      </li>)}
    </ul>
    <p className={styles.meta}>{props.notes === undefined ? t(honour ? 'kmHonourOn' : 'kmHonourOff') : honour ? props.notes.on : props.notes.off}</p>
  </section>
}
