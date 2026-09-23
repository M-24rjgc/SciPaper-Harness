/**
 * The research record beside the conversation: how the project is run (mode and
 * autonomy), where the paper stands by its last check, what was decided, and
 * what the project holds. It starts nothing on its own; the two actions it
 * offers are a check and handing the pipeline to the assistant as a goal.
 */
import type { ReactNode } from 'react'
import type { Autonomy, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { useModes, useSessionProject, type SessionSeatProps, type WorkbenchProps } from './contract.ts'
import { ResearchHeroMark } from './Hero.tsx'
import { modeChoice, modeName, modePhases, parseModeChoice, phaseName } from './format.ts'
import { ModeSelect } from './ModeSelect.tsx'
import styles from './Rail.module.css'

/** Runs that still occupy a supervisor, and therefore may still be moving. */
const OPEN_RUN_STATUS = ['queued', 'running', 'unknown']
/** Open errors listed before the rest collapse into the count. */
const VISIBLE_FINDINGS = 5
const VISIBLE_DECISIONS = 5
/** The access preset automatic autonomy runs under, and the one checkpoints return to. */
const AUTONOMY_PRESET: Record<Autonomy, string> = { automatic: 'research-auto', checkpoints: 'workspace-write' }

/** A project's status block, and the session its commands run in (none from outside a conversation). */
type RailProps = WorkbenchProps & { project: ResearchProject; commandSession: string | undefined }

/** Chip title of the research tab. */
export function ResearchRailTitle(props: { t: WorkbenchProps['t'] }): ReactNode {
  return <span className={styles.chip}><ResearchHeroMark size={14} />{props.t('railTitle')}</span>
}

/** How the project is run: its mode and autonomy, and the two actions a person takes from here. */
function Controls(props: RailProps): ReactNode {
  const { project, t, commandSession } = props
  const quiet = (work: Promise<unknown>): void => { void work.catch(() => {}) }
  const setAutonomy = (autonomy: Autonomy): void => {
    // The access preset follows the autonomy, and stays visible (and overridable) in the composer's own picker.
    quiet(props.run({ action: 'set-autonomy', projectId: project.id, autonomy })
      .then(() => commandSession === undefined ? undefined : props.command(commandSession, `/permission ${AUTONOMY_PRESET[autonomy]}`)))
  }
  const modes = useModes(props)
  const pipeline = modePhases(modes, project).length > 0
  return <section className={styles.controls}>
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{t('mode')}</span>
      <ModeSelect
        className={styles.select}
        modes={modes}
        t={t}
        value={modeChoice(project.mode, project.route)}
        onChoose={(value) => { quiet(props.run({ action: 'set-mode', projectId: project.id, ...parseModeChoice(value) })) }}
      />
    </label>
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{t('autonomy')}</span>
      <select className={styles.select} value={project.autonomy} onChange={(event) => { setAutonomy(event.target.value as Autonomy) }}>
        <option value="checkpoints">{t('autonomyCheckpoints')}</option>
        <option value="automatic">{t('autonomyAutomatic')}</option>
      </select>
    </label>
    <div className={styles.buttons}>
      <button type="button" className={styles.button} onClick={() => { quiet(props.run({ action: 'check', projectId: project.id })) }}>{t('checkRun')}</button>
      {pipeline && commandSession !== undefined && <button
        type="button"
        className={styles.button}
        title={t('pipelineRunHelp')}
        onClick={() => { quiet(props.command(commandSession, `/goal ${t('goalObjective', { title: project.title, mode: modeName(modes, project.mode, t) })}`)) }}
      >{t('pipelineRun')}</button>}
    </div>
  </section>
}

/** The mode's phases as the last check left them, with what still stands in each one's way. */
function Phases(props: RailProps): ReactNode {
  const { project, t } = props
  const check = project.lastCheck
  const modes = useModes(props)
  if (modePhases(modes, project).length === 0) return null
  if (!check || check.mode !== project.mode || check.route !== project.route || check.phases.length === 0) {
    return <p className={styles.note}>{t('checkNever')}</p>
  }
  return <ol className={styles.spine}>
    {check.phases.map(phase => <li key={phase.id} className={styles.stage}>
      <span className={phase.done ? styles.dotDone : styles.dotPending}></span>
      <span className={styles.stageBody}>
        <span className={phase.done ? styles.stageName : `${styles.stageName} ${styles.stageNamePending}`}>{phaseName(modes, project.mode, phase.id, t)}</span>
        {phase.missing.slice(0, 2).map(line => <span key={line} className={styles.caption}>{line}</span>)}
      </span>
    </li>)}
  </ol>
}

/** The errors the last check reported, each opening the file it names. */
function Findings(props: RailProps): ReactNode {
  const { project, t } = props
  const check = project.lastCheck
  if (!check) return null
  const errors = check.findings.filter(finding => finding.severity === 'error')
  const warnings = check.findings.length - errors.length
  return <section className={styles.block}>
    <div className={styles.blockHead}>
      {check.clean ? t('checkClean') : t('findings')}
      <span className={styles.note}> {t('checkErrors', { n: errors.length })} · {t('checkWarnings', { n: warnings })}</span>
    </div>
    {errors.slice(0, VISIBLE_FINDINGS).map((finding, index) => {
      const where = finding.file === undefined ? '' : `${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}`
      const file = finding.file
      return <div key={index} className={styles.finding}>
        <span className={styles.findingText}>{finding.message}</span>
        {file !== undefined && <button type="button" className={styles.link} onClick={() => { props.openFile(project.root, file) }}>{where}</button>}
      </div>
    })}
  </section>
}

/** Decisions settled so far — the user's answers at checkpoints and the assistant's own calls. */
function Decisions(props: RailProps): ReactNode {
  const { project, t } = props
  return <section className={styles.block}>
    <div className={styles.blockHead}>{t('decisions')}</div>
    {project.decisions.length === 0 && <p className={styles.note}>{t('noDecisions')}</p>}
    {project.decisions.slice(-VISIBLE_DECISIONS).reverse().map(decision => <div key={decision.id} className={styles.decision}>
      <span className={styles.caption}>{t(decision.by === 'user' ? 'decisionByUser' : 'decisionByAgent')} · {decision.question}</span>
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

/** The environment runs use by default. */
function Environment(props: RailProps): ReactNode {
  const { project, t } = props
  const environment = project.environments.find(item => item.isDefault) ?? project.environments[0]
  if (!environment) return null
  return <section className={styles.block}>
    <div className={styles.blockHead}>{t('environment')}</div>
    <p className={styles.blockBody}>{environment.name} · {t(environment.target)} · {environment.python}</p>
    <p className={styles.note}>{t(environment.status)}</p>
  </section>
}

/**
 * How a project is run and where it stands: mode, autonomy, the check and
 * pipeline actions, phases, open errors and decisions. The rail shows it
 * beside a conversation; the full workbench shows it from outside one.
 */
export function ProjectStatus(props: RailProps): ReactNode {
  return <>
    <Controls {...props} />
    <Phases {...props} />
    <Findings {...props} />
    <Decisions {...props} />
  </>
}

/** The research tab body. */
export function ResearchRail(props: WorkbenchProps & SessionSeatProps): ReactNode {
  const { t } = props
  const project = useSessionProject(props)
  if (!project) {
    return <div className={styles.root}><p className={styles.empty}>{t('railNoProject')}</p></div>
  }
  const stale = project.evidence.filter(item => item.stale).length
  const openRuns = project.experiments.filter(run => OPEN_RUN_STATUS.includes(run.status)).length
  const status = { ...props, project, commandSession: props.sessionId }
  return <div className={styles.root}>
    <div className={styles.header}><span className={styles.title}>{project.title}</span></div>
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
      <CountRow
        label={t('railExperimentsLabel')}
        value={project.experiments.length === 0 ? t('railNotStarted') : String(project.experiments.length)}
        onOpen={() => { props.expand(project.id, 'experiments') }}
        {...(openRuns > 0 ? { badge: <span className={styles.runningTag}>{t('runRunning')}</span> } : {})}
      />
    </div>
    <Environment {...status} />
  </div>
}
