/**
 * What is live in a research right now, for the research record's 现在 (Now)
 * line and the dots of the header chip and the sidebar tree: a conversation
 * of it waiting on the person, the goals of its live conversations, and its
 * running conversations and runs. Derived from the session list, the pending
 * interactions and the record; nothing here holds state.
 */
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { LocalizedText, ResearchGoal, ResearchProject, StandingPhase } from '@deepseek-ai/dsh-research-workbench/types'
import { sessionProject, type SessionDirectories } from './contract.ts'

/** What a dot says: something waits for the person (warn), or something runs (ongoing blue). */
export type ActivitySignal = 'waiting' | 'ongoing'

/** Pending interaction kinds that wait for the person, as the session rows of the shell present them. */
const WAITING_KINDS: ReadonlySet<string> = new Set(['approval', 'plan-review', 'question'])

/**
 * One conversation's own dot: waiting on the person outranks running.
 * @param summary - the conversation's row in the session list.
 * @param pending - the pending interactions by session.
 * @returns the dot, or undefined when nothing waits and nothing runs.
 */
export function conversationSignal(summary: SessionSummary, pending: SessionPendingInteractionSnapshot): ActivitySignal | undefined {
  const interaction = pending.get(summary.id)
  if (interaction !== undefined && WAITING_KINDS.has(interaction.kind)) return 'waiting'
  return summary.running ? 'ongoing' : undefined
}

/**
 * A goal's dot: one that drives rounds runs, one that is blocked waits on the person, and a paused one shows nothing.
 * @param goal - an unfinished goal of a live conversation.
 * @returns the dot, or undefined for a paused goal.
 */
export function goalSignal(goal: ResearchGoal): ActivitySignal | undefined {
  if (goal.phase === 'blocked') return 'waiting'
  return goal.phase === 'active' ? 'ongoing' : undefined
}

/**
 * The strongest of several dots.
 * @param signals - the dots, any of them absent.
 * @returns waiting when any waits, else ongoing when any runs, else undefined.
 */
export function strongestSignal(signals: readonly (ActivitySignal | undefined)[]): ActivitySignal | undefined {
  if (signals.includes('waiting')) return 'waiting'
  return signals.includes('ongoing') ? 'ongoing' : undefined
}

/** What is live in one research. */
export interface ResearchActivity {
  /** The first listed conversation of it that waits on the person: an approval, a plan review or a question. */
  waiting: SessionSummary | undefined
  /** The newest goal that drives rounds, and the newest blocked one, in the conversation that holds it. */
  active: ResearchGoal | undefined
  blocked: ResearchGoal | undefined
  /** How many of its runs are running (not queued, not unconfirmed). */
  running: number
  /** The dot of the whole research: its conversations, its goals and its running runs. */
  signal: ActivitySignal | undefined
}

/**
 * What is live in a research: its conversations are the listed sessions whose
 * research it is (bound to it, or working in its folder), as `sessionProject` finds it.
 * @param project - the research.
 * @param projects - every project the snapshot carries, which decides where a working directory belongs.
 * @param list - the session list.
 * @param pending - the pending interactions by session.
 * @param directories - each listed session's working directory.
 * @returns the research's live activity.
 */
export function researchActivity(
  project: ResearchProject, projects: readonly ResearchProject[] | undefined, list: SessionListState,
  pending: SessionPendingInteractionSnapshot, directories: SessionDirectories,
): ResearchActivity {
  const signals: (ActivitySignal | undefined)[] = []
  let waiting: SessionSummary | undefined
  for (const id of list.ids) {
    const summary = list.byId[id]
    if (summary === undefined || sessionProject(projects, id, directories)?.id !== project.id) continue
    const signal = conversationSignal(summary, pending)
    if (signal === 'waiting') waiting ??= summary
    signals.push(signal)
  }
  const goals = project.goals ?? []
  const running = project.experiments.filter(run => run.status === 'running').length
  return {
    waiting,
    active: goals.find(goal => goal.phase === 'active'),
    blocked: goals.find(goal => goal.phase === 'blocked'),
    running,
    signal: strongestSignal([...signals, ...goals.map(goalSignal), running > 0 ? 'ongoing' : undefined]),
  }
}

/**
 * The research record's 现在 (Now) line, the first of these that holds:
 * a conversation waits on the person; a goal drives rounds; runs are running;
 * a goal is blocked on the person; in a pack mode, the next phase after a
 * check; a deferred phase with nothing left before it; the paper is
 * finished; no check has run yet; every phase is done but the paper needs
 * another check; and in the general mode, that the conversation is where to ask.
 */
export type NowLine =
  | { kind: 'waiting'; sessionId: string }
  | { kind: 'goal'; sessionId: string; phase: StandingPhase | undefined }
  | { kind: 'runs'; n: number }
  | { kind: 'blocked'; sessionId: string }
  | { kind: 'next'; phase: StandingPhase; hint: LocalizedText | undefined }
  | { kind: 'deferred'; phase: StandingPhase }
  | { kind: 'finished' }
  | { kind: 'unchecked' }
  | { kind: 'recheck' }
  | { kind: 'general' }

/**
 * Where the research stands right now, for the 现在 (Now) line.
 * @param project - the research, with its standing.
 * @param activity - what is live in it.
 * @returns the line, or undefined for a pack mode without phases or before the snapshot carries a standing.
 */
export function nowLine(project: ResearchProject, activity: ResearchActivity): NowLine | undefined {
  const phases = project.standing?.phases ?? []
  const current = phases.find(phase => phase.state === 'current')
  if (activity.waiting !== undefined) return { kind: 'waiting', sessionId: activity.waiting.id }
  if (activity.active !== undefined) return { kind: 'goal', sessionId: activity.active.sessionId, phase: current }
  if (activity.running > 0) return { kind: 'runs', n: activity.running }
  if (activity.blocked !== undefined) return { kind: 'blocked', sessionId: activity.blocked.sessionId }
  const standing = project.standing
  if (standing === undefined || phases.length === 0) return project.mode === 'general' ? { kind: 'general' } : undefined
  const checked = standing.checkedAt !== undefined
  if (checked && current !== undefined) return { kind: 'next', phase: current, hint: standing.hint }
  const deferred = phases.find(phase => phase.state === 'deferred')
  if (deferred !== undefined && current === undefined) return { kind: 'deferred', phase: deferred }
  if (standing.finished) return { kind: 'finished' }
  return checked ? { kind: 'recheck' } : { kind: 'unchecked' }
}
