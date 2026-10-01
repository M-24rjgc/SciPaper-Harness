/**
 * What the Memory (记忆) view derives from the memory page before it draws: where every research card, item chip and
 * the next-research card sits, and the sentences beside the switches. The host sends facts about the records; every
 * sentence is picked from the dictionary here, so nothing the person reads is generated outside the interface language.
 *
 * @module @deepseek-ai/dsh-client-ui-research/memoryValues
 */
import type {
  MemoryEnvironment, MemoryKind, MemoryLesson, MemoryResearch, ProjectId, ResearchMemoryPage,
} from '@deepseek-ai/dsh-research-workbench/types'
import { counted, dateText, type Translate } from './format.ts'
import type { ResearchKey } from './locales.ts'

/** Height of a research card, in pixels; its title is clamped to fit. */
export const RESEARCH_HEIGHT = 92
/** Height of an item chip, in pixels. */
export const CHIP_HEIGHT = 30
/** Space between two chips of one kind. */
export const CHIP_GAP = 8
/** Space between the last chip of one kind and the first of the next. */
export const GROUP_GAP = 18
/** Space between two research cards. */
export const CARD_GAP = 12
/** Height of the next-research card, in pixels. */
export const NEXT_HEIGHT = 92
/** The most items of one kind drawn as chips; the rest become one chip that counts them. */
export const SHOWN_PER_KIND = 5
/** The most names a switch's sentence lists before it counts the rest. */
const NAMED = 3
/** The most lessons listed in the panel. */
export const LESSONS_SHOWN = 5

/** The kinds of memory, in the order the chips and the switches list them. */
export const KINDS: readonly MemoryKind[] = ['literature', 'runs', 'environments', 'writing']

const TITLE_KEYS: Record<MemoryKind, ResearchKey> = {
  literature: 'memKindLiterature', runs: 'memKindRuns', environments: 'memKindEnvironments', writing: 'memKindWriting',
}
const CHIP_KEYS: Record<MemoryKind, ResearchKey> = {
  literature: 'memChipLiterature', runs: 'memChipRuns', environments: 'memChipEnvironments', writing: 'memChipWriting',
}

/** One item chip and its place in the middle column. */
export interface PlacedChip {
  id: string
  kind: MemoryKind
  /** The item's name; the count of the rest for the chip that stands for them. */
  label: string
  /** The full text for the chip's tooltip. */
  title: string
  /** The researches the item came from. */
  researches: readonly ProjectId[]
  /** The kind is switched on, so the next research carries the item. */
  carried: boolean
  top: number
  center: number
}

/** A research card and its place in the left column. */
export interface PlacedResearch {
  research: MemoryResearch
  top: number
  center: number
}

/** A line from a research to an item it left, as heights in the gutter between their columns. */
export interface SourceEdge {
  researchId: ProjectId
  chipId: string
  from: number
  to: number
}

/** A line from a carried item to the next research, as heights in the gutter between their columns. */
export interface CarryEdge {
  chipId: string
  from: number
  to: number
}

/** Where the cards, chips and lines of the memory graph go. */
export interface MemoryLayout {
  /** Height of the three columns. */
  height: number
  researches: PlacedResearch[]
  chips: PlacedChip[]
  /** The next-research card. */
  next: { top: number; center: number }
  sourceEdges: SourceEdge[]
  carryEdges: CarryEdge[]
}

/** An item of one kind before it has a place. */
interface ChipSeed {
  label: string
  title: string
  researches: readonly ProjectId[]
}

/**
 * A kind's name for the switch that carries it.
 * @param kind - the kind of memory.
 * @param t - bound dictionary lookup.
 * @returns the localized name.
 */
export function kindTitle(kind: MemoryKind, t: Translate): string {
  return t(TITLE_KEYS[kind])
}

/**
 * A kind's short name on a chip.
 * @param kind - the kind of memory.
 * @param t - bound dictionary lookup.
 * @returns the localized name.
 */
export function chipKind(kind: MemoryKind, t: Translate): string {
  return t(CHIP_KEYS[kind])
}

/** The label of an environment: an SSH host by its alias, the local `uv` environment by its kind, any other by its name. */
function environmentLabel(environment: MemoryEnvironment, t: Translate): string {
  if (environment.target === 'ssh') return `${environment.host ?? environment.name} · ${t('memSsh')}`
  return environment.kind === 'uv' ? t('memLocalUv') : environment.name
}

/** Lines joined for a tooltip; blank ones are left out. */
function lines(parts: readonly string[]): string {
  return parts.filter(part => part !== '').join('\n')
}

/** The first metrics a run recorded, exactly as its metrics file reported them. */
function metricsText(metrics: Record<string, number>): string {
  return Object.entries(metrics).slice(0, NAMED).map(([name, value]) => `${name} ${value}`).join(' · ')
}

/** The items of one kind as chips without a place. */
function seedsOf(page: ResearchMemoryPage, kind: MemoryKind, t: Translate): ChipSeed[] {
  switch (kind) {
    case 'literature': return page.literature.items.map(item => ({
      label: item.title, title: lines([item.title, item.doi ?? '']), researches: item.researches,
    }))
    case 'runs': return page.runs.items.map(item => ({
      label: item.name, title: lines([item.name, metricsText(item.metrics), item.command]), researches: item.researches,
    }))
    case 'environments': return page.environments.items.map(item => ({
      label: environmentLabel(item, t),
      title: lines([environmentLabel(item, t), item.python, item.requirements.join(', ')]), researches: item.researches,
    }))
    case 'writing': return page.writing.items.map(item => ({
      label: item.name ?? item.venue, title: lines([item.name ?? '', item.venue]), researches: item.researches,
    }))
  }
}

/** The chips of one kind: the first few items, and one chip that counts and stands for the rest. */
function chipsOf(page: ResearchMemoryPage, kind: MemoryKind, t: Translate): ChipSeed[] {
  const seeds = seedsOf(page, kind, t)
  const shown = seeds.slice(0, SHOWN_PER_KIND)
  const more = page[kind].total - shown.length
  if (more <= 0) return shown
  const label = t('memMore', { n: more })
  return [...shown, { label, title: label, researches: [...new Set(seeds.slice(SHOWN_PER_KIND).flatMap(seed => seed.researches))] }]
}

/** The average of at least one number. */
function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * Place the researches, the items they left and the next research in three columns. Chips stack by kind in the order
 * the switches list them; each research sits level with the middle of its own chips and is pushed down only as far as
 * the card above requires; the next research sits level with the middle of the chips it carries. Every height is a
 * pixel count the columns reproduce exactly, so the lines between them are computed rather than measured.
 * @param page - the memory page.
 * @param t - bound dictionary lookup, for the chips' names.
 * @returns the heights of every card, chip and line; a research that left no chip sits where the cards above it end.
 */
export function memoryLayout(page: ResearchMemoryPage, t: Translate): MemoryLayout {
  const chips: PlacedChip[] = []
  let cursor = 0
  for (const kind of KINDS) {
    const group = chipsOf(page, kind, t)
    if (group.length === 0) continue
    if (chips.length > 0) cursor += GROUP_GAP - CHIP_GAP
    for (const seed of group) {
      chips.push({ ...seed, id: `${kind}:${chips.length}`, kind, carried: page.carry[kind], top: cursor, center: cursor + CHIP_HEIGHT / 2 })
      cursor += CHIP_HEIGHT + CHIP_GAP
    }
  }
  let floor = 0
  const researches = page.researches.map((research): PlacedResearch => {
    const centers = chips.filter(chip => chip.researches.includes(research.id)).map(chip => chip.center)
    const wanted = centers.length === 0 ? floor + RESEARCH_HEIGHT / 2 : mean(centers)
    const top = Math.max(wanted - RESEARCH_HEIGHT / 2, floor)
    floor = top + RESEARCH_HEIGHT + CARD_GAP
    return { research, top, center: top + RESEARCH_HEIGHT / 2 }
  })
  const carried = chips.filter(chip => chip.carried)
  const anchors = (carried.length === 0 ? chips : carried).map(chip => chip.center)
  const nextTop = Math.max((anchors.length === 0 ? NEXT_HEIGHT / 2 : mean(anchors)) - NEXT_HEIGHT / 2, 0)
  const next = { top: nextTop, center: nextTop + NEXT_HEIGHT / 2 }
  return {
    height: Math.max(
      0, cursor - CHIP_GAP, next.top + NEXT_HEIGHT, ...researches.map(placed => placed.top + RESEARCH_HEIGHT),
    ),
    researches,
    chips,
    next,
    sourceEdges: chips.flatMap(chip => researches.filter(placed => chip.researches.includes(placed.research.id)).map(placed => ({
      researchId: placed.research.id, chipId: chip.id, from: placed.center, to: chip.center,
    }))),
    carryEdges: carried.map(chip => ({ chipId: chip.id, from: chip.center, to: next.center })),
  }
}

/**
 * How many items the next research carries: those of every kind that is switched on.
 * @param page - the memory page.
 * @returns the sum of the carried kinds' totals.
 */
export function carriedCount(page: ResearchMemoryPage): number {
  return KINDS.filter(kind => page.carry[kind]).reduce((sum, kind) => sum + page[kind].total, 0)
}

/**
 * The next-research card's line under its name.
 * @param page - the memory page.
 * @param t - bound dictionary lookup.
 * @returns what it carries, or that it carries nothing yet.
 */
export function nextMeta(page: ResearchMemoryPage, t: Translate): string {
  const n = carriedCount(page)
  return n === 0 ? t('memCarriesNone') : counted(n, 'memCarriesOne', 'memCarriesMany', t)
}

/**
 * The line under a research's name: what it imported and finished, and the venue it writes for.
 * @param research - the research as the page lists it.
 * @param t - bound dictionary lookup.
 * @returns the facts joined by a middle dot; empty when the record holds none of them.
 */
export function researchMeta(research: MemoryResearch, t: Translate): string {
  return [
    ...research.literature > 0 ? [counted(research.literature, 'memPapersOne', 'memPapersMany', t)] : [],
    ...research.runs > 0 ? [counted(research.runs, 'memRunsOne', 'memRunsMany', t)] : [],
    ...research.venue === undefined ? [] : [research.venue],
  ].join(' · ')
}

/** The first names of a kind, and the count of the rest. */
function names(all: readonly string[], total: number, t: Translate): string {
  const shown = all.slice(0, NAMED).join(t('memJoin'))
  return total > NAMED ? t('memAndMore', { names: shown, n: total - NAMED }) : shown
}

/**
 * The sentence beside a switch: how much of the kind there is and where it came from, as the page states it.
 * @param kind - the kind the switch carries.
 * @param page - the memory page.
 * @param t - bound dictionary lookup.
 * @returns the sentence; that nothing is recorded yet when the kind is empty.
 */
export function switchDetail(kind: MemoryKind, page: ResearchMemoryPage, t: Translate): string {
  const { total } = page[kind]
  if (total === 0) return t('memDetailNone')
  switch (kind) {
    case 'literature': {
      const shared = page.literature.items.filter(item => item.researches.length > 1).length
      const main = t('memDetailLiterature', {
        papers: counted(total, 'memPapersOne', 'memPapersMany', t),
        researches: counted(page.researches.filter(research => research.literature > 0).length, 'memResearchesOne', 'memResearchesMany', t),
      })
      return shared === 0 ? main : `${main} ${t('memDetailShared', { n: shared })}`
    }
    case 'runs': return t('memDetailRuns', { runs: counted(total, 'memRunsOne', 'memRunsMany', t) })
    case 'environments': return t('memDetailEnvironments', {
      environments: counted(total, 'memEnvsOne', 'memEnvsMany', t),
      names: names(page.environments.items.map(item => environmentLabel(item, t)), total, t),
    })
    case 'writing': return t('memDetailWriting', {
      venues: counted(total, 'memVenuesOne', 'memVenuesMany', t),
      names: names(page.writing.items.map(item => item.name ?? item.venue), total, t),
    })
  }
}

/** What a lesson says in the panel. */
export interface LessonText {
  kind: MemoryLesson['kind']
  /** The recorded failure or decision. */
  text: string
  /** The recorded rationale of a decision; empty for a failure and for a decision that gave none. */
  why: string
  /** The research and the day it was recorded. */
  from: string
}

/**
 * A recorded lesson as the panel words it. Names, reasons and rationales are the record's own words.
 * @param lesson - a failed run or a decision.
 * @param page - the memory page, which names the research.
 * @param t - bound dictionary lookup.
 * @returns the lesson's lines.
 */
export function lessonText(lesson: MemoryLesson, page: Pick<ResearchMemoryPage, 'researches'>, t: Translate): LessonText {
  /* v8 ignore next -- every lesson names a research the page lists */
  const title = page.researches.find(research => research.id === lesson.research)?.title ?? ''
  const from = t('memLessonFrom', { research: title, date: dateText(lesson.at, t) })
  switch (lesson.kind) {
    case 'failed-run': return {
      kind: lesson.kind, why: '', from,
      text: t('memLessonFailed', { name: lesson.name, reason: lesson.reason === '' ? t('memExitCode', { n: String(lesson.exitCode) }) : lesson.reason }),
    }
    case 'decision': return {
      kind: lesson.kind, from, text: t('memLessonDecision', { question: lesson.question, answer: lesson.answer }),
      why: lesson.rationale === '' ? '' : t('memLessonWhy', { rationale: lesson.rationale }),
    }
  }
}
