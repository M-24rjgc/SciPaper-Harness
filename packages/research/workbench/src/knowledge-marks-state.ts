/**
 * Whether the agent follows the research's marks. The person can pause them to hear the graph's independent
 * ranking; pausing keeps every mark and only stops recall from applying them. The state is the person's, kept in
 * `.research/kg/honour.json`; a missing or damaged file means the marks are followed.
 */
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { atomicWrite, projectPath, readText } from './files.ts'

/** Where a project keeps whether its marks are followed. */
export const HONOUR_FILE = '.research/kg/honour.json'
const STATE_LIMIT = 4096
const stateSchema = z.object({ version: z.literal(1), honour: z.boolean() })

/**
 * Whether the agent follows the marks of a research.
 * @param root - the project root.
 * @returns false only when the person paused the marks; true when the file is missing or damaged.
 */
export async function readHonour(root: string): Promise<boolean> {
  try {
    return stateSchema.parse(JSON.parse(await readText(await projectPath(root, HONOUR_FILE), STATE_LIMIT))).honour
  } catch {
    return true
  }
}

/**
 * Pause or resume following the marks.
 * @param root - the project root.
 * @param honour - whether recall applies the marks.
 */
export async function writeHonour(root: string, honour: boolean): Promise<void> {
  const path = await projectPath(root, HONOUR_FILE)
  await mkdir(dirname(path), { recursive: true })
  await withFileLock(path, async () => { await atomicWrite(path, `${JSON.stringify({ version: 1, honour })}\n`) })
}
