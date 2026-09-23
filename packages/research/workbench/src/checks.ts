/**
 * Definition-of-done checks the agent runs on its own paper. They read the
 * files as they exist on disk and report; nothing here ever refuses an action.
 * The base checks run in every mode; a mode pack adds its phases (each with the
 * facts it requires and the checks that decide it) and its own gates, which a
 * caller-supplied runner executes. A phase is done when its requirements hold
 * and its checks carry no errors — whether to keep working is the agent's
 * call, guided by its skills.
 */
import { stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { errorText, projectPath, readText } from './files.ts'
import {
  bibliographyFiles, citations, documentClass, findMainManuscript, flattenPaper, graphicReferences,
  listProjectFiles, originAt, paperDigest, paperModifiedAt, parseBibliography, sections,
  type BibEntry, type FlatPaper,
} from './latex.ts'
import type { ModeCondition, ModePhase, ModeScript, ResolvedMode } from './modes.ts'
import { validateLinks } from './project.ts'
import { checkIds } from './schema.ts'
import type { CheckFinding, CheckId, CheckReport, PhaseStatus, ResearchProject } from './types.ts'

/**
 * Runs one of the mode pack's gates over the project. The service supplies it,
 * so this module never starts a process itself.
 * @returns the gate's findings, each tagged with the gate's id.
 */
export type GateRunner = (gate: ModeScript, mode: ResolvedMode, project: ResearchProject) => Promise<CheckFinding[]>

const RESULT_SECTION = /experiment|result|evaluat|ablation|analys|benchmark|实验|结果|评估|消融/i
const CONCLUSION_SECTION = /conclu|summary|discussion|结论|总结|讨论/i
const EXPECTED_SECTIONS: { label: string; pattern: RegExp }[] = [
  { label: 'Introduction', pattern: /intro|引言|绪论/i },
  { label: 'Related work', pattern: /related|background|prior|literature|相关工作|背景/i },
  { label: 'Method', pattern: /method|approach|model|framework|design|方法|模型/i },
  { label: 'Experiments', pattern: RESULT_SECTION },
  { label: 'Conclusion', pattern: CONCLUSION_SECTION },
]
const LENGTH_UNIT = /^\s*(?:pt|em|ex|cm|mm|in|bp|pc|sp|\\(?:line|text|column)width|\\textheight|\\hsize|\\baselineskip)/
const MAX_FINDINGS_PER_CHECK = 25

interface Context {
  project: ResearchProject
  mode: ResolvedMode
  limit: number
  paper?: FlatPaper | undefined
  findings: CheckFinding[]
  bibEntries: BibEntry[]
  graphicsCount: number
  reviewExists: boolean
}

/**
 * Run the checks and fold them into phase progress for the project's mode.
 * @param project - the ledger; only read.
 * @param limit - byte ceiling for any single file read.
 * @param scope - `all` (default), a phase of the mode, a base check or one of the mode's gates.
 * @param mode - the mode in effect, as the registry resolved it.
 * @param runGate - executes the mode's gates; without one, gates are reported as not run.
 */
export async function runChecks(
  project: ResearchProject, limit: number, scope: string | undefined, mode: ResolvedMode, runGate?: GateRunner,
): Promise<CheckReport> {
  const context: Context = { project, mode, limit, findings: [], bibEntries: [], graphicsCount: 0, reviewExists: false }
  const main = await findMainManuscript(project, limit)
  if (main === undefined) {
    add(context, 'structure', 'error', 'No LaTeX manuscript yet: write one with \\documentclass (for example paper/main.tex)')
  } else {
    try {
      context.paper = await flattenPaper(project.root, main, limit)
    } catch (error) {
      add(context, 'structure', 'error', `The manuscript could not be read: ${errorText(error)}`, main)
    }
  }
  const paper = context.paper
  if (paper) {
    await checkCitations(context, paper)
    await checkNumbers(context, paper)
    checkPlaceholders(context, paper)
    await checkFigures(context, paper)
    await checkCompile(context, paper)
    checkStructure(context, paper)
  }
  await checkReview(context)
  checkLedger(context)
  await runGates(context, gatesInScope(mode, scope ?? 'all'), runGate)
  const phases = await phaseProgress(context)
  return summarize(context, phases, scope ?? 'all')
}

/** The mode's gates a scope calls for: all of them, those deciding one phase, or one by id. */
function gatesInScope(mode: ResolvedMode, scope: string): ModeScript[] {
  if ((checkIds as readonly string[]).includes(scope)) return []
  const phase = mode.phases.find(item => item.id === scope)
  if (phase) return phase.checks === 'all' ? mode.gates : mode.gates.filter(gate => phase.checks.includes(gate.id))
  const gate = mode.gates.find(item => item.id === scope)
  return gate ? [gate] : mode.gates
}

async function runGates(context: Context, gates: ModeScript[], runGate: GateRunner | undefined): Promise<void> {
  for (const gate of gates) {
    if (!runGate) { add(context, gate.id, 'error', 'This gate could not run here'); continue }
    try {
      const findings = await runGate(gate, context.mode, context.project)
      context.findings.push(...findings.slice(0, MAX_FINDINGS_PER_CHECK).map(finding => ({ ...finding, check: gate.id })))
      if (findings.length > MAX_FINDINGS_PER_CHECK) add(context, gate.id, 'error', `…and ${findings.length - MAX_FINDINGS_PER_CHECK} more findings`)
    } catch (error) {
      add(context, gate.id, 'error', `The gate failed to run: ${errorText(error)}`)
    }
  }
}

function add(context: Context, check: string, severity: CheckFinding['severity'], message: string, file?: string, line?: number): void {
  context.findings.push({ check, severity, message, ...(file === undefined ? {} : { file }), ...(line === undefined ? {} : { line }) })
}

function addAt(context: Context, paper: FlatPaper, check: CheckId, severity: CheckFinding['severity'], message: string, offset: number): void {
  const origin = originAt(paper, offset)
  add(context, check, severity, message, origin.file, origin.line)
}

async function checkCitations(context: Context, paper: FlatPaper): Promise<void> {
  const { project, limit } = context
  const files = new Set(await bibliographyFiles(project.root, paper))
  for (const artifact of project.artifacts) if (artifact.kind === 'bibliography') files.add(artifact.path)
  for (const file of files) {
    try { context.bibEntries.push(...parseBibliography(await readText(await projectPath(project.root, file), limit), file)) }
    catch (error) { add(context, 'cite', 'error', `Bibliography unreadable: ${errorText(error)}`, file) }
  }
  const keys = new Set(context.bibEntries.map(entry => entry.key))
  const cited = citations(paper)
  if (cited.length && !files.size) add(context, 'cite', 'error', 'The paper cites sources but names no bibliography file (\\bibliography or \\addbibresource)', paper.main)
  const reported = new Set<string>()
  for (const { key, offset } of cited) {
    if (keys.has(key) || reported.has(key)) continue
    reported.add(key)
    addAt(context, paper, 'cite', 'error', `Citation key has no bibliography entry: ${key}`, offset)
  }
  const verified = project.evidence.filter(source => source.kind === 'literature' && source.verified && !source.stale)
  const citedKeys = new Set(cited.map(item => item.key))
  for (const entry of context.bibEntries) {
    if (!citedKeys.has(entry.key)) continue
    const has = (...names: string[]): boolean => names.some(name => entry.fields.has(name))
    if (!has('title') || !has('author', 'editor') || !has('year', 'date')) {
      add(context, 'cite', 'error', `Incomplete bibliography entry ${entry.key}: needs author, title and year`, entry.file, entry.line)
      continue
    }
    if (!has('journal', 'booktitle', 'publisher', 'doi', 'url', 'eprint', 'howpublished', 'school', 'institution')) {
      add(context, 'cite', 'warning', `Bibliography entry ${entry.key} names no venue, DOI or URL`, entry.file, entry.line)
    }
    const matched = verified.some(source => (entry.doi !== undefined && source.doi?.toLowerCase() === entry.doi)
      || (entry.eprint !== undefined && source.sourceUrl?.includes(entry.eprint) === true)
      || source.chunks.some(chunk => chunk.locator.key === 'bibtex' && chunk.text.replace(/\s/g, '') === entry.raw.replace(/\s/g, '')))
    if (!matched) add(context, 'cite', 'warning', `Bibliography entry ${entry.key} was not verified against a scholarly provider (literature-import)`, entry.file, entry.line)
  }
}

/** Rounded spellings of every recorded fact, so a paper value can be traced in constant time. */
function factSpellings(values: number[]): Set<string> {
  const spellings = new Set<string>()
  for (const value of values) {
    for (const scaled of [value, value * 100, value / 100]) {
      for (let digits = 0; digits <= 6; digits++) {
        spellings.add(`${digits}:${scaled.toFixed(digits)}`)
        const factor = 10 ** digits
        spellings.add(`${digits}:${(Math.trunc(scaled * factor) / factor).toFixed(digits)}`)
      }
    }
  }
  return spellings
}

function numbersIn(text: string): number[] {
  return [...text.matchAll(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g)].map(match => Number(match[0])).filter(Number.isFinite)
}

async function recordedFacts(context: Context): Promise<number[]> {
  const { project, limit } = context
  const facts: number[] = []
  for (const source of project.evidence) {
    if (source.coverage === 'data' && !source.stale) for (const chunk of source.chunks) facts.push(...numbersIn(chunk.text))
  }
  for (const run of project.experiments) if (run.status === 'completed') facts.push(...Object.values(run.metrics), ...numbersIn(run.spec.argv.join(' ')))
  // Setup values (learning rates, batch sizes) are traced to the code and configuration that uses them.
  const configurations = await listProjectFiles(project.root, path => /^code\/.*\.(ya?ml|json|toml|cfg|ini|py)$/i.test(path), 4)
  let budget = limit * 2
  for (const file of configurations) {
    try {
      const text = await readText(join(project.root, file), Math.min(limit, 256 * 1024))
      budget -= text.length
      if (budget < 0) break
      facts.push(...numbersIn(text))
    } catch { /* an oversized or unreadable file contributes no facts */ }
  }
  return facts
}

/** Remove commands whose arguments carry layout numbers or identifiers, never results. */
function withoutLayout(text: string): string {
  return text
    .replace(/\\(?:[A-Za-z]*cite[A-Za-z]*|ref|eqref|autoref|cref|Cref|label|url|input|include|includegraphics|includesvg|bibliography|addbibresource|tbd|todo)\*?\s*(?:\[[^\]]*\])*\s*\{[^}]*\}/g, m => ' '.repeat(m.length))
    .replace(/\\(?:vspace|hspace|setlength|addtolength|rule|resizebox|scalebox|multicolumn|multirow|cmidrule|cline|arraystretch|tabcolsep|renewcommand|newcommand|setcounter)\*?\s*(?:\([^)]*\))?\s*(?:\{[^}]*\}|\[[^\]]*\])*/g, m => ' '.repeat(m.length))
    .replace(/\\begin\s*\{[^}]+\}\s*(?:\[[^\]]*\])?\s*(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})?/g, m => ' '.repeat(m.length))
}

async function checkNumbers(context: Context, paper: FlatPaper): Promise<void> {
  const facts = factSpellings(await recordedFacts(context))
  // Layout arguments are blanked to spaces of equal length, so offsets still index the original text,
  // where table and section boundaries are found.
  const text = withoutLayout(paper.text)
  const tables: [number, number][] = [...paper.text.matchAll(/\\begin\s*\{(tabular\*?|tabularx|longtable|tblr)\}[\s\S]*?\\end\s*\{\1\}/g)]
    .map(match => [match.index, match.index + match[0].length])
  const regions: [number, number][] = []
  for (const section of sections(paper)) {
    if (RESULT_SECTION.test(section.title) || CONCLUSION_SECTION.test(section.title)) regions.push([section.start, section.end])
  }
  for (const match of paper.text.matchAll(/\\begin\s*\{abstract\}[\s\S]*?\\end\s*\{abstract\}/g)) {
    regions.push([match.index, match.index + match[0].length])
  }
  const within = (ranges: [number, number][], offset: number): boolean => ranges.some(([start, end]) => offset >= start && offset < end)
  let reported = 0
  for (const match of text.matchAll(/(?<![\w.\\])(\d+\.\d+|\d+)(\s*\\?%)?/g)) {
    const offset = match.index
    const raw = String(match[1])
    const percent = match[2] !== undefined
    if (!raw.includes('.') && !percent) continue
    if (LENGTH_UNIT.test(text.slice(offset + match[0].length, offset + match[0].length + 16))) continue
    const inTable = within(tables, offset)
    if (!inTable && !within(regions, offset)) continue
    const digits = raw.split('.')[1]?.length ?? 0
    if (facts.has(`${digits}:${Number(raw).toFixed(digits)}`)) continue
    if (reported++ >= MAX_FINDINGS_PER_CHECK) continue
    addAt(context, paper, 'numbers', inTable ? 'error' : 'warning',
      `${raw}${percent ? '%' : ''} does not trace to any collected metric, imported data or code value — never state a number the data does not give`, offset)
  }
  if (reported > MAX_FINDINGS_PER_CHECK) add(context, 'numbers', 'error', `…and ${reported - MAX_FINDINGS_PER_CHECK} more untraced numbers`, paper.main)
}

function checkPlaceholders(context: Context, paper: FlatPaper): void {
  let count = 0
  const report = (offset: number, what: string): void => {
    if (count++ < MAX_FINDINGS_PER_CHECK) addAt(context, paper, 'placeholders', 'error', `Placeholder remains: ${what}`, offset)
  }
  for (const match of paper.text.matchAll(/\\(?:tbd|todo)\s*\{([^}]*)\}|\b(?:TODO|TBD|FIXME)\b|XX\.X+|待补|待填|实验占位/g)) {
    report(match.index, match[1] !== undefined ? `\\tbd{${match[1]}}` : match[0])
  }
  for (const table of paper.text.matchAll(/\\begin\s*\{(tabular\*?|tabularx|longtable|tblr)\}[\s\S]*?\\end\s*\{\1\}/g)) {
    const cells = [...table[0].matchAll(/(?:^|&|\\\\)\s*(--)\s*(?=&|\\\\|$)/gm)]
    const [first] = cells
    if (first) report(table.index + first.index, `${cells.length} empty result cell(s) "--" in a table`)
  }
  if (count > MAX_FINDINGS_PER_CHECK) add(context, 'placeholders', 'error', `…and ${count - MAX_FINDINGS_PER_CHECK} more placeholders`, paper.main)
}

async function checkFigures(context: Context, paper: FlatPaper): Promise<void> {
  const { project } = context
  const references = await graphicReferences(project.root, paper)
  context.graphicsCount = references.length
  for (const reference of references) {
    if (!reference.resolved) {
      addAt(context, paper, 'figures', 'error', `Included figure not found: ${reference.name}`, reference.offset)
      continue
    }
    const artifact = project.artifacts.find(item => item.path === reference.resolved)
    if (artifact?.kind !== 'figure') continue
    const hasData = artifact.evidence.some(link => project.evidence.some(source => source.id === link.evidenceId && source.coverage === 'data'))
    const hasScript = artifact.inputArtifacts.some(link => project.artifacts.some(item => item.id === link.id && item.kind === 'code'))
    if (!hasData || !hasScript) addAt(context, paper, 'figures', 'warning', `Result plot ${artifact.path} does not record the data and script that produced it`, reference.offset)
    if (/\.(png|jpe?g)$/i.test(artifact.path)) addAt(context, paper, 'figures', 'warning', `Result plot ${artifact.path} is raster; export plots as vector PDF`, reference.offset)
  }
  for (const diagram of project.artifacts.filter(item => item.kind === 'diagram' && item.path.endsWith('.drawio'))) {
    const stem = diagram.path.replace(/\.drawio$/, '')
    const exported = references.some(ref => ref.resolved?.replace(/\.[^.]+$/, '').endsWith(posix.basename(stem)))
    if (!exported) add(context, 'figures', 'warning', `Diagram ${diagram.path} is not included in the paper; export it and \\includegraphics it`, diagram.path)
  }
}

async function checkCompile(context: Context, paper: FlatPaper): Promise<void> {
  const { project } = context
  const latest = project.compilations
    .filter(record => project.artifacts.some(item => item.id === record.artifactId && item.path === paper.main))
    .at(-1)
  if (!latest) { add(context, 'compile', 'error', 'The paper has not been compiled yet', paper.main); return }
  if (latest.status === 'failed') {
    const first = latest.diagnostics.filter(line => /^!|Error|fatal/i.test(line)).slice(0, 3).join(' | ')
    add(context, 'compile', 'error', `The last compile failed${first ? `: ${first}` : ''} (log: ${latest.logPath})`, paper.main)
    return
  }
  if (latest.inputDigest !== await paperDigest(project.root, paper)) {
    add(context, 'compile', 'error', 'Sources changed since the last successful compile; compile again', paper.main)
  }
  const undefinedReferences = latest.diagnostics.filter(line => /Reference .* undefined|undefined references/i.test(line))
  if (undefinedReferences.length) add(context, 'compile', 'warning', `Undefined cross-references: ${undefinedReferences.slice(0, 3).join(' | ')}`, paper.main)
  const overfull = latest.diagnostics.filter(line => /Overfull/i.test(line)).length
  if (overfull) add(context, 'compile', 'warning', `${overfull} overfull box(es) in the compiled PDF`, paper.main)
  const inspected = project.visualReviews.some(review => ['rendered', 'reviewed'].includes(review.status) && review.inputDigest === latest.inputDigest)
  if (!inspected) add(context, 'visual', 'warning', 'The compiled pages have not been looked at since the last compile: render-pages, then read_image each page', latest.pdfPath)
}

function checkStructure(context: Context, paper: FlatPaper): void {
  for (const missing of paper.missingInputs) add(context, 'structure', 'error', `\\input target not found: ${missing.name}`, missing.origin.file, missing.origin.line)
  // Without a pipeline the paper may be anything — a note, a chapter — so its shape is not judged.
  if (context.mode.phases.length === 0) return
  const titles = sections(paper).map(section => section.title)
  if (!/\\begin\s*\{abstract\}|\\abstract\s*\{/.test(paper.text)) add(context, 'structure', 'warning', 'No abstract', paper.main)
  for (const expected of EXPECTED_SECTIONS) {
    if (!titles.some(title => expected.pattern.test(title))) add(context, 'structure', 'warning', `No ${expected.label} section`, paper.main)
  }
  if (['article', 'report', 'ctexart'].includes(documentClass(paper) ?? '')) {
    add(context, 'structure', 'warning', 'The paper uses a generic document class; apply the venue template (apply-template) before submission', paper.main)
  }
}

async function checkReview(context: Context): Promise<void> {
  const { project, limit, paper } = context
  const reviews = await listProjectFiles(project.root, path => /(^|\/)(reviews?\/[^/]+|review[\w-]*)\.md$/i.test(path), 3)
  if (!reviews.length) {
    add(context, 'review', 'warning', 'No review yet: run the paper-review skill and write its findings to reviews/review.md')
    return
  }
  context.reviewExists = true
  let newest = 0
  for (const review of reviews) {
    newest = Math.max(newest, (await stat(join(project.root, review))).mtimeMs)
    const text = await readText(join(project.root, review), limit)
    text.split(/\r?\n/).forEach((line, index) => {
      if (/^\s*[-*]\s*\[ \]\s*\[(?:blocker|major)\]/i.test(line)) add(context, 'review', 'error', `Open review issue: ${line.replace(/^\s*[-*]\s*\[ \]\s*/, '').slice(0, 160)}`, review, index + 1)
    })
  }
  if (paper && newest < await paperModifiedAt(project.root, paper)) {
    add(context, 'review', 'warning', 'The latest review predates the latest manuscript changes', reviews[0])
  }
}

function checkLedger(context: Context): void {
  const { project } = context
  for (const artifact of project.artifacts) if (artifact.stale) add(context, 'stale', 'warning', 'Out of date: its inputs changed after it was made', artifact.path)
  for (const source of project.evidence) if (source.stale) add(context, 'stale', 'warning', `Source changed or its run inputs changed: ${source.title}`, source.path)
  for (const claim of project.claims) {
    if (claim.state === 'contradicted') add(context, 'claims', 'warning', `Contradicted by the evidence — make sure the paper says so: ${claim.text.slice(0, 160)}`)
    try { validateLinks(project, claim.evidence) } catch (error) { add(context, 'claims', 'error', `${claim.id}: ${errorText(error)}`) }
  }
}

/**
 * A case-insensitive matcher for a project-relative glob (`*`, `?`, `**`,
 * `{a,b}`). A pattern without a slash matches a file name at any depth.
 * @param glob - the pattern a mode pack wrote.
 * @returns whether a project-relative path matches.
 */
export function globMatcher(glob: string): (path: string) => boolean {
  const escape = (text: string): string => text.replace(/[.+^$()|[\]\\{}*?]/g, '\\$&')
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index] as string
    const close = character === '{' ? glob.indexOf('}', index) : -1
    if (glob.startsWith('**/', index)) { source += '(?:.*/)?'; index += 2 }
    else if (glob.startsWith('**', index)) { source += '.*'; index += 1 }
    else if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else if (close > index) { source += `(?:${glob.slice(index + 1, close).split(',').map(escape).join('|')})`; index = close }
    else source += escape(character)
  }
  const pattern = new RegExp(`^${source}$`, 'i')
  return glob.includes('/') ? path => pattern.test(path) : path => pattern.test(posix.basename(path))
}

/** What the phases can require of the project, gathered once per check. */
interface Facts {
  paper: boolean
  bibEntries: number
  sections: number
  figures: number
  pagesInspected: boolean
  reviewCurrent: boolean
  completedRuns: number
  activeRuns: number
  dataSources: number
  /** Project files, listed only when a phase asks about files or diagrams. */
  files: () => Promise<string[]>
  diagram: () => Promise<boolean>
}

/** The facts a check found, with file listings deferred until a requirement needs them. */
function gatherFacts(context: Context): Facts {
  const { project, paper } = context
  let listing: Promise<string[]> | undefined
  const files = (): Promise<string[]> => listing ??= listProjectFiles(project.root, () => true, 4)
  return {
    paper: paper !== undefined,
    bibEntries: context.bibEntries.length,
    sections: paper ? sections(paper).length : 0,
    figures: context.graphicsCount,
    pagesInspected: !context.findings.some(finding => finding.check === 'visual'),
    reviewCurrent: context.reviewExists && !context.findings.some(finding => finding.check === 'review'),
    completedRuns: project.experiments.filter(run => run.status === 'completed' && run.collected).length,
    activeRuns: project.experiments.filter(run => ['queued', 'running'].includes(run.status)).length,
    dataSources: project.evidence.filter(source => source.coverage === 'data' && !source.stale).length,
    files,
    // An architecture diagram is an editable draw.io file or a TikZ picture in the paper itself.
    diagram: async () => project.artifacts.some(item => item.kind === 'diagram' && !item.stale)
      || /\\begin\s*\{tikzpicture\}/.test(paper?.text ?? '')
      || (await files()).some(path => path.endsWith('.drawio')),
  }
}

/** Why a condition does not hold yet, or undefined when it does. */
async function unmet(condition: ModeCondition, facts: Facts): Promise<string | undefined> {
  if (typeof condition === 'string') {
    switch (condition) {
      case 'manuscript': return facts.paper ? undefined : 'No manuscript yet'
      case 'diagram': return await facts.diagram() ? undefined : 'No editable architecture diagram (draw.io file or TikZ picture)'
      case 'pagesInspected': return facts.pagesInspected ? undefined : 'Compiled pages not inspected'
      case 'reviewCurrent': return facts.reviewCurrent ? undefined : 'No current review'
      case 'runsCollected': return facts.completedRuns ? undefined : 'No completed, collected experiment run'
      case 'noActiveRuns': return facts.activeRuns ? `${facts.activeRuns} run(s) still in progress` : undefined
      case 'dataEvidence': return facts.dataSources ? undefined : 'No data evidence: import the measured results'
      case 'resultsOrData': return facts.completedRuns || facts.dataSources ? undefined : 'No collected results to report'
    }
  }
  if ('file' in condition) {
    const min = condition.min ?? 1
    const matches = globMatcher(condition.file)
    const found = (await facts.files()).filter(matches).length
    if (found >= min) return undefined
    return found === 0 ? `No file matching ${condition.file}` : `Fewer than ${min} files matching ${condition.file} (${found})`
  }
  const [have, need, noun] = 'bibEntries' in condition
    ? [facts.bibEntries, condition.bibEntries, 'bibliography entries']
    : 'sections' in condition ? [facts.sections, condition.sections, 'sections'] : [facts.figures, condition.figures, 'figures in the paper']
  if (have >= need) return undefined
  return have === 0 ? `No ${noun} yet` : `Fewer than ${need} ${noun} (${have})`
}

/** The checks whose errors hold a phase back. */
function decidingChecks(phase: ModePhase, context: Context): Set<string> {
  return new Set(phase.checks === 'all' ? [...checkIds, ...context.mode.gates.map(gate => gate.id)] : phase.checks)
}

async function phaseProgress(context: Context): Promise<PhaseStatus[]> {
  const facts = gatherFacts(context)
  const statuses: PhaseStatus[] = []
  for (const phase of context.mode.phases) {
    const missing: string[] = []
    const deciding = decidingChecks(phase, context)
    const blocking = context.findings.filter(finding => finding.severity === 'error' && deciding.has(finding.check))
    if (blocking.length) missing.push(`${blocking.length} error(s) in ${[...new Set(blocking.map(item => item.check))].join(', ')}`)
    for (const requirement of phase.requires) {
      const alternatives = Array.isArray(requirement.when) ? requirement.when : [requirement.when]
      const reasons: string[] = []
      for (const condition of alternatives) {
        const reason = await unmet(condition, facts)
        if (reason === undefined) break
        reasons.push(reason)
      }
      if (reasons.length === alternatives.length) missing.push(requirement.message ?? reasons[0] as string)
    }
    statuses.push({ id: phase.id, done: missing.length === 0, missing })
  }
  return statuses
}

function summarize(context: Context, phases: PhaseStatus[], scope: string): CheckReport {
  const { mode } = context
  let findings = context.findings
  // The whole paper is done only when nothing is wrong and every phase of its mode is done.
  let clean = !findings.some(finding => finding.severity === 'error') && phases.every(phase => phase.done)
  const phase = mode.phases.find(item => item.id === scope)
  if (phase) {
    const deciding = decidingChecks(phase, context)
    findings = findings.filter(finding => deciding.has(finding.check))
    clean = phases.some(item => item.id === scope && item.done)
  } else if ((checkIds as readonly string[]).includes(scope) || mode.gates.some(gate => gate.id === scope)) {
    findings = findings.filter(finding => finding.check === scope)
    clean = !findings.some(finding => finding.severity === 'error')
  }
  findings = [...findings].sort((a, b) => Number(a.severity === 'warning') - Number(b.severity === 'warning'))
  return {
    clean, scope, mode: mode.pack.id, ...(mode.route === undefined ? {} : { route: mode.route }),
    phases, findings, checkedAt: new Date().toISOString(),
  }
}
