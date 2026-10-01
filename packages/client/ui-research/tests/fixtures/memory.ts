/** Builders for memory pages, so the specs of the Memory view state only the facts they care about. */
import type {
  MemoryEnvironment, MemoryKind, MemoryList, MemoryLiterature, MemoryResearch, MemoryRun, MemoryWriting, ProjectId, ResearchMemoryPage,
} from '@deepseek-ai/dsh-research-workbench/types'

/** Research ids from plain strings. */
export const ids = (...values: string[]): ProjectId[] => values as ProjectId[]

/** A research as the page lists it. */
export const research = (id: string, patch: Partial<MemoryResearch> = {}): MemoryResearch => (
  { id: id as ProjectId, title: `Research ${id}`, finished: false, literature: 0, runs: 0, ...patch }
)

/** A list of items and, unless given, their count as the total. */
export const list = <T>(items: T[], total = items.length): MemoryList<T> => ({ total, items })

/** A literature item imported by the named researches. */
export const paper = (title: string, from: string[], patch: Partial<MemoryLiterature> = {}): MemoryLiterature => (
  { title, verified: true, researches: ids(...from), ...patch }
)

/** Finished runs of one experiment name in one research. */
export const experiment = (name: string, from: string, patch: Partial<MemoryRun> = {}): MemoryRun => ({
  name, runs: 1, metrics: { accuracy: 0.9, loss: 0.1, f1: 0.8, extra: 1 }, command: '{python} train.py', at: '2026-08-01T00:00:00Z',
  researches: ids(from), ...patch,
})

/** A ready local `uv` environment of the named researches unless the patch says otherwise. */
export const environment = (name: string, from: string[], patch: Partial<MemoryEnvironment> = {}): MemoryEnvironment => (
  { name, kind: 'uv', target: 'local', python: '', requirements: [], researches: ids(...from), ...patch }
)

/** A venue the named researches use, with the library's name when given. */
export const venue = (id: string, from: string[], name?: string): MemoryWriting => (
  { venue: id, researches: ids(...from), ...name === undefined ? {} : { name } }
)

/** Every kind switched on. */
export const everyKind: Record<MemoryKind, boolean> = { literature: true, runs: true, environments: true, writing: true }

/** A page that holds nothing unless the patch gives it something. */
export const page = (patch: Partial<ResearchMemoryPage> = {}): ResearchMemoryPage => ({
  researches: [], literature: list([]), runs: list([]), environments: list([]), writing: list([]), lessons: list([]),
  carry: everyKind, ...patch,
})
