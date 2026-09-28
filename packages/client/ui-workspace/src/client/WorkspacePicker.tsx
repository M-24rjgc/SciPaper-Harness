/**
 * Workspace pick/add flow. WorkspacePickFlow is the reusable core (menu +
 * path error dialogs) consumed directly by WorkspaceBrowser (same package) and
 * wrapped by WorkspacePicker for the conversation empty-state slot
 * registration. Local directory picking lives in a composed flow package's
 * slot occupant. SSH workspaces use the host alias and path form here.
 */
import type { FormEvent, ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useId, useState } from 'react'
import {
  Button, IconFolderCloseRegular, IconPlusOutlineRegular, Menu, Modal, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceCreateRequest } from '@deepseek-ai/dsh-api-workspace-controller/types'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'

const ADD_WORKSPACE = '::add-workspace'
const ADD_SSH_WORKSPACE = '::add-ssh-workspace'

/** Core flow props: the owner supplies popover control and pick semantics. */
export interface WorkspacePickFlowProps {
  /** The standard locale seat, forwarded by whichever slot entry hosts the flow. */
  t: WorkspacePickerProps['t']
  /** Popover visibility (anchor button toggle state, owner-local). */
  open: boolean
  /** The anchor button element — the popover's placement anchor. */
  anchorRef?: RefObject<HTMLElement | null> | undefined
  /** Selector hook over the workspace list (framework standard hook). */
  useWorkspaces: <S>(selector: (state: WorkspaceSnapshot) => S) => S
  /** Adopt a picked host directory as a real Workspace. */
  createWorkspace: (input: WorkspaceCreateRequest) => Promise<WorkspaceView>
  /** Bound occupancy selector hook for this surface's local directory-flow hole. */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
  /** Render this surface's directory-flow hole with the owner conversation (the entry's narrowed renderSlot). */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  /** A real Workspace was picked or created. */
  onPick: (workspaceId: WorkspaceId) => void
  /** Close the popover (outside click / Escape / post-pick). */
  onClose: () => void
  /** Report the picking interaction and adoption occupancy. */
  onBusyChange?: (busy: boolean) => void
  /** Only offer the add action, hide existing workspaces. */
  addOnly?: boolean
  /** Menu opening direction relative to the anchor. */
  side?: 'bottom' | 'top' | 'right'
  /** Currently active workspace (trailing check in the picker list). */
  selectedId?: WorkspaceId | undefined
}

/**
 * Render the pick menu plus the adoption error dialog.
 * @param props - owner-controlled flow props.
 * @returns menu + dialog elements.
 */
export function WorkspacePickFlow({
  t,
  open,
  anchorRef,
  useWorkspaces,
  createWorkspace,
  useDirectoryFlow,
  renderDirectoryFlow,
  onPick,
  onClose,
  addOnly = false,
  onBusyChange,
  side = 'bottom',
  selectedId,
}: WorkspacePickFlowProps) {
  const workspaceSnapshot = useWorkspaces(state => state)
  const workspaces = workspaceSnapshot.items
  const getAnchorRect = useCallback(
    () => anchorRef?.current?.getBoundingClientRect() ?? null,
    [anchorRef],
  )
  const [errorOpen, setErrorOpen] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const [flowOpen, setFlowOpen] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [sshOpen, setSshOpen] = useState(false)
  const [sshHost, setSshHost] = useState('')
  const [sshPath, setSshPath] = useState('')
  const [sshError, setSshError] = useState<string | null>(null)
  const [sshSaving, setSshSaving] = useState(false)
  const sshFormId = useId()
  // One picking interaction at a time: while the flow is open (native chooser
  // pending, browse dialog up) or its pick is being adopted, every other
  // menu action stays disabled — a late outcome must not race a concurrent
  // selection or adoption.
  const flowBusy = flowOpen || pickingFolder || sshOpen || sshSaving
  useEffect(() => { onBusyChange?.(flowBusy) }, [flowBusy, onBusyChange])

  // The occupied hole gates the picking affordance: with no composed flow the
  // entry simply is not there (the seam's documented no-flow default). The
  // framework-bound hook keeps occupancy live: flow plugins activate (and
  // HMR-reload) independently of this menu's renders.
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  // An occupant that unloads mid-interaction leaves nobody to cancel: an
  // open flow over an empty hole withdraws so the menu actions come back.
  // flowOpen is a dependency because the flow can also OPEN over an already
  // empty hole (Choose again after the occupant unloaded with the error
  // dialog up) — that transition must snap back too, not just occupancy loss.
  useEffect(() => {
    if (flowOpen && !flowAvailable) setFlowOpen(false)
  }, [flowOpen, flowAvailable])
  const addEntries: MenuEntry[] = [
    ...(flowAvailable
      ? [{ id: ADD_WORKSPACE, label: t('menu.addWorkspace'), icon: <IconPlusOutlineRegular size={16} />, disabled: flowBusy }]
      : []),
    { id: ADD_SSH_WORKSPACE, label: t('menu.addSshWorkspace'), icon: <IconPlusOutlineRegular size={16} />, disabled: flowBusy },
  ]
  // With workspaces listed, the add action pins below the scroll region
  // (divider + always visible); otherwise it IS the menu.
  const pinAdd = !addOnly && workspaces.length > 0
  const items: MenuEntry[] = pinAdd
    ? workspaces.map(workspace => ({
      id: workspace.workspaceId,
      label: workspace.location.kind === 'ssh'
        ? `${workspaceDisplayTitle(workspace.title, t('workspace.defaultName'))} · ${workspace.location.host}:${workspace.path}`
        : workspaceDisplayTitle(workspace.title, t('workspace.defaultName')),
      icon: <IconFolderCloseRegular size={16} />,
      disabled: flowBusy,
    }))
    : addEntries
  // SSH registration stays available when no local picker is composed.
  const menuIsEmpty = items.length === 0

  const closeModal = (): void => {
    setErrorOpen(false)
    setModalError(null)
  }

  /** Adopt a picked directory; failures land in the folder-error dialog (Choose again reopens the flow). */
  const adoptDirectory = (path: string): Promise<void> =>
    createWorkspace({ path }).then((workspace) => {
      setFlowOpen(false)
      onPick(workspace.workspaceId)
    }).catch((reason: unknown) => {
      setModalError(reason instanceof Error ? reason.message : String(reason))
      setFlowOpen(false)
      setErrorOpen(true)
    })

  const openDirectoryFlow = useCallback((): void => {
    onClose()
    setErrorOpen(false)
    setModalError(null)
    setFlowOpen(true)
  }, [onClose])

  const openSshFlow = (): void => {
    onClose()
    setSshError(null)
    setSshOpen(true)
  }
  const submitSsh = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const host = sshHost.trim()
    const path = sshPath.trim()
    if (host === '' || !path.startsWith('/')) {
      setSshError(t('ssh.invalid'))
      return
    }
    setSshSaving(true)
    setSshError(null)
    void createWorkspace({ location: { kind: 'ssh', host, path } }).then((workspace) => {
      setSshOpen(false)
      onPick(workspace.workspaceId)
    }).catch((reason: unknown) => {
      setSshError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setSshSaving(false) })
  }

  /** Owner side of the flow conversation: adopt keeps the flow open (busy) until the Host answers. */
  const flowOwner: DirectoryFlowOwnerProps = {
    open: flowOpen,
    busy: pickingFolder,
    onPicked: (path) => {
      setPickingFolder(true)
      void adoptDirectory(path).finally(() => { setPickingFolder(false) })
    },
    onCancel: () => { setFlowOpen(false) },
    onError: (message) => {
      setFlowOpen(false)
      setModalError(message)
      setErrorOpen(true)
    },
  }

  const handleSelect = (id: string): void => {
    if (id === ADD_WORKSPACE) {
      openDirectoryFlow()
      return
    }
    if (id === ADD_SSH_WORKSPACE) {
      openSshFlow()
      return
    }
    onPick(id as WorkspaceId)
  }

  return (
    <>
      <Menu
        open={open && !menuIsEmpty}
        anchor={null}
        items={items}
        {...pinAdd ? { footer: addEntries } : {}}
        selectedId={selectedId}
        onSelect={handleSelect}
        onClose={onClose}
        side={side}
        portal
        getAnchorRect={getAnchorRect}
      />
      {open && !menuIsEmpty && workspaceSnapshot.phase === 'pending' && <div className={css.menuStatus} role="status">{t('picker.loading')}</div>}
      {renderDirectoryFlow(flowOwner)}
      <Modal
        open={sshOpen}
        onClose={() => { if (!sshSaving) setSshOpen(false) }}
        closeLabel={t('close')}
        title={t('ssh.title')}
        footer={<>
          <Button variant="outline" className={css.modalAction} disabled={sshSaving} onClick={() => { setSshOpen(false) }}>{t('cancel')}</Button>
          <Button variant="primary" className={css.modalAction} type="submit" form={sshFormId} disabled={sshSaving}>{t('ssh.add')}</Button>
        </>}
      >
        <form id={sshFormId} className={css.sshForm} onSubmit={submitSsh}>
          <label className={css.sshField}>
            <span>{t('ssh.host')}</span>
            <input autoFocus required spellCheck={false} value={sshHost} disabled={sshSaving} onChange={(event) => { setSshHost(event.target.value) }} placeholder={t('ssh.hostPlaceholder')} />
          </label>
          <label className={css.sshField}>
            <span>{t('ssh.path')}</span>
            <input required spellCheck={false} value={sshPath} disabled={sshSaving} onChange={(event) => { setSshPath(event.target.value) }} placeholder={t('ssh.pathPlaceholder')} />
          </label>
          {sshError !== null && <div className={css.modalError} role="alert">{sshError}</div>}
        </form>
      </Modal>
      <Modal
        open={errorOpen}
        onClose={closeModal}
        closeLabel={t('close')}
        title={t('folderError.title')}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} onClick={closeModal}>{t('cancel')}</Button>
            {/* Retrying needs an occupant to serve the flow; without one the
              * button would open a flow nobody can answer or cancel. */}
            <Button variant="primary" className={css.modalAction} disabled={!flowAvailable} onClick={openDirectoryFlow}>{t('folderError.retry')}</Button>
          </>
        )}
      >
        <div className={css.modalError} role="alert">{modalError}</div>
      </Modal>
    </>
  )
}

/**
 * The conversation empty-state registration: adapts the owner share to the
 * core flow (all state and semantics live in the flow / the owner).
 * @param props - empty-state slot props (owner share + injected creation callback).
 * @returns the flow element.
 */
export function WorkspacePicker({
  open,
  anchorRef,
  useWorkspaces,
  selectedId,
  onPick,
  onClose,
  createWorkspace,
  useDirectoryFlow,
  renderSlot,
  t,
}: WorkspacePickerProps) {
  return (
    <WorkspacePickFlow
      t={t}
      open={open}
      anchorRef={anchorRef}
      useWorkspaces={useWorkspaces}
      createWorkspace={createWorkspace}
      useDirectoryFlow={useDirectoryFlow}
      renderDirectoryFlow={owner => renderSlot('conversation.hero.workspace.directoryFlow', owner)}
      selectedId={selectedId}
      onPick={onPick}
      onClose={onClose}
    />
  )
}
