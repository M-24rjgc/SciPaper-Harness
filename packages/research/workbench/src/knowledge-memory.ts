/**
 * The memory of the researches on this computer, read from their records: the literature they imported, the experiments
 * they finished, the environments they set up, the venue templates they chose, and the failures and decisions they
 * recorded. Every function is pure; nothing is stored, and each item comes from a recorded field, never from a guess.
 */
import { blankRecord } from './drafts.ts'
import { MODE_DECISION_KEY } from './schema.ts'
import { titleKey } from './title-key.ts'
import type {
  EvidenceRecord, ExperimentRecord, MemoryEnvironment, MemoryKind, MemoryLesson, MemoryList, MemoryLiterature, MemoryRun,
  MemoryWriting, ProjectId, ResearchMemoryPage, ResearchPreferences, ResearchProject,
} from './types.ts'

/** The most items one kind lists on a page; the list's `total` counts them all. */
export const MEMORY_LIMIT = 100
/** The most items of one kind the agent reads at once. */
export const AGENT_MEMORY_LIMIT = 40
/** The longest recorded sentence kept, in characters; a longer one is cut and ends with an ellipsis. */
const MAX_TEXT = 240
/** The kinds a new research can carry, in the order the page lists them. */
const MEMORY_KINDS: readonly MemoryKind[] = ['literature', 'runs', 'environments', 'writing']

/** What the memory reads besides the records. */
export interface MemoryOptions {
  /** Whether a research folder lies among the shipped examples, which leave no memory. */
  isExample: (root: string) => boolean
  /** The researches that stand finished (`ResearchStanding.finished`). */
  finished: ReadonlySet<ProjectId>
  /** Which kinds a new research carries (`memoryCarry`). */
  carry: Record<MemoryKind, boolean>
  /** The library's name for a venue id, when it has one. */
  venueName?: ((id: string) => string | undefined) | undefined
}

/**
 * The person's switches as they stand: a kind is on unless it was switched off.
 * @param preferences - the saved research preferences.
 * @returns every kind, on or off.
 */
export function memoryCarry(preferences: Pick<ResearchPreferences, 'memoryCarry'>): Record<MemoryKind, boolean> {
  const saved = preferences.memoryCarry
  return {
    literature: saved?.literature !== false, runs: saved?.runs !== false,
    environments: saved?.environments !== false, writing: saved?.writing !== false,
  }
}

/**
 * Whether a research leaves memory. A research removed from the list, the untouched draft and an example do not.
 * @param project - the research record.
 * @param isExample - whether a folder lies among the shipped examples.
 * @returns true when its record is worth remembering from.
 */
export function leavesMemory(project: ResearchProject, isExample: (root: string) => boolean): boolean {
  return project.archivedAt === undefined && !blankRecord(project) && !isExample(project.root)
}

/** A recorded sentence on one line, cut to the longest one kept. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const characters = Array.from(flat)
  return characters.length > MAX_TEXT ? `${characters.slice(0, MAX_TEXT - 1).join('')}…` : flat
}

/** What makes two literature records the same paper: the title without case, accents and punctuation, else the record's own id. */
function literatureKey(item: EvidenceRecord): string {
  return titleKey(item.title) || item.id
}

/** Record that a research contributed to an item, once. */
function credit(researches: ProjectId[], id: ProjectId): void {
  if (!researches.includes(id)) researches.push(id)
}

/** The items shared by most researches first; among equals the older research's come first. */
function mostShared<T extends { researches: readonly ProjectId[] }>(items: T[]): T[] {
  return items.sort((a, b) => b.researches.length - a.researches.length)
}

/** The literature of the researches, merged by title. */
function literatureOf(researches: readonly ResearchProject[]): MemoryLiterature[] {
  const merged = new Map<string, MemoryLiterature>()
  for (const research of researches) {
    for (const item of research.evidence.filter(record => record.kind === 'literature')) {
      const key = literatureKey(item)
      const known = merged.get(key)
      if (known === undefined) {
        merged.set(key, {
          title: oneLine(item.title), ...item.doi === undefined ? {} : { doi: item.doi },
          verified: item.verified, researches: [research.id],
        })
        continue
      }
      credit(known.researches, research.id)
      known.verified ||= item.verified
      if (known.doi === undefined && item.doi !== undefined) known.doi = item.doi
    }
  }
  return mostShared([...merged.values()])
}

/** The experiments one research finished, one item per name; its newest run speaks for the name. */
function runsOf(research: ResearchProject): MemoryRun[] {
  const groups = new Map<string, { latest: ExperimentRecord; runs: number }>()
  for (const run of research.experiments.filter(item => item.status === 'completed')) {
    const group = groups.get(run.spec.name)
    if (group === undefined) {
      groups.set(run.spec.name, { latest: run, runs: 1 })
      continue
    }
    group.runs++
    if (run.updatedAt > group.latest.updatedAt) group.latest = run
  }
  return [...groups].map(([name, { latest, runs }]) => ({
    name, runs, metrics: { ...latest.metrics }, command: oneLine(latest.spec.argv.join(' ')), at: latest.updatedAt, researches: [research.id],
  }))
}

/**
 * The ready environments of the researches. A local `uv` environment lives in its research's own folder, so those merge into
 * one; an SSH environment merges by host and interpreter; any other local interpreter by kind and path.
 */
function environmentsOf(researches: readonly ResearchProject[]): MemoryEnvironment[] {
  const merged = new Map<string, MemoryEnvironment>()
  for (const research of researches) {
    for (const environment of research.environments.filter(item => item.status === 'ready')) {
      const own = environment.target === 'local' && environment.kind === 'uv'
      const host = environment.target === 'ssh' ? environment.sshHost : undefined
      const key = own ? 'local|uv' : `${environment.target}|${host ?? ''}|${environment.kind}|${environment.python}`
      const known = merged.get(key)
      if (known === undefined) {
        merged.set(key, {
          name: environment.name, kind: environment.kind, target: environment.target, ...host === undefined ? {} : { host },
          python: own ? '' : environment.python, requirements: [...environment.requirements], researches: [research.id],
        })
        continue
      }
      credit(known.researches, research.id)
      for (const requirement of environment.requirements) {
        if (!known.requirements.includes(requirement)) known.requirements.push(requirement)
      }
    }
  }
  return mostShared([...merged.values()])
}

/** The venue templates the researches use. */
function writingOf(researches: readonly ResearchProject[], venueName: MemoryOptions['venueName']): MemoryWriting[] {
  const merged = new Map<string, MemoryWriting>()
  for (const research of researches) {
    if (research.venue === undefined) continue
    const known = merged.get(research.venue)
    if (known !== undefined) {
      credit(known.researches, research.id)
      continue
    }
    const name = venueName?.(research.venue)
    merged.set(research.venue, { venue: research.venue, ...name === undefined ? {} : { name }, researches: [research.id] })
  }
  return mostShared([...merged.values()])
}

/**
 * What one research recorded about what went wrong or what it decided: runs that failed with a recorded reason or exit
 * code, and its decisions other than the choice of mode. A failure repeated under one name and reason is one lesson.
 */
function lessonsOf(research: ResearchProject): MemoryLesson[] {
  const failures = new Map<string, MemoryLesson>()
  for (const run of research.experiments.filter(item => item.status === 'failed')) {
    const reason = oneLine(run.message)
    if (reason === '' && run.exitCode === undefined) continue
    const at = run.finishedAt ?? run.updatedAt
    const key = `${run.spec.name}\n${reason}\n${String(run.exitCode)}`
    const known = failures.get(key)
    if (known === undefined || at > known.at) {
      failures.set(key, {
        research: research.id, at, kind: 'failed-run', name: run.spec.name, reason, ...run.exitCode === undefined ? {} : { exitCode: run.exitCode },
      })
    }
  }
  const decisions = research.decisions.filter(decision => decision.key !== MODE_DECISION_KEY).map((decision): MemoryLesson => ({
    research: research.id, at: decision.at, kind: 'decision', question: oneLine(decision.question), answer: oneLine(decision.answer),
    rationale: oneLine(decision.rationale), by: decision.by,
  }))
  return [...failures.values(), ...decisions]
}

/** Newest first, by the ISO time the items carry. */
function newestFirst(a: { at: string }, b: { at: string }): number {
  return b.at.localeCompare(a.at)
}

/** A list capped at the page's limit, with the count of them all. */
function listed<T>(items: T[]): MemoryList<T> {
  return { total: items.length, items: items.slice(0, MEMORY_LIMIT) }
}

/**
 * Project the researches into what a new research can carry. The projection is pure: it reads the records and the
 * options and nothing else. Literature merges by title across researches; the finished experiments are listed by name
 * with no claim that any is a baseline, because the record does not mark one; the environments are the ready ones; the
 * writing choices are the venues whose templates were applied; the lessons are recorded failures and decisions.
 * @param projects - every research record the host holds.
 * @param options - the examples, the finished researches, the switches and the venue names.
 * @returns the researches that left memory, oldest first, and their memory by kind.
 */
export function buildResearchMemory(projects: readonly ResearchProject[], options: MemoryOptions): ResearchMemoryPage {
  const researches = projects.filter(project => leavesMemory(project, options.isExample))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  return {
    researches: researches.map(research => ({
      id: research.id, title: oneLine(research.title), finished: options.finished.has(research.id),
      literature: new Set(research.evidence.filter(item => item.kind === 'literature').map(literatureKey)).size,
      runs: runsOf(research).length,
      ...research.venue === undefined ? {} : { venue: options.venueName?.(research.venue) ?? research.venue },
    })),
    literature: listed(literatureOf(researches)),
    runs: listed(researches.flatMap(runsOf).sort(newestFirst)),
    environments: listed(environmentsOf(researches)),
    writing: listed(writingOf(researches, options.venueName)),
    lessons: listed(researches.flatMap(lessonsOf).sort(newestFirst)),
    carry: { ...options.carry },
  }
}

/** An item as the agent reads it: the researches it came from by title instead of by id. */
export type Sourced<T extends { researches: readonly ProjectId[] }> = Omit<T, 'researches'> & { from: string[] }

/** What the agent reads of the memory: the kinds the person switched on, and the researches they came from by title. */
export interface CarriedMemory {
  /** The kinds switched on, whether or not they hold anything. */
  carried: MemoryKind[]
  /** The earlier researches that left memory, oldest first. */
  researches: { title: string; finished: boolean }[]
  literature?: MemoryList<Sourced<MemoryLiterature>>
  runs?: MemoryList<Sourced<MemoryRun>>
  environments?: MemoryList<Sourced<MemoryEnvironment>>
  writing?: MemoryList<Sourced<MemoryWriting>>
}

/**
 * Reduce a page to what the agent reads: only the kinds the person switched on, each cut to the agent's limit, with
 * research titles in place of ids. Lessons are for the person's page only and are not carried.
 * @param page - the memory of the other researches, as {@link buildResearchMemory} derives it.
 * @param limit - the most items of one kind to list.
 * @returns the compact memory to serialize into the tool result.
 */
export function carriedMemory(page: ResearchMemoryPage, limit: number = AGENT_MEMORY_LIMIT): CarriedMemory {
  const titles = (ids: readonly ProjectId[]): string[] => (
    page.researches.filter(research => ids.includes(research.id)).map(research => research.title)
  )
  const sourced = <T extends { researches: readonly ProjectId[] }>(list: MemoryList<T>): MemoryList<Sourced<T>> => ({
    total: list.total, items: list.items.slice(0, limit).map(({ researches, ...rest }) => ({ ...rest, from: titles(researches) })),
  })
  const { carry } = page
  return {
    carried: MEMORY_KINDS.filter(kind => carry[kind]),
    researches: page.researches.map(({ title, finished }) => ({ title, finished })),
    ...carry.literature ? { literature: sourced(page.literature) } : {},
    ...carry.runs ? { runs: sourced(page.runs) } : {},
    ...carry.environments ? { environments: sourced(page.environments) } : {},
    ...carry.writing ? { writing: sourced(page.writing) } : {},
  }
}
