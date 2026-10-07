/** Microphone access belongs to the primary application frame and the operating system. */
import { systemPreferences, type Session, type WebContents } from 'electron'
import { isDesktopApplicationDocument } from './ipc.ts'

/**
 * Permit microphone and sanitized clipboard writes only from the owned application main frame.
 * Other renderer permissions are denied.
 * @param session - application's browser session.
 * @param primary - current primary window contents, absent while no window is open.
 */
export function installMicrophonePermissions(session: Pick<Session, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>, primary: () => WebContents | undefined): void {
  session.setPermissionCheckHandler((contents, permission, origin, details) => {
    const owned = contents != null && contents === primary() && details.isMainFrame && isDesktopApplicationDocument(origin)
    if (permission !== 'media') return owned && permission === 'clipboard-sanitized-write'
    return owned && details.mediaType === 'audio'
      && (process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted')
  })
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const owned = contents === primary() && details.isMainFrame && isDesktopApplicationDocument(details.requestingUrl)
    if (permission !== 'media') { callback(owned && permission === 'clipboard-sanitized-write'); return }
    const allowed = owned && 'mediaTypes' in details && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio'
    if (!allowed) { callback(false); return }
    if (process.platform !== 'darwin') { callback(true); return }
    void systemPreferences.askForMediaAccess('microphone').then(callback, () => { callback(false) })
  })
}
