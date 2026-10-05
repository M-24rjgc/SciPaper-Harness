/** Non-destructive message revisions over an authoritative source log. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import { SessionSeq, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionMessageRevision, SessionRequestId } from './types.ts'

/**
 * Prepare an exact history prefix and a fresh human message without modifying the source.
 * @param events - complete source history at the observed cut.
 * @param revision - selected message and optional replacement text.
 * @returns a balanced seed, inherited prefix length, and the message to resend.
 */
export function prepareMessageRevision(events: readonly SessionEvent[], revision: SessionMessageRevision): {
  seed: SessionEvent[]
  inheritedEventCount: number
  message: UserMessage
} {
  const seq = revision.messageSeq
  const event = Number.isSafeInteger(seq) && seq >= 0 ? events[seq] : undefined
  if (event?.type !== 'user/message' || !isAppendSurfaceEvent(event) || event.data.source.kind !== 'user') {
    throw new RemoteError('gateway/bad-request', 'Select a recorded human message to edit or resend.', {})
  }
  const content = revision.text === undefined ? event.data.content : [
    ...event.data.content.filter(part => part.type !== 'text'),
    ...(revision.text.trim().length === 0 ? [] : [{ type: 'text' as const, text: revision.text }]),
  ]
  if (!content.some(part => part.type !== 'text' || part.text.trim().length > 0)) {
    throw new RemoteError('gateway/bad-request', 'The message must contain text or an attachment.', {})
  }
  const seed: SessionEvent[] = seq === 0
    ? [{ type: 'session/end-seed', seq: SessionSeq(0), time: event.time, data: { inherited: true } }]
    : buildForkSeed(events, SessionSeq(seq - 1))
  // A historical cut can contain other queued prompts. Clear them in the
  // child before publishing its Agent so a revision cannot replay that queue.
  const pending = { 'next-turn': 0, 'next-step': 0 }
  for (const entry of seed) {
    if (entry.type !== 'agent/inbox/spliced') continue
    const splice = entry.data
    pending[splice.target] += splice.inserted.length - (splice.removedCount ?? 0)
  }
  for (const target of ['next-turn', 'next-step'] as const) {
    if (pending[target] === 0) continue
    seed.push({
      type: 'agent/inbox/spliced', seq: SessionSeq(seed.length), time: event.time,
      data: { target, start: 0, removedCount: pending[target], inserted: [] },
    })
  }
  return {
    seed, inheritedEventCount: seq,
    message: createUserMessage({
      content,
      source: { kind: 'user', rpcId: brandString<SessionRequestId>(randomUUID()),
        ...!('clientTimeZone' in event.data.source)
          ? {} : { clientTimeZone: event.data.source.clientTimeZone } },
    }),
  }
}
