/** Wait for a window that can display an update confirmation, including Windows restore. */
import type { BrowserWindow } from 'electron'

/**
 * @param window - Current product window, which may be hidden or minimized.
 * @param signal - Cancels the wait when the application starts quitting.
 * @returns Whether the window became visible; closing or cancellation never authorizes installation.
 */
export function waitForUpdateWindow(window: BrowserWindow | undefined, signal: AbortSignal): Promise<boolean> {
  if (window === undefined || window.isDestroyed() || signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const finish = (visible: boolean): void => {
      window.off('show', check)
      window.off('restore', check)
      window.off('focus', check)
      window.off('closed', cancel)
      signal.removeEventListener('abort', cancel)
      resolve(visible)
    }
    const cancel = (): void => { finish(false) }
    const check = (): void => {
      if (window.isDestroyed() || signal.aborted) cancel()
      else if (window.isVisible() && !window.isMinimized()) finish(true)
    }
    window.on('show', check)
    window.on('restore', check)
    window.on('focus', check)
    window.once('closed', cancel)
    signal.addEventListener('abort', cancel, { once: true })
    check()
  })
}
