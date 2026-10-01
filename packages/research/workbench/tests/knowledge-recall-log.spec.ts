import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { appendRecall, MAX_RECALLS, PAPERS_PER_RECALL, PATTERNS_PER_RECALL, readRecalls, RECALL_LOG } from '../src/knowledge-recall-log.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }) })
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'recall log '))
  roots.push(root)
  return root
}
const ranked = (count: number) => Array.from({ length: count }, (_, index) => ({ index, score: count - index }))

describe('the recall log', () => {
  it('reads nothing from a project without a log or with a damaged one', async () => {
    const root = await temp()
    expect(await readRecalls(root)).toEqual([])
    await mkdir(dirname(join(root, RECALL_LOG)), { recursive: true })
    await writeFile(join(root, RECALL_LOG), '{"version": 2}')
    expect(await readRecalls(root)).toEqual([])
  })

  it('keeps the newest recalls first, one per query, with their leading papers and patterns, and replaces a damaged log', async () => {
    const root = await temp()
    await mkdir(dirname(join(root, RECALL_LOG)), { recursive: true })
    await writeFile(join(root, RECALL_LOG), 'not json')
    await appendRecall(root, 'block sparse attention', { papers: ranked(40), patterns: ranked(9) }, new Date('2026-10-01T00:00:00Z'))
    await appendRecall(root, 'kv cache', { papers: ranked(2), patterns: [] }, new Date('2026-10-01T00:01:00Z'))
    await appendRecall(root, 'block sparse attention', { papers: ranked(1), patterns: ranked(1) }, new Date('2026-10-01T00:02:00Z'))
    const recalls = await readRecalls(root)
    expect(recalls.map(item => item.query)).toEqual(['block sparse attention', 'kv cache'])
    expect(recalls[0]).toMatchObject({ at: '2026-10-01T00:02:00.000Z', papers: [{ index: 0, score: 1 }] })
    await appendRecall(root, 'wide', { papers: ranked(40), patterns: ranked(9) })
    const wide = (await readRecalls(root))[0]!
    expect(wide.papers).toHaveLength(PAPERS_PER_RECALL)
    expect(wide.patterns).toHaveLength(PATTERNS_PER_RECALL)
  })

  it('keeps at most MAX_RECALLS and cuts an overlong query', async () => {
    const root = await temp()
    for (let at = 0; at < MAX_RECALLS + 3; at++) await appendRecall(root, `query ${at}`, { papers: [], patterns: [] })
    const recalls = await readRecalls(root)
    expect(recalls).toHaveLength(MAX_RECALLS)
    expect(recalls[0]?.query).toBe(`query ${MAX_RECALLS + 2}`)
    await appendRecall(root, 'x'.repeat(5000), { papers: [], patterns: [] })
    expect((await readRecalls(root))[0]?.query).toHaveLength(2000)
  })
})
