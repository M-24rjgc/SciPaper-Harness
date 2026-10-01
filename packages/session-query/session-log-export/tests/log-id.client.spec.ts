import { describe, expect, it } from 'vitest'
import { shortLogId } from '../src/client/log-id.ts'

describe('shortLogId', () => {
  it('drops the shared session tag and keeps the first eight characters of the UUID', () => {
    expect(shortLogId('session-8f261bbc-706e-4817-b5f7-1e2f6dfa3401')).toBe('8f261bbc')
  })

  it('keeps a short unique part whole', () => {
    expect(shortLogId('session-7')).toBe('7')
  })

  it('shortens an id that carries no session tag from its first characters', () => {
    expect(shortLogId('ab12cd34ef56')).toBe('ab12cd34')
  })

  it('shows the whole id when nothing follows the tag', () => {
    expect(shortLogId('session-')).toBe('session-')
  })
})
