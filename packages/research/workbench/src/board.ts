/**
 * The experiment board. The agent keeps the layout: sections built from a few
 * kinds of block, whose numbers follow runs or come from collector scripts.
 * Everything the board shows is then read by scripts on a timer, never by the
 * model: a probe reports each experiment machine, the runs' progress files
 * give the curves, and each collector prints what only the project knows how
 * to read.
 */
import { existsSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { runtimeAsset } from './components.ts'
import { atomicWrite, errorText, projectPath, readText } from './files.ts'
import { checked, runProcess, ssh, type ProcessResult } from './process.ts'
import { boardAlertSchema, boardSectionSchema, boardSpecSchema, boardStatSchema, withoutNulls } from './schema.ts'
import type {
  BoardAlert, BoardBlock, BoardCollected, BoardCollector, BoardMachine, BoardPatch, BoardSample, BoardSnapshot, BoardSpec,
  EnvironmentRecord, ExperimentRecord, ProjectId, ResearchProject,
} from './types.ts'

/** The layout, as the agent last saved it. */
export const BOARD_FILE = '.research/board/board.json'
/** What the scripts last read, so a reopened board shows it at once. */
const SNAPSHOT_FILE = '.research/board/snapshot.json'
/** A background read starts at most this often, however often the board asks. */
const MIN_READ_MS = 10_000
const DEFAULT_COLLECTOR_SECONDS = 30
/** Progress lines kept per run: enough for a smooth curve, small enough to send on every read. */
const SERIES_ROWS = 400
const PROGRESS_BYTES = 16 * 1024 * 1024
const PROGRESS_FIELDS = 40
const HISTORY_SAMPLES = 720
const HISTORY_MS = 6 * 60 * 60 * 1000
const PROBE_TIMEOUT_MS = 45_000
const COLLECTOR_TIMEOUT_MS = 120_000
const COLLECTOR_OUTPUT_BYTES = 4 * 1024 * 1024
const SCRIPT_BYTES = 256 * 1024
/** A disk with less than this share free raises an alert. */
const LOW_DISK = 0.08
const ACTIVE = new Set(['queued', 'running', 'unknown'])
const EMPTY: BoardSpec = { sections: [], collectors: [] }

/** What the board read last, without the layout. */
type BoardData = Omit<BoardSnapshot, 'spec' | 'refreshing'>
const NO_DATA: BoardData = { machines: [], series: {}, collected: {}, alerts: [] }

const optionalNumber = z.number().nullish().transform(value => value ?? undefined)
const probeSchema = z.object({
  host: z.string().optional(),
  os: z.string().optional(),
  gpus: z.array(z.object({
    name: z.string(), util: optionalNumber, memoryUsed: optionalNumber, memoryTotal: optionalNumber,
    temperature: optionalNumber, power: optionalNumber, powerLimit: optionalNumber,
  })).catch([]),
  cpu: z.object({ util: optionalNumber, cores: optionalNumber }).nullish().transform(value => value ?? undefined),
  memory: z.object({ used: z.number(), total: z.number() }).nullish().transform(value => value ?? undefined),
  disk: z.object({ path: z.string(), used: z.number(), total: z.number(), free: z.number() })
    .nullish().transform(value => value ?? undefined),
  progress: z.record(z.string(), z.array(z.record(z.string(), z.number()))).catch({}),
})
type Probe = z.infer<typeof probeSchema>
const collectorShape = z.object({
  stats: z.array(z.unknown()).optional(),
  sections: z.array(z.unknown()).optional(),
  alerts: z.array(z.unknown()).optional(),
})
const dataSchema = z.object({
  capturedAt: z.string().optional(),
  machines: z.array(z.unknown()),
  series: z.record(z.string(), z.unknown()),
  collected: z.record(z.string(), z.unknown()),
  alerts: z.array(z.unknown()),
})

/** One machine the board reads, and what to read on it. */
interface MachineGroup {
  key: string
  python: string
  host?: string | undefined
  disk: string
  environments: EnvironmentRecord[]
  /** Active runs on a remote host, whose progress only that host can read. */
  remote: ExperimentRecord[]
}

/** What `board-refresh` tells the agent: what each script produced, compactly. */
export interface BoardReport {
  capturedAt: string | undefined
  machines: { key: string; error?: string | undefined; gpus: number }[]
  collectors: { id: string; ok: boolean; error?: string | undefined; sections: number; stats: number; ms: number }[]
  series: number
  alerts: BoardAlert[]
}

/**
 * Issues of a failed parse, one line each, with the path that failed.
 * @param error - the parse failure.
 * @param prefix - what the paths are relative to, such as `sections[2]`.
 * @returns the first six issues, joined.
 */
export function issueText(error: z.ZodError, prefix = ''): string {
  return error.issues.slice(0, 6).map((issue) => {
    const path = [prefix, ...issue.path.map(String)].filter(Boolean).join('.')
    return `${path || 'board'}: ${issue.message}`
  }).join('; ')
}

/**
 * Whether a run name matches a pattern in which `*` matches anything.
 * @param pattern - the name, with `*` for any run of characters.
 * @param name - a run name.
 * @returns whether the whole name matches.
 */
export function nameMatches(pattern: string, name: string): boolean {
  const expression = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${expression}$`).test(name)
}

/**
 * The runs a board value follows: the run with that id, else every run of that name (and seed).
 * @param project - the runs on record.
 * @param ref - the run it names (an id, or a name) and the seed, when one is picked.
 * @returns the followed runs, in record order.
 */
export function followedRuns(project: Pick<ResearchProject, 'experiments'>, ref: { run?: string | undefined; seed?: number | undefined }): ExperimentRecord[] {
  if (ref.run === undefined) return []
  const byId = project.experiments.filter(run => run.id === ref.run)
  if (byId.length) return byId
  return project.experiments.filter(run => run.spec.name === ref.run && (ref.seed === undefined || run.spec.seed === ref.seed))
}

/**
 * The run a chart line follows: the latest of those {@link followedRuns} finds.
 * @param project - the runs on record.
 * @param ref - the run it names (an id, or a name) and the seed, when one is picked.
 * @returns the latest followed run, or undefined when none is.
 */
export function latestRun(project: Pick<ResearchProject, 'experiments'>, ref: { run?: string | undefined; seed?: number | undefined }): ExperimentRecord | undefined {
  return followedRuns(project, ref).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
}

/** Every run reference a set of blocks makes, and the `runs` block patterns. */
function references(blocks: BoardBlock[]): { refs: { run?: string | undefined; seed?: number | undefined }[]; patterns: string[] } {
  const refs: { run?: string | undefined; seed?: number | undefined }[] = []
  const patterns: string[] = []
  for (const block of blocks) {
    if (block.type === 'stats') refs.push(...block.items)
    else if (block.type === 'list') refs.push(...block.items)
    else if (block.type === 'chart') refs.push(...block.series)
    else if (block.type === 'runs') patterns.push(block.match)
    else if (block.type === 'table') {
      for (const row of block.rows) for (const cell of Object.values(row.cells)) if (cell !== null && typeof cell === 'object') refs.push(cell)
    }
  }
  return { refs: refs.filter(ref => ref.run !== undefined), patterns }
}

/**
 * The references in a layout that match no run yet: a board is often laid out
 * before its runs are submitted, so this informs rather than refuses.
 * @param project - the runs on record.
 * @param spec - the layout.
 * @returns each unmatched run name, seed or pattern once.
 */
export function unmatched(project: Pick<ResearchProject, 'experiments'>, spec: BoardSpec): string[] {
  const { refs, patterns } = references(spec.sections.flatMap(section => section.blocks))
  const names = new Set<string>()
  for (const ref of refs) if (followedRuns(project, ref).length === 0) names.add(ref.seed === undefined ? String(ref.run) : `${ref.run} (seed ${ref.seed})`)
  for (const pattern of patterns) if (!project.experiments.some(run => nameMatches(pattern, run.spec.name))) names.add(pattern)
  return [...names]
}

/**
 * A layout with a patch applied: fields present replace, sections and collectors are replaced or removed by id.
 * @param current - the stored layout, left as it was.
 * @param patch - the change.
 * @returns the new layout.
 */
export function applyPatch(current: BoardSpec, patch: BoardPatch): BoardSpec {
  const next: BoardSpec = structuredClone(current)
  // An empty title or summary clears it.
  if (patch.title !== undefined) next.title = patch.title.trim() ? patch.title : undefined
  if (patch.summary !== undefined) next.summary = patch.summary.trim() ? patch.summary : undefined
  if (patch.tags !== undefined) next.tags = patch.tags
  const merge = <T extends { id: string }>(list: T[], changes: (T | { id: string; remove: true })[] | undefined): T[] => {
    let result = [...list]
    for (const change of changes ?? []) {
      if ('remove' in change) { result = result.filter(item => item.id !== change.id); continue }
      const index = result.findIndex(item => item.id === change.id)
      if (index === -1) result.push(change)
      else result[index] = change
    }
    return result
  }
  next.sections = merge(next.sections, patch.sections)
  next.collectors = merge(next.collectors, patch.collectors)
  return next
}

/**
 * At most `limit` rows, evenly spaced, always keeping the last.
 * @param rows - the rows in order.
 * @param limit - the most rows returned.
 * @returns the rows kept, in order.
 */
export function thin<T>(rows: T[], limit: number): T[] {
  if (rows.length <= limit) return rows
  const step = rows.length / limit
  return [...Array.from({ length: limit - 1 }, (_, index) => rows[Math.floor(index * step)] as T), rows.at(-1) as T]
}

/**
 * The numeric fields of each JSON-object line; other lines, and a line still being written, are skipped.
 * @param text - the contents of a progress file.
 * @returns one record of numbers per line kept.
 */
export function progressRows(text: string): Record<string, number>[] {
  const rows: Record<string, number>[] = []
  for (const line of text.split(/\r?\n/)) {
    let row: unknown
    try { row = JSON.parse(line) } catch { continue }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    const values = Object.entries(row).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    if (values.length) rows.push(Object.fromEntries(values.slice(0, PROGRESS_FIELDS)))
  }
  return rows
}

/** The progress lines of a file on this machine, from its last 16 MB; none when it does not exist. */
async function readProgress(path: string): Promise<Record<string, number>[]> {
  let file
  try { file = await open(path, 'r') } catch { return [] }
  try {
    const { size } = await file.stat()
    const length = Math.min(size, PROGRESS_BYTES)
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, size - length)
    return thin(progressRows(buffer.toString('utf8')), SERIES_ROWS)
  } finally { await file.close() }
}

/** A run's progress file on this machine: in its directory, or the copy a finished remote run left in the project. */
async function localProgress(project: ResearchProject, run: ExperimentRecord): Promise<string> {
  const environment = project.environments.find(item => item.id === run.spec.environmentId)
  return environment?.target === 'ssh'
    ? projectPath(project.root, `.research/runs/${run.id}/progress.jsonl`)
    : join(run.directory, 'progress.jsonl')
}

/** The fraction a used/total pair gives, or undefined without a total. */
function share(used: number | undefined, total: number | undefined): number | undefined {
  return used !== undefined && total ? used / total : undefined
}

/** One resource sample from a probe: the mean over the machine's GPUs. */
function sample(probe: Probe, t: number): BoardSample {
  const mean = (values: (number | undefined)[]): number | undefined => {
    const known = values.filter((value): value is number => value !== undefined)
    return known.length ? known.reduce((a, b) => a + b, 0) / known.length : undefined
  }
  return {
    t,
    gpu: mean(probe.gpus.map(gpu => gpu.util === undefined ? undefined : gpu.util / 100)),
    gpuMemory: mean(probe.gpus.map(gpu => share(gpu.memoryUsed, gpu.memoryTotal))),
    cpu: probe.cpu?.util,
    memory: share(probe.memory?.used, probe.memory?.total),
  }
}

/** What the service gives the boards: the platform interpreter, its lifetime, its task tracker and its log. */
export interface BoardOptions {
  /** The platform interpreter, for a collector that names no environment; undefined when none is installed. */
  localPython: () => Promise<string | undefined>
  /** Ends every background read when the service stops. */
  signal: AbortSignal
  /** Lets the service wait for a background read at shutdown. */
  track: (operation: Promise<unknown>) => void
  warn: (message: string) => void
}

interface ProjectState {
  data?: BoardData | undefined
  reading?: Promise<BoardData> | undefined
  lastAttempt: number
  /** The last run of each collector, in epoch milliseconds. */
  ran: Map<string, number>
}

/** Every project's board: its stored layout, the last read, and the reads under way. */
export class ExperimentBoards {
  private readonly states = new Map<ProjectId, ProjectState>()
  private readonly writes = new Map<string, Promise<unknown>>()

  constructor(private readonly options: BoardOptions) {}

  private state(id: ProjectId): ProjectState {
    let state = this.states.get(id)
    if (!state) { state = { lastAttempt: 0, ran: new Map() }; this.states.set(id, state) }
    return state
  }

  /**
   * The stored layout. A layout that no longer parses (the file was edited by
   * hand) reads as an empty board, with the reason.
   * @param root - the project root.
   * @returns the layout, and why it reads as empty when it does.
   */
  async layout(root: string): Promise<{ spec: BoardSpec; problem?: string | undefined }> {
    let text: string
    try { text = await readFile(await projectPath(root, BOARD_FILE), 'utf8') } catch { return { spec: structuredClone(EMPTY) } }
    let value: unknown
    try { value = JSON.parse(text) } catch (error) { return { spec: structuredClone(EMPTY), problem: `${BOARD_FILE} is not JSON: ${errorText(error)}` } }
    const parsed = boardSpecSchema.safeParse(value)
    if (parsed.success) return { spec: parsed.data }
    return { spec: structuredClone(EMPTY), problem: `${BOARD_FILE} is invalid: ${issueText(parsed.error)}` }
  }

  /**
   * Apply a patch to the stored layout, one change at a time per project.
   * @param root - the project root.
   * @param patch - the change.
   * @param replace - whether to start from an empty board.
   * @returns the layout as stored.
   */
  update(root: string, patch: BoardPatch, replace: boolean): Promise<BoardSpec> {
    const previous = this.writes.get(root) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      const current = replace ? structuredClone(EMPTY) : (await this.layout(root)).spec
      const parsed = boardSpecSchema.safeParse({ ...applyPatch(current, patch), updatedAt: new Date().toISOString() })
      if (!parsed.success) throw new Error(`The board was not saved: ${issueText(parsed.error)}`)
      await atomicWrite(await projectPath(root, BOARD_FILE), `${JSON.stringify(parsed.data, null, 1)}\n`)
      return parsed.data
    })
    this.writes.set(root, next)
    return next
  }

  /** What the scripts read last: from memory, else from the project's saved copy. */
  private async data(project: ResearchProject): Promise<BoardData> {
    const state = this.state(project.id)
    if (state.data) return state.data
    try {
      const parsed = dataSchema.safeParse(JSON.parse(await readFile(await projectPath(project.root, SNAPSHOT_FILE), 'utf8')))
      if (parsed.success) state.data = parsed.data as BoardData
    } catch { /* nothing read yet */ }
    state.data ??= structuredClone(NO_DATA)
    return state.data
  }

  /**
   * The board as last read. With `refresh`, a read starts in the background
   * unless one is under way or began less than ten seconds ago.
   * @param project - the project, as recorded now.
   * @param refresh - whether to start a read.
   * @param runs - runs whose progress lines to add from this machine when the last read did not carry them.
   * @returns the layout, what the scripts read last, and whether a read is under way.
   */
  async view(project: ResearchProject, refresh: boolean, runs: string[] = []): Promise<BoardSnapshot> {
    const { spec, problem } = await this.layout(project.root)
    const data = await this.data(project)
    const series = { ...data.series }
    for (const run of project.experiments.filter(item => runs.includes(item.id) && series[item.id] === undefined)) {
      series[run.id] = await readProgress(await localProgress(project, run))
    }
    const state = this.state(project.id)
    if (refresh && !state.reading && Date.now() - state.lastAttempt >= MIN_READ_MS) {
      const reading = this.read(project, this.options.signal, false).catch((error: unknown) => {
        this.options.warn(`research board read for ${project.id}: ${errorText(error)}`)
      })
      this.options.track(reading)
    }
    return {
      spec, ...data, series, refreshing: state.reading !== undefined,
      alerts: problem ? [{ level: 'error', text: problem }, ...data.alerts] : data.alerts,
    }
  }

  /**
   * Read everything now, collectors included, and say what each script produced.
   * @param project - the project, as recorded now.
   * @param signal - cancellation of the read.
   * @returns the report the agent reads.
   */
  async refresh(project: ResearchProject, signal: AbortSignal): Promise<BoardReport> {
    const data = await this.read(project, signal, true)
    return {
      capturedAt: data.capturedAt,
      machines: data.machines.map(machine => ({
        key: machine.key, ...machine.error ? { error: machine.error } : {}, gpus: machine.gpus.length,
      })),
      collectors: Object.entries(data.collected).map(([id, collected]) => ({
        id, ok: collected.error === undefined, ...collected.error ? { error: collected.error } : {},
        sections: collected.sections.length, stats: collected.stats.length, ms: collected.ms,
      })),
      series: Object.keys(data.series).length,
      alerts: data.alerts,
    }
  }

  /** One read at a time per project: a read asked for during another starts when that one ends. */
  private read(project: ResearchProject, signal: AbortSignal, force: boolean): Promise<BoardData> {
    const state = this.state(project.id)
    state.lastAttempt = Date.now()
    const reading = (state.reading ?? Promise.resolve()).catch(() => {}).then(() => this.collect(project, signal, force))
      .finally(() => { if (state.reading === reading) state.reading = undefined })
    state.reading = reading
    return reading
  }

  private async collect(project: ResearchProject, signal: AbortSignal, force: boolean): Promise<BoardData> {
    const { spec } = await this.layout(project.root)
    const previous = await this.data(project)
    const state = this.state(project.id)
    const now = Date.now()
    const groups = machineGroups(project, spec)
    const probes = await Promise.all(groups.map(group => this.probe(group, signal).then(
      probe => ({ probe }),
      (error: unknown) => ({ error: errorText(error) }),
    )))
    const alerts: BoardAlert[] = []
    const machines = groups.map((group, index): BoardMachine => {
      const result = probes[index] as { probe: Probe } | { error: string }
      const history = (previous.machines.find(machine => machine.key === group.key)?.history ?? [])
        .filter(item => item.t >= now - HISTORY_MS)
      const environments = group.environments.map(environment => environment.name)
      if ('error' in result) {
        alerts.push({ level: 'warning', text: `${group.key}: ${result.error}` })
        return { key: group.key, environments, at: new Date(now).toISOString(), error: result.error, gpus: [], history }
      }
      const { probe } = result
      if (probe.disk && probe.disk.total > 0 && probe.disk.free / probe.disk.total < LOW_DISK) {
        alerts.push({ level: 'warning', text: `${group.key}: ${probe.disk.path} has ${Math.round(probe.disk.free / probe.disk.total * 100)}% free` })
      }
      return {
        key: group.key, environments, at: new Date(now).toISOString(),
        ...probe.host === undefined ? {} : { host: probe.host }, ...probe.os === undefined ? {} : { os: probe.os },
        gpus: probe.gpus,
        ...probe.cpu ? { cpu: probe.cpu } : {}, ...probe.memory ? { memory: probe.memory } : {}, ...probe.disk ? { disk: probe.disk } : {},
        history: [...history, sample(probe, now)].slice(-HISTORY_SAMPLES),
      }
    })
    const series: Record<string, Record<string, number>[]> = {}
    for (const run of seriesRuns(project, spec)) {
      const group = groups.find(item => item.remote.includes(run))
      if (group === undefined) {
        series[run.id] = await readProgress(await localProgress(project, run))
        continue
      }
      // A host that did not answer keeps the curve it last gave.
      const result = probes[groups.indexOf(group)] as { probe: Probe } | { error: string }
      const lines = 'probe' in result ? result.probe.progress[run.directory] : previous.series[run.id]
      if (lines) series[run.id] = lines
    }
    const collected: Record<string, BoardCollected> = {}
    for (const collector of spec.collectors) {
      const last = previous.collected[collector.id]
      const every = (collector.every ?? DEFAULT_COLLECTOR_SECONDS) * 1000
      const due = force || last === undefined || now - (state.ran.get(collector.id) ?? 0) >= every
      if (!due) { collected[collector.id] = last; continue }
      state.ran.set(collector.id, now)
      const started = Date.now()
      try {
        const output = await this.runCollector(project, collector, signal)
        collected[collector.id] = { ...output, at: new Date().toISOString(), ms: Date.now() - started }
      } catch (error) {
        signal.throwIfAborted()
        collected[collector.id] = {
          stats: last?.stats ?? [], sections: last?.sections ?? [], alerts: last?.alerts ?? [],
          at: new Date().toISOString(), ms: Date.now() - started, error: errorText(error),
        }
      }
    }
    for (const [id, item] of Object.entries(collected)) if (item.error) alerts.push({ level: 'warning', text: `${id}: ${item.error}` })
    const data: BoardData = { capturedAt: new Date(now).toISOString(), machines, series, collected, alerts }
    state.data = data
    await atomicWrite(await projectPath(project.root, SNAPSHOT_FILE), JSON.stringify(data))
    return data
  }

  /** Run the probe on one machine, over SSH or here. */
  private async probe(group: MachineGroup, signal: AbortSignal): Promise<Probe> {
    const request = JSON.stringify({ disk: group.disk, progress: group.remote.map(run => run.directory), limit: SERIES_ROWS })
    const input = await readFile(runtimeAsset('board_probe.py'))
    const options = { signal, input, timeoutMs: PROBE_TIMEOUT_MS, maxBytes: PROGRESS_BYTES }
    const result = group.host === undefined
      ? await runProcess(group.python, ['-', request], options)
      : await ssh(group.host, [group.python, '-', request], options)
    return probeSchema.parse(JSON.parse(checked(result, 'Machine probe')))
  }

  /**
   * Run one collector with its environment's interpreter, the script on
   * standard input. A local collector starts in the project folder with
   * RESEARCH_PROJECT_ROOT set; a remote one gets RESEARCH_REMOTE_ROOT.
   */
  private async runCollector(project: ResearchProject, collector: BoardCollector, signal: AbortSignal): Promise<Omit<BoardCollected, 'at' | 'ms'>> {
    const environment = collector.environmentId === undefined
      ? project.environments.find(item => item.isDefault && item.status === 'ready')
      : project.environments.find(item => item.id === collector.environmentId)
    if (collector.environmentId !== undefined && !environment) throw new Error(`Unknown environment ${collector.environmentId}`)
    const input = await readText(await projectPath(project.root, collector.script), SCRIPT_BYTES)
    const args = collector.args ?? []
    const options = { signal, input, timeoutMs: COLLECTOR_TIMEOUT_MS, maxBytes: COLLECTOR_OUTPUT_BYTES }
    let result: ProcessResult
    if (environment?.target === 'ssh') {
      result = await ssh(environment.sshHost ?? '', ['env', `RESEARCH_REMOTE_ROOT=${environment.remoteRoot ?? ''}`, environment.python, '-', ...args], options)
    } else {
      const python = environment?.python ?? await this.options.localPython()
      if (python === undefined) throw new Error('No Python to run the collector: bind an experiment environment or install the platform Python')
      result = await runProcess(python, ['-', ...args], { ...options, cwd: project.root, env: { RESEARCH_PROJECT_ROOT: project.root } })
    }
    const output = checked(result, 'Collector')
    let value: unknown
    try { value = JSON.parse(output) } catch { throw new Error(`The collector printed no JSON object: ${output.slice(0, 200)}`) }
    return collectorOutput(value)
  }
}

/**
 * A collector's output, keeping every part that parses. Parts that do not are
 * dropped and named in `error`, so one bad block does not blank the rest.
 * @param value - what the script printed, parsed as JSON.
 * @returns the stats, sections and alerts that parse, and what did not.
 */
export function collectorOutput(value: unknown): Omit<BoardCollected, 'at' | 'ms'> {
  const shape = collectorShape.safeParse(withoutNulls(value))
  if (!shape.success) throw new Error(`The collector must print one object {stats?, sections?, alerts?}: ${issueText(shape.error)}`)
  const problems: string[] = []
  const keep = <T>(items: unknown[] | undefined, schema: z.ZodType<T>, name: string): T[] => (items ?? []).flatMap((item, index) => {
    const parsed = schema.safeParse(item)
    if (parsed.success) return [parsed.data]
    problems.push(issueText(parsed.error, `${name}[${index}]`))
    return []
  })
  const output = {
    stats: keep(shape.data.stats, boardStatSchema, 'stats'),
    sections: keep(shape.data.sections, boardSectionSchema, 'sections'),
    alerts: keep(shape.data.alerts, boardAlertSchema, 'alerts'),
  } as Omit<BoardCollected, 'at' | 'ms'>
  return problems.length ? { ...output, error: problems.join('; ') } : output
}

/**
 * The machines to probe: those of the active runs, of the collectors and of
 * the default environment, one per host however many environments share it.
 */
function machineGroups(project: ResearchProject, spec: BoardSpec): MachineGroup[] {
  const ready = project.environments.filter(environment => environment.status === 'ready')
  const wanted = new Set<string>()
  const active = project.experiments.filter(run => ACTIVE.has(run.status))
  for (const run of active) wanted.add(run.spec.environmentId)
  for (const collector of spec.collectors) if (collector.environmentId !== undefined) wanted.add(collector.environmentId)
  for (const environment of ready) if (environment.isDefault) wanted.add(environment.id)
  const groups = new Map<string, MachineGroup>()
  for (const environment of ready.filter(item => wanted.has(item.id))) {
    const host = environment.target === 'ssh' ? environment.sshHost : undefined
    const key = host ?? 'local'
    let group = groups.get(key)
    if (!group) {
      group = { key, python: environment.python, host, disk: host === undefined ? project.root : environment.remoteRoot ?? '', environments: [], remote: [] }
      groups.set(key, group)
    }
    group.environments.push(environment)
    if (host !== undefined) group.remote.push(...active.filter(run => run.spec.environmentId === environment.id))
  }
  return [...groups.values()]
}

/** The runs whose progress lines the board carries: every active run, and each run a chart line follows. */
function seriesRuns(project: ResearchProject, spec: BoardSpec): ExperimentRecord[] {
  const runs = new Set(project.experiments.filter(run => ACTIVE.has(run.status)))
  for (const section of spec.sections) {
    for (const block of section.blocks) {
      if (block.type !== 'chart') continue
      for (const series of block.series) {
        const run = latestRun(project, series)
        if (run) runs.add(run)
      }
    }
  }
  return [...runs]
}

/**
 * The collector scripts not written yet; the layout may name one before the agent writes it.
 * @param root - the project root.
 * @param spec - the layout.
 * @returns the missing scripts' paths.
 */
export async function missingScripts(root: string, spec: BoardSpec): Promise<string[]> {
  const missing: string[] = []
  for (const collector of spec.collectors) if (!existsSync(await projectPath(root, collector.script))) missing.push(collector.script)
  return missing
}
