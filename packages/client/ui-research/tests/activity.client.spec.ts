/**
 * What is live in a research, and the research record's 现在 (Now) line:
 * which conversations belong to the research, which of them waits on the
 * person, which goals and runs move, and which one line says so first.
 */
import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionPendingInteractionBase, SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ExperimentRecord, PhaseState, ResearchGoal, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { conversationSignal, goalSignal, nowLine, researchActivity, strongestSignal, type ResearchActivity } from '../src/client/activity.ts'
import { standingOf } from './fixtures/standing.ts'

function research(root: string, extra: Partial<ResearchProject> = {}): ResearchProject {
  return { ...newProject({ title: 'Sparse attention', root, brief: '' }, 'w' as WorkspaceId), ...extra }
}

function session(id: string, cwd: string | undefined, extra: Partial<SessionSummary> = {}): SessionSummary {
  const where = cwd === undefined ? {} : { cwd }
  return { id: id as SessionId, displayTitle: id, ...where, running: false, blank: false, updatedAt: 1, ...extra }
}

function listOf(sessions: SessionSummary[], ghosts: string[] = []): SessionListState {
  return {
    ids: [...sessions.map(item => item.id), ...ghosts as SessionId[]],
    byId: Object.fromEntries(sessions.map(item => [item.id, item])),
    current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}

/** The pending interactions by session; the assembled client narrows them to its domains' kinds, and these read only `kind`. */
function pendingOf(entries: [string, string][]): SessionPendingInteractionSnapshot {
  return new Map<SessionId, SessionPendingInteractionBase>(entries.map(([id, kind]) => [
    id as SessionId, { key: `${id}-${kind}`, kind, sessionId: id as SessionId },
  ])) as unknown as SessionPendingInteractionSnapshot
}

const directoriesOf = (sessions: SessionSummary[]): Record<string, string> =>
  Object.fromEntries(sessions.flatMap(item => (item.cwd === undefined ? [] : [[item.id, item.cwd]])))

const goal = (sessionId: string, phase: ResearchGoal['phase']): ResearchGoal => ({ sessionId, objective: 'the paper', phase, roundsStarted: 1, updatedAt: 1 })
const run = (status: ExperimentRecord['status']): ExperimentRecord => ({ id: status, status } as unknown as ExperimentRecord)

const quiet: ResearchActivity = { waiting: undefined, active: undefined, blocked: undefined, running: 0, signal: undefined }

describe('the dots of one conversation, one goal and several', () => {
  it('says waiting for an approval, a plan review or a question, and ongoing while the conversation runs', () => {
    const idle = session('idle', undefined)
    expect(conversationSignal(idle, pendingOf([]))).toBeUndefined()
    expect(conversationSignal({ ...idle, running: true }, pendingOf([]))).toBe('ongoing')
    for (const kind of ['approval', 'plan-review', 'question']) expect(conversationSignal({ ...idle, running: true }, pendingOf([['idle', kind]]))).toBe('waiting')
    expect(conversationSignal(idle, pendingOf([['idle', 'tutorial']]))).toBeUndefined()
    expect([goalSignal(goal('g', 'active')), goalSignal(goal('g', 'blocked')), goalSignal(goal('g', 'paused'))]).toEqual(['ongoing', 'waiting', undefined])
    expect([strongestSignal([]), strongestSignal([undefined, 'ongoing']), strongestSignal(['ongoing', 'waiting'])]).toEqual([undefined, 'ongoing', 'waiting'])
  })
})

describe('what is live in a research', () => {
  const root = '/research/sparse'

  it('reads its conversations, the first one waiting, its goals and its running runs', () => {
    const project = research(root, {
      goals: [goal('older', 'paused'), goal('driving', 'active'), goal('stuck', 'blocked'), goal('second', 'active')],
      experiments: [run('running'), run('queued'), run('running'), run('unknown')],
    })
    const other = research('/research/other')
    const sessions = [
      session('asking', `${root}/paper`), session('also-asking', root), session('busy', root, { running: true }),
      session('elsewhere', '/research/other', { running: true }), session('nowhere', undefined),
    ]
    const activity = researchActivity(project, [project, other], listOf(sessions, ['ghost']), pendingOf([
      ['asking', 'question'], ['also-asking', 'approval'], ['elsewhere', 'question'],
    ]), directoriesOf(sessions))
    expect(activity.waiting?.id).toBe('asking')
    expect(activity.active?.sessionId).toBe('driving')
    expect(activity.blocked?.sessionId).toBe('stuck')
    expect(activity.running).toBe(2)
    expect(activity.signal).toBe('waiting')
  })

  it('says ongoing for a running conversation, a goal or a run alone, and nothing for a quiet research', () => {
    const sessions = [session('here', root)]
    const read = (project: ResearchProject, running = false): ResearchActivity =>
      researchActivity(project, [project], listOf([{ ...sessions[0]!, running }]), pendingOf([]), directoriesOf(sessions))
    expect(read(research(root))).toEqual(quiet)
    expect(read(research(root), true).signal).toBe('ongoing')
    expect(read(research(root, { goals: [goal('here', 'active')] })).signal).toBe('ongoing')
    expect(read(research(root, { experiments: [run('running')] }))).toMatchObject({ running: 1, signal: 'ongoing' })
  })
})

describe('the 现在 (Now) line', () => {
  const root = '/research/sparse'
  const pack = (phases: [string, PhaseState][], over: Parameters<typeof standingOf>[1] = {}): ResearchProject =>
    research(root, { mode: 'spark-to-paper', standing: standingOf(phases, over) })
  const checked = { checkedAt: '2026-09-26T08:00:00.000Z' }
  const hint = { en: 'No bibliography yet', zh: '还没有参考文献库' }

  it('says first what waits on the person or moves: a question, a goal driving rounds, running runs, a blocked goal', () => {
    const project = pack([['plan', 'done'], ['cite', 'current']], checked)
    const asking = session('asking', root)
    const everything: ResearchActivity = {
      waiting: asking, active: goal('driving', 'active'), blocked: goal('stuck', 'blocked'), running: 2, signal: 'waiting',
    }
    expect(nowLine(project, everything)).toEqual({ kind: 'waiting', sessionId: 'asking' })
    expect(nowLine(project, { ...everything, waiting: undefined })).toEqual({ kind: 'goal', sessionId: 'driving', phase: project.standing!.phases[1] })
    expect(nowLine(pack([['plan', 'done']], { finished: true }), { ...quiet, active: goal('driving', 'active') }))
      .toEqual({ kind: 'goal', sessionId: 'driving', phase: undefined })
    expect(nowLine(project, { ...everything, waiting: undefined, active: undefined })).toEqual({ kind: 'runs', n: 2 })
    expect(nowLine(project, { ...quiet, blocked: goal('stuck', 'blocked') })).toEqual({ kind: 'blocked', sessionId: 'stuck' })
  })

  it('then says where a pack mode stands: the next phase once checked, a deferred end, finished, never checked, or needing another check', () => {
    const next = pack([['plan', 'done'], ['cite', 'current']], { ...checked, hint })
    expect(nowLine(next, quiet)).toEqual({ kind: 'next', phase: next.standing!.phases[1], hint })
    // A deferred phase with work after it still points at that work.
    const around = pack([['experiments', 'deferred'], ['writing', 'current']], checked)
    expect(nowLine(around, quiet)).toMatchObject({ kind: 'next', phase: { id: 'writing' }, hint: undefined })
    expect(nowLine(pack([['plan', 'done'], ['experiments', 'deferred']], checked), quiet)).toMatchObject({ kind: 'deferred', phase: { id: 'experiments' } })
    expect(nowLine(pack([['plan', 'done']], { ...checked, finished: true }), quiet)).toEqual({ kind: 'finished' })
    expect(nowLine(pack([['plan', 'current'], ['cite', 'pending']]), quiet)).toEqual({ kind: 'unchecked' })
    expect(nowLine(pack([['plan', 'done']], checked), quiet)).toEqual({ kind: 'recheck' })
  })

  it('says the general mode is asked in the conversation, and nothing for a pack without phases or before a standing arrives', () => {
    expect(nowLine(research(root), quiet)).toEqual({ kind: 'general' })
    expect(nowLine(research(root, { standing: standingOf([]) }), quiet)).toEqual({ kind: 'general' })
    expect(nowLine(research(root, { mode: 'spark-to-paper' }), quiet)).toBeUndefined()
    expect(nowLine(research(root, { mode: 'spark-to-paper', standing: standingOf([]) }), quiet)).toBeUndefined()
  })
})
