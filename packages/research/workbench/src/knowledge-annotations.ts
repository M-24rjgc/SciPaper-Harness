/**
 * Marks that people and the agent put on knowledge-graph results, and the
 * re-ranking that honors them. A mark pins a pattern or paper (keep it in
 * view) or calls it irrelevant to the idea, with an optional short reason.
 * A project keeps its marks in .research/kg/annotations.json.
 *
 * applyAnnotations re-ranks recall's fused candidates: pins are listed first,
 * an irrelevant target leaves the list for `skipped`, and the papers and
 * patterns near a mark move a bounded number of places, each with the mark
 * that moved it. A mark's weight on a paper is the chance that the verdict
 * reaches it along the graph's recorded similarity links when each link
 * passes it on with probability one half: every simple path of up to three
 * links counts, and the paths combine by noisy-OR. A pattern's weight is the
 * mean over its papers; a pattern mark weighs on its own papers as one link
 * would. The measurements behind these constants and the rejected
 * alternatives are in the Agent Note
 * .agents/notes/proposed/feature/2026-10-01-knowledge-graph-annotations.md.
 */
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { atomicWrite, errorText, projectPath } from './files.ts'
import type { GraphFile } from './knowledge.ts'

/** Project-relative file holding a project's marks. */
export const ANNOTATIONS_FILE = '.research/kg/annotations.json'
/** Most marks a project keeps; adding one more is refused until some are removed. */
export const MAX_ANNOTATIONS = 1000
/** Longest reason a mark carries, in UTF-16 code units after whitespace is collapsed. */
export const MAX_NOTE_LENGTH = 280
/** Longest pattern or paper id a mark can name. */
export const MAX_TARGET_ID_LENGTH = 512
/** Byte ceiling of the marks file, both as written and as read. */
export const MAX_ANNOTATIONS_BYTES = 1024 * 1024
/** Problems listed one by one before the rest are only counted. */
const LISTED_PROBLEMS = 10
/** Orphaned mark ids listed in a summary. */
const LISTED_ORPHANS = 10

/** A graph's source: `ai` for the built-in graph, `project` for the project's own. */
export type GraphSource = 'ai' | 'project'

/** What a mark points at: a pattern or paper of one graph, by its id in that graph. */
export const annotationTargetSchema = z.object({
  kind: z.enum(['pattern', 'paper']),
  graph: z.enum(['ai', 'project']),
  id: z.string().min(1).max(MAX_TARGET_ID_LENGTH),
})
/** The pattern or paper a mark points at. */
export type AnnotationTarget = z.infer<typeof annotationTargetSchema>

const verdictSchema = z.enum(['pin', 'irrelevant'])
const authorSchema = z.enum(['user', 'agent'])

/**
 * A mark as a person or the agent asks for it. The note is collapsed to one
 * line and trimmed before its length is checked; an empty note is no note.
 */
export const annotationInputSchema = z.object({
  target: annotationTargetSchema,
  verdict: verdictSchema,
  note: z.string().transform(text => text.replace(/\s+/g, ' ').trim()).pipe(z.string().max(MAX_NOTE_LENGTH)).optional(),
  by: authorSchema,
})
/** The fields of a mark to set. */
export type AnnotationInput = z.input<typeof annotationInputSchema>

const annotationSchema = z.object({
  id: z.string(),
  target: annotationTargetSchema,
  verdict: verdictSchema,
  note: z.string().min(1).max(MAX_NOTE_LENGTH).optional(),
  by: authorSchema,
  at: z.iso.datetime(),
})
/** A stored mark; `id` is {@link annotationId} of its target, so a target holds at most one mark. */
export type Annotation = z.infer<typeof annotationSchema>

const fileSchema = z.object({ version: z.number(), annotations: z.array(z.unknown()) })

/**
 * The id of the mark on a target, which is also the node id graph-view gives
 * the target (`ai:paper:<paper id>`).
 * @param target - the marked pattern or paper.
 * @returns `<graph>:<kind>:<id>`.
 */
export function annotationId(target: AnnotationTarget): string {
  return `${target.graph}:${target.kind}:${target.id}`
}

/** The marks of a project as read, and what was wrong with the stored file. */
export interface AnnotationsRead {
  /** The honored marks, ordered by id. */
  annotations: Annotation[]
  /** Each problem names the marks it keeps from being honored; empty for a sound or missing file. */
  problems: string[]
}

/** What one change to a project's marks did. */
export interface AnnotationChange {
  /** Whether the stored marks differ from before. */
  changed: boolean
  /** The mark now stored on the target; absent after a removal. */
  annotation?: Annotation | undefined
  /** The mark this change replaced or removed. */
  previous?: Annotation | undefined
  /** Problems of the stored file this change repaired by rewriting it. */
  problems: string[]
  /** Project-relative copy of the damaged file, kept before it was rewritten. */
  backup?: string | undefined
}

/**
 * The stored file as loaded. `damaged` holds the marks that could be read,
 * and the next change rewrites the file after keeping a copy; `newer` is a
 * format this build does not know, which is never rewritten.
 */
type Stored =
  | { state: 'missing' | 'sound' | 'damaged'; annotations: Annotation[]; problems: string[] }
  | { state: 'newer'; annotations: []; problems: [string] }

function listed(problems: string[]): string[] {
  if (problems.length <= LISTED_PROBLEMS) return problems
  return [...problems.slice(0, LISTED_PROBLEMS), `and ${problems.length - LISTED_PROBLEMS} more problems`]
}

function byId(a: Annotation, b: Annotation): number { return a.id < b.id ? -1 : 1 }

function parseStored(text: string): Stored {
  let data: unknown
  try { data = JSON.parse(text) } catch (error) {
    return { state: 'damaged', annotations: [], problems: [`${ANNOTATIONS_FILE} is not valid JSON (${errorText(error)}); none of its marks are honored`] }
  }
  const file = fileSchema.safeParse(data)
  if (!file.success) return { state: 'damaged', annotations: [], problems: [`${ANNOTATIONS_FILE} is not a marks file; none of its marks are honored`] }
  const { version, annotations } = file.data
  if (version > 1) {
    return { state: 'newer', annotations: [], problems: [`${ANNOTATIONS_FILE} has format version ${version}, written by a newer SciPaper Harness; its marks are neither honored nor changed`] }
  }
  if (version !== 1) return { state: 'damaged', annotations: [], problems: [`${ANNOTATIONS_FILE} has unknown format version ${version}; none of its marks are honored`] }
  const problems: string[] = []
  const marks = new Map<string, Annotation>()
  annotations.forEach((raw, at) => {
    const record = annotationSchema.safeParse(raw)
    if (!record.success) {
      problems.push(`mark ${at + 1} is malformed (${record.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}) and is not honored`)
      return
    }
    const id = annotationId(record.data.target)
    if (record.data.id !== id) problems.push(`mark ${at + 1} is filed as ${record.data.id} but points at ${id}; it is honored as ${id}`)
    const previous = marks.get(id)
    if (previous) problems.push(`mark ${at + 1} is a second mark on ${id}; the later of the two is honored`)
    if (!previous || Date.parse(previous.at) <= Date.parse(record.data.at)) marks.set(id, { ...record.data, id })
  })
  let kept = [...marks.values()]
  if (kept.length > MAX_ANNOTATIONS) {
    problems.push(`${ANNOTATIONS_FILE} holds ${kept.length} marks; only the newest ${MAX_ANNOTATIONS} are honored`)
    kept = kept.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_ANNOTATIONS)
  }
  return { state: problems.length ? 'damaged' : 'sound', annotations: kept.sort(byId), problems: listed(problems) }
}

/** Load the marks file; failures other than its absence or its content are thrown. */
async function load(path: string): Promise<Stored> {
  let size: number
  try { size = (await stat(path)).size } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing', annotations: [], problems: [] }
    throw error
  }
  if (size > MAX_ANNOTATIONS_BYTES) {
    return { state: 'damaged', annotations: [], problems: [`${ANNOTATIONS_FILE} is larger than ${MAX_ANNOTATIONS_BYTES} bytes; none of its marks are honored`] }
  }
  return parseStored(await readFile(path, 'utf8'))
}

/**
 * Read a project's marks without a lock: writers replace the file in one
 * rename, so a reader sees one complete version. A damaged file yields the
 * marks that could be read and its problems; it is left as it is until the
 * next change.
 * @param root - the project directory.
 * @returns the honored marks and the problems found; an unreadable file is a problem, not a failure.
 */
export async function readAnnotations(root: string): Promise<AnnotationsRead> {
  try {
    const { annotations, problems } = await load(await projectPath(root, ANNOTATIONS_FILE))
    return { annotations, problems }
  } catch (error) {
    return { annotations: [], problems: [`${ANNOTATIONS_FILE} could not be read (${errorText(error)}); no marks are honored`] }
  }
}

/** Copy the damaged file beside itself under a name no earlier copy has. */
async function keepBackup(path: string, now: Date): Promise<string> {
  const stamp = now.toISOString().replace(/[-:]|\.\d+/g, '')
  for (let copy = 1; ; copy++) {
    const suffix = `${stamp}${copy === 1 ? '' : `-${copy}`}.bak`
    try {
      await copyFile(path, `${path}.${suffix}`, constants.COPYFILE_EXCL)
      return `${ANNOTATIONS_FILE}.${suffix}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

/** One edit of the marks, applied to the map of stored marks by id. */
type Edit = (marks: Map<string, Annotation>) => { changed: boolean; annotation?: Annotation | undefined; previous?: Annotation | undefined }

/**
 * Apply an edit under the writer lock of the marks file and commit it by
 * atomic replacement. A damaged file is copied aside, then rewritten with the
 * marks that could be read; a newer format is refused.
 */
async function update(root: string, now: Date, edit: Edit): Promise<AnnotationChange> {
  const path = await projectPath(root, ANNOTATIONS_FILE)
  await mkdir(dirname(path), { recursive: true })
  return withFileLock(path, async () => {
    const stored = await load(path)
    if (stored.state === 'newer') throw new Error(stored.problems[0])
    const marks = new Map(stored.annotations.map(mark => [mark.id, mark]))
    const { changed, annotation, previous } = edit(marks)
    const result: AnnotationChange = { changed, annotation, previous, problems: stored.problems }
    if (!changed && stored.state !== 'damaged') return result
    if (marks.size > MAX_ANNOTATIONS) throw new Error(`A project keeps at most ${MAX_ANNOTATIONS} marks; remove some before adding more`)
    const text = `${JSON.stringify({ version: 1, annotations: [...marks.values()].sort(byId) }, null, 1)}\n`
    if (Buffer.byteLength(text) > MAX_ANNOTATIONS_BYTES) throw new Error(`The marks would exceed ${MAX_ANNOTATIONS_BYTES} bytes; remove some or shorten their notes`)
    if (stored.state === 'damaged') result.backup = await keepBackup(path, now)
    await atomicWrite(path, text)
    return result
  })
}

/**
 * Mark a pattern or paper. Setting the same verdict, note and author again
 * changes nothing; any other mark replaces the target's earlier one, so the
 * opposite verdict overturns it. The target is not checked against a graph:
 * a mark on an id a rebuilt graph lacks is kept and reported as orphaned.
 * @param root - the project directory.
 * @param input - the target, verdict, optional note and author; validated here.
 * @param now - the time recorded on the mark and on a backup.
 * @returns the stored mark and the one it replaced.
 */
export async function setAnnotation(root: string, input: AnnotationInput, now: Date = new Date()): Promise<AnnotationChange> {
  const { target, verdict, note, by } = annotationInputSchema.parse(input)
  const id = annotationId(target)
  return update(root, now, (marks) => {
    const previous = marks.get(id)
    const kept = note === '' ? undefined : note
    const same = previous && previous.verdict === verdict && previous.note === kept && previous.by === by
    if (same) return { changed: false, annotation: previous }
    const annotation: Annotation = { id, target, verdict, ...kept === undefined ? {} : { note: kept }, by, at: now.toISOString() }
    marks.set(id, annotation)
    return { changed: true, annotation, previous }
  })
}

/**
 * Remove the mark on a target; removing a mark that does not exist changes nothing.
 * @param root - the project directory.
 * @param id - the mark's id ({@link annotationId}).
 * @param now - the time recorded on a backup of a damaged file.
 * @returns the removed mark, if there was one.
 */
export async function removeAnnotation(root: string, id: string, now: Date = new Date()): Promise<AnnotationChange> {
  return update(root, now, (marks) => {
    const previous = marks.get(id)
    marks.delete(id)
    return { changed: previous !== undefined, previous }
  })
}

/**
 * The re-ranking constants. {@link ANNOTATION_TUNING} holds the values the
 * Agent Note's measurements on the built-in graph chose; another value is for
 * evaluation only.
 */
export interface AnnotationTuning {
  /** Chance that one recorded similarity link passes a mark's verdict on; also a pattern mark's weight on each of its papers. */
  transmission: number
  /** Most similarity links a mark's verdict travels. */
  depth: number
  /** Places a result moves down when irrelevant marks weigh 1 on it. */
  maxDemotion: number
  /** Places a result moves up when pins weigh 1 on it. */
  maxPromotion: number
  /** Weight below which a result is left where the query put it. */
  threshold: number
  /** Most pinned items listed before the ranked ones in each list. */
  pinLimit: number
}

/** The measured re-ranking constants. */
export const ANNOTATION_TUNING: Readonly<AnnotationTuning> = Object.freeze({
  transmission: 0.5, depth: 3, maxDemotion: 3, maxPromotion: 3, threshold: 0.15, pinLimit: 5,
})

/** One entry of recall's fused ranking: a pattern or paper index in a graph and its fused score. */
export interface RecallCandidate {
  graph: GraphSource
  index: number
  score: number
}

/** Recall's rankings and the marks to honor in them. */
export interface AnnotationRequest {
  /** The loaded graphs; a mark on a graph that is not here counts as unavailable, and a candidate of one is left unmarked. */
  graphs: Partial<Record<GraphSource, GraphFile>>
  annotations: readonly Annotation[]
  /** The complete fused pattern ranking, best first, before any cut. */
  patterns: readonly RecallCandidate[]
  /** The complete fused paper ranking, best first, before any cut. */
  papers: readonly RecallCandidate[]
  /** How many ranked items each list returns after its pinned ones. */
  limits: { patterns: number; papers: number }
}

/** How a returned item relates to the mark that moved it. */
export interface AnnotationLink {
  /** The mark's id. */
  mark: string
  /** The marked paper's title or pattern's name. */
  title: string
  /** The reason given with the mark. */
  note?: string
  /**
   * `similar`: a paper linked to the marked paper by recorded similarity;
   * `in-pattern`: a paper of the marked pattern; `members`: a pattern whose
   * papers include or neighbour the marked paper.
   */
  relation: 'similar' | 'in-pattern' | 'members'
  /**
   * `similar`: links between the two papers; `members`: links from the
   * marked paper to the pattern's nearest paper, 0 when it is one of them.
   */
  hops?: number
  /** `members`: how many of the pattern's papers the mark reaches. */
  papers?: number
}

/** Why a returned item sits where it does. */
export type AnnotationWhy =
  | {
    kind: 'pinned'
    mark: string
    by: 'user' | 'agent'
    note?: string
    /** False when the query did not recall the pinned item and it was added. */
    recalled: boolean
  }
  | {
    /** `demoted` when irrelevant marks move it down at least as far as pins move it up, `boosted` otherwise. */
    kind: 'demoted' | 'boosted'
    /** Places the marks moved it, down positive: maxDemotion × penalty − maxPromotion × boost. */
    shift: number
    /** Combined weight of irrelevant marks, 0 to 1. */
    penalty: number
    /** Combined weight of pins, 0 to 1. */
    boost: number
    /** The mark of the most weight in the direction it moved. */
    nearest: AnnotationLink
    /** The mark of the most weight the other way, when that weight counts. */
    counter?: AnnotationLink
    /** How many marks weigh on it in the direction it moved. */
    marks: number
  }
  | { kind: 'unchanged' }

/** A returned pattern or paper. */
export interface AnnotatedItem extends RecallCandidate {
  /** 1-based place in the query's own ranking; null for a pin the query did not recall, whose score is 0. */
  before: number | null
  why: AnnotationWhy
}

/** A result the query placed in view that a mark calls irrelevant. */
export interface SkippedItem {
  kind: 'pattern' | 'paper'
  graph: GraphSource
  index: number
  mark: string
  title: string
  note?: string
  by: 'user' | 'agent'
  /** 1-based place the query gave it. */
  before: number
}

/** What the marks did to one recall, for the agent to report. */
export interface AnnotationSummary {
  /** Marks given. */
  marks: number
  /** Marks whose target exists in a loaded graph. */
  applied: number
  /** Marks whose graph is loaded but no longer holds their target; they stay stored. */
  orphaned: number
  /** Up to ten orphaned mark ids. */
  orphanedIds: string[]
  /** Marks on a graph that is not loaded. */
  unavailable: number
  /** Pinned items listed. */
  pinned: number
  /** Pins beyond the pin limit, not listed. */
  pinsNotShown: number
  /** Results left out as marked irrelevant. */
  skipped: number
  demoted: number
  boosted: number
}

/** Recall's lists with the marks honored. */
export interface AnnotatedRecall {
  /** Pinned patterns, then up to limits.patterns ranked ones. */
  patterns: AnnotatedItem[]
  /** Pinned papers, then up to limits.papers ranked ones. */
  papers: AnnotatedItem[]
  /** Patterns, then papers, the query placed in view and a mark calls irrelevant, in query order. */
  skipped: SkippedItem[]
  summary: AnnotationSummary
}

/** The papers one paper mark reaches, other than the marked paper itself, with its weight on each. */
interface Spread {
  nodes: Int32Array
  /** 1 − weight, the chance the verdict does not reach the paper. */
  kept: Float64Array
  /** The fewest links from the marked paper. */
  hops: Uint8Array
}

/** Per-paper arrays for counting paths, reused across marks and emptied after each. */
interface Scratch {
  /** Simple paths of one, two and three links from the mark that end at each paper. */
  paths: [Uint32Array, Uint32Array, Uint32Array]
  /** 1 for a paper some path reached, which is then listed once in `touched`. */
  reached: Uint8Array
  touched: number[]
}

/** Spreads kept per graph; a recall with more marks than this recomputes the oldest. */
const CACHED_SPREADS = 2 * MAX_ANNOTATIONS

/** A graph's structure for spreading marks, built once per loaded graph. */
interface Prepared {
  /**
   * Undirected similarity links without duplicates or self-links: the
   * neighbours of paper i are links[offsets[i]] up to links[offsets[i + 1] - 1],
   * ascending.
   */
  offsets: Int32Array
  links: Int32Array
  /** Paper indices by id, ascending; an id the graph repeats lists every copy. */
  papers: Map<string, number[]>
  patterns: Map<string, number>
  /** The papers of each pattern, ascending. */
  members: number[][]
  /** Each paper's pattern index, -1 for none. */
  patternOf: Int32Array
  /** Paper-mark spreads by depth, transmission and marked indices, least recently used first. */
  spreads: Map<string, Spread>
  scratch: Scratch
}

/** Prepared structures, released with the parsed graph object they describe. */
const preparedGraphs = new WeakMap<GraphFile, Prepared>()

function prepare(file: GraphFile): Prepared {
  const cached = preparedGraphs.get(file)
  if (cached) return cached
  const n = file.papers.length
  const neighbours: number[][] = file.papers.map(() => [])
  file.papers.forEach((paper, i) => {
    const own = neighbours[i] as number[]
    for (const j of paper.similar) if (j !== i) { own.push(j); (neighbours[j] as number[]).push(i) }
  })
  const offsets = new Int32Array(n + 1)
  const links: number[] = []
  neighbours.forEach((list, i) => {
    list.sort((a, b) => a - b).forEach((j, k) => { if (k === 0 || j !== list[k - 1]) links.push(j) })
    offsets[i + 1] = links.length
  })
  const papers = new Map<string, number[]>()
  const members: number[][] = file.patterns.map(() => [])
  file.papers.forEach((paper, i) => {
    papers.set(paper.id, [...papers.get(paper.id) ?? [], i])
    if (paper.pattern >= 0) (members[paper.pattern] as number[]).push(i)
  })
  const prepared: Prepared = {
    offsets, links: Int32Array.from(links), papers, patterns: new Map(file.patterns.map((pattern, i) => [pattern.id, i])), members,
    patternOf: Int32Array.from(file.papers, paper => paper.pattern), spreads: new Map(),
    scratch: { paths: [new Uint32Array(n), new Uint32Array(n), new Uint32Array(n)], reached: new Uint8Array(n), touched: [] },
  }
  preparedGraphs.set(file, prepared)
  return prepared
}

/**
 * Build the structure that spreads marks over a graph, unless it is cached.
 * The cache is keyed by the parsed graph object, so it lives exactly as long
 * as the knowledge base keeps that graph loaded, and it also keeps the spread
 * of each paper mark used lately. applyAnnotations and locateTarget build it
 * on first use; calling this moves the cost to load time.
 * @param file - a parsed graph.
 */
export function prepareAnnotationGraph(file: GraphFile): void {
  prepare(file)
}

/**
 * Where a target sits in a graph.
 * @param file - the graph the target names.
 * @param target - the marked pattern or paper.
 * @returns the pattern's index, or every index of a paper the graph lists more than once; empty when the graph lacks the target.
 */
export function locateTarget(file: GraphFile, target: AnnotationTarget): number[] {
  const prepared = prepare(file)
  if (target.kind === 'paper') return prepared.papers.get(target.id) ?? []
  const index = prepared.patterns.get(target.id)
  return index === undefined ? [] : [index]
}

/** Count the simple paths of one to `depth` (at most three) links from paper x into the scratch arrays. */
function countPaths({ offsets, links, scratch }: Prepared, x: number, depth: number): void {
  const { paths: [one, two, three], reached, touched } = scratch
  const reach = (v: number): void => {
    if (reached[v] === 0) { reached[v] = 1; touched.push(v) }
  }
  for (let i = offsets[x] as number; i < (offsets[x + 1] as number); i++) {
    const a = links[i] as number
    reach(a)
    one[a] = (one[a] as number) + 1
    if (depth < 2) continue
    for (let j = offsets[a] as number; j < (offsets[a + 1] as number); j++) {
      const b = links[j] as number
      if (b === x) continue
      reach(b)
      two[b] = (two[b] as number) + 1
      if (depth < 3) continue
      for (let k = offsets[b] as number; k < (offsets[b + 1] as number); k++) {
        const c = links[k] as number
        if (c === x || c === a) continue
        reach(c)
        three[c] = (three[c] as number) + 1
      }
    }
  }
}

/**
 * The spread of a paper mark: its weight 1 − Π(1 − tᵏ) over the simple paths of
 * k ≤ depth links from any copy of the marked paper. Cached per graph.
 */
function paperSpread(prepared: Prepared, indices: number[], { depth, transmission }: AnnotationTuning): Spread {
  const key = `${depth}:${transmission}:${indices.join(',')}`
  const cached = prepared.spreads.get(key)
  if (cached) {
    prepared.spreads.delete(key)
    prepared.spreads.set(key, cached)
    return cached
  }
  for (const x of indices) countPaths(prepared, x, depth)
  const { paths: [one, two, three], reached, touched } = prepared.scratch
  const keep1 = 1 - transmission
  const keep2 = 1 - transmission ** 2
  const keep3 = 1 - transmission ** 3
  const nodes: number[] = [], kept: number[] = [], hops: number[] = []
  for (const v of touched) {
    const c1 = one[v] as number, c2 = two[v] as number, c3 = three[v] as number
    one[v] = 0
    two[v] = 0
    three[v] = 0
    reached[v] = 0
    if (indices.includes(v)) continue
    // Most papers are reached by paths of one length only, so a power is taken only for a count above zero.
    let miss = 1, fewest = 3
    if (c3 > 0) miss = keep3 ** c3
    if (c2 > 0) { miss *= keep2 ** c2; fewest = 2 }
    if (c1 > 0) { miss *= keep1 ** c1; fewest = 1 }
    nodes.push(v)
    kept.push(miss)
    hops.push(fewest)
  }
  touched.length = 0
  const spread = { nodes: Int32Array.from(nodes), kept: Float64Array.from(kept), hops: Uint8Array.from(hops) }
  prepared.spreads.set(key, spread)
  if (prepared.spreads.size > CACHED_SPREADS) prepared.spreads.delete(prepared.spreads.keys().next().value as string)
  return spread
}

/** A mark whose target exists in a loaded graph. */
interface Resolved {
  annotation: Annotation
  file: GraphFile
  /** The target's indices in its graph ({@link locateTarget}). */
  indices: number[]
  title: string
}

type Verdict = Annotation['verdict']
type WeightLink = Pick<AnnotationLink, 'relation' | 'hops' | 'papers'>
/** The heaviest single weight on one item in one direction, and how many marks weigh on it that way. */
interface Side { best: { mark: Resolved; value: number; link: WeightLink } | undefined; count: number }
type Weights = Record<Verdict, Side>

function record(weights: Map<number, Weights>, index: number, verdict: Verdict, mark: Resolved, value: number, link: WeightLink): void {
  let entry = weights.get(index)
  if (!entry) {
    entry = { pin: { best: undefined, count: 0 }, irrelevant: { best: undefined, count: 0 } }
    weights.set(index, entry)
  }
  const side = entry[verdict]
  side.count++
  if (!side.best || value > side.best.value) side.best = { mark, value, link }
}

/** The weights of the marks of one graph on that graph's candidates. */
interface GraphWeights {
  papers: Map<number, Weights>
  patterns: Map<number, Weights>
  /** Combined weight on every paper per verdict, kept as the chance that no mark of that verdict reaches it. */
  miss: Record<Verdict, Float64Array>
  members: number[][]
}

/**
 * Spread the marks of one graph. A paper mark weighs 1 on the marked paper and
 * its {@link paperSpread} on other papers; a pattern mark weighs t on each paper
 * of the pattern. Several marks of one verdict combine by noisy-OR. Marks are
 * taken in the given order, which fixes every floating-point product.
 */
function spreadMarks(
  file: GraphFile, marks: Resolved[], candidates: { papers: Set<number>; patterns: Set<number> }, tuning: AnnotationTuning,
): GraphWeights {
  const prepared = prepare(file)
  const { members, patternOf } = prepared
  const n = file.papers.length
  const miss = { pin: new Float64Array(n).fill(1), irrelevant: new Float64Array(n).fill(1) }
  const result: GraphWeights = { papers: new Map(), patterns: new Map(), miss, members }
  const paperCandidate = new Uint8Array(n)
  for (const index of candidates.papers) paperCandidate[index] = 1
  const patternCandidate = new Uint8Array(file.patterns.length)
  for (const index of candidates.patterns) patternCandidate[index] = 1
  // Per mark and candidate pattern: the summed weight over its papers, the fewest links to one of them, and how many it reaches.
  const reaches = new Map<number, { sum: number; hops: number; papers: number }>()
  for (const mark of marks) {
    const { verdict } = mark.annotation
    const own = miss[verdict]
    if (mark.annotation.target.kind === 'pattern') {
      for (const m of members[mark.indices[0] as number] as number[]) {
        own[m] = (own[m] as number) * (1 - tuning.transmission)
        if (paperCandidate[m] === 1) record(result.papers, m, verdict, mark, tuning.transmission, { relation: 'in-pattern' })
      }
      continue
    }
    const settle = (v: number, kept: number, hops: number): void => {
      own[v] = (own[v] as number) * kept
      if (paperCandidate[v] === 1) record(result.papers, v, verdict, mark, 1 - kept, { relation: 'similar', hops })
      const p = patternOf[v] as number
      // A paper without a pattern (-1) reads undefined here.
      if (patternCandidate[p] !== 1) return
      const reach = reaches.get(p)
      if (!reach) { reaches.set(p, { sum: 1 - kept, hops, papers: 1 }); return }
      reach.sum += 1 - kept
      reach.hops = Math.min(reach.hops, hops)
      reach.papers++
    }
    for (const x of mark.indices) settle(x, 0, 0)
    const spread = paperSpread(prepared, mark.indices, tuning)
    for (let k = 0; k < spread.nodes.length; k++) settle(spread.nodes[k] as number, spread.kept[k] as number, spread.hops[k] as number)
    for (const [p, reach] of reaches) {
      record(result.patterns, p, verdict, mark, reach.sum / (members[p] as number[]).length, { relation: 'members', hops: reach.hops, papers: reach.papers })
    }
    reaches.clear()
  }
  return result
}

function round(value: number): number { return Math.round(value * 1000) / 1000 }

function noteOf(annotation: Annotation): { note?: string } { return annotation.note === undefined ? {} : { note: annotation.note } }

function linkOf(side: Side): AnnotationLink {
  const best = side.best as NonNullable<Side['best']>
  return { mark: best.mark.annotation.id, title: best.mark.title, ...noteOf(best.mark.annotation), ...best.link }
}

function pinWhy(annotation: Annotation, recalled: boolean): AnnotationWhy {
  return { kind: 'pinned', mark: annotation.id, by: annotation.by, ...noteOf(annotation), recalled }
}

/** The reason for a candidate's move; weights exist whenever the penalty or the boost is above zero. */
function shiftWhy(shift: number, penalty: number, boost: number, weights: Weights | undefined): AnnotationWhy {
  if (penalty === 0 && boost === 0) return { kind: 'unchanged' }
  const { pin, irrelevant } = weights as Weights
  const demoted = penalty > 0 && shift >= 0
  const [ahead, behind, against] = demoted ? [irrelevant, pin, boost] : [pin, irrelevant, penalty]
  return {
    kind: demoted ? 'demoted' : 'boosted', shift: round(shift), penalty: round(penalty), boost: round(boost),
    nearest: linkOf(ahead), ...against > 0 ? { counter: linkOf(behind) } : {}, marks: ahead.count,
  }
}

/** One list's candidates: how to name them and what weighs on them. */
interface ListKind {
  kind: AnnotationTarget['kind']
  /** The id of a candidate's target in its graph. */
  id: (file: GraphFile, index: number) => string
  /** The combined penalty and boost on a candidate, each zero under the threshold, and the heaviest weights on it. */
  weights: (graph: GraphSource, index: number) => { penalty: number; boost: number; weights: Weights | undefined }
}

/** Rank one list: its pins first, its irrelevant targets out, the rest by their bounded shifts. */
function rankList(
  list: ListKind, candidates: readonly RecallCandidate[], limit: number, graphs: AnnotationRequest['graphs'],
  exact: Map<string, Resolved>, pins: Resolved[], tuning: AnnotationTuning,
): { items: AnnotatedItem[]; skipped: SkippedItem[]; pinsNotShown: number } {
  const skipped: SkippedItem[] = []
  const pinned = new Map<Resolved, AnnotatedItem>()
  const handled = new Set<Resolved>()
  const rest: { item: AnnotatedItem; position: number; virtual: number }[] = []
  candidates.forEach((candidate, rank) => {
    const file = graphs[candidate.graph]
    const mark = file && exact.get(annotationId({ graph: candidate.graph, kind: list.kind, id: list.id(file, candidate.index) }))
    if (mark) {
      // Every copy of a marked paper is the marked paper; only its best-placed copy is reported.
      if (handled.has(mark)) return
      handled.add(mark)
      const { annotation, title } = mark
      if (annotation.verdict === 'pin') pinned.set(mark, { ...candidate, before: rank + 1, why: pinWhy(annotation, true) })
      else if (rank < limit) {
        skipped.push({
          kind: list.kind, graph: candidate.graph, index: candidate.index, mark: annotation.id, title, ...noteOf(annotation),
          by: annotation.by, before: rank + 1,
        })
      }
      return
    }
    const { penalty, boost, weights } = list.weights(candidate.graph, candidate.index)
    const shift = tuning.maxDemotion * penalty - tuning.maxPromotion * boost
    const item: AnnotatedItem = { ...candidate, before: rank + 1, why: shiftWhy(shift, penalty, boost, weights) }
    rest.push({ item, position: rest.length, virtual: rest.length + shift })
  })
  const added = pins.filter(mark => !pinned.has(mark))
    .sort((a, b) => Date.parse(b.annotation.at) - Date.parse(a.annotation.at) || byId(a.annotation, b.annotation))
    .map((mark): AnnotatedItem => ({
      graph: mark.annotation.target.graph, index: mark.indices.at(-1) as number, score: 0, before: null,
      why: pinWhy(mark.annotation, false),
    }))
  const listedPins = [...pinned.values(), ...added]
  const ranked = rest.sort((a, b) => a.virtual - b.virtual || a.position - b.position).slice(0, limit).map(entry => entry.item)
  const pinsNotShown = Math.max(0, listedPins.length - tuning.pinLimit)
  return { items: [...listedPins.slice(0, tuning.pinLimit), ...ranked], skipped, pinsNotShown }
}

/**
 * Honor a project's marks in one recall. Without a mark whose target exists in
 * a loaded graph, each list is its first `limits` candidates in the given
 * order with their scores, each `unchanged`. Otherwise each list starts with
 * its pins: those the query recalled in query order, then the others newest
 * first, up to the pin limit. A target marked irrelevant is removed and named
 * in `skipped` when the query placed it within the limit. Every other
 * candidate is ordered by its place among them plus
 * maxDemotion × penalty − maxPromotion × boost, ties keeping query order, so
 * the marks move a ranked result down fewer than maxDemotion + maxPromotion
 * places among the ranked results. A weight under the threshold counts as none.
 * The result depends only on the inputs.
 * @param request - the fused rankings, the loaded graphs, the marks and the list lengths.
 * @param tuning - the re-ranking constants; production callers pass none.
 * @returns both lists with a reason per item, the skipped results and the summary counts.
 */
export function applyAnnotations(request: AnnotationRequest, tuning: AnnotationTuning = ANNOTATION_TUNING): AnnotatedRecall {
  const resolved: Resolved[] = []
  const orphanedIds: string[] = []
  let unavailable = 0
  for (const annotation of [...request.annotations].sort(byId)) {
    const file = request.graphs[annotation.target.graph]
    if (!file) { unavailable++; continue }
    const indices = locateTarget(file, annotation.target)
    const first = indices[0]
    if (first === undefined) { orphanedIds.push(annotation.id); continue }
    const title = annotation.target.kind === 'paper'
      ? (file.papers[first] as GraphFile['papers'][number]).title
      : (file.patterns[first] as GraphFile['patterns'][number]).name
    resolved.push({ annotation, file, indices, title })
  }
  const summary: AnnotationSummary = {
    marks: request.annotations.length, applied: resolved.length,
    orphaned: orphanedIds.length, orphanedIds: orphanedIds.slice(0, LISTED_ORPHANS),
    unavailable, pinned: 0, pinsNotShown: 0, skipped: 0, demoted: 0, boosted: 0,
  }
  if (resolved.length === 0) {
    const unchanged = (candidates: readonly RecallCandidate[], limit: number): AnnotatedItem[] =>
      candidates.slice(0, limit).map((candidate, rank) => ({ ...candidate, before: rank + 1, why: { kind: 'unchanged' } }))
    const { patterns, papers, limits } = request
    return { patterns: unchanged(patterns, limits.patterns), papers: unchanged(papers, limits.papers), skipped: [], summary }
  }
  const spread = new Map<GraphSource, GraphWeights>()
  for (const graph of ['ai', 'project'] as const) {
    const marks = resolved.filter(mark => mark.annotation.target.graph === graph)
    const inGraph = (list: readonly RecallCandidate[]): Set<number> => new Set(list.flatMap(item => item.graph === graph ? item.index : []))
    const candidates = { papers: inGraph(request.papers), patterns: inGraph(request.patterns) }
    if (marks[0]) spread.set(graph, spreadMarks(marks[0].file, marks, candidates, tuning))
  }
  const effective = (value: number): number => value >= tuning.threshold ? value : 0
  const none = { penalty: 0, boost: 0, weights: undefined }
  const papers: ListKind = {
    kind: 'paper',
    id: (file, index) => (file.papers[index] as GraphFile['papers'][number]).id,
    weights: (graph, index) => {
      const own = spread.get(graph)
      if (!own) return none
      const { irrelevant, pin } = own.miss
      const penalty = effective(1 - (irrelevant[index] as number))
      return { penalty, boost: effective(1 - (pin[index] as number)), weights: own.papers.get(index) }
    },
  }
  const patterns: ListKind = {
    kind: 'pattern',
    id: (file, index) => (file.patterns[index] as GraphFile['patterns'][number]).id,
    weights: (graph, index) => {
      const own = spread.get(graph)
      if (!own) return none
      const members = own.members[index] as number[]
      let penalty = 0, boost = 0
      const { irrelevant, pin } = own.miss
      for (const m of members) { penalty += 1 - (irrelevant[m] as number); boost += 1 - (pin[m] as number) }
      const size = Math.max(members.length, 1)
      return { penalty: effective(penalty / size), boost: effective(boost / size), weights: own.patterns.get(index) }
    },
  }
  const exact = new Map(resolved.map(mark => [mark.annotation.id, mark]))
  const pinsOf = (kind: AnnotationTarget['kind']): Resolved[] => resolved.filter(mark => mark.annotation.verdict === 'pin' && mark.annotation.target.kind === kind)
  const patternList = rankList(patterns, request.patterns, request.limits.patterns, request.graphs, exact, pinsOf('pattern'), tuning)
  const paperList = rankList(papers, request.papers, request.limits.papers, request.graphs, exact, pinsOf('paper'), tuning)
  const items = [...patternList.items, ...paperList.items]
  const count = (kind: AnnotationWhy['kind']): number => items.filter(item => item.why.kind === kind).length
  Object.assign(summary, {
    pinned: count('pinned'), pinsNotShown: patternList.pinsNotShown + paperList.pinsNotShown,
    skipped: patternList.skipped.length + paperList.skipped.length, demoted: count('demoted'), boosted: count('boosted'),
  })
  return { patterns: patternList.items, papers: paperList.items, skipped: [...patternList.skipped, ...paperList.skipped], summary }
}

/**
 * The agent's account of what a project's marks did to one recall, one
 * labelled count per effect that occurred.
 * @param summary - applyAnnotations' summary.
 * @returns the account; empty when the project has no marks.
 */
export function describeAnnotations(summary: AnnotationSummary): string {
  if (summary.marks === 0) return ''
  const effects: string[] = []
  if (summary.pinned) effects.push(`Pinned and listed first: ${summary.pinned}${summary.pinsNotShown ? ` (${summary.pinsNotShown} more not listed)` : ''}.`)
  if (summary.skipped) effects.push(`Left out as marked irrelevant (see skipped): ${summary.skipped}.`)
  if (summary.demoted) effects.push(`Moved down near items marked irrelevant: ${summary.demoted}.`)
  if (summary.boosted) effects.push(`Moved up near pinned items: ${summary.boosted}.`)
  if (summary.orphaned) effects.push(`Marks naming items no longer in their graph, kept: ${summary.orphaned} (${summary.orphanedIds.join(', ')}).`)
  if (summary.unavailable) effects.push(`Marks on a graph that is not loaded: ${summary.unavailable}.`)
  const honored = `Marks honored: ${summary.applied} of ${summary.marks}`
  return effects.length ? `${honored}. ${effects.join(' ')}` : `${honored}; none touched these results.`
}
