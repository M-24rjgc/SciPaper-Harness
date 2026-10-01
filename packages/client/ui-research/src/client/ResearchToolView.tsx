/**
 * Research tool calls as the conversation shows them. Every call reads as one
 * row in the reader's language, the tool's name and what this call did, with
 * the raw arguments and result behind the row's disclosure. A research check
 * reads as a card: its scope, whether it passed, what it found by check with
 * the file each group names, and the check's own words behind 详细信息. Both
 * derive from the logged call and result (`toolCallValues.ts`); the research
 * record only names things and gives the project folder.
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { DisclosureRow, IconCheckOutlineRegular, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { KnowledgeTrace, KnowledgeTraceNode } from '@deepseek-ai/dsh-research-workbench/types'
import { sessionProject, type KnowledgeMarksRead, type ResearchToolInjected } from './contract.ts'
import { ActionError, useAction } from './Action.tsx'
import { ResearchHeroMark } from './Hero.tsx'
import { counted, findingCounts, type Translate } from './format.ts'
import { verdictOf } from './followValues.ts'
import { clipped } from './mapValues.ts'
import {
  actionPhrase, callArgs, callArgsRaw, callState, checkName, checkView, failureReason, familyName, knowledgeTraceOf, phaseName, readable,
  resultText, scopeName, type CallState, type CheckView, type FindingGroup, type NameContext,
} from './toolCallValues.ts'
import styles from './ResearchToolView.module.css'

/** A research tool card's props: the keyed tool view's own, the research dictionary, and the injected record. */
export type ResearchToolProps = ToolCallViewProps & PropsLocale<'research'> & InjectFace<ResearchToolInjected>

/** Groups a check card lists; the rest sit in its details. */
const VISIBLE_GROUPS = 3

/** The mark of a call that has not answered well: running, failed, or stopped. */
const STATE_DOTS: Record<Exclude<CallState, 'ok'>, StateDotState> = { running: 'ongoing', error: 'error', stopped: 'warning' }

/** What names things on this card: the dictionary, the installed modes, and the research of the card's conversation. */
function useNames(props: ResearchToolProps): NameContext {
  const snapshot = props.useResearch(view => view.snapshot)
  const directories = props.cwd === undefined ? {} : { [props.sessionId]: props.cwd }
  return { t: props.t, modes: snapshot?.modes ?? [], project: sessionProject(snapshot?.projects, props.sessionId, directories) }
}

/** The leading mark: the research flask once a call answered, else a state dot for running, failed or stopped. */
function Leading(props: { state: CallState }): ReactNode {
  return props.state === 'ok' ? <ResearchHeroMark size={14} /> : <StateDot state={STATE_DOTS[props.state]} />
}

/** The dot between the parts of a row. */
function Separator(): ReactNode {
  return <span className={styles.separator} aria-hidden="true"></span>
}

/** A call's failure, in place under its row; the host's own words. */
function Failure(props: { block: ResearchToolProps['block']; t: Translate }): ReactNode {
  return <p className={styles.failure} role="status">{props.t('actionFailed', { reason: failureReason(props.block) })}</p>
}

/** The call's raw arguments and result, laid out for reading. */
function RawCall(props: { args: string; result: string; t: Translate }): ReactNode {
  return <div className={styles.raw}>
    {props.args !== '' && <section className={styles.rawPart}>
      <span className={styles.rawHead}>{props.t('toolArguments')}</span>
      <pre className={styles.rawBody}>{readable(props.args)}</pre>
    </section>}
    {props.result !== '' && <section className={styles.rawPart}>
      <span className={styles.rawHead}>{props.t('toolResult')}</span>
      <pre className={styles.rawBody}>{readable(props.result)}</pre>
    </section>}
  </div>
}

/**
 * One research tool call as a row: `研究资料 · 导入 3 个文件`. A running call
 * says so to a screen reader, a stopped one says so on the row, and a failed
 * one shows the host's reason under it.
 * @param props - the keyed tool view's props.
 * @returns the row.
 */
export function ResearchToolCard(props: ResearchToolProps): ReactNode {
  const { block, toolName, t } = props
  const names = useNames(props)
  const [expanded, setExpanded] = useState(false)
  const partial = props.useToolCallArgumentsPartial()
  const state = callState(block)
  const parsed = callArgs(block, partial)
  const trace = state === 'ok' ? knowledgeTraceOf(block) : undefined
  const phrase = actionPhrase(toolName, parsed, names, trace)
  const args = callArgsRaw(block, partial)
  const result = resultText(block)
  const expandable = args !== '' || result !== ''
  const project = names.project
  const knowledge = props.useResearch(view => view.snapshot?.knowledge)
  const read = props.useMarks(marks => project === undefined ? undefined : marks[project.id])
  // The chips read whether a node is marked now, so the marks are read once the card shows a graph node.
  const marked = knowledge?.enabled === true && trace !== undefined && trace.nodes.some(node => node.source !== 'relations')
  useEffect(() => { if (marked && project !== undefined) props.readMarks(project.id) }, [marked, project?.id, block.callId])
  return <div className={styles.call} data-tool={toolName} data-state={state}>
    <DisclosureRow
      icon={<Leading state={state} />}
      title={familyName(toolName, t)}
      open={expanded && expandable}
      expandable={expandable}
      expandOnRowClick
      keepContentWhenOpen
      onToggle={() => { setExpanded(value => !value) }}
      collapsedContent={<>
        {phrase !== undefined && <><Separator /><span className={styles.phrase}>{phrase}</span></>}
        {state === 'running' && <span className={styles.hidden}>{t('toolRunning')}</span>}
        {state === 'stopped' && <span className={styles.stopped}>{t('toolStopped')}</span>}
      </>}
    >
      <RawCall args={args} result={result} t={t} />
    </DisclosureRow>
    {toolName === 'research_knowledge' && state === 'ok' && <div className={styles.touched}>
      {trace !== undefined && <TouchedChips trace={trace} marks={read} callId={block.callId} t={t} open={props.openKnowledge} />}
      {trace !== undefined && (knowledge?.modules.map === true || knowledge?.modules.relations === true)
        ? <button type="button" className={styles.graphLink} onClick={() => { props.openKnowledge({ call: block.callId }) }}>{t('toolGraphLink')}</button>
        : <button type="button" className={styles.graphLink} onClick={() => { props.openKnowledge({
          query: typeof parsed?.query === 'string' ? parsed.query : undefined,
          pattern: typeof parsed?.pattern === 'string' ? parsed.pattern : undefined,
        }) }}>{t('kgOpen')}</button>}
    </div>}
    {state === 'error' && <Failure block={block} t={t} />}
  </div>
}

/** Chips a card shows before the rest are counted. */
const VISIBLE_CHIPS = 8
/** Which nodes a card names first: what a mark decided, then the centre and the ends, then the rest. */
const CHIP_ORDER = { pinned: 0, skipped: 1, centre: 2, end: 2, recalled: 3 } as const

/**
 * The nodes a knowledge call touched, as chips: a pinned one outlined, one the person marked not relevant struck
 * through, each from the marks as they stand now. A chip opens the conversation's graph focused on its node.
 */
function TouchedChips(props: {
  trace: KnowledgeTrace
  marks: KnowledgeMarksRead | undefined
  callId: string
  t: Translate
  open: ResearchToolProps['openKnowledge']
}): ReactNode {
  const { trace, marks, t } = props
  const order = (node: KnowledgeTraceNode): number => node.use === undefined ? 4 : CHIP_ORDER[node.use]
  const nodes = [...trace.nodes].sort((a, b) => order(a) - order(b))
  if (nodes.length === 0) return null
  return <div className={styles.chips} role="group" aria-label={t('toolTouched')}>
    {nodes.slice(0, VISIBLE_CHIPS).map((node) => {
      const verdict = marks?.honour === false ? undefined : verdictOf(marks?.marks ?? [], node.id)
      const text = clipped(node.label, 26)
      return <button key={node.id} type="button" className={styles.chip} data-look={verdict === 'pin' ? 'pinned' : verdict === 'irrelevant' ? 'struck' : 'plain'}
        aria-label={verdict === 'pin' ? t('kfChipPinned', { name: text }) : verdict === 'irrelevant' ? t('kfChipIrrelevant', { name: text }) : text}
        title={node.label} onClick={() => { props.open({ call: props.callId, node: node.id }) }}>{text}</button>
    })}
    {nodes.length > VISIBLE_CHIPS && <span className={styles.more}>{t('toolTouchedMore', { n: nodes.length - VISIBLE_CHIPS })}</span>}
  </div>
}

/** What the check card's head says after the scope. */
interface Verdict {
  /** How the check went; absent for a call that failed, whose reason shows under the head. */
  word?: string
  className?: string | undefined
  /** What it found, one phrase each. */
  counts: string[]
}

/** Why a check that found no error did not pass, as one phrase. */
function openPhrase(open: NonNullable<CheckView['open']>, t: Translate): string {
  return open.kind === 'requirements'
    ? counted(open.n, 'checkUnmetOne', 'checkUnmet', t)
    : counted(open.n, 'checkPhasesOpenOne', 'checkPhasesOpen', t)
}

/** How the check went, and what it found. */
function verdict(state: CallState, view: CheckView | undefined, t: Translate): Verdict {
  if (state === 'running') return { word: t('checkRunning'), counts: [] }
  if (state === 'stopped') return { word: t('toolStopped'), className: styles.stopped, counts: [] }
  if (view === undefined) return { counts: [] }
  const open = view.open === undefined ? [] : [openPhrase(view.open, t)]
  return view.clean
    ? { word: t('checkPassed'), className: styles.passed, counts: findingCounts(0, view.warnings, t) }
    : { word: t('checkNotPassed'), className: styles.notPassed, counts: [...findingCounts(view.errors, view.warnings, t), ...open] }
}

/** Where a finding points: its file, and the line when it names one. */
function where(file: string, line: number | undefined): string {
  return line === undefined ? file : `${file}:${line}`
}

/**
 * One group of findings: the check's name and counts, and the file it names,
 * which opens in the right sidebar when the card can open it.
 */
function Group(props: { group: FindingGroup; names: NameContext; onOpen: ((path: string) => void) | undefined }): ReactNode {
  const { group, names, onOpen } = props
  const file = group.file
  return <li className={styles.group}>
    <span className={styles.groupName}>{[checkName(group.check, names), ...findingCounts(group.errors, group.warnings, names.t)].join(' · ')}</span>
    {file !== undefined && (onOpen === undefined
      ? <span className={styles.fileName}>{where(file, group.line)}</span>
      : <button type="button" className={styles.file} title={names.t('issueOpenFile', { file })} onClick={() => { onOpen(file) }}>{where(file, group.line)}</button>)}
  </li>
}

/** The check card's leading mark: the verified ✓ only on a clean report, the warn dot on one that did not pass. */
function CheckMark(props: { state: CallState; view: CheckView | undefined }): ReactNode {
  if (props.view === undefined) return <Leading state={props.state} />
  return props.view.clean ? <IconCheckOutlineRegular className={styles.passMark} /> : <StateDot state="warning" />
}

/** The check's own words: each finding, then what each unfinished phase the scope covers still lacks. */
function CheckDetails(props: { view: CheckView; mode: string | undefined; names: NameContext }): ReactNode {
  const { view, mode, names } = props
  if (view.findings.length === 0 && view.missing.length === 0) return null
  return <details className={styles.details}>
    <summary className={styles.detailsToggle}>{names.t('issueDetails')}</summary>
    {view.findings.map((finding, index) => <p key={`finding-${index}`} className={styles.detailLine}>
      {finding.message}
      {finding.file !== undefined && <span className={styles.where}> {where(finding.file, finding.line)}</span>}
    </p>)}
    {view.missing.map(phase => phase.lines.map((line, index) => <p key={`${phase.phase}-${index}`} className={styles.detailLine}>
      {names.t('toolDetail', { action: phaseName(phase.phase, mode, names), detail: line })}
    </p>))}
  </details>
}

/**
 * A research_check call as a card: `研究检查 · 引用 · 未通过 · 2 个错误`, the
 * first groups of what it found with the file each names, and the check's own
 * words behind 详细信息. A file opens in the right sidebar only when the report
 * shows it was on disk. Only a clean report earns the verified green ✓. A
 * result that is not a report shows as the ordinary research row.
 * @param props - the keyed tool view's props.
 * @returns the card.
 */
export function ResearchCheckCard(props: ResearchToolProps): ReactNode {
  const { block, t } = props
  const names = useNames(props)
  const opening = useAction()
  const partial = props.useToolCallArgumentsPartial()
  const state = callState(block)
  const view = state === 'ok' ? checkView(block) : undefined
  if (state === 'ok' && view === undefined) return <ResearchToolCard {...props} />
  const mode = view?.mode ?? names.project?.mode
  // Before the report arrives the scope comes from the call, and an incomplete call names none yet.
  const scope = view === undefined ? actionPhrase('research_check', callArgs(block, partial), names) : scopeName(view.scope, mode, names)
  const said = verdict(state, view, t)
  const project = names.project
  // A file opens only when the report proves it was on disk and the card knows the research folder.
  const onOpen = project === undefined || view?.filesExist !== true
    ? undefined
    : (path: string): void => { opening.start(() => { props.openProjectFile(project.root, path) }) }
  return <section className={styles.check} data-tool="research_check" data-state={state} data-clean={view?.clean}>
    <div className={styles.checkHead}>
      <span className={styles.leading}><CheckMark state={state} view={view} /></span>
      <span className={styles.part}>{t('toolCheck')}</span>
      {scope !== undefined && <><Separator /><span className={styles.part}>{scope}</span></>}
      {said.word !== undefined && <><Separator /><span className={said.className ?? styles.part}>{said.word}</span></>}
      {said.counts.map(phrase => <Fragment key={phrase}><Separator /><span className={styles.part}>{phrase}</span></Fragment>)}
    </div>
    {view !== undefined && view.groups.length > 0 && <ul className={styles.groups}>
      {view.groups.slice(0, VISIBLE_GROUPS).map(group => <Group key={group.check} group={group} names={names} onOpen={onOpen} />)}
    </ul>}
    {view !== undefined && <CheckDetails view={view} mode={mode} names={names} />}
    {state === 'error' && <Failure block={block} t={t} />}
    <ActionError t={t} error={opening.error} />
  </section>
}
