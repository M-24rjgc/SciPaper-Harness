/**
 * 研究记录 (Research record), the research tab beside the conversation. From
 * top to bottom: the research and its folder; the mode as recorded, and the
 * autonomy; the 现在 (Now) line; the phases of the host's `standing` with
 * when they were checked; the open issues; the latest decisions; the counts;
 * and the secondary tools. It reports: the assistant sets the mode and runs
 * the checks, the autonomy is changed in the composer, and a suggested
 * sentence is only added to the composer's draft. Every caption is the mode
 * pack's or this package's own copy, never text written for the model.
 */
import { useMemo, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DecisionRecord, ModeSummary, PhaseState, ResearchProject, ResearchStanding, StandingIssues } from '@deepseek-ai/dsh-research-workbench/types'
import { useModes, useSessionProject, type WorkbenchProps } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import { ResearchHeroMark } from './Hero.tsx'
import { nowLine, researchActivity, type NowLine, type ResearchActivity } from './activity.ts'
import { appendedDraft, autonomyName, checkedText, counted, findingCounts, modeName, modePhases, packText, type Translate } from './format.ts'
import type { ResearchKey } from './locales.ts'
import { NoResearch, type ResearchTabProps } from './Tabs.tsx'
import styles from './Rail.module.css'

/** Runs that still occupy a supervisor, and therefore may still be moving. */
const OPEN_RUN_STATUS = ['queued', 'running', 'unknown']
/** The phase id both mode packs give their experiments; its presence on the route is what makes runs expected. */
const EXPERIMENTS_PHASE = 'experiments'
/** Groups of open issues listed; the rest wait for the next check or the conversation. */
const VISIBLE_ISSUE_GROUPS = 3
/** Decisions listed, newest first. */
const VISIBLE_DECISIONS = 3
/** The key `set-mode` gives the decision it records; its answer holds the mode and route ids. */
const MODE_DECISION = 'mode'
/** How `set-mode` joins the mode and route ids in that answer. */
const MODE_ANSWER_SEPARATOR = ' · '
/** What a phase's mark says to a screen reader. */
const PHASE_STATE_KEYS: Record<PhaseState, ResearchKey> = {
  done: 'phaseDone', current: 'phaseCurrent', pending: 'phasePending', deferred: 'phaseDeferred',
}
const PHASE_MARKS: Record<Exclude<PhaseState, 'done'>, string | undefined> = {
  current: styles.markCurrent, pending: styles.markPending, deferred: styles.markDeferred,
}
/** The research record's props: the tab seat's runtime share, the research face and the research on screen. */
type RecordProps = ResearchTabProps & { project: ResearchProject }

/** Chip title of the research tab. */
export function ResearchRailTitle(props: { t: WorkbenchProps['t'] }): ReactNode {
  return <span className={styles.chip}><ResearchHeroMark size={14} />{props.t('railTitle')}</span>
}

/**
 * A button that adds one sentence to the composer's draft, after what is
 * already typed, and sends nothing; the person decides whether to send it.
 */
function DraftButton(props: Pick<RecordProps, 't' | 'useInput' | 'inputActions'> & { sentence: string; label: string; className: string | undefined }): ReactNode {
  const draft = props.useInput(state => state.draft)
  return <button type="button" className={props.className} title={props.t('entryTryHint')}
    onClick={() => { props.inputActions.setDraft(appendedDraft(draft, props.sentence)) }}>
    {props.label}
  </button>
}

/** The research's title, the 示例 tag of an example, its folder, and 在资源管理器中打开 where the host can show it. */
function TitleBlock(props: RecordProps): ReactNode {
  const { project, t } = props
  const canReveal = props.useCanReveal(state => state)
  const revealing = useAction()
  return <div className={styles.header}>
    <div className={styles.titleRow}>
      <span className={styles.title}>{project.title}</span>
      {project.example === true && <span className={styles.exampleTag}>{t('exampleTag')}</span>}
    </div>
    <p className={styles.folder}>
      <span className={styles.folderPath}>{project.root}</span>
      {canReveal && <button type="button" className={styles.link} disabled={revealing.pending}
        onClick={() => { revealing.start(() => props.reveal(project.root)) }}>{t('folderReveal')}</button>}
    </p>
    <ActionError t={t} error={revealing.error} />
  </div>
}

/**
 * Said when this conversation was composed from an agent preset other than
 * the research assistant's, and when the settings keep such a preset as the
 * default for new conversations, which the person can put back. An example
 * says neither.
 */
function LegacyNote(props: RecordProps): ReactNode {
  const { project, t } = props
  const presets = props.usePresets(state => state)
  const preset = props.useSessions((state) => {
    const value = state.byId[props.sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const resetting = useAction()
  if (presets === null || project.example === true) return null
  const legacy = preset !== undefined && preset !== presets.research
  const saved = presets.saved
  if (!legacy && saved === undefined) return null
  return <section className={styles.legacy} role="note">
    {legacy && <p className={styles.legacyText}>{t(saved === undefined ? 'legacyConversation' : 'legacyConversationStale')}</p>}
    {saved !== undefined && <>
      <p className={styles.legacyText}>{t('legacyDefault', { preset: saved })}</p>
      <button type="button" className={styles.link} disabled={resetting.pending}
        onClick={() => { resetting.start(() => props.resetDefaultPreset()) }}>{t('legacyReset')}</button>
    </>}
    <ActionError t={t} error={resetting.error} />
  </section>
}

/** Who chose the mode, as the record says it: the person, the assistant, or in an example the example's author. */
function modeChooser(project: ResearchProject): ResearchKey {
  if (project.modeSetBy === 'agent') return 'modeByAgent'
  return project.example === true ? 'modeByExampleAuthor' : 'modeByUser'
}

/**
 * The mode as recorded, read-only: `{mode} · {route} · 你选定` with its
 * reason, or 模式待定 before it is chosen. 想换模式？ (Change the mode?) only
 * drafts a sentence asking the assistant; nothing here writes the mode.
 */
function ModeLine(props: RecordProps): ReactNode {
  const { project, t } = props
  const modes = useModes(props)
  const pack = modes.find(mode => mode.id === project.mode)
  const routeId = project.route ?? pack?.defaultRoute
  const route = pack?.routes.find(item => item.id === routeId)
  const text = project.modeSetBy === undefined
    ? t('modeUnchosen')
    : [modeName(modes, project.mode, t), ...route === undefined ? [] : [packText(route.name, t)], t(modeChooser(project))].join(' · ')
  return <div className={styles.field}>
    <span className={styles.fieldLabel}>{t('modeLabel')}</span>
    <span>{text}</span>
    {project.modeReason !== undefined && <span className={styles.caption}>{project.modeReason}</span>}
    {project.example !== true && <DraftButton {...props} className={styles.link} sentence={t('modeChangeDraft')} label={t('modeChange')} />}
  </div>
}

/** The research's autonomy, read-only here: the person changes it with the composer's chip, and an example keeps its own. */
function AutonomyLine(props: RecordProps): ReactNode {
  const { project, t } = props
  const name = autonomyName(project.autonomy, t)
  return <div className={styles.field}>
    <span className={styles.fieldLabel}>{t('autonomy')}</span>
    <span>{project.example === true ? name : t('railAutonomy', { name })}</span>
  </div>
}

/** How the 现在 line is coloured: warn while it waits on the person, ongoing while work moves, verified once clean. */
const NOW_TONES: Record<NowLine['kind'], string | undefined> = {
  waiting: styles.nowWarn, blocked: styles.nowWarn, deferred: styles.nowWarn,
  goal: styles.nowOngoing, runs: styles.nowOngoing,
  finished: styles.nowVerified,
  next: undefined, unchecked: undefined, recheck: undefined, general: undefined,
}

/** The 现在 line's words for one line, with the conversation it names. */
function nowText(line: NowLine, props: RecordProps, title: string): string {
  const { t } = props
  switch (line.kind) {
    case 'waiting': return t('nowWaiting', { title })
    case 'goal': return line.phase === undefined ? t('nowGoal', { title }) : t('nowGoalPhase', { phase: packText(line.phase.label, t), title })
    case 'runs': return counted(line.n, 'nowRunsOne', 'nowRuns', t)
    case 'blocked': return t('nowBlocked', { title })
    case 'next': {
      const phase = packText(line.phase.label, t)
      return line.hint === undefined ? t('nowNextBare', { phase }) : t('nowNext', { phase, hint: packText(line.hint, t) })
    }
    case 'deferred': return t('nowDeferred', { phase: packText(line.phase.label, t) })
    case 'finished': return t('nowFinished')
    case 'unchecked': return t('nowUnchecked')
    case 'recheck': return t('nowRecheck')
    case 'general': return t('nowGeneral')
  }
}

/** The sentence a 现在 line suggests saying in the conversation, when it suggests one. */
function nowSentence(line: NowLine, t: Translate): string | undefined {
  if (line.kind === 'next') return t('nowContinue', { phase: packText(line.phase.label, t) })
  if (line.kind === 'finished') return t('nowExport')
  if (line.kind === 'unchecked' || line.kind === 'recheck') return t('nowCheck')
  return undefined
}

/**
 * 现在 (Now): one line on where the research stands right now, first
 * whatever waits on the person or moves, then what comes next. A line that
 * names another conversation offers 跳过去 (Go there); running runs open the
 * board; a line with a next step offers 在对话中提出 (Suggest in the
 * conversation), which adds its sentence to the draft. An example offers
 * nothing to say.
 */
function Now(props: RecordProps & { activity: ResearchActivity }): ReactNode {
  const { project, t } = props
  const jumping = useAction()
  const line = nowLine(project, props.activity)
  const named = line !== undefined && (line.kind === 'waiting' || line.kind === 'goal' || line.kind === 'blocked') ? line.sessionId : undefined
  // The conversation a line names goes by its title, or 新对话 while it is blank or not listed.
  const summary = props.useSessions(state => (named === undefined ? undefined : state.byId[named as SessionId]))
  const title = summary === undefined || summary.blank ? t('treeBlankConversation') : summary.displayTitle
  if (line === undefined) return null
  const sentence = project.example === true ? undefined : nowSentence(line, t)
  const jump = line.kind !== 'goal' && named !== undefined && named !== props.sessionId ? named : undefined
  return <section className={styles.block}>
    <div className={styles.blockHead}>{t('nowTitle')}</div>
    <p className={NOW_TONES[line.kind] ?? styles.nowText}>
      {nowText(line, props, title)}
      {line.kind === 'finished' && <span className={styles.verifiedMark} aria-hidden="true"> ✓</span>}
    </p>
    {(jump !== undefined || line.kind === 'runs' || sentence !== undefined) && <div className={styles.nowActions}>
      {jump !== undefined && <button type="button" className={styles.link} disabled={jumping.pending}
        onClick={() => { jumping.start(() => props.openConversation(jump, project.workspaceId)) }}>{t('nowJump')}</button>}
      {line.kind === 'runs' && <button type="button" className={styles.link} onClick={() => { props.openBoard() }}>{t('nowOpenBoard')}</button>}
      {sentence !== undefined && <DraftButton {...props} className={styles.propose} sentence={sentence} label={t('nowPropose', { sentence })} />}
    </div>}
    <ActionError t={t} error={jumping.error} />
  </section>
}

/** One phase's mark: a check for done, a ring on the current phase, hollow for the rest. */
function PhaseMark(props: { state: PhaseState; t: Translate }): ReactNode {
  const label = props.t(PHASE_STATE_KEYS[props.state])
  if (props.state === 'done') {
    return <svg className={styles.markDone} role="img" aria-label={label} viewBox="0 0 12 12"><path d="M2.5 6.4 5 8.8 9.5 3.4" /></svg>
  }
  return <span className={PHASE_MARKS[props.state]} role="img" aria-label={label}></span>
}

/** When the last check ran, and whether a file changed after it; nothing before any check. */
function CheckedLine(props: { standing: ResearchStanding; t: Translate }): ReactNode {
  const { standing, t } = props
  if (standing.checkedAt === undefined) return null
  return <p className={styles.note}>
    {checkedText(standing.checkedAt, Date.now(), t)}
    {standing.changedSinceCheck === true && <span className={styles.changed}> · {t('changedSinceCheck')}</span>}
  </p>
}

/** 阶段 (Phases): the mode's phases as the host reads them from the stored progress, the current one with what it lacks. */
function Phases(props: RecordProps): ReactNode {
  const { project, t } = props
  const standing = project.standing
  if (standing === undefined || standing.phases.length === 0) return null
  return <section className={styles.block}>
    <div className={styles.blockHead}>{t('phasesTitle')}</div>
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
function issueName(group: StandingIssues, t: Translate): string {
  return [packText(group.label, t), ...findingCounts(group.errors, group.warnings, t)].join(' · ')
}

/**
 * 待处理 (Open issues): what the latest checks found, in at most three
 * groups. A group opens its file only while the file exists; the checks' own
 * words stay behind 详细信息 (Details).
 */
function Issues(props: RecordProps): ReactNode {
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

/** Who a decision is shown as coming from: in an example the person's answers were the example's author's, not the reader's. */
function decisionAuthor(project: ResearchProject, by: DecisionRecord['by']): ResearchKey {
  if (by === 'agent') return 'decisionByAgent'
  return project.example === true ? 'exampleAuthor' : 'decisionByUser'
}

/** A decision's question and answer as the reader reads them; the mode decision names its mode and route by their pack names. */
function decisionText(decision: DecisionRecord, modes: readonly ModeSummary[], t: Translate): { question: string; answer: string } {
  if (decision.key !== MODE_DECISION) return { question: decision.question, answer: decision.answer }
  const at = decision.answer.indexOf(MODE_ANSWER_SEPARATOR)
  const mode = at < 0 ? decision.answer : decision.answer.slice(0, at)
  const route = at < 0 ? undefined : decision.answer.slice(at + MODE_ANSWER_SEPARATOR.length)
  const routeName = modes.find(item => item.id === mode)?.routes.find(item => item.id === route)?.name
  const names = [modeName(modes, mode, t), ...route === undefined ? [] : [routeName === undefined ? route : packText(routeName, t)]]
  return { question: t('decisionModeQuestion'), answer: names.join(MODE_ANSWER_SEPARATOR) }
}

/** 决策 (Decisions): the latest three, the person's answers at checkpoints and the assistant's own calls, newest first. */
function Decisions(props: RecordProps): ReactNode {
  const { project, t } = props
  const modes = useModes(props)
  return <section className={styles.block}>
    <div className={styles.blockHead}>{t('decisions')}</div>
    {project.decisions.length === 0 && <p className={styles.note}>{t('noDecisions')}</p>}
    {project.decisions.slice(-VISIBLE_DECISIONS).reverse().map((decision) => {
      const { question, answer } = decisionText(decision, modes, t)
      return <div key={decision.id} className={styles.decision}>
        <span className={styles.caption}>{t(decisionAuthor(project, decision.by))} · {question}</span>
        <span className={styles.blockBody}>{answer}</span>
      </div>
    })}
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

/**
 * 资料 · 论点 · 文件 · 实验 (Sources, claims, files, experiments), each
 * opening its tab beside the conversation and named as that tab is. 实验
 * shows only on a route with an experiments phase, or once a run exists.
 */
function Counts(props: RecordProps): ReactNode {
  const { project, t } = props
  const modes = useModes(props)
  const opening = useAction()
  const stale = project.evidence.filter(item => item.stale).length
  const openRuns = project.experiments.filter(run => OPEN_RUN_STATUS.includes(run.status)).length
  const runsExpected = project.experiments.length > 0 || modePhases(modes, project).includes(EXPERIMENTS_PHASE)
  return <section className={styles.counts}>
    <CountRow
      label={t('sourcesTab')}
      value={String(project.evidence.length)}
      onOpen={() => { props.openSources() }}
      {...(stale > 0 ? { badge: <span className={styles.staleTag}>{t('railStaleCount', { n: stale })}</span> } : {})}
    />
    <CountRow label={t('claims')} value={String(project.claims.length)} onOpen={() => { props.openSources('claims') }} />
    <CountRow label={t('railFilesLabel')} value={String(project.artifacts.length)} onOpen={() => { opening.start(() => { props.openFiles() }) }} />
    {runsExpected && <CountRow
      label={t('railExperimentsLabel')}
      value={project.experiments.length === 0 ? t('railNotStarted') : String(project.experiments.length)}
      onOpen={() => { props.openBoard() }}
      {...(openRuns > 0 ? { badge: <span className={styles.runningTag}>{t('runRunning')}</span> } : {})}
    />}
    <ActionError t={t} error={opening.error} />
  </section>
}

/** The research's secondary tools: the experiment board, the figure gallery and the research folder's files. */
function Tools(props: RecordProps): ReactNode {
  const { t } = props
  const opening = useAction()
  return <section className={styles.tools}>
    <div className={styles.toolRow}>
      <button type="button" className={styles.tool} onClick={() => { props.openBoard() }}>{t('boardTitle')}</button>
      <button type="button" className={styles.tool} onClick={() => { props.openGallery() }}>{t('gallery')}</button>
      <button type="button" className={styles.tool} onClick={() => { opening.start(() => { props.openFiles() }) }}>{t('researchFiles')}</button>
    </div>
    <ActionError t={t} error={opening.error} />
  </section>
}

/** The record of one research, with what is live in it now. */
function ResearchRecord(props: RecordProps): ReactNode {
  const { project, t } = props
  const projects = props.useResearch(state => state.snapshot)?.projects
  const list = props.useSessions(state => state)
  const pending = props.useSessionStatus(state => state)
  const directories = props.useDirectories(state => state)
  const activity = useMemo(
    () => researchActivity(project, projects, list, pending, directories),
    [project, projects, list, pending, directories],
  )
  return <div className={styles.root}>
    {project.example === true && <p className={styles.exampleBanner}>{t('exampleBanner')}</p>}
    <TitleBlock {...props} />
    <LegacyNote {...props} />
    <ModeLine {...props} />
    <AutonomyLine {...props} />
    <Now {...props} activity={activity} />
    <Phases {...props} />
    <Issues {...props} />
    <Decisions {...props} />
    <Counts {...props} />
    <Tools {...props} />
  </div>
}

/** The research tab body: the record of the research the conversation beside it belongs to. */
export function ResearchRail(props: ResearchTabProps): ReactNode {
  const project = useSessionProject(props)
  if (!project) return <NoResearch t={props.t} />
  return <ResearchRecord key={project.id} {...props} project={project} />
}
