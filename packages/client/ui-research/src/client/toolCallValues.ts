/**
 * What the research tool cards read from one logged call: where it stands, its
 * arguments, its result, what it did in the reader's language, and for
 * research_check the report it returned. Every value comes from the call and
 * result events the Session log keeps; the research record only names things
 * (a mode's phases and routes, a check's label) and gives the project folder.
 * A value that does not read the way the research tools write it reads as
 * absent, so a card shows less instead of failing.
 *
 * @module @deepseek-ai/dsh-client-ui-research/toolCallValues
 */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { KnowledgeTrace, LocalizedText, ModeSummary, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { counted, modeName, packText, type Translate } from './format.ts'
import type { ResearchKey } from './locales.ts'
import { readTrace, recalledCounts } from './traceValues.ts'

/** One running or settled tool call, as the conversation holds it. */
export type ToolCallBlock = ToolCallViewProps['block']

/** Where one call stands: still running, answered, failed, or stopped before it answered. */
export type CallState = 'running' | 'ok' | 'error' | 'stopped'

/** A JSON object: a call's arguments, or a result the tool returned. */
type Fields = Readonly<Record<string, unknown>>

/** What names things on a card: the dictionary, the installed modes, and the research the conversation is in. */
export interface NameContext {
  t: Translate
  modes: readonly ModeSummary[]
  /** The research of the card's conversation; absent before the record arrives or outside every research. */
  project: ResearchProject | undefined
}

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The JSON object a text holds, or undefined when it holds something else. */
function objectOf(raw: string): Fields | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    // SyntaxError: a streaming call exposes a prefix of its JSON, and a failure's text is prose; neither is an object.
    return undefined
  }
  return isFields(value) ? value : undefined
}

/**
 * Where a call stands.
 * @param block - the call as the conversation holds it.
 * @returns running before a result, stopped when interrupted, else by the result's error flag.
 */
export function callState(block: ToolCallBlock): CallState {
  if (!('kind' in block)) return 'running'
  if (block.error?.code === 'interrupted') return 'stopped'
  return block.isError ? 'error' : 'ok'
}

/**
 * The call's argument text as the model wrote it.
 * @param block - the call as the conversation holds it.
 * @param partial - argument prefix available during preparation.
 * @returns the raw JSON text; empty when a result arrived without its call.
 */
export function callArgsRaw(block: ToolCallBlock, partial = ''): string {
  return ('kind' in block ? block.call?.argsRaw : block.phase === 'preparing' ? partial : block.argsRaw) ?? ''
}

/**
 * The call's arguments.
 * @param block - the call as the conversation holds it.
 * @param partial - argument prefix available during preparation.
 * @returns the argument object, or undefined while it is incomplete or when it is no object.
 */
export function callArgs(block: ToolCallBlock, partial = ''): Fields | undefined {
  return objectOf(callArgsRaw(block, partial))
}

/**
 * A settled call's result as text: text blocks as written, any other block as
 * JSON, and a failure without content as its error's name and code.
 * @param block - the call as the conversation holds it.
 * @returns the text; empty while the call runs or when the result carries none.
 */
export function resultText(block: ToolCallBlock): string {
  if (!('kind' in block)) return ''
  const parts = block.content.map(item => item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n')
}

/**
 * JSON text laid out for reading; any other text as it is.
 * @param text - an argument or result text.
 * @returns the indented JSON, or the text unchanged.
 */
export function readable(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    // SyntaxError: a failure message or a truncated argument prefix reads best as written.
    return text
  }
}

/**
 * Why a call failed, in the host's words, without the `Error:` its registry puts before them.
 * @param block - a failed call.
 * @returns the failure text.
 */
export function failureReason(block: ToolCallBlock): string {
  return resultText(block).replace(/^Error:\s*/, '')
}

/** A string argument's first line; undefined when absent, empty or not a string. */
function field(fields: Fields, name: string): string | undefined {
  const value = fields[name]
  if (typeof value !== 'string' || value === '') return undefined
  const newline = value.indexOf('\n')
  return newline === -1 ? value : value.slice(0, newline)
}

/** A string field of an object argument. */
function inner(fields: Fields, name: string, key: string): string | undefined {
  const value = fields[name]
  return isFields(value) ? field(value, key) : undefined
}

/** How many items the named array arguments hold together. */
function size(fields: Fields, names: readonly string[]): number {
  return names.reduce((sum, name) => {
    const value = fields[name]
    return sum + (Array.isArray(value) ? value.length : 0)
  }, 0)
}

/**
 * What a settled knowledge call touched, as the host kept it beside the result.
 * @param block - the call as the conversation holds it.
 * @returns the trace; undefined while the call runs, for a call that touched nothing to draw, and for metadata that is no trace.
 */
export function knowledgeTraceOf(block: ToolCallBlock): KnowledgeTrace | undefined {
  return 'kind' in block ? readTrace(block.meta) : undefined
}

/** What one call of a tool did, from its arguments and, for a knowledge call, what it touched. */
type Describe = (args: Fields, names: NameContext, trace: KnowledgeTrace | undefined) => string

/** An action's phrase, followed by what it acted on when the call says. */
function detail(t: Translate, key: ResearchKey, value: string | undefined): string {
  return value === undefined ? t(key) : t('toolDetail', { action: t(key), detail: value })
}

const plain = (key: ResearchKey): Describe => (_args, names) => names.t(key)
const about = (key: ResearchKey, name: string): Describe =>
  (args, names) => detail(names.t, key, field(args, name))
const aboutInner = (key: ResearchKey, name: string, inside: string): Describe =>
  (args, names) => detail(names.t, key, inner(args, name, inside))
const count = (one: ResearchKey, many: ResearchKey, ...arrays: string[]): Describe =>
  (args, names) => counted(size(args, arrays), one, many, names.t)

/** 读取你的 3 条标注: the marks a listing read, when the call's trace says how many. */
const marksRead: Describe = (_args, names, trace) =>
  trace?.marks === undefined ? names.t('toolKnowledgeMarks') : names.t('toolKnowledgeMarksRead', { n: trace.marks.count })

/** What a recall brought back, and how many marks shaped it; before the trace, the query alone. */
const recalled: Describe = (args, names, trace) => {
  if (trace === undefined) return detail(names.t, 'toolKnowledgeRecall', field(args, 'query'))
  const counts = recalledCounts(trace)
  const marks = trace.marks?.count ?? 0
  return `${names.t('toolKnowledgeRecalled', counts)}${marks === 0 ? '' : names.t('toolKnowledgeByMarks', { n: marks })}`
}

/** 沿 2 条路径找: the paths a search found between the two ends the call named. */
const pathsFound: Describe = (args, names, trace) => {
  const from = field(args, 'from'), to = field(args, 'to')
  if (trace?.paths === undefined || from === undefined || to === undefined) return names.t('toolKnowledgeRelationsPaths')
  if (trace.paths === 0) return names.t('toolKnowledgePathsNone', { from, to })
  return names.t(trace.paths === 1 ? 'toolKnowledgePathsFoundOne' : 'toolKnowledgePathsFound', { from, to, n: trace.paths })
}

/** The mode and route a set-mode call chose, by the names their pack gives them. */
function modeChoiceName(args: Fields, names: NameContext): string | undefined {
  const mode = field(args, 'mode')
  if (mode === undefined) return undefined
  const route = field(args, 'route')
  const chosen = modeName(names.modes, mode, names.t)
  if (route === undefined) return chosen
  const routeName = names.modes.find(item => item.id === mode)?.routes.find(item => item.id === route)?.name
  return `${chosen} · ${routeName === undefined ? route : packText(routeName, names.t)}`
}

/** The autonomy a set-autonomy call chose, by the name the composer gives it. */
function autonomyName(args: Fields, t: Translate): string | undefined {
  if (args.autonomy === 'automatic') return t('autonomyShortAutomatic')
  return args.autonomy === 'checkpoints' ? t('autonomyShortCheckpoints') : undefined
}

/** A phase's label in the mode a report ran under, when the installed modes carry it. */
function phaseLabel(id: string, mode: string | undefined, names: NameContext): LocalizedText | undefined {
  return names.modes.find(item => item.id === mode)?.phases.find(phase => phase.id === id)?.label
}

/**
 * A check's name: the label the research's standing gives it (a gate's pack
 * label, or a base check's built-in name), else its id.
 * @param check - a base check or gate id.
 * @param names - what names things.
 * @returns the name in the reader's language when the record has one.
 */
export function checkName(check: string, names: NameContext): string {
  const label = names.project?.standing?.issues.find(group => group.check === check)?.label
  return label === undefined ? check : packText(label, names.t)
}

/**
 * A phase's name in the mode a report ran under, else its id.
 * @param id - a phase id.
 * @param mode - the mode the report ran under.
 * @param names - what names things.
 * @returns the pack's label in the reader's language, or the id.
 */
export function phaseName(id: string, mode: string | undefined, names: NameContext): string {
  const label = phaseLabel(id, mode, names)
  return label === undefined ? id : packText(label, names.t)
}

/**
 * What a check's scope names, read the way research_check reads it: all, a
 * phase of the mode (which wins over a check of the same id), or one check.
 * @param scope - the scope the report or the call carries.
 * @param mode - the mode the report ran under.
 * @param names - what names things.
 * @returns the scope's name.
 */
export function scopeName(scope: string, mode: string | undefined, names: NameContext): string {
  if (scope === 'all') return names.t('checkScopeAll')
  return phaseLabel(scope, mode, names) === undefined ? checkName(scope, names) : phaseName(scope, mode, names)
}

/** One research tool: its name in the conversation, and what each of its actions did. */
interface Family {
  key: ResearchKey
  /** By action id; a tool without actions describes every call under `''`. */
  actions: ReadonlyMap<string, Describe>
}

const family = (key: ResearchKey, actions: Record<string, Describe>): Family => ({ key, actions: new Map(Object.entries(actions)) })

/** The research tools by wire name, as the research host registers them. */
const FAMILIES: ReadonlyMap<string, Family> = new Map([
  ['research_project', family('toolProject', {
    current: plain('toolProjectCurrent'),
    create: about('toolProjectCreate', 'title'),
    list: plain('toolProjectList'),
    modes: plain('toolProjectModes'),
    'set-mode': (args, names) => detail(names.t, 'toolProjectSetMode', modeChoiceName(args, names)),
    'set-autonomy': (args, names) => detail(names.t, 'toolProjectSetAutonomy', autonomyName(args, names.t)),
    'record-decision': about('toolProjectDecision', 'question'),
    rename: about('toolProjectRename', 'title'),
    memory: plain('toolProjectMemory'),
  })],
  ['research_check', family('toolCheck', {
    '': (args, names) => scopeName(field(args, 'scope') ?? 'all', names.project?.mode, names),
  })],
  ['research_evidence', family('toolEvidence', {
    import: count('toolEvidenceImportOne', 'toolEvidenceImport', 'paths'),
    'refresh-evidence': plain('toolEvidenceRefresh'),
    'search-evidence': about('toolEvidenceSearch', 'query'),
    claim: aboutInner('toolEvidenceClaim', 'claim', 'text'),
    'literature-search': about('toolEvidenceLiteratureSearch', 'query'),
    'literature-import': aboutInner('toolEvidenceLiteratureImport', 'item', 'title'),
  })],
  ['research_artifact', family('toolArtifact', {
    'save-artifact': about('toolArtifactSave', 'path'),
    'register-artifact': about('toolArtifactRegister', 'path'),
    'read-artifact': plain('toolArtifactRead'),
    'list-venues': about('toolArtifactVenues', 'query'),
    'apply-template': about('toolArtifactApplyTemplate', 'venue'),
    'import-template': count('toolArtifactImportTemplateOne', 'toolArtifactImportTemplate', 'paths'),
    compile: about('toolArtifactCompile', 'path'),
    'render-pages': plain('toolArtifactRenderPages'),
    'run-script': about('toolArtifactRunScript', 'script'),
    export: plain('toolArtifactExport'),
  })],
  ['research_environment', family('toolEnvironment', {
    environment: aboutInner('toolEnvironmentPrepare', 'environment', 'name'),
  })],
  ['research_experiment', family('toolExperiment', {
    experiment: aboutInner('toolExperimentSubmit', 'spec', 'name'),
    'experiment-refresh': plain('toolExperimentRefresh'),
    'experiment-cancel': plain('toolExperimentCancel'),
    'experiment-dismiss': plain('toolExperimentDismiss'),
    'experiment-logs': plain('toolExperimentLogs'),
    'experiment-wait': count('toolExperimentWaitOne', 'toolExperimentWait', 'runIds'),
  })],
  ['research_board', family('toolBoard', {
    'board-get': plain('toolBoardGet'),
    'board-update': plain('toolBoardUpdate'),
    'board-refresh': plain('toolBoardRefresh'),
  })],
  ['research_media', family('toolMedia', {
    'visual-review': plain('toolMediaVisualReview'),
    'complete-visual-review': plain('toolMediaCompleteReview'),
    'generate-image': about('toolMediaGenerate', 'path'),
    'find-reference-figures': about('toolMediaFindFigures', 'query'),
    'fetch-reference-figures': count('toolMediaFetchFiguresOne', 'toolMediaFetchFigures', 'galleryIds', 'arxivIds'),
    'audit-svg': about('toolMediaAuditSvg', 'path'),
    'export-figure': about('toolMediaExportFigure', 'path'),
  })],
  ['research_knowledge', family('toolKnowledge', {
    'graph-status': plain('toolKnowledgeStatus'),
    'graph-view': plain('kgOpen'),
    recall: recalled,
    novelty: plain('toolKnowledgeNovelty'),
    'build-graph': plain('toolKnowledgeBuild'),
    'name-patterns': plain('toolKnowledgeName'),
    mark: plain('toolKnowledgeMark'),
    unmark: plain('toolKnowledgeUnmark'),
    marks: marksRead,
    'relations-propose': plain('toolKnowledgeRelationsPropose'),
    'relations-reject': plain('toolKnowledgeRelationsReject'),
    'relations-neighbourhood': about('toolKnowledgeRelationsNeighbourhood', 'entity'),
    'relations-paths': pathsFound,
    'relations-gaps': plain('toolKnowledgeRelationsGaps'),
    'relations-suggestions': plain('toolKnowledgeRelationsSuggestions'),
  })],
  ['research_task', family('toolTask', {
    '': plain('toolTaskRead'),
  })],
])

/** The wire names of the research tools, each of which gets a research card. */
export const RESEARCH_TOOLS: readonly string[] = [...FAMILIES.keys()]

/**
 * A research tool's name in the conversation.
 * @param tool - the wire tool name.
 * @param t - bound dictionary lookup.
 * @returns the tool's name in the reader's language; a tool this build does not know keeps its wire name.
 */
export function familyName(tool: string, t: Translate): string {
  const known = FAMILIES.get(tool)
  return known === undefined ? tool : t(known.key)
}

/**
 * What one call did, from its arguments: `导入 3 个文件`, `设定模式：spark-to-paper`.
 * @param tool - the wire tool name.
 * @param args - the call's arguments.
 * @param names - what names things.
 * @param trace - what a knowledge call touched, once it settled; its phrases then carry the counts.
 * @returns the phrase; `执行 <action>` for an action this build does not know;
 *   undefined while the arguments are incomplete or name no action.
 */
export function actionPhrase(tool: string, args: Fields | undefined, names: NameContext, trace?: KnowledgeTrace): string | undefined {
  const known = FAMILIES.get(tool)
  if (known === undefined || args === undefined) return undefined
  const action = field(args, 'action') ?? ''
  const describe = known.actions.get(action)
  if (describe !== undefined) return describe(args, names, trace)
  return action === '' ? undefined : names.t('toolUnknownAction', { action })
}

/** One finding of a report, as the card lists it. */
export interface ReportFinding {
  check: string
  severity: 'error' | 'warning'
  message: string
  file?: string | undefined
  line?: number | undefined
}

/** One check's findings in a report. */
export interface FindingGroup {
  check: string
  errors: number
  warnings: number
  /** The first file its findings name, errors first; see {@link CheckView.filesExist} for whether it was on disk. */
  file?: string | undefined
  line?: number | undefined
}

/** What a report says for the card. */
export interface CheckView {
  clean: boolean
  scope: string
  /** The mode the check ran under; absent on reports that did not say. */
  mode?: string | undefined
  errors: number
  warnings: number
  /** One group per check with findings, groups with errors first. */
  groups: FindingGroup[]
  /**
   * The files the report names were on disk when it ran. A report that lists
   * the gates it ran comes from a host that drops a finding's missing file;
   * an earlier report may name a file that never existed.
   */
  filesExist: boolean
  /**
   * Why a check that found no error did not pass: requirements of the
   * checked phase, or phases of the paper, still open. Absent when it passed,
   * found errors, or states no reason.
   */
  open?: { kind: 'requirements' | 'phases'; n: number } | undefined
  /** Every finding, in the check's own words. */
  findings: ReportFinding[]
  /** What each unfinished phase the scope covers still lacks, in the check's own words. */
  missing: { phase: string; lines: string[] }[]
}

/** The array a field holds, or none. */
function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** A finding as the host writes one, or undefined for anything else. */
function findingOf(value: unknown): ReportFinding | undefined {
  if (!isFields(value) || typeof value.check !== 'string' || typeof value.message !== 'string') return undefined
  return {
    check: value.check,
    severity: value.severity === 'error' ? 'error' : 'warning',
    message: value.message,
    ...typeof value.file === 'string' ? { file: value.file } : {},
    ...typeof value.line === 'number' ? { line: value.line } : {},
  }
}

/** A phase status as the host writes one, or undefined for anything else. */
function phaseOf(value: unknown): { id: string; done: boolean; missing: string[] } | undefined {
  if (!isFields(value) || typeof value.id !== 'string') return undefined
  return { id: value.id, done: value.done === true, missing: list(value.missing).filter((line): line is string => typeof line === 'string') }
}

/** The findings grouped by check in the order the report lists them, groups with errors first. */
function groupsOf(findings: readonly ReportFinding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>()
  for (const finding of findings) {
    const group = groups.get(finding.check) ?? { check: finding.check, errors: 0, warnings: 0 }
    if (finding.severity === 'error') group.errors++
    else group.warnings++
    if (group.file === undefined && finding.file !== undefined) {
      group.file = finding.file
      group.line = finding.line
    }
    groups.set(finding.check, group)
  }
  return [...groups.values()].sort((a, b) => Number(b.errors > 0) - Number(a.errors > 0))
}

/**
 * The report a research_check call returned.
 * @param block - a settled research_check call.
 * @returns what the card shows, or undefined when the result is not a report.
 */
export function checkView(block: ToolCallBlock): CheckView | undefined {
  const report = objectOf(resultText(block))?.check
  if (!isFields(report) || typeof report.clean !== 'boolean' || typeof report.scope !== 'string') return undefined
  const { clean, scope } = report
  const findings = list(report.findings).map(findingOf).filter(finding => finding !== undefined)
  const phases = list(report.phases).map(phaseOf).filter(phase => phase !== undefined)
  const errors = findings.filter(finding => finding.severity === 'error').length
  const scoped = phases.find(phase => phase.id === scope)
  // A phase scope covers its phase, scope all the whole route, and a single check no phase.
  const covered = scoped !== undefined ? [scoped] : scope === 'all' ? phases : []
  const unfinished = covered.filter(phase => !phase.done)
  const reason = (): CheckView['open'] => {
    if (clean || errors > 0) return undefined
    if (scoped !== undefined) return { kind: 'requirements', n: scoped.missing.length }
    return unfinished.length === 0 ? undefined : { kind: 'phases', n: unfinished.length }
  }
  return {
    clean, scope, ...typeof report.mode === 'string' ? { mode: report.mode } : {},
    errors, warnings: findings.length - errors, groups: groupsOf(findings), open: reason(), findings,
    filesExist: Array.isArray(report.gatesRun),
    missing: unfinished.filter(phase => phase.missing.length > 0).map(phase => ({ phase: phase.id, lines: phase.missing })),
  }
}
