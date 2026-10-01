/**
 * 记忆 (Memory): the researches on this computer, the literature, finished experiments, environments and venue
 * templates each left, and a switch per kind for what the next research carries. The host sends what the records hold;
 * the layout and every sentence are derived here (`memoryValues.ts`). Selecting a research lights its lines and its
 * items. Nothing is drawn that a record does not hold.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Switch, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryKind, ProjectId, ResearchMemoryPage, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import {
  CHIP_HEIGHT, KINDS, LESSONS_SHOWN, NEXT_HEIGHT, RESEARCH_HEIGHT, chipKind, kindTitle, lessonText, memoryLayout, nextMeta, researchMeta,
  switchDetail, type MemoryLayout,
} from './memoryValues.ts'
import styles from './MemoryView.module.css'

/** A component-local length handed to the stylesheet; the stylesheet turns it into a position or a size. */
function lengths(values: Record<`--mv-${string}`, number>): CSSProperties {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [name, `${value}px`]))
}

/** One line of a gutter, from a height on its left edge to a height on its right. */
interface GutterLine {
  key: string
  /** `source` joins an item to the research it came from; `carry` joins a carried item to the next research. */
  kind: 'source' | 'carry'
  active: boolean
  from: number
  to: number
}

/** One gutter between two columns: the lines of the layout as curves. */
function Gutter(props: { height: number; lines: readonly GutterLine[] }): ReactNode {
  // Lit lines are drawn last so they cross over the dim ones.
  const ordered = [...props.lines].sort((a, b) => Number(a.active) - Number(b.active))
  return <svg className={styles.gutter} viewBox={`0 0 100 ${props.height}`} preserveAspectRatio="none" aria-hidden="true">
    {ordered.map(line => <path key={line.key} className={styles.line} data-kind={line.kind} data-active={line.active}
      d={`M0,${line.from} C50,${line.from} 50,${line.to} 100,${line.to}`} />)}
  </svg>
}

/** The graph: researches on the left, what they left in the middle, the next research on the right. */
function Graph(props: WorkbenchProps & {
  page: ResearchMemoryPage
  layout: MemoryLayout
  current: ProjectId
  chosen: ProjectId | undefined
  choose: (id: ProjectId) => void
}): ReactNode {
  const { page, layout, chosen, t } = props
  const lit = new Set(layout.chips.filter(chip => chosen !== undefined && chip.researches.includes(chosen)).map(chip => chip.id))
  return <div className={styles.columns} style={lengths({
    '--mv-height': layout.height, '--mv-research-height': RESEARCH_HEIGHT, '--mv-chip-height': CHIP_HEIGHT, '--mv-next-height': NEXT_HEIGHT,
  })}>
    <ol className={styles.column} data-heading={t('memColumnResearches')} aria-label={t('memColumnResearches')}>
      {layout.researches.map(({ research, top }) => <li key={research.id} className={styles.node} style={lengths({ '--mv-top': top })}>
        <button type="button" className={styles.research} data-finished={research.finished} data-current={research.id === props.current}
          aria-pressed={research.id === chosen} title={research.title} onClick={() => { props.choose(research.id) }}>
          <span className={styles.kicker}>
            <span className={styles.dot} aria-hidden="true" />
            <span className={styles.state}>{t(research.finished ? 'memFinished' : 'memWorking')}</span>
            {research.id === props.current && <span className={styles.where}>· {t('memCurrent')}</span>}
          </span>
          <span className={styles.researchTitle}>{research.title}</span>
          {researchMeta(research, t) !== '' && <span className={styles.researchMeta}>{researchMeta(research, t)}</span>}
        </button>
      </li>)}
    </ol>
    <Gutter height={layout.height} lines={layout.sourceEdges.map(edge => ({
      key: `${edge.researchId}:${edge.chipId}`, kind: 'source', active: edge.researchId === chosen, from: edge.from, to: edge.to,
    }))} />
    <ul className={styles.column} data-heading={t('memColumnItems')} aria-label={t('memColumnItems')}>
      {layout.chips.map(chip => <li key={chip.id} className={styles.node} style={lengths({ '--mv-top': chip.top })}>
        <div className={styles.chip} data-kind={chip.kind} data-carried={chip.carried} data-linked={lit.has(chip.id)} title={chip.title}>
          <span className={styles.chipKind}>{chipKind(chip.kind, t)}</span>
          <span className={styles.chipLabel}>{chip.label}</span>
        </div>
      </li>)}
    </ul>
    <Gutter height={layout.height} lines={layout.carryEdges.map(edge => ({
      key: edge.chipId, kind: 'carry', active: lit.has(edge.chipId), from: edge.from, to: edge.to,
    }))} />
    <div className={styles.column} data-heading={t('memColumnNext')}>
      <div className={styles.next} style={lengths({ '--mv-top': layout.next.top })}>
        <span className={styles.nextKicker}>{t('memNextKicker')}</span>
        <span className={styles.nextTitle}>{t('memNextTitle')}</span>
        <span className={styles.nextMeta}>{nextMeta(page, t)}</span>
      </div>
    </div>
  </div>
}

/** The switches for what the next research carries, the recorded lessons and the way to start that research. */
function Panel(props: WorkbenchProps & {
  page: ResearchMemoryPage
  flip: (kind: MemoryKind, on: boolean) => void
  pending: boolean
  error: string
}): ReactNode {
  const { page, t } = props
  const shown = page.lessons.items.slice(0, LESSONS_SHOWN)
  return <aside className={styles.aside} aria-label={t('memGraph')}>
    <section className={styles.card}>
      <h4 className={styles.cardTitle}>{t('memCarryHead')}</h4>
      <p className={styles.hint}>{t('memCarryNote')}</p>
      <ul className={styles.switches}>
        {KINDS.map(kind => <li key={kind} className={styles.switchRow}>
          <Switch checked={page.carry[kind]} label={kindTitle(kind, t)} disabled={props.pending}
            onChange={(on) => { props.flip(kind, on) }} />
          <div className={styles.switchText}>
            <span className={styles.switchTitle}>{kindTitle(kind, t)}</span>
            <span className={styles.hint}>{switchDetail(kind, page, t)}</span>
          </div>
        </li>)}
      </ul>
      <ActionError t={t} error={props.error} />
    </section>
    {shown.length > 0 && <section className={styles.lessons}>
      <h4 className={styles.lessonsTitle}>{t('memLessonsHead')}</h4>
      {shown.map((lesson, index) => {
        const text = lessonText(lesson, page, t)
        return <div key={`${lesson.research}:${lesson.at}:${index}`} className={styles.lesson} data-kind={text.kind}>
          <p className={styles.lessonText}>{text.text}</p>
          {text.why !== '' && <p className={styles.hint}>{text.why}</p>}
          <p className={styles.hint}>{text.from}</p>
        </div>
      })}
      {page.lessons.total > shown.length && <p className={styles.hint}>{t('memLessonsMore', { n: page.lessons.total - shown.length })}</p>}
    </section>}
    <div className={styles.actions}>
      <button type="button" className={styles.primary} onClick={() => { props.startNew() }}>{t('memStartNew')}</button>
    </div>
  </aside>
}

/**
 * The view of the memory the researches on this computer leave. It asks the host again whenever the current research's record changes.
 * @param props - the research face and the research the Knowledge tab is open on; the owner keys it by research.
 * @returns the headline, the graph and the panel of switches, or a line saying why there is nothing to show.
 */
export function MemoryView(props: WorkbenchProps & { project: ResearchProject }): ReactNode {
  const { project, t } = props
  const [page, setPage] = useState<ResearchMemoryPage | null>(null)
  const [error, setError] = useState('')
  const [chosen, setChosen] = useState<ProjectId | undefined>()
  const latest = useRef(0)
  const switching = useAction()
  useEffect(() => {
    const ticket = ++latest.current
    props.run({ action: 'memory', projectId: project.id }).then((result) => {
      if (ticket !== latest.current) return
      if (!result.memory) throw new Error(t('kgNoResponse'))
      setPage(result.memory)
      setError('')
    }).catch((reason: unknown) => {
      if (ticket === latest.current) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { latest.current++ }
  }, [project.id, project.revision])
  const flip = (kind: MemoryKind, on: boolean): void => {
    switching.start(async () => {
      const result = await props.run({ action: 'memory-carry', projectId: project.id, kind, on })
      if (!result.memory) throw new Error(t('kgNoResponse'))
      // An earlier read that is still on its way would put the old switches back.
      latest.current++
      setPage(result.memory)
    })
  }
  const layout = page === null ? undefined : memoryLayout(page, t)
  return <section className={styles.view} data-memory-view aria-busy={page === null && error === ''}>
    <ActionError t={t} error={error} />
    {page === null && error === '' && <p role="status" className={styles.note}>{t('kgLoading')}</p>}
    {page !== null && layout !== undefined && <>
      <div className={styles.strip}>
        <p className={styles.headline}>{t('memHeadline')}</p>
        <Tag tone="quiet"><span className={styles.lock}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          {t('memLock')}
        </span></Tag>
      </div>
      {page.researches.length === 0 && <p className={styles.note}>{t('memEmpty')}</p>}
      {page.researches.length > 0 && <>
        <p className={styles.caption}>{t('memCaption')}</p>
        {page.researches.length === 1 && <p className={styles.caption}>{t('memSingle')}</p>}
        {layout.chips.length === 0 && <p className={styles.caption}>{t('memNothing')}</p>}
        <div className={styles.body}>
          <div className={styles.graph} role="group" aria-label={t('memGraph')}>
            <Graph {...props} page={page} layout={layout} current={project.id} chosen={chosen}
              choose={(id) => { setChosen(selected => selected === id ? undefined : id) }} />
          </div>
          <Panel {...props} page={page} flip={flip} pending={switching.pending} error={switching.error} />
        </div>
      </>}
    </>}
  </section>
}
