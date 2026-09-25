/**
 * The research record beside the conversation: the autonomy the person chose,
 * where the paper stands (the host's `standing`, derived from the checks the
 * assistant ran), what was decided, what the project holds, and its tools. It
 * reports; the assistant sets the mode and runs the checks, so nothing here
 * starts work. The only thing it changes is the autonomy, which is the
 * person's. Every caption is the mode pack's or this package's own copy, never
 * text written for the model.
 */
import type { ReactNode } from 'react'
import type { Autonomy, PhaseState, ResearchProject, ResearchStanding, StandingIssues } from '@deepseek-ai/dsh-research-workbench/types'
import { useModes, useSessionProject, type SessionSeatProps, type WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import { ResearchHeroMark } from './Hero.tsx'
import { checkedText, modePhases, packText } from './format.ts'
import type { ResearchKey } from './locales.ts'
import styles from './Rail.module.css'

/** Runs that still occupy a supervisor, and therefore may still be moving. */
const OPEN_RUN_STATUS = ['queued', 'running', 'unknown']
/** The phase id both mode packs give their experiments; its presence on the route is what makes runs expected. */
const EXPERIMENTS_PHASE = 'experiments'
/** Groups of open issues listed; the rest wait for the next check or the conversation. */
const VISIBLE_ISSUE_GROUPS = 3
const VISIBLE_DECISIONS = 5
/** What a phase's mark says to a screen reader. */
const PHASE_STATE_KEYS: Record<PhaseState, ResearchKey> = {
  done: 'phaseDone', current: 'phaseCurrent', pending: 'phasePending', deferred: 'phaseDeferred',
}
const PHASE_MARKS: Record<Exclude<PhaseState, 'done'>, string | undefined> = {
  current: styles.markCurrent, pending: styles.markPending, deferred: styles.markDeferred,
}
/** The access preset automatic autonomy runs under, and the one checkpoints return to. */
const AUTONOMY_PRESET: Record<Autonomy, string> = { automatic: 'research-auto', checkpoints: 'workspace-write' }

/** A project's status block, and the session its commands run in (none from outside a conversation). */
type RailProps = WorkbenchProps & { project: ResearchProject; commandSession: string | undefined }

/** Chip title of the research tab. */
export function ResearchRailTitle(props: { t: WorkbenchProps['t'] }): ReactNode {
  return <span className={styles.chip}><ResearchHeroMark size={14} />{props.t('railTitle')}</span>
}

/** The project's autonomy, the one setting a person changes here. */
function AutonomyField(props: RailProps): ReactNode {
  const { project, t, commandSession } = props
  const change = useAction()
  const choose = (autonomy: Autonomy): void => {
    change.start(async () => {
      await props.run({ action: 'set-autonomy', projectId: project.id, autonomy })
      // The access preset follows the autonomy, and stays visible (and overridable) in the composer's own picker.
      if (commandSession !== undefined) await props.command(commandSession, `/permission ${AUTONOMY_PRESET[autonomy]}`)
    })
  }
  return <section className={styles.controls}>
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{t('autonomy')}</span>
      <select
        className={styles.select}
        value={project.autonomy}
        disabled={change.pending || project.example === true}
        onChange={(event) => { choose(event.target.value as Autonomy) }}
      >
        <option value="checkpoints">{t('autonomyCheckpoints')}</option>
        <option value="automatic">{t('autonomyAutomatic')}</option>
      </select>
    </label>
    <ActionError t={t} error={change.error} />
  </section>
}

/** Who a decision is shown as coming from: in an example the person's answers were the example's author's, not the reader's. */
function decisionAuthor(project: ResearchProject, by: 'user' | 'agent'): 'decisionByUser' | 'decisionByAgent' | 'exampleAuthor' {
  if (by === 'agent') return 'decisionByAgent'
  return project.example === true ? 'exampleAuthor' : 'decisionByUser'
}

/** One phase's mark: a check for done, a ring on the current phase, hollow for the rest. */
function PhaseMark(props: { state: PhaseState; t: WorkbenchProps['t'] }): ReactNode {
  const label = props.t(PHASE_STATE_KEYS[props.state])
  if (props.state === 'done') {
    return <svg className={styles.markDone} role="img" aria-label={label} viewBox="0 0 12 12"><path d="M2.5 6.4 5 8.8 9.5 3.4" /></svg>
  }
  return <span className={PHASE_MARKS[props.state]} role="img" aria-label={label}></span>
}

/** When the last check ran and whether a file changed after it; before any check, that there was none. */
function CheckedLine(props: { standing: ResearchStanding; t: WorkbenchProps['t'] }): ReactNode {
  const { standing, t } = props
  if (standing.checkedAt === undefined) return <p className={styles.note}>{t('checkNever')}</p>
  return <p className={styles.note}>
    {checkedText(standing.checkedAt, Date.now(), t)}
    {standing.changedSinceCheck === true && <span className={styles.changed}> · {t('changedSinceCheck')}</span>}
  </p>
}

/** The mode's phases as the host reads them from the stored progress, the current one with what it lacks. */
function Phases(props: RailProps): ReactNode {
  const { project, t } = props
  const standing = project.standing
  if (standing === undefined || standing.phases.length === 0) return null
  return <section className={styles.phases}>
    <ol className={styles.spine}>
      {standing.phases.map(phase => <li key={phase.id} className={styles.stage}>
        <PhaseMark state={phase.state} t={t} />
        <span className={styles.stageBody}>
          <span className={phase.state === 'done' || phase.state === 'current' ? styles.stageName : `${styles.stageName} ${styles.stageNamePending}`}>
            {packText(phase.label, t)}
            {phase.state === 'deferred' && <span className={styles.deferred}>{t('phaseDeferred')}</span>}
          </span>
          {phase.state === 'current' && standing.hint !== undefined && <span className={styles.caption}>{packText(standing.hint, t)}</span>}
          {phase.checkpoint && <span className={styles.caption}>{t('phaseCheckpoint')}</span>}
        </span>
      </li>)}
    </ol>
    <CheckedLine standing={standing} t={t} />
  </section>
}

/** One check's issues, named in the reader's language: `引用 · 2 个错误`. */
function issueName(group: StandingIssues, t: WorkbenchProps['t']): string {
  const count = (n: number, one: ResearchKey, many: ResearchKey): string[] => n === 0 ? [] : [n === 1 ? t(one) : t(many, { n })]
  const counts = [...count(group.errors, 'issueOneError', 'checkErrors'), ...count(group.warnings, 'issueOneWarning', 'checkWarnings')]
  return [packText(group.label, t), ...counts].join(' · ')
}

/**
 * What the latest checks found, in at most three groups. A group opens its
 * file only while the file exists; the checks' own words stay behind Details.
 */
function Issues(props: RailProps): ReactNode {
  const { project, t } = props
  const opening = useAction()
  const standing = project.standing
  if (standing?.checkedAt === undefined) return null
  const groups = standing.issues.slice(0, VISIBLE_ISSUE_GROUPS)
  return <section className={styles.block}>
    <div className={styles.blockHead}>{t('issuesTitle')}</div>
    {groups.length === 0 && <p className={styles.note}>{t('issuesNone')}</p>}
    {groups.map((group) => {
      const name = issueName(group, t)
      const file = group.file
      return <div key={group.check} className={styles.issue}>
        {file === undefined
          ? <span className={styles.issueName}>{name}</span>
          : <button type="button" className={styles.issueOpen} title={t('issueOpenFile', { file })} onClick={() => { opening.start(() => { props.openFile(project.root, file) }) }}>{name}</button>}
        <details className={styles.details}>
          <summary className={styles.detailsToggle}>{t('issueDetails')}</summary>
          {group.findings.map((finding, index) => <p key={index} className={styles.findingText}>
            {finding.message}
            {finding.file !== undefined && <span className={styles.where}> {finding.file}{finding.line === undefined ? '' : `:${finding.line}`}</span>}
          </p>)}
        </details>
      </div>
    })}
    {standing.phases.length === 0 && <CheckedLine standing={standing} t={t} />}
    <ActionError t={t} error={opening.error} />
  </section>
}

/** Decisions settled so far — the user's answers at checkpoints and the assistant's own calls. */
function Decisions(props: RailProps): ReactNode {
  const { project, t } = props
  return <section className={styles.block}>
    <div className={styles.blockHead}>{t('decisions')}</div>
    {project.decisions.length === 0 && <p className={styles.note}>{t('noDecisions')}</p>}
    {project.decisions.slice(-VISIBLE_DECISIONS).reverse().map(decision => <div key={decision.id} className={styles.decision}>
      <span className={styles.caption}>{t(decisionAuthor(project, decision.by))} · {decision.question}</span>
      <span className={styles.blockBody}>{decision.answer}</span>
      {decision.rationale !== '' && <span className={styles.note}>{decision.rationale}</span>}
    </div>)}
  </section>
}

/** What one counted row shows, and what opening it does. */
interface CountRowProps {
  label: string
  value: string
  badge?: ReactNode
  onOpen: () => void
}

function CountRow(props: CountRowProps): ReactNode {
  return <button type="button" className={styles.countRowOpen} title={props.label} onClick={props.onOpen}>
    <span className={styles.countLabel}>{props.label}</span>
    {props.badge}
    <span className={styles.countValue}>{props.value}</span>
  </button>
}

/** The project's secondary tools: the experiment board, the figure gallery and the research folder's files. */
function Tools(props: RailProps): ReactNode {
  const { project, t } = props
  const opening = useAction()
  return <section className={styles.tools}>
    <div className={styles.toolRow}>
      <button type="button" className={styles.tool} onClick={() => { props.expand(project.id, 'experiments') }}>{t('boardTitle')}</button>
      <button type="button" className={styles.tool} onClick={() => { props.expand(project.id, 'gallery') }}>{t('gallery')}</button>
      <button type="button" className={styles.tool} onClick={() => { opening.start(() => { props.openFiles() }) }}>{t('researchFiles')}</button>
    </div>
    <ActionError t={t} error={opening.error} />
  </section>
}

/**
 * How a project is run and where it stands: autonomy, phases, open issues and
 * decisions. The rail shows it beside a conversation; the full workbench shows
 * it from outside one.
 */
export function ProjectStatus(props: RailProps): ReactNode {
  return <>
    <AutonomyField {...props} />
    <Phases {...props} />
    <Issues {...props} />
    <Decisions {...props} />
  </>
}

/** The research tab body. */
export function ResearchRail(props: WorkbenchProps & SessionSeatProps): ReactNode {
  const { t } = props
  const project = useSessionProject(props)
  const modes = useModes(props)
  if (!project) {
    return <div className={styles.root}><p className={styles.empty}>{t('railNoProject')}</p></div>
  }
  const stale = project.evidence.filter(item => item.stale).length
  const openRuns = project.experiments.filter(run => OPEN_RUN_STATUS.includes(run.status)).length
  // Runs are part of the record only on a route with an experiments phase, or once one exists.
  const runsExpected = project.experiments.length > 0 || modePhases(modes, project).includes(EXPERIMENTS_PHASE)
  const status = { ...props, project, commandSession: props.sessionId }
  return <div className={styles.root}>
    <div className={styles.header}><span className={styles.title}>{project.title}</span></div>
    {project.example === true && <p className={styles.exampleBanner}>{t('exampleBanner')}</p>}
    <ProjectStatus {...status} />
    <div className={styles.counts}>
      <CountRow
        label={t('railSourcesLabel')}
        value={String(project.evidence.length)}
        onOpen={() => { props.expand(project.id, 'sources') }}
        {...(stale > 0 ? { badge: <span className={styles.staleTag}>{t('railStaleCount', { n: stale })}</span> } : {})}
      />
      <CountRow label={t('claims')} value={String(project.claims.length)} onOpen={() => { props.expand(project.id, 'claims') }} />
      <CountRow label={t('artifacts')} value={String(project.artifacts.length)} onOpen={() => { props.expand(project.id, 'artifacts') }} />
      {runsExpected && <CountRow
        label={t('railExperimentsLabel')}
        value={project.experiments.length === 0 ? t('railNotStarted') : String(project.experiments.length)}
        onOpen={() => { props.expand(project.id, 'experiments') }}
        {...(openRuns > 0 ? { badge: <span className={styles.runningTag}>{t('runRunning')}</span> } : {})}
      />}
    </div>
    <Tools {...status} />
  </div>
}
