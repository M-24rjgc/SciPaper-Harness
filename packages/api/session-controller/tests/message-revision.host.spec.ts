import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { prepareMessageRevision } from '../src/message-revision.ts'

describe('message revisions', () => {
  it('retains prior context and attachments, drops later history and queued input, and leaves the source intact', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const source = ctx.sessions.create(SessionId('source'))
      source.append('turn/start', { turn: 1 })
      source.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Earlier context' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const queued = createUserMessage({ content: [{ type: 'text', text: 'Do not run again' }], source: { kind: 'user' } })
      source.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued] })
      source.append('turn/start', { turn: 2 })
      const original = createUserMessage({ content: [
        { type: 'text', text: 'Original prompt' },
        { type: 'image', attachment: { attachmentId: AttachmentId('picture'), bytes: 1, width: 1, height: 1, mediaType: 'image/png' } },
        { type: 'file', attachment: { attachmentId: AttachmentId('file'), name: 'data.csv', bytes: 12 } },
      ], source: { kind: 'user' } })
      const message = source.append('user/message', original, { surfaceOp: 'append' })
      source.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      source.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Later history' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const before = source.snapshotEvents()
      const revision = prepareMessageRevision(before, { messageSeq: message.seq, text: 'Revised prompt' })
      const child = ctx.sessions.create(SessionId('revision'), {
        seed: revision.seed, meta: { isSeeded: true, parentSession: source.id },
        inheritedEventCount: SessionLogOffset(revision.inheritedEventCount),
      })
      child.append('user/message', revision.message, { surfaceOp: 'append' })
      expect(child.deriveMessages().map(item => item.content.filter(part => part.type === 'text').map(part => part.text)))
        .toMatchInlineSnapshot(`
          [
            [
              "Earlier context",
            ],
            [
              "Revised prompt",
            ],
          ]
        `)
      expect(revision.message.content.filter(part => part.type !== 'text')).toEqual(original.content.filter(part => part.type !== 'text'))
      expect(revision.seed.at(-1)).toMatchObject({ type: 'agent/inbox/spliced', data: { target: 'next-turn', removedCount: 1, inserted: [] } })
      expect(source.snapshotEvents()).toEqual(before)
      expect(prepareMessageRevision(before, { messageSeq: message.seq }).message.content).toEqual(original.content)
      expect(prepareMessageRevision(before, { messageSeq: message.seq, text: '' }).message.content).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('can revise the first event and refuses empty text-only or non-human revisions', () => {
    const original = createUserMessage({ content: [{ type: 'text', text: 'First' }], source: { kind: 'user' } })
    const events: SessionEvent[] = [{ type: 'user/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append', data: original }]
    const revision = prepareMessageRevision(events, { messageSeq: 0, text: 'Replacement' })
    expect(revision.inheritedEventCount).toBe(0)
    expect(revision.seed).toEqual([{ type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true } }])
    expect(revision.message.id).not.toBe(original.id)
    expect(() => prepareMessageRevision(events, { messageSeq: 0, text: '  ' })).toThrow('text or an attachment')
    for (const messageSeq of [-1, 0.5, 1, NaN]) expect(() => prepareMessageRevision(events, { messageSeq })).toThrow('human message')
    expect(() => prepareMessageRevision([{ type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } }], { messageSeq: 0 })).toThrow('human message')
  })
})
