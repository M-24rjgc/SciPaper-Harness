/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, profile-owned persistent storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string, sessionId: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param workspace - resolved storage account. @returns after its site data and guests have been cleared. */
  clearWorkspaceData(workspace: string, sessionId: string, lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}

/** Model operations on a guest already opened by the same conversation. */
export type DesktopBrowserOperation =
  | { readonly action: 'list'; readonly sessionId: string }
  | { readonly action: 'inspect' | 'screenshot'; readonly sessionId: string; readonly tabId?: DesktopBrowserLeaseId }
  | { readonly action: 'click'; readonly sessionId: string; readonly tabId?: DesktopBrowserLeaseId; readonly selector: string }
  | { readonly action: 'type'; readonly sessionId: string; readonly tabId?: DesktopBrowserLeaseId; readonly selector: string; readonly text: string }
  | { readonly action: 'scroll'; readonly sessionId: string; readonly tabId?: DesktopBrowserLeaseId; readonly deltaY: number }
  | { readonly action: 'navigate'; readonly sessionId: string; readonly tabId?: DesktopBrowserLeaseId; readonly url: string }
