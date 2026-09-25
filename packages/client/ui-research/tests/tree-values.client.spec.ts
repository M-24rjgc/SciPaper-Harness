/**
 * What the sidebar's research tree lists, from the record, the session list,
 * the Workspace list and the pending interactions: which conversation belongs
 * where, which rows show, in what order, with which dot, and what a search
 * finds among them.
 */
import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ExperimentRecord, ResearchGoal, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { deriveTree, flattenTree, searchTree, treeKey, type TreeModel, type TreeSources } from '../src/client/treeValues.ts'

const EARLY = '2026-09-01T00:00:00.000Z'

function research(title: string, root: string, workspaceId: string, extra: Partial<ResearchProject> = {}): ResearchProject {
  return { ...newProject({ title, root, brief: '' }, workspaceId as WorkspaceId), updatedAt: EARLY, ...extra }
}

function session(id: string, cwd: string | undefined, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id: id as SessionId, displayTitle: `title ${id}`, ...(cwd === undefined ? {} : { cwd }), running: false, blank: false, updatedAt: 1000, ...extra }
}

function workspace(id: string, path: string, sessionIds: string[], title = path): WorkspaceView {
  return { workspaceId: id as WorkspaceId, path, title, sessionIds: sessionIds as SessionId[], createdAt: EARLY, updatedAt: EARLY }
}

function sources(parts: {
  projects: ResearchProject[]
  sessions: SessionSummary[]
  current?: string
  workspaces?: WorkspaceView[]
  archived?: string[]
  pending?: [string, string][]
  showExamples?: boolean
  ghosts?: string[]
}): TreeSources {
  const list: SessionListState = {
    ids: [...parts.sessions.map(item => item.id), ...(parts.ghosts ?? []) as SessionId[]],
    byId: Object.fromEntries(parts.sessions.map(item => [item.id, item])),
    current: parts.current as SessionId | undefined,
    phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
  const workspaces: WorkspaceSnapshot = {
    items: parts.workspaces ?? [], archivedSessionIds: (parts.archived ?? []) as SessionId[], state: 'idle', phase: 'ready', error: null,
  }
  const pending = new Map<SessionId, SessionPendingInteractionBase>((parts.pending ?? []).map(([id, kind]) => [
    id as SessionId, { key: `${id}-${kind}`, kind, sessionId: id as SessionId },
  ]))
  // The assembled client narrows pending interactions to its domains' kinds; the tree reads only `kind`.
  const narrowed = pending as unknown as TreeSources['pending']
  return { projects: parts.projects, list, workspaces, pending: narrowed, showExamples: parts.showExamples ?? true }
}

// The tree reads a run's status alone.
const running = { id: 'run', status: 'running' } as unknown as ExperimentRecord
const queued = { id: 'queued', status: 'queued' } as unknown as ExperimentRecord

describe('which conversation belongs where', () => {
  const sparse = research('Sparse attention', 'C:\\Research\\sparse', 'w-sparse', {
    visualReviews: [
      { artifactId: 'a' as never, artifactRevision: 1, status: 'reviewed', sessionId: 's-reviewer', findings: '', createdAt: '' },
      { artifactId: 'a' as never, artifactRevision: 2, status: 'rendered', findings: '', createdAt: '' },
    ],
  })
  const nested = workspace('w-nested', 'C:\\Research\\sparse\\paper', ['s-nested'])

  it('puts each conversation under its research, a folder without one, or no folder, and hides children, reviewers, archived and idle blank ones', () => {
    const model = deriveTree(sources({
      projects: [sparse],
      sessions: [
        session('s-in', 'c:/research/sparse/figures', { updatedAt: 2000 }),
        session('s-listed', undefined, { updatedAt: 1500 }),
        session('s-nested', undefined, { updatedAt: 1400 }),
        session('s-child', 'C:\\Research\\sparse', { parentId: 's-in' as SessionId, running: true }),
        session('s-agent', 'C:\\Research\\sparse', { origin: 'subagent' }),
        session('s-reviewer', 'C:\\Research\\sparse'),
        session('s-archived', 'C:\\Research\\sparse'),
        session('s-idle-blank', 'C:\\Research\\sparse', { blank: true }),
        session('s-legacy', 'D:\\legacy', { updatedAt: 500 }),
        session('s-legacy-2', undefined, { updatedAt: 900 }),
        session('s-loose', 'E:\\loose'),
      ],
      workspaces: [
        workspace('w-sparse', 'C:\\Research\\sparse', ['s-in', 's-listed']),
        nested,
        workspace('w-legacy', 'D:\\legacy', ['s-legacy', 's-legacy-2'], 'legacy'),
        // A session two folders list belongs to the first.
        workspace('w-again', 'F:\\again', ['s-legacy']),
        workspace('w-empty', 'G:\\empty', []),
      ],
      archived: ['s-archived'],
      ghosts: ['s-ghost'],
    }))
    const [row] = model.own
    expect(row?.conversations.map(item => item.id)).toEqual(['s-in', 's-listed', 's-nested'])
    // The bound conversation of the snapshot is the project's own.
    const bound = deriveTree(sources({ projects: [{ ...sparse, sessionId: 's-bound' }], sessions: [session('s-bound', undefined, { updatedAt: 3000 })] }))
    expect(bound.own[0]?.conversations.map(item => item.id)).toEqual(['s-bound'])
    // A registered folder inside a research is part of it, never a folder of its own.
    expect(model.folders.map(folder => [folder.workspaceId, folder.title, folder.conversations.map(item => item.id)])).toEqual([
      ['w-legacy', 'legacy', ['s-legacy-2', 's-legacy']], ['w-again', 'F:\\again', []], ['w-empty', 'G:\\empty', []],
    ])
    expect(model.loose.map(item => item.id)).toEqual(['s-loose'])
    // The child's activity still lights its research.
    expect(row?.signal).toBe('ongoing')
  })

  it('shows a blank conversation only while it is on screen, as the research\'s blank one', () => {
    const list = [session('s-blank', 'C:\\Research\\sparse', { blank: true, updatedAt: 9000 }), session('s-old', 'C:\\Research\\sparse', { updatedAt: 1000 })]
    const [row] = deriveTree(sources({ projects: [sparse], sessions: list, current: 's-blank', workspaces: [workspace('w-sparse', 'C:\\Research\\sparse', [])] })).own
    expect(row).toMatchObject({ current: true, onBlank: true, registered: true, latest: 's-old' })
    expect(row?.conversations).toEqual([
      { id: 's-blank', title: '', blank: true, updatedAt: 9000, signal: undefined },
      { id: 's-old', title: 'title s-old', blank: false, updatedAt: 1000, signal: undefined },
    ])
    // A current conversation the list does not carry yet is not blank.
    expect(deriveTree(sources({ projects: [{ ...sparse, sessionId: 's-new' }], sessions: [], current: 's-new' })).own[0]).toMatchObject({ current: true, onBlank: false })
    // Nothing on screen: no research is current.
    expect(deriveTree(sources({ projects: [sparse], sessions: list })).own[0])
      .toMatchObject({ current: false, onBlank: false, registered: false })
  })
})

describe('the dots', () => {
  const sparse = research('Sparse attention', '/research/sparse', 'w-sparse')

  it('says something waits for the person before it says something runs, and nothing when neither', () => {
    const tree = (pending: [string, string][], sessions: SessionSummary[], experiments: ExperimentRecord[] = []) =>
      deriveTree(sources({ projects: [{ ...sparse, experiments }], sessions, pending })).own[0]
    const idle = session('s-idle', '/research/sparse')
    const busy = session('s-busy', '/research/sparse', { running: true })
    expect(tree([], [idle])?.signal).toBeUndefined()
    expect(tree([], [idle, busy])?.signal).toBe('ongoing')
    expect(tree([['s-idle', 'question']], [idle, busy])?.signal).toBe('waiting')
    expect(tree([['s-idle', 'approval']], [idle])?.conversations[0]?.signal).toBe('waiting')
    expect(tree([['s-idle', 'plan-review']], [idle])?.signal).toBe('waiting')
    // Another plugin's interaction kind is not the person's to answer here.
    expect(tree([['s-idle', 'tutorial']], [idle])?.signal).toBeUndefined()
    // A run on the experiment board is work in progress; a queued one is not running yet.
    expect(tree([], [idle], [queued])?.signal).toBeUndefined()
    expect(tree([], [idle], [running])?.signal).toBe('ongoing')
  })

  it('lights a research whose live conversation holds a goal: ongoing while it drives rounds, waiting while it is blocked', () => {
    const goal = (phase: ResearchGoal['phase']): ResearchGoal => ({ sessionId: 's-idle', objective: 'the paper', phase, roundsStarted: 1, updatedAt: 1 })
    const tree = (goals: ResearchGoal[]) => deriveTree(sources({ projects: [{ ...sparse, goals }], sessions: [session('s-idle', '/research/sparse')] })).own[0]
    expect(tree([goal('paused')])?.signal).toBeUndefined()
    expect(tree([goal('active')])?.signal).toBe('ongoing')
    expect(tree([goal('active'), goal('blocked')])?.signal).toBe('waiting')
  })
})

describe('the order and the groups', () => {
  it('lists own researches by recent use, then the examples unless they are hidden, and skips removed ones', () => {
    const early = research('Early', '/r/early', 'w-early')
    const later = research('Later', '/r/later', 'w-later', { updatedAt: '2026-09-20T00:00:00.000Z' })
    const tieA = research('Alpha', '/r/alpha', 'w-a')
    const tieB = research('Beta', '/r/beta', 'w-b')
    const unparsed = research('Unparsed', '/r/unparsed', 'w-u', { updatedAt: 'not a time' })
    const removed = research('Removed', '/r/removed', 'w-removed', { archived: true })
    const example = research('Example', '/demo/x', 'w-x', { example: true })
    const draft = research('新研究', '/home/SciPaper/1', 'w-draft', { draft: true, untitled: true })
    const busy = session('s-early', '/r/early', { updatedAt: Date.parse('2026-09-25T00:00:00.000Z') })
    const all = [unparsed, tieB, tieA, later, early, removed, example]
    const model = deriveTree(sources({ projects: all, sessions: [busy] }))
    // Early's conversation is newer than Later's record; Alpha and Beta tie on their records' time, broken by title;
    // a record time that does not parse counts as never.
    expect(model.own.map(row => row.project.title)).toEqual(['Early', 'Later', 'Alpha', 'Beta', 'Unparsed'])
    expect(model.examples.map(row => row.project.title)).toEqual(['Example'])
    expect(model.hasOwn).toBe(true)
    expect(deriveTree(sources({ projects: all, sessions: [], showExamples: false })).examples).toEqual([])
    expect(deriveTree(sources({ projects: [draft, example], sessions: [] })).hasOwn).toBe(false)
    // A removed research's folder is no folder without a research.
    expect(deriveTree(sources({ projects: [removed], sessions: [], workspaces: [workspace('w-removed', '/r/removed', [])] })).folders).toEqual([])
  })
})

describe('the rows as drawn', () => {
  const own = research('Own', '/r/own', 'w-own')
  const other = research('Other', '/r/other', 'w-other')
  const draft = research('新研究', '/home/SciPaper/1', 'w-draft', { draft: true, untitled: true, updatedAt: '2026-09-26T00:00:00.000Z' })
  const example = research('Example', '/demo/x', 'w-x', { example: true })
  const at = (day: number): number => Date.parse(`2026-09-${String(day).padStart(2, '0')}T08:00:00.000Z`)
  const world = (current?: string) => deriveTree(sources({
    projects: [own, other, draft, example],
    sessions: [
      session('s-own', '/r/own', { updatedAt: at(24) }),
      session('s-own-blank', '/r/own', { blank: true, updatedAt: at(25) }),
      session('s-example', '/demo/x', { updatedAt: at(4) }),
      session('s-draft', '/home/SciPaper/1', { blank: true, updatedAt: at(26) }),
      session('s-legacy', '/legacy', { updatedAt: 100 }),
      session('s-loose', '/elsewhere', { updatedAt: 50 }),
    ],
    workspaces: [workspace('w-own', '/r/own', []), workspace('w-legacy', '/legacy', ['s-legacy'])],
    ...(current === undefined ? {} : { current }),
  }))
  const shape = (model: TreeModel, chosen: Record<string, boolean> = {}) =>
    flattenTree(model, chosen).map(row => [row.key, row.level, row.parent, row.posinset, row.setsize, 'expanded' in row ? row.expanded : 'leaf'])

  it('opens the research on screen with its conversations and ＋ 新对话, keeps the draft a leaf, and folds the rest', () => {
    const model = world('s-own')
    expect(model.hasOwn).toBe(true)
    expect(shape(model)).toEqual([
      [`research:${draft.id}`, 1, undefined, 1, 5, undefined],
      [`research:${own.id}`, 1, undefined, 2, 5, true],
      ['conversation:s-own', 2, `research:${own.id}`, 1, 2, 'leaf'],
      [`add:${own.id}`, 2, `research:${own.id}`, 2, 2, 'leaf'],
      [`research:${other.id}`, 1, undefined, 3, 5, false],
      [treeKey.examples, 1, undefined, 4, 5, false],
      [treeKey.others, 1, undefined, 5, 5, false],
    ])
  })

  it('hides ＋ 新对话 while its blank conversation is on screen, and never offers it in an example', () => {
    const onBlank = flattenTree(world('s-own-blank'), {})
    expect(onBlank.filter(row => row.parent === 'research:' + own.id).map(row => row.key)).toEqual(['conversation:s-own-blank', 'conversation:s-own'])
    const inExample = flattenTree(world('s-example'), {})
    // The person is in an example, so the group opens on it; its conversations are read-only.
    expect(inExample.filter(row => row.parent === 'research:' + example.id)).toEqual([
      expect.objectContaining({ kind: 'conversation', key: 'conversation:s-example', level: 3, readOnly: true }),
    ])
  })

  it('opens the examples while the person has none of their own, and follows every explicit choice', () => {
    const none = deriveTree(sources({ projects: [draft, example], sessions: [] }))
    expect(flattenTree(none, {}).map(row => row.key)).toEqual(['research:' + draft.id, treeKey.examples, 'research:' + example.id])
    expect(flattenTree(none, { [treeKey.examples]: false }).map(row => row.key)).toEqual(['research:' + draft.id, treeKey.examples])
    const chosen = flattenTree(world(), {
      [`research:${other.id}`]: true, [treeKey.others]: true, ['folder:w-legacy']: true, [treeKey.loose]: true,
    })
    expect(chosen.map(row => [row.key, row.level])).toEqual([
      ['research:' + draft.id, 1],
      ['research:' + own.id, 1],
      ['research:' + other.id, 1],
      ['add:' + other.id, 2],
      [treeKey.examples, 1],
      [treeKey.others, 1],
      ['folder:w-legacy', 2],
      ['conversation:s-legacy', 3],
      [treeKey.loose, 2],
      ['conversation:s-loose', 3],
    ])
  })

  it('opens the other folders on the conversation on screen, in a folder or in none', () => {
    const inFolder = flattenTree(world('s-legacy'), {})
    expect(inFolder.slice(-3).map(row => row.key)).toEqual(['folder:w-legacy', 'conversation:s-legacy', treeKey.loose])
    const inNone = flattenTree(world('s-loose'), {})
    expect(inNone.slice(-2).map(row => row.key)).toEqual([treeKey.loose, 'conversation:s-loose'])
    // Only folders, or only folderless conversations, still make the group.
    const foldersOnly = deriveTree(sources({ projects: [], sessions: [], workspaces: [workspace('w-legacy', '/legacy', [])] }))
    expect(flattenTree(foldersOnly, { [treeKey.others]: true }).map(row => row.kind)).toEqual(['group', 'folder'])
    const looseOnly = deriveTree(sources({ projects: [], sessions: [session('s-loose', '/elsewhere')] }))
    expect(flattenTree(looseOnly, {}).map(row => row.kind)).toEqual(['group'])
    expect(flattenTree(deriveTree(sources({ projects: [], sessions: [] })), {})).toEqual([])
  })
})

describe('searching the tree', () => {
  const own = research('Sparse attention', '/r/own', 'w-own')
  const draft = research('新研究', '/home/SciPaper/1', 'w-draft', { draft: true, untitled: true })
  const example = research('Attention example', '/demo/x', 'w-x', { example: true })
  const model = deriveTree(sources({
    projects: [own, draft, example],
    sessions: [
      session('s-a', '/r/own', { displayTitle: 'Attention budget', updatedAt: 3000 }),
      session('s-b', '/r/own', { displayTitle: 'Datasets', updatedAt: 2000 }),
      session('s-x', '/demo/x', { displayTitle: 'Attention in the example', updatedAt: 1000 }),
      session('s-blank', '/home/SciPaper/1', { blank: true }),
      session('s-legacy', '/legacy', { displayTitle: 'Legacy notes' }),
      session('s-loose', '/elsewhere', { displayTitle: 'Loose thoughts' }),
    ],
    current: 's-blank',
    workspaces: [workspace('w-legacy', '/legacy', ['s-legacy'], 'legacy')],
  }))
  const nameOf = (project: ResearchProject): string => project.untitled === true ? 'New research' : project.title

  it('finds research names and conversation titles, then the conversations whose text the host matched', () => {
    const content = {
      items: [
        { sessionId: 's-a' as SessionId, snippet: 'attention budget table' },
        { sessionId: 's-a' as SessionId, snippet: 'a second passage' },
        { sessionId: 's-legacy' as SessionId, snippet: 'attention, see notes' },
        { sessionId: 's-loose' as SessionId, snippet: 'attention drifts' },
        { sessionId: 's-blank' as SessionId, snippet: 'nothing yet' },
        { sessionId: 's-unknown' as SessionId, snippet: 'archived elsewhere' },
      ],
      hasMore: false,
    }
    const found = searchTree(model, '  ATTENTION ', content, 10, nameOf)
    expect(found.researches.map(row => row.project.title)).toEqual(['Sparse attention', 'Attention example'])
    expect(found.conversations.map(hit => [hit.conversation.id, hit.place.kind, hit.snippet])).toEqual([
      ['s-a', 'research', 'attention budget table'],
      ['s-x', 'research', undefined],
      ['s-legacy', 'folder', 'attention, see notes'],
      ['s-loose', 'loose', 'attention drifts'],
    ])
    expect(found.hasMore).toBe(false)
    // The placeholder name of an untitled research is what a search matches.
    expect(searchTree(model, 'new research', { items: [], hasMore: false }, 10, nameOf).researches.map(row => row.project.id)).toEqual([draft.id])
  })

  it('finds nothing for an empty query, and says when more match than it shows', () => {
    expect(searchTree(model, '   ', { items: [], hasMore: true }, 10, nameOf)).toEqual({ researches: [], conversations: [], hasMore: false })
    expect(searchTree(model, 'attention', { items: [], hasMore: true }, 10, nameOf).hasMore).toBe(true)
    const bounded = searchTree(model, 'attention', { items: [], hasMore: false }, 1, nameOf)
    expect(bounded.conversations.map(hit => hit.conversation.id)).toEqual(['s-a'])
    expect(bounded.hasMore).toBe(true)
  })
})
