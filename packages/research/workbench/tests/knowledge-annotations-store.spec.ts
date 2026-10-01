import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ANNOTATIONS_FILE, MAX_ANNOTATIONS, MAX_ANNOTATIONS_BYTES, MAX_NOTE_LENGTH, MAX_TARGET_ID_LENGTH,
  annotationId, readAnnotations, removeAnnotation, setAnnotation, type Annotation,
} from '../src/knowledge-annotations.ts'

const fsHarness = vi.hoisted(() => ({
  nextStatError: undefined as NodeJS.ErrnoException | undefined,
  nextCopyError: undefined as NodeJS.ErrnoException | undefined,
}))

// Permission failures cannot be produced portably on a temporary directory, so the next stat or copy can be made to fail.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const failing = <F extends (...args: never[]) => Promise<unknown>>(key: 'nextStatError' | 'nextCopyError', original: F): F => (async (...args: Parameters<F>) => {
    const error = fsHarness[key]
    if (error !== undefined) {
      fsHarness[key] = undefined
      throw error
    }
    return original(...args)
  }) as F
  return { ...actual, stat: failing('nextStatError', actual.stat), copyFile: failing('nextCopyError', actual.copyFile) }
})

const roots: string[] = []
afterEach(async () => {
  fsHarness.nextStatError = undefined
  fsHarness.nextCopyError = undefined
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'research annotations '))
  roots.push(root)
  return root
}

const NOW = new Date('2026-10-01T12:00:00.000Z')
const later = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000)
const paper = (id: string, graph: 'ai' | 'project' = 'ai') => ({ kind: 'paper' as const, graph, id })
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code })

async function stored(root: string): Promise<string> {
  return readFile(join(root, ANNOTATIONS_FILE), 'utf8')
}

async function writeStored(root: string, content: string): Promise<void> {
  await mkdir(join(root, '.research', 'kg'), { recursive: true })
  await writeFile(join(root, ANNOTATIONS_FILE), content)
}

/** A sound stored mark, as the file holds it. */
function record(id: string, at: Date = NOW, extra: Partial<Annotation> = {}): Annotation {
  const target = paper(id)
  return { id: annotationId(target), target, verdict: 'irrelevant', by: 'user', at: at.toISOString(), ...extra }
}

describe('annotation ids', () => {
  it('names a mark by its graph, kind and target id, as graph-view names the node', () => {
    expect(annotationId({ kind: 'paper', graph: 'ai', id: 'RUzSobdYy0V' })).toBe('ai:paper:RUzSobdYy0V')
    expect(annotationId({ kind: 'pattern', graph: 'project', id: 'pattern_3' })).toBe('project:pattern:pattern_3')
  })
})

describe('setting and removing marks', () => {
  it('reads no marks and no problems from a project without a marks file', async () => {
    expect(await readAnnotations(await project())).toEqual({ annotations: [], problems: [] })
  })

  it('stores a mark with its reason on one line, its author and its time', async () => {
    const root = await project()
    const result = await setAnnotation(root, { target: paper('p1'), verdict: 'irrelevant', note: '  it targets\n\tthe prefill   stage ', by: 'user' }, NOW)
    const expected: Annotation = {
      id: 'ai:paper:p1', target: paper('p1'), verdict: 'irrelevant', note: 'it targets the prefill stage', by: 'user', at: '2026-10-01T12:00:00.000Z',
    }
    expect(result).toEqual({ changed: true, annotation: expected, previous: undefined, problems: [] })
    expect(await readAnnotations(root)).toEqual({ annotations: [expected], problems: [] })
    expect(JSON.parse(await stored(root))).toEqual({ version: 1, annotations: [expected] })
    expect((await stored(root)).endsWith('}\n')).toBe(true)
  })

  it('treats a blank reason as none, and keeps a reason of exactly the length limit', async () => {
    const root = await project()
    const blank = await setAnnotation(root, { target: paper('p1'), verdict: 'pin', note: ' \n ', by: 'agent' }, NOW)
    expect(blank.annotation).toEqual({ id: 'ai:paper:p1', target: paper('p1'), verdict: 'pin', by: 'agent', at: NOW.toISOString() })
    const longest = 'x'.repeat(MAX_NOTE_LENGTH)
    expect((await setAnnotation(root, { target: paper('p2'), verdict: 'pin', note: `${longest}  `, by: 'user' }, NOW)).annotation?.note).toBe(longest)
  })

  it('refuses a reason over the limit and a target id that is empty or too long', async () => {
    const root = await project()
    await expect(setAnnotation(root, { target: paper('p1'), verdict: 'pin', note: 'x'.repeat(MAX_NOTE_LENGTH + 1), by: 'user' })).rejects.toThrow(/280/)
    await expect(setAnnotation(root, { target: paper(''), verdict: 'pin', by: 'user' })).rejects.toThrow()
    await expect(setAnnotation(root, { target: paper('x'.repeat(MAX_TARGET_ID_LENGTH + 1)), verdict: 'pin', by: 'user' })).rejects.toThrow()
    expect(await readAnnotations(root)).toEqual({ annotations: [], problems: [] })
  })

  it('changes nothing when the same mark is set again', async () => {
    const root = await project()
    const input = { target: paper('p1'), verdict: 'pin' as const, note: 'keep it', by: 'user' as const }
    const first = await setAnnotation(root, input, NOW)
    const before = await stored(root)
    const again = await setAnnotation(root, input, later(60))
    expect(again).toEqual({ changed: false, annotation: first.annotation, previous: undefined, problems: [] })
    expect(await stored(root)).toBe(before)
  })

  it('replaces the mark on a target when the verdict, the reason or the author changes', async () => {
    const root = await project()
    const pinned = (await setAnnotation(root, { target: paper('p1'), verdict: 'pin', by: 'agent' }, NOW)).annotation
    const overturned = await setAnnotation(root, { target: paper('p1'), verdict: 'irrelevant', note: 'off topic', by: 'agent' }, later(1))
    expect(overturned).toMatchObject({ changed: true, previous: pinned, annotation: { verdict: 'irrelevant', note: 'off topic', at: later(1).toISOString() } })
    const reasoned = await setAnnotation(root, { target: paper('p1'), verdict: 'irrelevant', note: 'another setting', by: 'agent' }, later(2))
    expect(reasoned).toMatchObject({ changed: true, annotation: { note: 'another setting' } })
    const endorsed = await setAnnotation(root, { target: paper('p1'), verdict: 'irrelevant', note: 'another setting', by: 'user' }, later(3))
    expect(endorsed).toMatchObject({ changed: true, annotation: { by: 'user' } })
    expect((await readAnnotations(root)).annotations).toEqual([endorsed.annotation])
  })

  it('keeps marks ordered by id whatever order they were set in', async () => {
    const root = await project()
    for (const id of ['m', 'b', 'z', 'a']) await setAnnotation(root, { target: paper(id), verdict: 'pin', by: 'user' }, NOW)
    await setAnnotation(root, { target: { kind: 'pattern', graph: 'project', id: 'pattern_0' }, verdict: 'irrelevant', by: 'user' }, NOW)
    const ids = ['ai:paper:a', 'ai:paper:b', 'ai:paper:m', 'ai:paper:z', 'project:pattern:pattern_0']
    expect((await readAnnotations(root)).annotations.map(mark => mark.id)).toEqual(ids)
    expect((JSON.parse(await stored(root)) as { annotations: Annotation[] }).annotations.map(mark => mark.id)).toEqual(ids)
  })

  it('removes a mark, and treats removing a missing one as no change without writing', async () => {
    const root = await project()
    expect(await removeAnnotation(root, 'ai:paper:none', NOW)).toEqual({ changed: false, annotation: undefined, previous: undefined, problems: [] })
    await expect(stored(root)).rejects.toThrow(/ENOENT/)
    const set = await setAnnotation(root, { target: paper('p1'), verdict: 'pin', by: 'user' }, NOW)
    expect(await removeAnnotation(root, 'ai:paper:p1', NOW)).toEqual({ changed: true, annotation: undefined, previous: set.annotation, problems: [] })
    expect(await readAnnotations(root)).toEqual({ annotations: [], problems: [] })
    expect(await removeAnnotation(root, 'ai:paper:p1')).toMatchObject({ changed: false })
  })

  it('loses no mark when several writers change marks at the same time', async () => {
    const root = await project()
    const ids = Array.from({ length: 8 }, (_, at) => `p${String(at).padStart(2, '0')}`)
    await Promise.all(ids.map((id, at) => setAnnotation(root, { target: paper(id), verdict: at % 2 ? 'pin' : 'irrelevant', by: 'user' }, NOW)))
    expect((await readAnnotations(root)).annotations.map(mark => mark.target.id)).toEqual(ids)
    await Promise.all([
      removeAnnotation(root, 'ai:paper:p00', NOW),
      setAnnotation(root, { target: paper('p01'), verdict: 'irrelevant', by: 'agent' }, NOW),
      setAnnotation(root, { target: paper('p99'), verdict: 'pin', by: 'agent' }, NOW),
    ])
    const after = (await readAnnotations(root)).annotations
    expect(after.map(mark => mark.target.id)).toEqual([...ids.slice(1), 'p99'])
    expect(after.find(mark => mark.target.id === 'p01')).toMatchObject({ verdict: 'irrelevant', by: 'agent' })
    expect((await readdir(join(root, '.research', 'kg'))).sort()).toEqual(['annotations.json'])
  })
})

describe('the count and size limits', () => {
  it('refuses a mark beyond the count limit but still replaces marks at the limit', async () => {
    const root = await project()
    const full = Array.from({ length: MAX_ANNOTATIONS }, (_, at) => record(`p${String(at).padStart(4, '0')}`))
    await writeStored(root, JSON.stringify({ version: 1, annotations: full }))
    await expect(setAnnotation(root, { target: paper('extra'), verdict: 'pin', by: 'user' }, NOW)).rejects.toThrow(`at most ${MAX_ANNOTATIONS} marks`)
    expect(await setAnnotation(root, { target: paper('p0000'), verdict: 'pin', by: 'user' }, NOW)).toMatchObject({ changed: true })
    expect((await readAnnotations(root)).annotations).toHaveLength(MAX_ANNOTATIONS)
  })

  it('refuses a change that would grow the file past the byte limit, and reads a file of exactly the limit', async () => {
    const root = await project()
    // Long ids and three-byte characters make each mark about two kilobytes.
    const big = (at: number): Annotation => {
      const target = paper(`${String(at).padStart(4, '0')}${'i'.repeat(MAX_TARGET_ID_LENGTH - 4)}`)
      return { id: annotationId(target), target, verdict: 'pin', note: '注'.repeat(MAX_NOTE_LENGTH), by: 'user', at: NOW.toISOString() }
    }
    const text = (marks: Annotation[]): string => `${JSON.stringify({ version: 1, annotations: marks }, null, 1)}\n`
    // Every mark serializes to the same length, so the file grows by a fixed step per mark.
    const one = Buffer.byteLength(text([big(0)]))
    const step = Buffer.byteLength(text([big(0), big(1)])) - one
    const marks = Array.from({ length: Math.floor((MAX_ANNOTATIONS_BYTES - one) / step) + 1 }, (_, at) => big(at))
    const content = text(marks)
    expect(Buffer.byteLength(content) + step).toBeGreaterThan(MAX_ANNOTATIONS_BYTES)
    // Pad the file to exactly the limit; readers accept it.
    await writeStored(root, content.replace(/\n$/, `${' '.repeat(MAX_ANNOTATIONS_BYTES - Buffer.byteLength(content))}\n`))
    expect(Buffer.byteLength(await stored(root))).toBe(MAX_ANNOTATIONS_BYTES)
    expect(await readAnnotations(root)).toEqual({ annotations: marks, problems: [] })
    const next = big(marks.length)
    await expect(setAnnotation(root, { target: next.target, verdict: 'pin', note: next.note, by: 'user' }, NOW)).rejects.toThrow(/would exceed 1048576 bytes/)
    expect((await readAnnotations(root)).annotations).toHaveLength(marks.length)
  })
})

describe('a damaged marks file', () => {
  it('reports invalid JSON, honors nothing from it, and keeps a copy before the next change rewrites it', async () => {
    const root = await project()
    await writeStored(root, '{"version": 1, "annotations": [')
    const read = await readAnnotations(root)
    expect(read.annotations).toEqual([])
    const invalid = /^\.research\/kg\/annotations\.json is not valid JSON \(.+\); none of its marks are honored$/
    expect(read.problems).toEqual([expect.stringMatching(invalid)])
    const change = await setAnnotation(root, { target: paper('p1'), verdict: 'pin', by: 'user' }, NOW)
    expect(change).toMatchObject({ changed: true, problems: read.problems, backup: '.research/kg/annotations.json.20261001T120000Z.bak' })
    expect(await readFile(join(root, change.backup!), 'utf8')).toBe('{"version": 1, "annotations": [')
    expect(await readAnnotations(root)).toEqual({ annotations: [change.annotation], problems: [] })
    // A second damaged file in the same second gets its own copy.
    await writeStored(root, 'garbage')
    expect((await removeAnnotation(root, 'ai:paper:p1', NOW)).backup).toBe('.research/kg/annotations.json.20261001T120000Z-2.bak')
    expect(await readFile(join(root, '.research/kg/annotations.json.20261001T120000Z.bak'), 'utf8')).toBe('{"version": 1, "annotations": [')
  })

  it('reports a file that is not a marks file, or has an unknown older version', async () => {
    const root = await project()
    await writeStored(root, JSON.stringify({ marks: [] }))
    expect((await readAnnotations(root)).problems).toEqual(['.research/kg/annotations.json is not a marks file; none of its marks are honored'])
    await writeStored(root, JSON.stringify({ version: 0, annotations: [record('p1')] }))
    expect(await readAnnotations(root)).toEqual({ annotations: [], problems: ['.research/kg/annotations.json has unknown format version 0; none of its marks are honored'] })
  })

  it('neither honors nor rewrites a file of a newer format version', async () => {
    const root = await project()
    const newer = JSON.stringify({ version: 2, annotations: [{ relation: 'not-similar' }] })
    await writeStored(root, newer)
    const message = '.research/kg/annotations.json has format version 2, written by a newer SciPaper Harness; its marks are neither honored nor changed'
    expect(await readAnnotations(root)).toEqual({ annotations: [], problems: [message] })
    await expect(setAnnotation(root, { target: paper('p1'), verdict: 'pin', by: 'user' }, NOW)).rejects.toThrow(message)
    await expect(removeAnnotation(root, 'ai:paper:p1', NOW)).rejects.toThrow(message)
    expect(await stored(root)).toBe(newer)
  })

  it('honors the readable marks of a partly damaged file and names each problem', async () => {
    const root = await project()
    const misfiled = { ...record('p3'), id: 'ai:paper:wrong' }
    await writeStored(root, JSON.stringify({ version: 1, annotations: [
      record('p1', NOW, { note: 'first' }),
      { ...record('p2'), by: 'someone' },
      misfiled,
      record('p1', later(5), { note: 'newer' }),
      record('p4', later(5), { note: 'kept' }),
      record('p4', NOW, { note: 'older' }),
      { ...record('p5'), extra: 'ignored' },
    ] }))
    const read = await readAnnotations(root)
    expect(read.annotations.map(mark => [mark.id, mark.note])).toEqual([
      ['ai:paper:p1', 'newer'], ['ai:paper:p3', undefined], ['ai:paper:p4', 'kept'], ['ai:paper:p5', undefined],
    ])
    expect(read.annotations[3]).not.toHaveProperty('extra')
    expect(read.problems).toEqual([
      expect.stringMatching(/^mark 2 is malformed \(by .+\) and is not honored$/),
      'mark 3 is filed as ai:paper:wrong but points at ai:paper:p3; it is honored as ai:paper:p3',
      'mark 4 is a second mark on ai:paper:p1; the later of the two is honored',
      'mark 6 is a second mark on ai:paper:p4; the later of the two is honored',
    ])
    const change = await setAnnotation(root, { target: paper('p9'), verdict: 'pin', by: 'user' }, NOW)
    expect(change.backup).toMatch(/\.bak$/)
    expect((await readAnnotations(root)).annotations.map(mark => mark.id)).toEqual(['ai:paper:p1', 'ai:paper:p3', 'ai:paper:p4', 'ai:paper:p5', 'ai:paper:p9'])
  })

  it('honors only the newest marks of a file holding more than the limit, and counts problems beyond ten', async () => {
    const root = await project()
    const many = Array.from({ length: MAX_ANNOTATIONS + 1 }, (_, at) => record(`p${String(at).padStart(4, '0')}`, later(at)))
    await writeStored(root, JSON.stringify({ version: 1, annotations: [...many, ...Array.from({ length: 11 }, () => ({ broken: true }))] }))
    const read = await readAnnotations(root)
    expect(read.annotations).toHaveLength(MAX_ANNOTATIONS)
    expect(read.annotations[0]?.target.id).toBe('p0001')
    expect(read.problems).toHaveLength(11)
    expect(read.problems[10]).toBe('and 2 more problems')
    expect(read.problems.at(-2)).toMatch(/^mark 1011 is malformed/)
    // A change repairs the file: what was honored is written back, beside a copy of the original.
    const change = await removeAnnotation(root, 'ai:paper:p0500', NOW)
    expect(change).toMatchObject({ changed: true, backup: expect.stringMatching(/\.bak$/) as unknown })
    expect((await readAnnotations(root))).toMatchObject({ problems: [] })
    expect((await readAnnotations(root)).annotations).toHaveLength(MAX_ANNOTATIONS - 1)
  })

  it('repairs a damaged file on a change that alters no mark', async () => {
    const root = await project()
    await writeStored(root, JSON.stringify({ version: 1, annotations: [record('p1'), { broken: true }] }))
    const change = await removeAnnotation(root, 'ai:paper:none', NOW)
    expect(change).toMatchObject({
      changed: false, problems: [expect.stringMatching(/^mark 2 is malformed/)], backup: expect.stringMatching(/\.bak$/) as unknown,
    })
    expect(await readAnnotations(root)).toEqual({ annotations: [record('p1')], problems: [] })
  })

  it('reports a file over the byte limit and replaces it only after keeping a copy', async () => {
    const root = await project()
    await writeStored(root, `${JSON.stringify({ version: 1, annotations: [record('p1')] })}${' '.repeat(MAX_ANNOTATIONS_BYTES)}`)
    expect(await readAnnotations(root)).toEqual({ annotations: [], problems: ['.research/kg/annotations.json is larger than 1048576 bytes; none of its marks are honored'] })
    const change = await setAnnotation(root, { target: paper('p2'), verdict: 'pin', by: 'user' }, NOW)
    expect(Buffer.byteLength(await readFile(join(root, change.backup!), 'utf8'))).toBeGreaterThan(MAX_ANNOTATIONS_BYTES)
    expect((await readAnnotations(root)).annotations.map(mark => mark.id)).toEqual(['ai:paper:p2'])
  })
})

describe('marks file failures', () => {
  it('reports an unreadable file as a problem when reading, and fails a change without touching it', async () => {
    const root = await project()
    // A directory where the file belongs reads as EISDIR.
    await mkdir(join(root, ANNOTATIONS_FILE), { recursive: true })
    const unreadable = /^\.research\/kg\/annotations\.json could not be read \(.+\); no marks are honored$/
    expect((await readAnnotations(root)).problems).toEqual([expect.stringMatching(unreadable)])
    await expect(setAnnotation(root, { target: paper('p1'), verdict: 'pin', by: 'user' }, NOW)).rejects.toThrow()
  })

  it('fails a change when the file cannot be inspected, and when a damaged file cannot be copied aside', async () => {
    const root = await project()
    await setAnnotation(root, { target: paper('p1'), verdict: 'pin', by: 'user' }, NOW)
    fsHarness.nextStatError = errno('EACCES')
    await expect(setAnnotation(root, { target: paper('p2'), verdict: 'pin', by: 'user' }, NOW)).rejects.toThrow('EACCES: injected')
    fsHarness.nextStatError = errno('EACCES')
    expect((await readAnnotations(root)).problems).toEqual(['.research/kg/annotations.json could not be read (EACCES: injected); no marks are honored'])
    await writeStored(root, 'garbage')
    fsHarness.nextCopyError = errno('ENOSPC')
    await expect(setAnnotation(root, { target: paper('p2'), verdict: 'pin', by: 'user' }, NOW)).rejects.toThrow('ENOSPC: injected')
    expect(await stored(root)).toBe('garbage')
  })
})
