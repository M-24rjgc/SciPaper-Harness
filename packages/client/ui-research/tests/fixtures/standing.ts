/** Where a project stands, as the host's `standing` would derive it for the fixture modes. */
import type { PhaseState, ResearchStanding, StandingPhase } from '@deepseek-ai/dsh-research-workbench/types'
import { MODES } from './modes.ts'

/**
 * A standing with the given phases, labelled as the fixture's spark-to-paper pack labels them.
 * @param phases - each phase id with its state, in order.
 * @param over - any other fields; nothing is checked and nothing is open by default.
 * @returns the standing.
 */
export function standingOf(phases: [string, PhaseState][], over: Partial<ResearchStanding> = {}): ResearchStanding {
  const labels = new Map(MODES.flatMap(mode => mode.phases).map(phase => [phase.id, phase.label]))
  const items: StandingPhase[] = phases.map(([id, state]) => ({
    id, state, label: labels.get(id) ?? { en: id, zh: id }, checkpoint: id === 'experiments', hints: [],
  }))
  const current = items.find(phase => phase.state === 'current')
  return { phases: items, ...(current ? { next: current.id } : {}), finished: false, changedSinceCheck: false, issues: [], ...over }
}
