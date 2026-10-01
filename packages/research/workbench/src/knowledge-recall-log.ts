/**
 * The research's recent recalls against the built-in graph, by paper and pattern index: what the domain map
 * shows as the agent's recall and places as the research's idea. It is derived data; a damaged file is
 * replaced on the next recall, never repaired.
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { atomicWrite, projectPath, readText } from './files.ts'
import type { RecallIndices } from './knowledge.ts'

/** Where a project keeps its recent recalls. */
export const RECALL_LOG = '.research/kg/recalls.json'
/** Recalls kept, newest first. */
export const MAX_RECALLS = 20
/** Papers kept per recall: the BM25 hits that place the query on the map. */
export const PAPERS_PER_RECALL = 30
/** Patterns kept per recall, in fused order. */
export const PATTERNS_PER_RECALL = 5
const MAX_QUERY = 2000
const LOG_LIMIT = 1024 * 1024

const ranked = z.array(z.object({ index: z.number().int().min(0), score: z.number() }))
const entrySchema = z.object({ query: z.string().min(1).max(MAX_QUERY), at: z.iso.datetime(), papers: ranked, patterns: ranked })
const logSchema = z.object({ version: z.literal(1), recalls: z.array(entrySchema) })

/** One recall as the log keeps it. */
export type RecallLogEntry = z.infer<typeof entrySchema>

/**
 * The recent recalls, newest first.
 * @param root - the project root.
 * @returns the entries; none when the log is missing or damaged.
 */
export async function readRecalls(root: string): Promise<RecallLogEntry[]> {
  try {
    return logSchema.parse(JSON.parse(await readText(await projectPath(root, RECALL_LOG), LOG_LIMIT))).recalls
  } catch {
    return []
  }
}

/**
 * Record one recall's built-in rankings, newest first, keeping the last MAX_RECALLS.
 * @param root - the project root.
 * @param query - the recall's query.
 * @param indices - the built-in graph's rankings behind the recall.
 * @param now - the time to record.
 */
export async function appendRecall(root: string, query: string, indices: RecallIndices, now: Date = new Date()): Promise<void> {
  const path = await projectPath(root, RECALL_LOG)
  const entry: RecallLogEntry = {
    query: query.slice(0, MAX_QUERY), at: now.toISOString(),
    papers: indices.papers.slice(0, PAPERS_PER_RECALL), patterns: indices.patterns.slice(0, PATTERNS_PER_RECALL),
  }
  await mkdir(dirname(path), { recursive: true })
  await withFileLock(path, async () => {
    const recalls = [entry, ...(await readRecalls(root)).filter(item => item.query !== entry.query)].slice(0, MAX_RECALLS)
    await atomicWrite(path, `${JSON.stringify({ version: 1, recalls })}\n`)
  })
}
