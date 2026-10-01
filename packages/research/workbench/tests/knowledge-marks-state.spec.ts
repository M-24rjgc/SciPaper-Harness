import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HONOUR_FILE, readHonour, writeHonour } from '../src/knowledge-marks-state.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'research-honour-'))
  roots.push(root)
  return root
}

it('follows the marks until the person pauses them, and again once they resume', async () => {
  const root = await temp()
  expect(await readHonour(root)).toBe(true)
  await writeHonour(root, false)
  expect(await readHonour(root)).toBe(false)
  expect(JSON.parse(await readFile(join(root, HONOUR_FILE), 'utf8'))).toEqual({ version: 1, honour: false })
  await writeHonour(root, true)
  expect(await readHonour(root)).toBe(true)
})

it('follows the marks when the state is damaged or of another shape', async () => {
  const root = await temp()
  await mkdir(dirname(join(root, HONOUR_FILE)), { recursive: true })
  await writeFile(join(root, HONOUR_FILE), '{not json')
  expect(await readHonour(root)).toBe(true)
  await writeFile(join(root, HONOUR_FILE), JSON.stringify({ version: 2, honour: false }))
  expect(await readHonour(root)).toBe(true)
})
