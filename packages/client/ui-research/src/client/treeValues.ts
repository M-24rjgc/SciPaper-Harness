/**
 * What the sidebar's research tree shows, derived from the research record,
 * the session list, the Workspace list and the pending interactions. Nothing
 * here holds state; `ResearchTree.tsx` draws the rows these functions list.
 *
 * A conversation belongs to the research it is bound to or whose folder holds
 * its working directory (`sessionProject`), else to the research of the
 * Workspace that lists it, else to that Workspace as a folder without a
 * research, else to no folder. Archived conversations are nowhere; child
 * (subagent) sessions and visual-review reviewers are never rows, though
 * their activity lights their research's dot.
 */
import type { SessionListState, SessionSearchResultItem } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationDrafts } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import { conversationSignal, goalSignal, strongestSignal, type ActivitySignal } from './activity.ts'
import { projectAtPath, sessionDirectoriesOf, sessionProject } from './contract.ts'

/** What a row's dot says: something waits for the person (warn), or something runs (ongoing blue). */
export type TreeSignal = ActivitySignal

/** One conversation row. */
export interface TreeConversation {
  id: SessionId
  /** The session's display title, or the unsent draft's first line. */
  title: string
  blank: boolean
  draft?: ConversationDrafts[string] | undefined
  updatedAt: number
  signal: TreeSignal | undefined
}

/** One research row and what its expansion lists. */
export interface TreeResearch {
  project: ResearchProject
  /** Its top-level conversations, newest first; blank ones remain while current or holding a draft. */
  conversations: TreeConversation[]
  /** Its newest conversation that has started, which a click on the row opens. */
  latest: SessionId | undefined
  /** The current conversation belongs to it. */
  current: boolean
  /** The current conversation is its blank one, so ＋ 新对话 would do nothing. */
  onBlank: boolean
  /** Its folder is in the Workspace list, so its blank conversation can be opened. */
  registered: boolean
  signal: TreeSignal | undefined
  /** When it was last used: its newest started conversation or its record, epoch milliseconds. */
  at: number
}

/** A registered folder that holds no research (其他文件夹). */
export interface TreeFolder {
  workspaceId: WorkspaceId
  title: string
  path: string
  location: WorkspaceView['location']
  conversations: TreeConversation[]
  current: boolean
  signal: TreeSignal | undefined
}

/** Everything the tree lists, before expansion. */
export interface TreeModel {
  /** The person's own researches, the untouched draft included, by recent use. */
  own: TreeResearch[]
  /** The example researches, by recent use; none while the preference hides them. */
  examples: TreeResearch[]
  folders: TreeFolder[]
  /** Conversations that belong to no folder, newest first. */
  loose: TreeConversation[]
  looseCurrent: boolean
  /** The person has a research of their own besides the untouched draft. */
  hasOwn: boolean
}

/** What the tree is derived from. */
export interface TreeSources {
  /** Host-owned ordinary conversation directory; its workspaces are displayed as conversations. */
  conversationHome?: string | undefined
  drafts: ConversationDrafts
  projects: readonly ResearchProject[]
  list: SessionListState
  current: SessionId | undefined
  workspaces: WorkspaceSnapshot
  pending: SessionStatusSnapshot
  showExamples: boolean
}

/** A timestamp as epoch milliseconds; one that does not parse counts as never. */
function epoch(iso: string): number {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at
}

/** Newest first; equal times keep a stable order by id. */
function byRecency(a: TreeConversation, b: TreeConversation): number {
  return b.updatedAt - a.updatedAt || String(a.id).localeCompare(b.id)
}

/**
 * List what the tree shows.
 * @param sources - the record, the lists and the preference.
 * @returns the rows of each part of the tree, unexpanded.
 */
export function deriveTree(sources: TreeSources): TreeModel {
  const { projects, list, workspaces, pending } = sources
  const current = sources.current
  const archived = new Set<string>(workspaces.archivedSessionIds)
  const ordinary = (path: string): boolean => sources.conversationHome !== undefined
    && projectAtPath([{ root: sources.conversationHome }], path) !== undefined
  const reviewers = new Set<string>(projects.flatMap(project => project.visualReviews.flatMap(review => review.sessionId ?? [])))
  const directories = sessionDirectoriesOf(list.byId)
  const byWorkspace = new Map(projects.map(project => [project.workspaceId as string, project]))
  const listedBy = new Map<string, WorkspaceView>()
  for (const item of workspaces.items) for (const id of item.sessionIds) if (!listedBy.has(id)) listedBy.set(id, item)
  const researchOf = (id: string): ResearchProject | undefined => {
    const found = sessionProject(projects, id, directories)
    if (found !== undefined) return found
    const folder = listedBy.get(id)
    return folder !== undefined && folder.location.kind !== 'ssh'
      ? byWorkspace.get(folder.workspaceId) ?? projectAtPath(projects, folder.path)
      : undefined
  }

  const rows = new Map<string, TreeConversation[]>()
  const signals = new Map<string, TreeSignal[]>()
  const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
    const values = map.get(key)
    if (values === undefined) map.set(key, [value])
    else values.push(value)
  }
  const folderRows = new Map<string, TreeConversation[]>()
  const loose: TreeConversation[] = []
  for (const id of list.ids) {
    const summary = list.byId[id]
    if (summary === undefined || archived.has(id)) continue
    const project = researchOf(id)
    const signal = conversationSignal(summary, pending)
    if (project !== undefined && signal !== undefined) push(signals, project.id, signal)
    const topLevel = summary.origin !== 'subagent' && !reviewers.has(id)
    const draft = sources.drafts[id]
    if (!topLevel || (summary.blank && id !== current && draft === undefined)) continue
    const title = summary.blank ? (draft?.text.trim().split(/\r?\n/u)[0] ?? '') : summary.displayTitle
    const row: TreeConversation = { id, title, blank: summary.blank, updatedAt: summary.updatedAt, signal, ...(draft ? { draft } : {}) }
    if (project !== undefined) push(rows, project.id, row)
    else {
      const folder = listedBy.get(id)
      if (folder === undefined || (folder.location.kind === 'local' && ordinary(folder.path))) loose.push(row)
      else push(folderRows, folder.workspaceId, row)
    }
  }

  const registered = new Set<string>(workspaces.items.map(item => item.workspaceId))
  const currentProject = current === undefined ? undefined : researchOf(current)
  const currentBlank = current !== undefined && list.byId[current]?.blank === true
  const research = (project: ResearchProject): TreeResearch => {
    const conversations = (rows.get(project.id) ?? []).sort(byRecency)
    const started = conversations.filter(conversation => !conversation.blank)
    const running = project.experiments.some(run => run.status === 'running') ? 'ongoing' : undefined
    const isCurrent = currentProject?.id === project.id
    return {
      project,
      conversations,
      latest: started[0]?.id,
      current: isCurrent,
      onBlank: isCurrent && currentBlank,
      registered: registered.has(project.workspaceId),
      signal: strongestSignal([...signals.get(project.id) ?? [], ...(project.goals ?? []).map(goalSignal), running]),
      at: Math.max(epoch(project.updatedAt), ...started.map(conversation => conversation.updatedAt)),
    }
  }
  const byUse = (a: TreeResearch, b: TreeResearch): number => b.at - a.at || a.project.title.localeCompare(b.project.title)
  const listed = projects.filter(project => project.archived !== true)
  const own = listed.filter(project => project.example !== true).map(research).sort(byUse)
  const examples = sources.showExamples ? listed.filter(project => project.example === true).map(research).sort(byUse) : []

  const folders = workspaces.items
    .filter(item => item.location.kind === 'ssh'
      || (!ordinary(item.path) && !byWorkspace.has(item.workspaceId) && projectAtPath(projects, item.path) === undefined))
    .map((item): TreeFolder => {
      const conversations = (folderRows.get(item.workspaceId) ?? []).sort(byRecency)
      return {
        workspaceId: item.workspaceId, title: item.title, path: item.path,
        location: item.location, conversations,
        current: conversations.some(conversation => conversation.id === current),
        signal: strongestSignal(conversations.map(conversation => conversation.signal)),
      }
    })
  loose.sort(byRecency)
  return {
    own, examples, folders, loose,
    looseCurrent: loose.some(conversation => conversation.id === current),
    hasOwn: own.some(row => row.project.draft !== true),
  }
}

/** Where one row sits in the tree, for `aria-level`, `aria-posinset` and `aria-setsize`. */
export interface TreePosition {
  key: string
  /** The key of the row it sits under; absent at the top level. */
  parent?: string | undefined
  /** 1 at the top level. */
  level: number
  posinset: number
  setsize: number
}

/** One row of the drawn tree, in document order. */
export type TreeRow = TreePosition & (
  /** A research; `expanded` is undefined for the untouched draft, which lists nothing under it. */
  | { kind: 'research'; research: TreeResearch; expanded: boolean | undefined }
  /** A conversation; `readOnly` in an example, where nothing may be written. */
  | { kind: 'conversation'; conversation: TreeConversation; readOnly: boolean }
  /** ＋ 新对话 under an own research. */
  | { kind: 'add'; research: TreeResearch }
  /** The 示例 (Examples) and 其他文件夹 (Other folders) groups. */
  | { kind: 'group'; group: 'examples' | 'others'; expanded: boolean }
  | { kind: 'folder'; folder: TreeFolder; expanded: boolean }
  /** 未归入文件夹的对话 (Conversations in no folder). */
  | { kind: 'loose'; expanded: boolean }
)

/** Row keys: a research, a folder, a conversation, the ＋ line and the three groups. */
export const treeKey = {
  research: (project: ResearchProject): string => `research:${project.id}`,
  folder: (folder: TreeFolder): string => `folder:${folder.workspaceId}`,
  conversation: (conversation: TreeConversation): string => `conversation:${conversation.id}`,
  add: (project: ResearchProject): string => `add:${project.id}`,
  examples: 'group:examples',
  others: 'group:others',
  loose: 'group:loose',
} as const

/** Omit from each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** A row before its place among its siblings is known. */
type Unplaced = DistributiveOmit<TreeRow, 'posinset' | 'setsize'>

/**
 * The rows of the tree in document order, expanded as the person chose, or
 * by each row's default: a research while it holds the current conversation;
 * the examples while the person has no research of their own or is in one;
 * the other folders, a folder and the folderless conversations while they
 * hold the current conversation.
 * @param model - what {@link deriveTree} listed.
 * @param chosen - the person's explicit open or closed choice by row key.
 * @returns the visible rows, each with its place among its siblings.
 */
export function flattenTree(model: TreeModel, chosen: Readonly<Record<string, boolean>>): TreeRow[] {
  const open = (key: string, fallback: boolean): boolean => chosen[key] ?? fallback
  const rows: Unplaced[] = []
  const conversations = (list: readonly TreeConversation[], parent: string, level: number, readOnly: boolean): void => {
    for (const conversation of list) rows.push({ kind: 'conversation', key: treeKey.conversation(conversation), parent, level, conversation, readOnly })
  }
  const researchRows = (research: TreeResearch, parent: string | undefined, level: number): void => {
    const key = treeKey.research(research.project)
    const expanded = research.project.draft === true ? undefined : open(key, research.current)
    rows.push({ kind: 'research', key, parent, level, research, expanded })
    if (expanded !== true) return
    const readOnly = research.project.example === true
    conversations(research.conversations, key, level + 1, readOnly)
    if (!readOnly && !research.onBlank) rows.push({ kind: 'add', key: treeKey.add(research.project), parent: key, level: level + 1, research })
  }
  for (const research of model.own) researchRows(research, undefined, 1)
  const looseOpen = open(treeKey.loose, true)
  rows.push({ kind: 'loose', key: treeKey.loose, level: 1, expanded: looseOpen })
  if (looseOpen) conversations(model.loose, treeKey.loose, 2, false)
  if (model.examples.length > 0) {
    const expanded = open(treeKey.examples, !model.hasOwn || model.examples.some(research => research.current))
    rows.push({ kind: 'group', key: treeKey.examples, level: 1, group: 'examples', expanded })
    if (expanded) for (const research of model.examples) researchRows(research, treeKey.examples, 2)
  }
  if (model.folders.length > 0) {
    const expanded = open(treeKey.others, model.looseCurrent || model.folders.some(folder => folder.current))
    rows.push({ kind: 'group', key: treeKey.others, level: 1, group: 'others', expanded })
    if (expanded) {
      for (const folder of model.folders) {
        const key = treeKey.folder(folder)
        const folderOpen = open(key, folder.current)
        rows.push({ kind: 'folder', key, parent: treeKey.others, level: 2, folder, expanded: folderOpen })
        if (folderOpen) conversations(folder.conversations, key, 3, false)
      }
    }
  }
  const seen = new Map<string | undefined, number>()
  return rows.map((row) => {
    const posinset = (seen.get(row.parent) ?? 0) + 1
    seen.set(row.parent, posinset)
    return { ...row, posinset, setsize: rows.filter(other => other.parent === row.parent).length }
  })
}
/** Where a conversation found by a search lives. */
export type SearchPlace =
  | { kind: 'research'; research: TreeResearch }
  | { kind: 'folder'; folder: TreeFolder }
  | { kind: 'loose' }

/** One conversation a search found, with the passage its content matched in. */
export interface SearchConversation {
  conversation: TreeConversation
  place: SearchPlace
  snippet?: string | undefined
}

/** What one search found. */
export interface TreeSearch {
  /** Researches whose name matches, in tree order. */
  researches: TreeResearch[]
  /** Conversations whose title matches, newest first, then those whose text the host matched, in its order. */
  conversations: SearchConversation[]
  /** More conversations match than the host's bound shows. */
  hasMore: boolean
}

/**
 * Search the tree: names of the listed researches, titles of the listed
 * conversations that have started, and the host's content matches among them.
 * @param model - what {@link deriveTree} listed.
 * @param query - what the person typed; surrounding whitespace is ignored.
 * @param content - the host's content matches for the same query.
 * @param limit - the most conversations one search shows.
 * @param nameOf - the name a research row shows (the placeholder for an untitled one).
 * @returns the matches; none for an empty query.
 */
export function searchTree(
  model: TreeModel, query: string, content: { items: readonly SessionSearchResultItem[]; hasMore: boolean }, limit: number,
  nameOf: (project: ResearchProject) => string,
): TreeSearch {
  const q = query.trim().toLowerCase()
  if (q === '') return { researches: [], conversations: [], hasMore: false }
  const all = [...model.own, ...model.examples]
  const found = new Map<string, SearchConversation>()
  for (const research of all) for (const conversation of research.conversations) found.set(conversation.id, { conversation, place: { kind: 'research', research } })
  for (const folder of model.folders) for (const conversation of folder.conversations) found.set(conversation.id, { conversation, place: { kind: 'folder', folder } })
  for (const conversation of model.loose) found.set(conversation.id, { conversation, place: { kind: 'loose' } })
  const snippets = new Map<string, string>()
  for (const item of content.items) if (!snippets.has(item.sessionId)) snippets.set(item.sessionId, item.snippet)
  const started = [...found.values()].filter(hit => !hit.conversation.blank)
  const ordered = started
    .filter(hit => hit.conversation.title.toLowerCase().includes(q))
    .sort((a, b) => byRecency(a.conversation, b.conversation))
  const included = new Set(ordered.map(hit => hit.conversation.id as string))
  for (const item of content.items) {
    const hit = found.get(item.sessionId)
    if (hit === undefined || hit.conversation.blank || included.has(item.sessionId)) continue
    included.add(item.sessionId)
    ordered.push(hit)
  }
  return {
    researches: all.filter(research => nameOf(research.project).toLowerCase().includes(q)),
    conversations: ordered.slice(0, limit).map(hit => ({ ...hit, snippet: snippets.get(hit.conversation.id) })),
    hasMore: content.hasMore || ordered.length > limit,
  }
}
