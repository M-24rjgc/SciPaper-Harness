/**
 * The sidebar's 研究 (Researches) tree. It takes the shell's workspace browser
 * seat (`sidebar.workspaces`, priority -1): the person's own researches by
 * recent use, each opening onto its conversations and ＋ 新对话 (New
 * conversation); the 示例 (Examples) group; and 其他文件夹 (Other folders) for
 * registered folders without a research and conversations in no folder. Row
 * menus rename, show in the file manager and remove from the list. The header
 * searches names and, through the shell's session search, conversation text.
 * The collapsed rail keeps the search as its one control. `treeValues.ts`
 * derives every row; this module draws them and wires the keyboard.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import {
  Button, IconArchiveOutline20, IconCloseFill14, IconEditOutline16, IconEllipsisOutline16, IconFolderOpenOutline16, IconPlusOutline16,
  IconProjectAddOutline16, IconSearchOutline16, IconTriangleRightFill14, Menu, Modal, Tooltip, type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionSearchResultItem } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { ResearchTreeInjected } from './contract.ts'
import type { createResearchTreeStore } from './treeStore.ts'
import {
  deriveTree, flattenTree, searchTree, treeKey, type SearchConversation, type SearchPlace, type TreeConversation, type TreeFolder,
  type TreeModel, type TreeResearch, type TreeRow, type TreeSignal,
} from './treeValues.ts'
import { standingPhrase, type Translate } from './format.ts'
import { ActionError, useAction } from './Action.tsx'
import styles from './ResearchTree.module.css'

/** Composed props of the tree: the sidebar's owner share and globals, the viewing store, the dictionary and the tree face. */
export type ResearchTreeProps =
  PropsRuntime<'sidebar.workspaces'>
  & PropsStore<ReturnType<typeof createResearchTreeStore>>
  & PropsLocale<'research'>
  & InjectFace<ResearchTreeInjected>

/** The column's slide (`--ds-transition-duration-slow`); the rail's search focuses its box after it, so the slide does not jank. */
const EXPAND_SLIDE_MS = 300
/** Pause between the latest keystroke and a content search. */
const SEARCH_DEBOUNCE_MS = 250
/** The session search's wire bound, in UTF-16 code units. */
const SEARCH_MAX = 500

/** The first and last UTF-16 code units of a surrogate pair's leading half. */
const HIGH_SURROGATE = [0xd800, 0xdbff] as const

/**
 * A search query inside the session search's bound.
 * @param value - what was typed.
 * @returns the text without NUL characters, cut at the bound without splitting a surrogate pair.
 */
export function searchable(value: string): string {
  const text = value.replaceAll('\0', '')
  if (text.length <= SEARCH_MAX) return text
  const last = text.charCodeAt(SEARCH_MAX - 1)
  return text.slice(0, last >= HIGH_SURROGATE[0] && last <= HIGH_SURROGATE[1] ? SEARCH_MAX - 1 : SEARCH_MAX)
}

/** The class names that apply, joined. */
function cx(...names: readonly (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ')
}

/** The name a research row shows: the placeholder for one the product named. */
function researchName(project: ResearchProject, t: Translate): string {
  return project.untitled === true ? t('treeUntitled') : project.title
}

/** Started conversations use their title; unsent drafts show their text or attachment count. */
function conversationName(conversation: TreeConversation, t: Translate): string {
  if (conversation.blank && conversation.draft !== undefined) {
    const preview = conversation.title || (conversation.draft.attachmentCount > 0 ? t('treeDraftAttachments', { n: conversation.draft.attachmentCount }) : '')
    return preview === '' ? t('treeDraftConversation') : `${t('treeDraftConversation')} · ${preview}`
  }
  return conversation.blank ? t('treeBlankConversation') : conversation.title
}

/** A row's dot, with its words for a screen reader. */
function Dot(props: { signal: TreeSignal; t: Translate }): ReactNode {
  return <>
    <span className={styles.dot} data-signal={props.signal} aria-hidden="true" />
    <span className={styles.hidden}>{props.t(props.signal === 'waiting' ? 'treeWaiting' : 'treeOngoing')}</span>
  </>
}

/** A dialog the tree opened: a research or a conversation to rename, or a folder to make a research. */
type TreeDialog =
  | { kind: 'rename-research'; project: ResearchProject }
  | { kind: 'rename-conversation'; conversation: TreeConversation }
  | { kind: 'make-research'; folder: TreeFolder }

/** A row's ⋯ menu: its rows, and the work each one starts. */
interface RowMenu {
  items: MenuItem[]
  /** A menu row's work, run under the row's own failure line; undefined when it opened a dialog. */
  choose: (id: string) => (() => unknown) | undefined
}

/** What one row draws and does; the body decides it per row kind. */
interface ItemView {
  label: string
  /** The row's accessible name, when its text alone would not say enough. */
  name?: string | undefined
  italic?: boolean
  lead?: ReactNode
  trail?: ReactNode
  signal?: TreeSignal | undefined
  selected: boolean
  className: string | undefined
  /** Absent for a row that offers nothing to do with it. */
  menu?: RowMenu | undefined
  activate: () => unknown
}

/**
 * One row. Enter or Space activates it, the context-menu key or Shift+F10
 * opens its menu, and a failure of either shows under it.
 */
function TreeItem(props: { row: TreeRow; view: ItemView; focusable: boolean; t: Translate; onFocused(key: string): void }): ReactNode {
  const { row, view, t } = props
  const { menu } = view
  const action = useAction()
  const [menuOpen, setMenuOpen] = useState(false)
  const [byKeyboard, setByKeyboard] = useState(false)
  const element = useRef<HTMLDivElement>(null)
  const refocus = useRef(false)
  // Back on the row once a menu the keyboard opened closes; after the menu has put focus on its anchor.
  useEffect(() => {
    if (menuOpen || !refocus.current) return
    refocus.current = false
    /* v8 ignore next -- the effect runs only while the row is mounted. */
    element.current?.focus()
  }, [menuOpen])
  const expanded = 'expanded' in row ? row.expanded : undefined
  const openMenu = (keyboard: boolean): void => {
    setByKeyboard(keyboard)
    setMenuOpen(open => !open)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      action.start(view.activate)
    } else if (menu !== undefined && (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) {
      event.preventDefault()
      openMenu(true)
    }
  }
  return <div
    ref={element}
    role="treeitem"
    data-key={row.key}
    aria-level={row.level}
    aria-posinset={row.posinset}
    aria-setsize={row.setsize}
    aria-expanded={expanded}
    aria-selected={view.selected}
    aria-label={view.name}
    tabIndex={props.focusable ? 0 : -1}
    className={cx(styles.item, view.className, view.selected && styles.selected, menuOpen && styles.menuOpen)}
    onClick={() => { action.start(view.activate) }}
    onFocus={(event) => { if (event.target === event.currentTarget) props.onFocused(row.key) }}
    onKeyDown={onKeyDown}
  >
    <span className={styles.line}>
      <span className={styles.lead}>{view.lead}</span>
      <span className={cx(styles.label, view.italic === true && styles.italic)}>{view.label}</span>
      {view.signal !== undefined && <Dot signal={view.signal} t={t} />}
      {view.trail !== undefined && <span className={styles.trail}>{view.trail}</span>}
      {menu !== undefined && <span className={styles.actions}>
        <Menu
          open={menuOpen}
          onClose={() => {
            refocus.current = byKeyboard
            setMenuOpen(false)
          }}
          items={menu.items}
          onSelect={(id) => {
            setMenuOpen(false)
            const work = menu.choose(id)
            if (work === undefined) return
            refocus.current = byKeyboard
            action.start(work)
          }}
          portal
          closeOnPointerLeave
          autoFocus={byKeyboard}
          anchor={<button
            type="button"
            tabIndex={-1}
            className={styles.more}
            aria-label={t('treeRowActions', { name: view.label })}
            onClick={(event) => {
              event.stopPropagation()
              openMenu(false)
            }}
          ><IconEllipsisOutline16 /></button>}
        />
      </span>}
    </span>
    <ActionError t={t} error={action.error} className={styles.error} />
  </div>
}

/** The disclosure triangle of a row that opens. */
function Arrow(props: { open: boolean; current?: boolean }): ReactNode {
  const className = cx(styles.arrow, props.open && styles.arrowOpen, props.current === true && styles.arrowCurrent)
  return <IconTriangleRightFill14 size={12} className={className} />
}

/** What the body needs besides the model: the face, the dictionary, and who opens dialogs. */
type BodyProps = Pick<
  ResearchTreeProps,
  't' | 'actions' | 'openSession' | 'openWorkspace' | 'startSession' | 'run' | 'reveal' | 'archiveConversation' | 'removeFolder'
> & {
  model: TreeModel
  rows: TreeRow[]
  /** The conversation the main column shows; undefined while a panel covers it. */
  selectedId: string | undefined
  /** The record has arrived, so an empty tree means no research yet. */
  ready: boolean
  canReveal: boolean
  openDialog(dialog: TreeDialog): void
}

/** Open a research: expand it and show its newest started conversation, or its blank one; toggle the one already on screen. */
function activateResearch(props: BodyProps, research: TreeResearch, expanded: boolean | undefined): unknown {
  const { project } = research
  const shown = research.current && props.selectedId !== undefined
  if (expanded === undefined) {
    // The untouched draft lists nothing: its row is its blank conversation.
    if (shown || !research.registered) return undefined
    return props.openWorkspace(project.workspaceId)
  }
  const key = treeKey.research(project)
  if (shown) {
    props.actions.setExpanded(key, !expanded)
    return undefined
  }
  props.actions.setExpanded(key, true)
  if (research.latest !== undefined) {
    props.openSession(research.latest)
    return undefined
  }
  // An example is only read: nothing may create a conversation in it.
  if (project.example === true || !research.registered) return undefined
  return props.openWorkspace(project.workspaceId)
}

/**
 * The menu of a research row: 重命名 and 移出列表 for the person's own, and the
 * file manager where the host can; none for an example where it cannot.
 */
function researchMenu(props: BodyProps, project: ResearchProject): RowMenu | undefined {
  const { t } = props
  const items: MenuItem[] = []
  const example = project.example === true
  if (!example) items.push({ id: 'rename', label: t('treeRename'), icon: <IconEditOutline16 /> })
  if (props.canReveal) items.push({ id: 'reveal', label: t('folderReveal'), icon: <IconFolderOpenOutline16 /> })
  // The host refuses the untouched draft's removal: 新研究 reopens it, and it holds nothing yet.
  if (!example && project.draft !== true) items.push({ id: 'remove', label: t('treeRemove'), icon: <IconArchiveOutline20 size={16} /> })
  if (items.length === 0) return undefined
  return {
    items,
    choose: (id) => {
      if (id === 'rename') {
        props.openDialog({ kind: 'rename-research', project })
        return undefined
      }
      if (id === 'reveal') return () => props.reveal(project.root)
      return () => props.run({ action: 'archive-project', projectId: project.id })
    },
  }
}

/** What each kind of row draws and does. */
function itemView(props: BodyProps, row: TreeRow): ItemView {
  const { t } = props
  const toggle = (expanded: boolean): () => undefined => () => {
    props.actions.setExpanded(row.key, !expanded)
    return undefined
  }
  switch (row.kind) {
    case 'research': {
      const { research, expanded } = row
      const { project } = research
      const example = project.example === true
      const phrase = example ? undefined : standingPhrase(project, t)
      return {
        label: researchName(project, t),
        italic: project.untitled === true,
        lead: expanded === undefined ? undefined : <Arrow open={expanded} current={research.current} />,
        trail: example ? <span className={styles.exampleTag}>{t('exampleTag')}</span> : phrase,
        signal: research.signal,
        selected: expanded === undefined && research.current && props.selectedId !== undefined,
        className: styles.research,
        menu: researchMenu(props, project),
        activate: () => activateResearch(props, research, expanded),
      }
    }
    case 'conversation': {
      const { conversation } = row
      const writable = !row.readOnly && !conversation.blank
      return {
        label: conversationName(conversation, t),
        italic: conversation.blank,
        signal: conversation.signal,
        selected: conversation.id === props.selectedId,
        className: styles.conversation,
        menu: writable
          ? {
            items: [
              { id: 'rename', label: t('treeRename'), icon: <IconEditOutline16 /> },
              { id: 'remove', label: t('treeRemove'), icon: <IconArchiveOutline20 size={16} /> },
            ],
            choose: (id) => {
              if (id === 'rename') {
                props.openDialog({ kind: 'rename-conversation', conversation })
                return undefined
              }
              return () => props.archiveConversation(conversation.id)
            },
          }
          : undefined,
        activate: () => { props.openSession(conversation.id) },
      }
    }
    case 'add': {
      const { project } = row.research
      return {
        label: t('treeAddConversation'),
        name: t('treeAddConversationIn', { title: researchName(project, t) }),
        lead: <IconPlusOutline16 size={12} />,
        selected: false,
        className: styles.add,
        activate: () => { props.startSession(project.workspaceId) },
      }
    }
    case 'group':
      return {
        label: t(row.group === 'examples' ? 'treeExamples' : 'treeOthers'),
        lead: <Arrow open={row.expanded} />,
        selected: false,
        className: styles.group,
        activate: toggle(row.expanded),
      }
    case 'folder': {
      const { folder } = row
      return {
        label: folder.title,
        lead: <Arrow open={row.expanded} current={folder.current} />,
        signal: folder.signal,
        selected: false,
        className: styles.research,
        menu: {
          items: [
            { id: 'make', label: t('treeMakeResearch'), icon: <IconProjectAddOutline16 /> },
            { id: 'remove', label: t('treeRemove'), icon: <IconArchiveOutline20 size={16} /> },
          ],
          choose: (id) => {
            if (id === 'make') {
              props.openDialog({ kind: 'make-research', folder })
              return undefined
            }
            return () => props.removeFolder(folder.workspaceId)
          },
        },
        activate: toggle(row.expanded),
      }
    }
    case 'loose':
      return {
        label: t('treeLoose'),
        lead: <Arrow open={row.expanded} current={props.model.looseCurrent} />,
        selected: false,
        className: styles.research,
        activate: toggle(row.expanded),
      }
  }
}

/**
 * The tree itself, a flat list of rows with their levels. One row is in the
 * tab order at a time; the arrow keys move between rows, Right and Left open,
 * close and move to the parent, Home and End go to the ends.
 */
function TreeBody(props: BodyProps): ReactNode {
  const { t, rows } = props
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined)
  const items = rows.map(row => ({ row, view: itemView(props, row) }))
  const tabKey = rows.some(row => row.key === focusKey) ? focusKey : (items.find(item => item.view.selected) ?? items[0])?.row.key
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Keys inside a row's own controls and its menu carry no row key, and are theirs.
    const index = rows.findIndex(row => row.key === (event.target as HTMLElement).dataset.key)
    const row = rows[index]
    if (row === undefined) return
    const elements = event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')
    const move = (to: number): void => {
      if (to >= 0 && to < elements.length) elements.item(to).focus()
    }
    const expanded = 'expanded' in row ? row.expanded : undefined
    switch (event.key) {
      case 'ArrowDown': move(index + 1); break
      case 'ArrowUp': move(index - 1); break
      case 'Home': move(0); break
      case 'End': move(rows.length - 1); break
      case 'ArrowRight':
        if (expanded === false) props.actions.setExpanded(row.key, true)
        else if (expanded === true && rows[index + 1]?.parent === row.key) move(index + 1)
        break
      case 'ArrowLeft':
        if (expanded === true) props.actions.setExpanded(row.key, false)
        else move(rows.findIndex(other => other.key === row.parent))
        break
      default: return
    }
    event.preventDefault()
  }
  return <div className={styles.body}>
    <div className={styles.list} role="tree" aria-label={t('treeTitle')} onKeyDown={onKeyDown}>
      {items.map(({ row, view }) =>
        <TreeItem key={row.key} row={row} view={view} focusable={row.key === tabKey} t={t} onFocused={setFocusKey} />)}
    </div>
    {props.ready && rows.length === 0 && <p className={styles.empty}>{t('treeEmpty')}</p>}
    <span className={styles.fade} />
  </div>
}

/** Where a found conversation lives, as its result names it. */
function placeName(place: SearchPlace, t: Translate): string {
  switch (place.kind) {
    case 'research': return researchName(place.research.project, t)
    case 'folder': return place.folder.title
    case 'loose': return t('treeLoose')
  }
}

/** The host's content matches for the query now in the box. */
interface ContentSearch {
  query: string
  status: 'loading' | 'ready' | 'error'
  items: readonly SessionSearchResultItem[]
  hasMore: boolean
}

/** The results of a search: researches by name, then conversations by title and by text. */
function SearchBody(props: {
  t: Translate
  model: TreeModel
  query: string
  content: ContentSearch
  limit: number
  selectedId: string | undefined
  openResearch(research: TreeResearch): void
  openConversation(hit: SearchConversation): void
}): ReactNode {
  const { t, query } = props
  const content = props.content.query === query ? props.content : { query, status: 'loading' as const, items: [], hasMore: false }
  const found = useMemo(
    () => searchTree(props.model, query, content, props.limit, project => researchName(project, t)),
    [props.model, query, content, props.limit, t],
  )
  const nothing = found.researches.length === 0 && found.conversations.length === 0
  return <div className={styles.body}>
    <div className={styles.list}>
      <div className={styles.results} role="tree" aria-label={t('treeSearchResults')}>
        {found.researches.map(research => <button
          key={research.project.id}
          type="button"
          role="treeitem"
          aria-selected={false}
          className={cx(styles.result, styles.research)}
          onClick={() => { props.openResearch(research) }}
        >
          <span className={styles.line}>
            <span className={cx(styles.label, research.project.untitled === true && styles.italic)}>
              {researchName(research.project, t)}
            </span>
            {research.project.example === true && <span className={styles.exampleTag}>{t('exampleTag')}</span>}
          </span>
        </button>)}
        {found.conversations.map(hit => <button
          key={hit.conversation.id}
          type="button"
          role="treeitem"
          aria-selected={hit.conversation.id === props.selectedId}
          className={cx(styles.result, hit.conversation.id === props.selectedId && styles.selected)}
          onClick={() => { props.openConversation(hit) }}
        >
          <span className={styles.line}>
            <span className={styles.label}>{hit.conversation.title}</span>
            {hit.conversation.signal !== undefined && <Dot signal={hit.conversation.signal} t={t} />}
          </span>
          <span className={styles.meta}>
            <span className={styles.place}>{placeName(hit.place, t)}</span>
            {hit.snippet !== undefined && <span className={styles.snippet}>{hit.snippet}</span>}
          </span>
        </button>)}
      </div>
      {content.status === 'loading' && <p className={styles.status} role="status">{t('treeSearchPending')}</p>}
      {content.status === 'error' && <p className={styles.status} role="status">{t('treeSearchUnavailable')}</p>}
      {content.status !== 'loading' && nothing && <p className={styles.empty}>{t('treeSearchNone')}</p>}
      {found.hasMore && <p className={styles.status}>{t('treeSearchMore', { n: props.limit })}</p>}
    </div>
    <span className={styles.fade} />
  </div>
}

/**
 * A dialog that asks for one name: to rename a research or a conversation,
 * or to name the research a folder becomes. It closes once the work is done
 * and keeps the host's reason when the work was refused.
 */
function NameDialog(props: {
  t: Translate
  title: string
  hint?: string | undefined
  initial: string
  /** The name that would change nothing, so saving it is held off. */
  unchanged?: string | undefined
  submit: string
  work(name: string): Promise<unknown>
  onClose(): void
}): ReactNode {
  const { t } = props
  const saving = useAction()
  const [name, setName] = useState(props.initial)
  const formId = useId()
  const trimmed = name.trim()
  const blocked = saving.pending || trimmed === '' || trimmed === props.unchanged
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (blocked) return
    saving.start(async () => {
      await props.work(trimmed)
      props.onClose()
    })
  }
  const close = (): void => { if (!saving.pending) props.onClose() }
  return <Modal
    open
    onClose={close}
    title={props.title}
    closeLabel={t('close')}
    footer={<>
      <Button variant="outline" disabled={saving.pending} onClick={close}>{t('cancel')}</Button>
      <Button variant="primary" type="submit" form={formId} disabled={blocked}>{props.submit}</Button>
    </>}
  >
    <form id={formId} className={styles.form} onSubmit={submit}>
      {props.hint !== undefined && <p className={styles.hint}>{props.hint}</p>}
      <label className={styles.field}>
        <span>{t('treeNameLabel')}</span>
        <input
          className={styles.input}
          value={name}
          autoFocus
          spellCheck={false}
          disabled={saving.pending}
          onFocus={(event) => { event.target.select() }}
          onChange={(event) => { setName(event.target.value) }}
        />
      </label>
      <ActionError t={t} error={saving.error} />
    </form>
  </Modal>
}

/**
 * The research tree in the sidebar's browsing seat: its header and search,
 * the rows, and the dialogs its menus open; on the collapsed rail, the search
 * alone, which widens the sidebar.
 */
export function ResearchTree(props: ResearchTreeProps): ReactNode {
  const { t, wide } = props
  const list = props.useSessions(state => state)
  const workspaces = props.useWorkspaces(state => state)
  const pending = props.useSessionPendingInteraction(state => state)
  const drafts = props.useDrafts(state => state)
  const panelActive = props.usePanelInfo(info => info.activePanelId !== null)
  const snapshot = props.useResearch(state => state.snapshot)
  const canReveal = props.useCanReveal(state => state)
  const chosen = props.useStore(state => state.expanded)
  const model = useMemo(() => deriveTree({
    projects: snapshot?.projects ?? [], list, workspaces, pending, drafts, showExamples: snapshot?.preferences.showExamples !== false,
  }), [snapshot, list, workspaces, pending, drafts])
  const rows = useMemo(() => flattenTree(model, chosen), [model, chosen])
  const selectedId = panelActive ? undefined : list.current

  const [dialog, setDialog] = useState<TreeDialog | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const normalized = searchable(query).trim()
  const [content, setContent] = useState<ContentSearch>({ query: '', status: 'ready', items: [], hasMore: false })
  const searchInput = useRef<HTMLInputElement>(null)
  const focusAfterSlide = useRef(false)

  // The box takes focus once it is on screen: at once from the header, after the slide from the rail.
  useEffect(() => {
    if (!wide || !searchOpen) return
    const delay = focusAfterSlide.current ? EXPAND_SLIDE_MS : 0
    focusAfterSlide.current = false
    const timer = window.setTimeout(() => {
      /* v8 ignore next -- the timer is cleared before the box unmounts. */
      searchInput.current?.focus({ preventScroll: true })
    }, delay)
    return () => { window.clearTimeout(timer) }
  }, [wide, searchOpen])

  // Conversation text is searched through the host after a pause; a newer query drops the older answer.
  const { searchConversations } = props
  useEffect(() => {
    if (normalized === '') return
    const controller = new AbortController()
    setContent({ query: normalized, status: 'loading', items: [], hasMore: false })
    const timer = window.setTimeout(() => {
      searchConversations(normalized, controller.signal).then((result) => {
        if (!controller.signal.aborted) setContent({ query: normalized, status: 'ready', items: result.items, hasMore: result.hasMore })
      }, (_failure: unknown) => {
        // Names still match without the text; the results say the text could not be searched.
        if (!controller.signal.aborted) setContent({ query: normalized, status: 'error', items: [], hasMore: false })
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [normalized, searchConversations])

  const closeSearch = (): void => {
    setQuery('')
    setSearchOpen(false)
  }
  const bodyProps: BodyProps = {
    t, actions: props.actions, openSession: props.openSession, openWorkspace: props.openWorkspace, startSession: props.startSession,
    run: props.run, reveal: props.reveal, archiveConversation: props.archiveConversation, removeFolder: props.removeFolder,
    model, rows, selectedId, ready: snapshot !== null, canReveal, openDialog: setDialog,
  }
  const expandAll = (keys: readonly string[]): void => { for (const key of keys) props.actions.setExpanded(key, true) }
  const openResearch = (research: TreeResearch): void => {
    closeSearch()
    if (research.project.example === true) expandAll([treeKey.examples])
    const opening = activateResearch(bodyProps, research, research.project.draft === true ? undefined : false)
    void Promise.resolve(opening).catch((_failure: unknown) => {
      // The result it came from is gone with the search; the tree stays as it was.
    })
  }
  const openConversation = (hit: SearchConversation): void => {
    closeSearch()
    const { place } = hit
    if (place.kind === 'research') {
      const { project } = place.research
      expandAll([...project.example === true ? [treeKey.examples] : [], treeKey.research(project)])
    } else if (place.kind === 'folder') expandAll([treeKey.others, treeKey.folder(place.folder)])
    else expandAll([treeKey.others, treeKey.loose])
    props.openSession(hit.conversation.id)
  }

  const header = searchOpen
    ? <div
      className={styles.search}
      onBlur={(event) => {
        // An empty box closes once focus leaves it for anything but its own clear button.
        if (query.trim() === '' && !event.currentTarget.contains(event.relatedTarget)) setSearchOpen(false)
      }}
    >
      <IconSearchOutline16 size={12} />
      <input
        ref={searchInput}
        className={styles.searchInput}
        type="text"
        value={query}
        maxLength={SEARCH_MAX}
        aria-label={t('treeSearch')}
        placeholder={t('treeSearchPlaceholder')}
        onChange={(event) => { setQuery(searchable(event.target.value)) }}
        onKeyDown={(event) => { if (event.key === 'Escape') closeSearch() }}
      />
      <button type="button" className={styles.clear} aria-label={t('treeSearchClear')} onClick={closeSearch}><IconCloseFill14 /></button>
    </div>
    : <>
      <span className={styles.heading}>{t('treeTitle')}</span>
      <Tooltip label={t('treeSearch')} side="bottom" delayMs={500}>
        <button type="button" className={styles.iconButton} aria-label={t('treeSearch')} onClick={() => { setSearchOpen(true) }}>
          <IconSearchOutline16 size={14} />
        </button>
      </Tooltip>
    </>

  return <div className={cx(styles.root, !wide && styles.rail)}>
    {wide
      ? <div className={styles.header}>{header}</div>
      : <Tooltip label={t('treeSearch')}>
        <button
          type="button"
          className={styles.railButton}
          aria-label={t('treeSearch')}
          onClick={() => {
            focusAfterSlide.current = true
            setSearchOpen(true)
            props.expandSidebar()
          }}
        >
          <IconSearchOutline16 size={18} />
        </button>
      </Tooltip>}
    <div className={styles.area}>
      {wide && (normalized === ''
        ? <TreeBody {...bodyProps} />
        : <SearchBody
          t={t} model={model} query={normalized} content={content} limit={props.searchResultLimit} selectedId={selectedId}
          openResearch={openResearch} openConversation={openConversation}
        />)}
    </div>
    {dialog?.kind === 'rename-research' && <NameDialog
      t={t}
      title={t('treeRenameResearchTitle')}
      initial={dialog.project.untitled === true ? '' : dialog.project.title}
      unchanged={dialog.project.untitled === true ? undefined : dialog.project.title}
      submit={t('treeRename')}
      work={name => props.run({ action: 'rename', projectId: dialog.project.id, title: name })}
      onClose={() => { setDialog(null) }}
    />}
    {dialog?.kind === 'rename-conversation' && <NameDialog
      t={t}
      title={t('treeRenameConversationTitle')}
      initial={dialog.conversation.title}
      submit={t('treeRename')}
      work={name => props.renameConversation(dialog.conversation.id, name)}
      onClose={() => { setDialog(null) }}
    />}
    {dialog?.kind === 'make-research' && <NameDialog
      t={t}
      title={t('treeMakeResearchTitle', { name: dialog.folder.title })}
      hint={t('treeMakeResearchHint')}
      initial={dialog.folder.title}
      submit={t('treeMakeResearchSubmit')}
      work={async (name) => {
        const project = await props.create({ root: dialog.folder.path, title: name, brief: '' })
        props.actions.setExpanded(treeKey.research(project), true)
      }}
      onClose={() => { setDialog(null) }}
    />}
  </div>
}
