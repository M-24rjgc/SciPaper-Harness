/** The log ID a person reads and copies: the Session id, shown in a short form. */

/** Every host-minted Session id starts with this tag, so it carries no information. */
const SESSION_ID_PREFIX = 'session-'

/** Leading characters of the id's unique part that the short form keeps. */
const SHORT_LOG_ID_LENGTH = 8

/**
 * Shorten a Session id for display: drop the shared `session-` tag and keep the first eight
 * characters of the UUID. The Session's log directory is named by the full id, so a
 * directory named `session-<short>…` under the sessions root is the log of that ID.
 * @param sessionId - the full Session id; the log ID that is copied and exported.
 * @returns the short log ID, or the whole id when nothing follows the tag.
 */
export function shortLogId(sessionId: string): string {
  const unique = sessionId.startsWith(SESSION_ID_PREFIX)
    ? sessionId.slice(SESSION_ID_PREFIX.length)
    : sessionId
  return unique === '' ? sessionId : unique.slice(0, SHORT_LOG_ID_LENGTH)
}
