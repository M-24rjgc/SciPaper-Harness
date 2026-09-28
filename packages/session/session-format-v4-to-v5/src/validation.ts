/** V5 execution metadata and unchanged V4 event relationship admission. */

import { posix } from 'node:path'
import { isSessionFormatJsonObject, SessionFormatError, sessionFormatCount } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header, assertReleasedV4Relationships, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'

/**
 * Read and validate the execution target carried by a V5 header.
 * @param header - Physical Session format header.
 * @returns The local or SSH execution target.
 */
export function executionOf(header: SessionFormatHeader): { readonly kind: 'local' } | { readonly kind: 'ssh'; readonly host: string } {
  const value = header['execution']
  if (value === undefined) return { kind: 'local' }
  if (!isSessionFormatJsonObject(value)) throw new SessionFormatError('format v5 execution must be an object')
  if (value['kind'] === 'local' && Object.keys(value).length === 1) return { kind: 'local' }
  if (value['kind'] === 'ssh' && typeof value['host'] === 'string' && value['host'].trim() !== ''
    && Object.keys(value).length === 2) return { kind: 'ssh', host: value['host'] }
  throw new SessionFormatError('format v5 execution must identify a local or SSH host')
}

/**
 * Adapt metadata alone for the frozen V4 event/framing validator.
 * @param header - V5 header to adapt.
 * @returns A V4-compatible header for relationship validation.
 */
export function v4HeaderOf(header: SessionFormatHeader): SessionFormatHeader {
  const { execution: _execution, cwd, type: _type, ...rest } = header
  return {
    ...rest,
    version: 4,
    ...(executionOf(header).kind === 'local' && cwd !== undefined ? { cwd } : {}),
  }
}

/**
 * Validate a V5 header, including POSIX cwd on Windows SSH workspaces.
 * @param header - Candidate physical Session header.
 */
export function assertReleasedV5Header(header: unknown): void {
  if (!isSessionFormatJsonObject(header) || header['version'] !== 5) {
    throw new SessionFormatError('expected format v5 header')
  }
  const execution = executionOf(header as SessionFormatHeader)
  const local = v4HeaderOf(header as SessionFormatHeader)
  assertReleasedV4Header(local)
  if (execution.kind === 'ssh' && header['cwd'] !== undefined
    && (typeof header['cwd'] !== 'string' || !posix.isAbsolute(header['cwd']))) {
    throw new SessionFormatError('format v5 SSH cwd must be absolute POSIX')
  }
}

/**
 * Validate current events using their unchanged V4 relationships.
 * @param artifact - V5 Session artifact to restore.
 * @param knownEventTypes - Event types registered by the host.
 * @returns The validated artifact.
 */
export function restoreReleasedV5Artifact(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): SessionFormatArtifact {
  assertReleasedV5Header(artifact.header)
  restoreReleasedV4Artifact({ ...artifact, header: v4HeaderOf(artifact.header) }, knownEventTypes)
  assertReleasedV5DeliveryRelationships(artifact, knownEventTypes)
  return artifact
}

/**
 * Keep V4 event relationships and enforce ownership of new V5 delivery markers.
 * @param artifact - V5 Session artifact to validate.
 * @param knownEventTypes - Event types registered by the host.
 */
export function assertReleasedV5Relationships(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): void {
  assertReleasedV4Relationships({ ...artifact, header: v4HeaderOf(artifact.header) }, knownEventTypes)
  assertReleasedV5DeliveryRelationships(artifact, knownEventTypes)
}

function assertReleasedV5DeliveryRelationships(
  artifact: SessionFormatArtifact,
  knownEventTypes: ReadonlySet<string>,
): void {
  for (const event of artifact.events) {
    if (event.type !== 'session-log-deepseek/delivery-accepted' || !knownEventTypes.has(event.type)) continue
    const data = event.data
    if (!isSessionFormatJsonObject(data)) throw new SessionFormatError('delivery-accepted data must be an object')
    const version = sessionFormatCount(data['sessionFormatVersion'] ?? 0, 'delivery sessionFormatVersion')
    if (version !== 5) continue
    const throughSeq = sessionFormatCount(data['throughSeq'], 'delivery throughSeq')
    if (throughSeq >= event.seq) throw new SessionFormatError('delivery throughSeq must precede its marker')
    const id = data['sessionId']
    if (typeof id !== 'string' || id.length === 0) throw new SessionFormatError('delivery requires a nonempty Session id')
    if (!(artifact.header.parentSession !== undefined && event.seq < artifact.inheritedEventCount)
      && id !== artifact.header.id) {
      throw new SessionFormatError('current-generation delivery marker names the wrong Session')
    }
  }
}
