/** The abstract service preserves the provider's discovery contract. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { FILE_REFERENCE_PROMPT, FileReferenceService } from '../src/index.ts'
import type { FileReferenceCandidate } from '../src/types.ts'

describe('FileReferenceService', () => {
  it('describes file paths in the session execution environment', () => {
    expect(FILE_REFERENCE_PROMPT).toContain("this session's execution environment")
    expect(FILE_REFERENCE_PROMPT).not.toContain('on the host')
  })

  it('registers a provider implementation without wrapping its discovery member', async () => {
    const candidates: FileReferenceCandidate[] = [{ path: 'src', kind: 'directory' }]
    const list = vi.fn((_agent: Agent, _query: string, _signal: AbortSignal) => Promise.resolve(candidates))
    class StubProvider extends FileReferenceService {
      list = list
    }
    const provider = new StubProvider(new Context())
    const agent = { id: 'target' } as unknown as Agent
    const signal = new AbortController().signal
    await expect(provider.list(agent, 'sr', signal)).resolves.toBe(candidates)
    expect(list).toHaveBeenCalledWith(agent, 'sr', signal)
  })
})
