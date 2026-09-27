// @vitest-environment jsdom

/**
 * The research's folder menu under the entry screen's folder chip. What it
 * offers depends on the conversation on screen; choosing a folder for the
 * untouched draft goes to the host, and whatever the folder turns out to be,
 * the person decides in the same place. Anything that carries the composer's
 * draft goes through the seat's own `onPick`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ResearchProject, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import { breakablePath, outcomeOf, ResearchFolderMenu, type FolderMenuProps } from '../src/client/FolderMenu.tsx'
import type { CarryDraft, FolderPick, MoveRequest, ResearchView } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: string, params?: Record<string, unknown>): string => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (m, name: string) => name in params ? String(params[name]) : m)
}
const WRAP = String.fromCodePoint(0x200b)

const DRAFT_ROOT = 'C:\\Users\\me\\SciPaper\\2026-09-26-1'
const draft: ResearchProject = { ...newProject({ title: '新研究', root: DRAFT_ROOT, brief: '' }, 'w-draft' as WorkspaceId), draft: true, untitled: true }
const sparse: ResearchProject = { ...newProject({ title: '块稀疏注意力', root: 'C:\\Research\\sparse', brief: '' }, 'w-sparse' as WorkspaceId), updatedAt: '2026-09-20T00:00:00.000Z' }
const longer: ResearchProject = { ...newProject({ title: '长上下文', root: 'C:\\Research\\long', brief: '' }, 'w-long' as WorkspaceId), updatedAt: '2026-09-25T00:00:00.000Z' }
const removed: ResearchProject = newProject({ title: '已移除', root: 'C:\\Research\\gone', brief: '' }, 'w-gone' as WorkspaceId)
const example: ResearchProject = { ...newProject({ title: '示例', root: 'C:\\data\\demo\\x', brief: '' }, 'w-example' as WorkspaceId), example: true }
const taken: ResearchProject = { ...newProject({ title: '已移出列表', root: 'C:\\Research\\taken', brief: '' }, 'w-taken' as WorkspaceId), updatedAt: '2026-09-26T00:00:00.000Z', archived: true }

/** A promise the spec settles by hand. */
function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => { settle = resolve })
  return { promise, settle }
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
}

interface Setup {
  current?: string | undefined
  cwd?: string
  open?: boolean
  canReveal?: boolean
  projects?: ResearchProject[] | null
  picks?: FolderPick[]
  answers?: (ResearchResponse | undefined | Promise<ResearchResponse | undefined>)[]
  anchor?: boolean
}

function setup(parts: Setup = {}) {
  const current = 'current' in parts ? parts.current : 's-draft'
  const byId = current === undefined ? {} : { [current]: { cwd: parts.cwd ?? DRAFT_ROOT } }
  const list = { current, byId } as unknown as SessionListState
  const workspaces = { items: ['w-draft', 'w-sparse', 'w-long', 'w-example', 'w-taken'].map(workspaceId => ({ workspaceId })) } as unknown as WorkspaceSnapshot
  const view: ResearchView = {
    snapshot: parts.projects === null
      ? null
      : { projects: parts.projects ?? [draft, sparse, longer, removed, example, taken], preferences: {}, components: [], modes: [] },
    tasks: [],
  }
  const picks = [...parts.picks ?? []]
  const answers = [...parts.answers ?? []]
  const onPick = vi.fn<CarryDraft>()
  // The owner closes the menu when asked, as the hero's folder chip does.
  let open = parts.open ?? true
  const onClose = vi.fn(() => {
    open = false
    view$.rerender(<ResearchFolderMenu {...props()} />)
  })
  const chooseFolder = vi.fn(() => Promise.resolve(picks.shift() ?? { kind: 'cancelled' as const }))
  const move = vi.fn((_request: MoveRequest, _carry: CarryDraft) => Promise.resolve(answers.shift()))
  const adopt = vi.fn((_draftId: string, _workspaceId: string, _carry: CarryDraft) => Promise.resolve())
  const reveal = vi.fn()
  const anchor = document.createElement('button')
  document.body.append(anchor)
  const props = (overrides: Partial<Setup> = {}): FolderMenuProps => {
    const selected = 'current' in overrides ? overrides.current : current
    const byId = selected === undefined ? {} : { [selected]: { cwd: overrides.cwd ?? parts.cwd ?? DRAFT_ROOT } }
    const now = { ...list, current: selected, byId }
    if (overrides.open !== undefined) open = overrides.open
    return {
      t, open, onPick, onClose, selectedId: undefined,
      ...(parts.anchor === false ? {} : { anchorRef: { current: anchor } }),
      useCurrentSession: (select: (value: string | undefined) => unknown) => select(selected),
      useSessions: (select: (state: SessionListState) => unknown) => select(now as unknown as SessionListState),
      useWorkspaces: (select: (state: WorkspaceSnapshot) => unknown) => select(workspaces),
      useResearch: (select: (state: ResearchView) => unknown) => select(view),
      useDirectories: (select: (state: Record<string, string>) => unknown) => select({ 's-draft': DRAFT_ROOT, 's-sparse': 'C:\\Research\\sparse', 's-example': 'C:\\data\\demo\\x' }),
      useCanReveal: (select: (state: boolean) => unknown) => select(parts.canReveal ?? true),
      useEntry: (select: (state: unknown) => unknown) => select({ notice: null }),
      chooseFolder, move, adopt, reveal, showProgress: vi.fn(),
    } as unknown as FolderMenuProps
  }
  const view$ = render(<ResearchFolderMenu {...props()} />)
  return { ...view$, props, onPick, onClose, chooseFolder, move, adopt, reveal }
}

/** The open menus, as the portal puts them into the page. */
function menus(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menu"]')]
}

function item(name: string): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(element => element.textContent === name)
  if (found === undefined) throw new Error(`no menu item ${name}`)
  return found
}

describe('what the menu offers', () => {
  it('says where the draft is saved, and offers its move, the file manager and the person\'s other researches, newest first', () => {
    setup()
    const [menu] = menus()
    expect(menu!.textContent).toContain(t('folderSavedAt', { path: `C:\\${WRAP}Users\\${WRAP}me\\${WRAP}SciPaper\\${WRAP}2026-09-26-1` }))
    expect(within(menu!).getAllByRole('menuitem').map(element => element.textContent)).toEqual([zh.folderMove, zh.folderReveal, zh.folderSwitch])
    fireEvent.click(item(zh.folderSwitch))
    // Examples, the draft itself, researches whose folder left the list and researches removed from the list are not offered.
    expect(within(menus()[0]!).getAllByRole('menuitem').slice(3).map(element => element.textContent)).toEqual(['长上下文', '块稀疏注意力'])
  })

  it('offers an example only its place and the other researches, and no file manager where the host has none', () => {
    setup({ current: 's-example', cwd: 'C:\\data\\demo\\x', canReveal: false })
    const names = within(menus()[0]!).getAllByRole('menuitem').map(element => element.textContent)
    expect(names).toEqual([zh.folderSwitch])
    expect(menus()[0]!.textContent).toContain('demo')
  })

  it('names a folder outside every research by the conversation\'s own folder, and opens nothing with nothing to offer', () => {
    setup({ current: 's-loose', cwd: '/srv/loose', projects: [], canReveal: true })
    expect(within(menus()[0]!).getAllByRole('menuitem').map(element => element.textContent)).toEqual([zh.folderReveal])
    expect(menus()[0]!.textContent).toContain(`/${WRAP}srv/${WRAP}loose`)
    cleanup()
    setup({ current: undefined, projects: null })
    expect(menus()).toEqual([])
  })

  it('stays closed until the chip opens it, and hands back a closing gesture', () => {
    const view = setup({ open: false })
    expect(menus()).toEqual([])
    view.rerender(<ResearchFolderMenu {...view.props({ open: true })} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.onClose).toHaveBeenCalled()
  })
})

/** Open the menu again, as a click on the chip does. */
function reopen(view: ReturnType<typeof setup>): void {
  view.rerender(<ResearchFolderMenu {...view.props({ open: true })} />)
}

describe('what each row does', () => {
  it('shows the folder in the file manager and moves the draft into another research through the seat\'s own pick', () => {
    const view = setup()
    fireEvent.click(item(zh.folderReveal))
    expect(view.reveal).toHaveBeenCalledWith(DRAFT_ROOT)
    expect(view.onClose).toHaveBeenCalledTimes(1)
    expect(menus()).toEqual([])
    reopen(view)
    fireEvent.click(item(zh.folderSwitch))
    fireEvent.click(item('长上下文'))
    expect(view.onPick).toHaveBeenCalledWith('w-long')
  })

  it('moves the draft to the folder the chooser picked, carrying the composer\'s draft with the pick it was asked with', async () => {
    const pending = deferred<ResearchResponse | undefined>()
    const view = setup({ picks: [{ kind: 'picked', path: 'D:\\Papers\\sparse' }], answers: [pending.promise] })
    fireEvent.click(item(zh.folderMove))
    await flush()
    expect(view.move).toHaveBeenCalledWith({ projectId: draft.id, root: 'D:\\Papers\\sparse' }, view.onPick)
    // While the move runs the row holds itself.
    reopen(view)
    expect(item(zh.folderMove)).toHaveProperty('disabled', true)
    pending.settle({ message: 'Research moved', outcome: 'moved', project: draft, sessionId: 's-moved' })
    await flush()
    expect(item(zh.folderMove)).toHaveProperty('disabled', false)
    // A move leaves nothing to decide.
    expect(menus()).toHaveLength(1)
  })

  it('does nothing when the chooser is dismissed, and asks for a typed path where the host has no chooser', async () => {
    const view = setup({ picks: [{ kind: 'cancelled' }, { kind: 'unavailable' }], answers: [undefined] })
    fireEvent.click(item(zh.folderMove))
    await flush()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    reopen(view)
    fireEvent.click(item(zh.folderMove))
    await flush()
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe(zh.folderTypeTitle)
    const field = within(dialog).getByLabelText(zh.folderTypeLabel)
    // Blank is no folder.
    fireEvent.change(field, { target: { value: '   ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.folderTypeSubmit }))
    await flush()
    expect(view.move).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: '  /data/papers/sparse  ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: zh.folderTypeSubmit }))
    await flush()
    expect(view.move).toHaveBeenCalledWith({ projectId: draft.id, root: '/data/papers/sparse' }, view.onPick)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes the typed path by its buttons and by Escape', async () => {
    const view = setup({ picks: [{ kind: 'unavailable' }, { kind: 'unavailable' }] })
    fireEvent.click(item(zh.folderMove))
    await flush()
    fireEvent.click(within(document.body.querySelector<HTMLElement>('[role="dialog"]')!).getByRole('button', { name: zh.cancel }))
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    reopen(view)
    fireEvent.click(item(zh.folderMove))
    await flush()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(view.move).not.toHaveBeenCalled()
  })
})

describe('what a chosen folder turned out to be', () => {
  const choose = async (answer: ResearchResponse, picks: FolderPick[] = []) => {
    const view = setup({ picks: [{ kind: 'picked', path: 'C:\\Research\\sparse' }, ...picks], answers: [answer, { message: 'moved', outcome: 'moved' }] })
    fireEvent.click(item(zh.folderMove))
    await flush()
    const open = menus()
    expect(open).toHaveLength(1)
    return { view, question: open[0]! }
  }

  it('offers to open a folder that already is a research, carrying the draft there, or to leave it', async () => {
    const { view, question } = await choose({ message: 'existing', outcome: 'existing', project: sparse })
    expect(question.textContent).toContain(t('folderExisting', { title: sparse.title }))
    fireEvent.click(within(question).getByRole('menuitem', { name: zh.folderOpenIt }))
    expect(view.adopt).toHaveBeenCalledWith(draft.id, 'w-sparse', view.onPick)
    expect(menus()).toEqual([])
    cleanup()
    const again = await choose({ message: 'existing', outcome: 'existing', project: sparse })
    fireEvent.click(within(again.question).getByRole('menuitem', { name: zh.cancel }))
    expect(again.view.adopt).not.toHaveBeenCalled()
    expect(menus()).toEqual([])
  })

  it('points out a research the folder lies in, and offers another folder or that research', async () => {
    const { view, question } = await choose({ message: 'nested', outcome: 'nested', project: sparse }, [{ kind: 'picked', path: 'D:\\elsewhere' }])
    expect(question.textContent).toContain(t('folderNested', { title: sparse.title }))
    fireEvent.click(within(question).getByRole('menuitem', { name: t('folderOpenTitle', { title: sparse.title }) }))
    expect(view.adopt).toHaveBeenCalledWith(draft.id, 'w-sparse', view.onPick)
    cleanup()
    const other = await choose({ message: 'nested', outcome: 'nested', project: sparse }, [{ kind: 'picked', path: 'D:\\elsewhere' }])
    fireEvent.click(within(other.question).getByRole('menuitem', { name: zh.folderChooseAgain }))
    await flush()
    expect(other.view.move).toHaveBeenLastCalledWith({ projectId: draft.id, root: 'D:\\elsewhere' }, other.view.onPick)
  })

  it('says a folder inside the draft\'s own folder cannot hold it, and that examples cannot either', async () => {
    const own = await choose({ message: 'nested', outcome: 'nested', project: draft })
    expect(own.question.textContent).toContain(zh.folderNestedOwn)
    expect(within(own.question).getAllByRole('menuitem').map(element => element.textContent)).toEqual([zh.folderChooseAgain, zh.cancel])
    cleanup()
    const examples = await choose({ message: 'example', outcome: 'example' })
    expect(examples.question.textContent).toContain(zh.folderExample)
    expect(within(examples.question).getAllByRole('menuitem').map(element => element.textContent)).toEqual([zh.folderChooseAgain, zh.cancel])
  })

  it('asks before using a folder that holds files, and repeats the move with the person\'s yes', async () => {
    const { view, question } = await choose({ message: 'needs-confirm', outcome: 'needs-confirm' })
    expect(question.textContent).toContain(zh.folderNonEmpty)
    fireEvent.click(within(question).getByRole('menuitem', { name: zh.folderUseHere }))
    await flush()
    expect(view.move).toHaveBeenLastCalledWith({ projectId: draft.id, root: 'C:\\Research\\sparse', confirmNonEmpty: true }, view.onPick)
    expect(menus()).toEqual([])
  })

  it('drops the question when it is dismissed or when another conversation comes on screen', async () => {
    const { view } = await choose({ message: 'needs-confirm', outcome: 'needs-confirm' })
    fireEvent.pointerDown(document.body)
    expect(menus()).toEqual([])
    cleanup()
    const again = await choose({ message: 'needs-confirm', outcome: 'needs-confirm' })
    again.view.rerender(<ResearchFolderMenu {...again.view.props({ current: 's-sparse', cwd: 'C:\\Research\\sparse' })} />)
    expect(menus()).toEqual([])
    expect(view.adopt).not.toHaveBeenCalled()
  })

  it('asks nothing after a move or a failure, and reads an answer that names no research as nothing to decide', () => {
    const request = { projectId: draft.id, root: 'x' }
    const carry = vi.fn()
    expect(outcomeOf({ message: 'moved', outcome: 'moved' }, request, carry)).toBeNull()
    expect(outcomeOf(undefined, request, carry)).toBeNull()
    expect(outcomeOf({ message: 'existing', outcome: 'existing' }, request, carry)).toBeNull()
    expect(breakablePath('/a/b')).toBe(`/${WRAP}a/${WRAP}b`)
  })

  it('places its lists at the chip, and nowhere without one', () => {
    setup({ anchor: false })
    // A portal list with no anchor rectangle stays unplaced.
    expect(menus()[0]!.style.visibility).toBe('hidden')
  })
})
