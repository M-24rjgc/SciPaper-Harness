/**
 * The research's folder menu on the entry screen. It takes the seat of the
 * shell's Workspace picker (`conversation.hero.workspace`, priority -1) under
 * the shell's own folder chip, which names the folder, or the research once it
 * is named. The menu says where the research is saved, and offers 更改位置…
 * (Change location) for the untouched draft, 在资源管理器中打开 (Show in file
 * manager) where the host can, and 换到另一项研究 (Move to another research).
 * Whatever carries the composer's draft goes through the seat's own `onPick`,
 * which moves the draft and its attachments into that folder's blank
 * conversation.
 */
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import {
  Button, IconEditOutlineRegular, IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconRightUpOutlineRegular,
  Menu, Modal, type MenuEntry, type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectId, ResearchProject, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { sessionProject, type CarryDraft, type EntryProps, type MoveRequest } from './contract.ts'
import type { Translate } from './format.ts'
import styles from './FolderMenu.module.css'

/** Composed props of the folder menu: the hero folder seat's owner props and globals, and the entry face. */
export type FolderMenuProps = PropsRuntime<'conversation.hero.workspace'> & EntryProps

/**
 * What a chosen folder turned out to be, while the person decides, with the
 * draft's carry captured when the move began.
 */
export type Outcome =
  | { kind: 'existing' | 'nested'; request: MoveRequest; carry: CarryDraft; target: ResearchProject }
  | { kind: 'own' | 'confirm' | 'example'; request: MoveRequest; carry: CarryDraft }

/** A break opportunity the menu's narrow card may wrap a long path at. */
const WRAP = String.fromCodePoint(0x200b)

/**
 * A path that wraps after each separator.
 * @param path - an absolute folder.
 * @returns the same path with a zero-width break after every separator.
 */
export function breakablePath(path: string): string {
  return path.replace(/[\\/]/g, separator => `${separator}${WRAP}`)
}

/**
 * What a relocate answer leaves the person to decide: nothing for a move or a
 * failure, which the entry line reports.
 * @param answer - the host's answer, undefined when the move failed.
 * @param request - what was asked.
 * @param carry - the draft's carry, kept for the decision.
 * @returns the decision to offer, or null.
 */
export function outcomeOf(answer: ResearchResponse | undefined, request: MoveRequest, carry: CarryDraft): Outcome | null {
  switch (answer?.outcome) {
    case 'existing':
    case 'nested': {
      const target = answer.project
      if (target === undefined) return null
      if (answer.outcome === 'nested' && target.id === request.projectId) return { kind: 'own', request, carry }
      return { kind: answer.outcome, request, carry, target }
    }
    case 'needs-confirm': return { kind: 'confirm', request, carry }
    case 'example': return { kind: 'example', request, carry }
    case 'moved':
    case undefined: return null
  }
}

/**
 * The rows that ask the person about a chosen folder: the message first, then
 * the choices it offers.
 * @param outcome - what the folder turned out to be.
 * @param t - bound dictionary lookup.
 * @returns the menu rows.
 */
export function outcomeRows(outcome: Outcome, t: Translate): MenuEntry[] {
  const cancel: MenuItem = { id: 'cancel', label: t('cancel') }
  const again: MenuItem = { id: 'again', label: t('folderChooseAgain') }
  const message = (text: string): MenuEntry => ({ type: 'label', id: 'message', text })
  switch (outcome.kind) {
    case 'existing': return [message(t('folderExisting', { title: outcome.target.title })), { id: 'adopt', label: t('folderOpenIt') }, cancel]
    case 'nested': return [
      message(t('folderNested', { title: outcome.target.title })), again,
      { id: 'adopt', label: t('folderOpenTitle', { title: outcome.target.title }) }, cancel,
    ]
    case 'own': return [message(t('folderNestedOwn')), again, cancel]
    case 'confirm': return [message(t('folderNonEmpty')), { id: 'confirm', label: t('folderUseHere') }, cancel]
    case 'example': return [message(t('folderExample')), again, cancel]
  }
}

/** The draft whose new folder is being typed, when the host has no chooser. */
interface Typing {
  projectId: ProjectId
  carry: CarryDraft
}

/**
 * The folder menu. Choosing 更改位置… opens the host's chooser, or a path field
 * where the host has none; the chosen folder then either takes the research,
 * or the menu asks about it: already a research (打开它, Open it), inside one,
 * holding files (就用这里, Use this folder), or among the examples.
 */
export function ResearchFolderMenu(props: FolderMenuProps): ReactNode {
  const { t, onPick, onClose, anchorRef } = props
  const current = props.useCurrentSession(state => state)
  const session = props.useSessions(state => current === undefined ? undefined : state.byId[current])
  const registered = props.useWorkspaces(state => state.items)
  const snapshot = props.useResearch(state => state.snapshot)
  const directories = props.useDirectories(state => state)
  const canReveal = props.useCanReveal(state => state)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [typing, setTyping] = useState<Typing | null>(null)
  const [moving, setMoving] = useState(false)
  const formId = useId()
  const getAnchorRect = useCallback(() => anchorRef?.current?.getBoundingClientRect() ?? null, [anchorRef])
  // A question about a folder belongs to the conversation it was asked on.
  useEffect(() => {
    setOutcome(null)
    setTyping(null)
  }, [current])

  const projects = snapshot?.projects ?? []
  const project = current === undefined ? undefined : sessionProject(projects, current, directories)
  const path = project?.root ?? (session?.execution?.kind !== 'ssh' ? session?.cwd : undefined)

  const moveTo = (request: MoveRequest, carry: CarryDraft): void => {
    setOutcome(null)
    setMoving(true)
    void props.move(request, carry).then((answer) => {
      setMoving(false)
      setOutcome(outcomeOf(answer, request, carry))
    })
  }
  const pickFor = (projectId: ProjectId, carry: CarryDraft): void => {
    void props.chooseFolder().then((picked) => {
      if (picked.kind === 'picked') moveTo({ projectId, root: picked.path }, carry)
      else if (picked.kind === 'unavailable') setTyping({ projectId, carry })
    })
  }

  const runs = new Map<string, () => void>()
  const items: MenuEntry[] = []
  if (path !== undefined) items.push({ type: 'label', id: 'saved', text: t('folderSavedAt', { path: breakablePath(path) }) })
  if (project?.draft === true) {
    const projectId = project.id
    items.push({ id: 'move', label: t('folderMove'), icon: <IconEditOutlineRegular size={16} />, disabled: moving })
    runs.set('move', () => { pickFor(projectId, onPick) })
  }
  if (canReveal && path !== undefined) {
    items.push({ id: 'reveal', label: t('folderReveal'), icon: <IconFolderOpenOutlineRegular /> })
    runs.set('reveal', () => { props.reveal(path) })
  }
  // The person's own researches, newest first; the untouched draft is where 新研究 goes,
  // examples are only read, and removed ones are not listed.
  const workspaceIds = new Set<string>(registered.map(item => item.workspaceId))
  const others = projects
    .filter(other => other.id !== project?.id && other.example !== true && other.draft !== true && other.archived !== true
      && workspaceIds.has(other.workspaceId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  if (others.length > 0) {
    const submenu = others.map((other): MenuItem => {
      runs.set(`research:${other.id}`, () => { onPick(other.workspaceId) })
      return { id: `research:${other.id}`, label: other.title, icon: <IconFolderCloseRegular size={16} /> }
    })
    items.push({ id: 'switch', label: t('folderSwitch'), icon: <IconRightUpOutlineRegular size={16} />, submenu })
  }

  const decide = (chosen: Outcome, id: string): void => {
    setOutcome(null)
    if (id === 'adopt' && (chosen.kind === 'existing' || chosen.kind === 'nested')) {
      void props.adopt(chosen.request.projectId, chosen.target.workspaceId, chosen.carry)
    } else if (id === 'again') pickFor(chosen.request.projectId, chosen.carry)
    else if (id === 'confirm') moveTo({ ...chosen.request, confirmNonEmpty: true }, chosen.carry)
  }
  const submitTyped = (event: FormEvent<HTMLFormElement>, draft: Typing): void => {
    event.preventDefault()
    // The field is required, so a submitted form always holds it.
    const root = (new FormData(event.currentTarget).get('folder') as string).trim()
    if (root === '') return
    setTyping(null)
    moveTo({ projectId: draft.projectId, root }, draft.carry)
  }

  return <>
    <Menu
      open={props.open && items.length > 0}
      anchor={null}
      items={items}
      onSelect={(id) => {
        onClose()
        /* v8 ignore next -- the menu selects only the rows it was given, and every selectable row has an action. */
        runs.get(id)?.()
      }}
      onClose={onClose}
      portal
      getAnchorRect={getAnchorRect}
    />
    {outcome !== null && <Menu
      open
      anchor={null}
      items={outcomeRows(outcome, t)}
      onSelect={(id) => { decide(outcome, id) }}
      onClose={() => { setOutcome(null) }}
      portal
      getAnchorRect={getAnchorRect}
    />}
    <Modal
      open={typing !== null}
      onClose={() => { setTyping(null) }}
      title={t('folderTypeTitle')}
      closeLabel={t('close')}
      footer={<>
        <Button variant="outline" onClick={() => { setTyping(null) }}>{t('cancel')}</Button>
        <Button variant="primary" type="submit" form={formId}>{t('folderTypeSubmit')}</Button>
      </>}
    >
      {typing !== null && <form id={formId} className={styles.form} onSubmit={(event) => { submitTyped(event, typing) }}>
        <label className={styles.field}>
          <span>{t('folderTypeLabel')}</span>
          <input className={styles.input} name="folder" required autoFocus spellCheck={false} />
        </label>
        <p className={styles.hint}>{t('folderTypeHint')}</p>
      </form>}
    </Modal>
  </>
}
