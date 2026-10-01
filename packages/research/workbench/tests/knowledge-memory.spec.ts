import { describe, expect, it } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { newProject } from '../src/project.ts'
import { titleKey as mapTitleKey } from '../src/knowledge-map-view.ts'
import { titleKey } from '../src/title-key.ts'
import {
  AGENT_MEMORY_LIMIT, buildResearchMemory, carriedMemory, leavesMemory, MEMORY_LIMIT, memoryCarry, type MemoryOptions,
} from '../src/knowledge-memory.ts'
import type {
  DecisionRecord, EnvironmentId, EnvironmentRecord, EvidenceId, EvidenceRecord, ExperimentRecord, MemoryKind, ProjectId, ResearchProject,
} from '../src/types.ts'

const every: Record<MemoryKind, boolean> = { literature: true, runs: true, environments: true, writing: true }
const options = (patch: Partial<MemoryOptions> = {}): MemoryOptions => (
  { isExample: () => false, finished: new Set(), carry: every, ...patch }
)

/** A research that has been worked in: titled, created at the given time. */
function research(id: string, createdAt: string, patch: Partial<ResearchProject> = {}): ResearchProject {
  const base = newProject({ root: `/research/${id}`, title: `Research ${id}`, brief: '' }, 'workspace' as WorkspaceId)
  return { ...base, id: id as ProjectId, createdAt, ...patch }
}
const paper = (id: string, title: string, patch: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: id as EvidenceId, title, kind: 'literature', path: `.research/sources/${id}.json`, sha256: 'x', revision: 1, importedAt: '', chunks: [],
  coverage: 'abstract', verified: false, stale: false, ...patch,
})
const environment = (id: string, patch: Partial<EnvironmentRecord> = {}): EnvironmentRecord => ({
  id: id as EnvironmentId, name: id, kind: 'uv', target: 'local', python: `/${id}/bin/python`, requirements: [], fingerprint: '', status: 'ready',
  details: '', isDefault: false, ...patch,
})
const run = (id: string, name: string, patch: Partial<ExperimentRecord> = {}): ExperimentRecord => ({
  id: id as ExperimentRecord['id'],
  spec: {
    environmentId: 'e' as EnvironmentId, name, argv: ['{python}', 'code/train.py'], cwd: '.', seed: 1, maxSeconds: 60, gpuIds: [],
    dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'm.json',
  },
  status: 'completed', createdAt: '', updatedAt: '2026-09-01T00:00:00Z', directory: '', inputRevision: 1, environmentFingerprint: '',
  metrics: { accuracy: 0.8 }, message: '', snapshotPath: '', collected: true, ...patch,
})
const decision = (id: string, patch: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id, question: `Question ${id}`, answer: `Answer ${id}`, by: 'user', rationale: '', at: '2026-09-01T00:00:00Z', ...patch,
})
const clipped = `${'x'.repeat(239)}…`

describe('titleKey', () => {
  it('normalizes titles exactly as the domain map does, so the two plugins agree on what is the same paper', () => {
    for (const title of ['Longformer: The Long-Document Transformer', 'Café Résumé — 论文 题目 2024', '  ', 'A/B']) {
      expect(titleKey(title)).toBe(mapTitleKey(title))
    }
    expect(titleKey('Longformer: The Long-Document Transformer')).toBe('longformerthelongdocumenttransformer')
    expect(titleKey('Café — 论文 2024')).toBe('cafe论文2024')
  })
})

describe('memoryCarry', () => {
  it('reads every kind as on unless the person switched it off', () => {
    expect(memoryCarry({})).toEqual(every)
    expect(memoryCarry({ memoryCarry: { runs: false, writing: undefined, literature: true } })).toEqual({ ...every, runs: false })
    expect(memoryCarry({ memoryCarry: { literature: false, runs: false, environments: false, writing: false } }))
      .toEqual({ literature: false, runs: false, environments: false, writing: false })
  })
})

describe('leavesMemory', () => {
  it('keeps a worked research and leaves out an example, a research removed from the list and the untouched draft', () => {
    const worked = research('a', '2026-09-01T00:00:00Z')
    expect(leavesMemory(worked, () => false)).toBe(true)
    expect(leavesMemory(worked, root => root === '/research/a')).toBe(false)
    expect(leavesMemory({ ...worked, archivedAt: '2026-09-02T00:00:00Z' }, () => false)).toBe(false)
    expect(leavesMemory({ ...worked, title: '新研究', untitled: true }, () => false)).toBe(false)
  })
})

describe('buildResearchMemory', () => {
  const older = research('a', '2026-08-01T00:00:00Z', {
    evidence: [
      paper('p1', 'Longformer: The Long-Document Transformer'),
      paper('p2', 'Reformer', { doi: '10.1/reformer', verified: true }),
      paper('f1', 'results.csv', { kind: 'file', coverage: 'data' }),
    ],
    venue: 'aaai',
  })
  const newer = research('b', '2026-09-01T00:00:00Z', {
    evidence: [
      paper('p3', 'Longformer - the long document transformer', { doi: '10.1/longformer', verified: true }),
      paper('p4', 'Big Bird'),
      paper('p5', '  Longformer:   The Long-Document Transformer '),
    ],
    venue: 'aaai',
  })

  it('merges literature across researches by title, the most shared first, and records who imported each item', () => {
    const page = buildResearchMemory([newer, older], options({ finished: new Set(['a' as ProjectId]) }))
    expect(page.researches).toEqual([
      { id: 'a', title: 'Research a', finished: true, literature: 2, runs: 0, venue: 'aaai' },
      { id: 'b', title: 'Research b', finished: false, literature: 2, runs: 0, venue: 'aaai' },
    ])
    expect(page.literature.total).toBe(3)
    expect(page.literature.items).toEqual([
      { title: 'Longformer: The Long-Document Transformer', doi: '10.1/longformer', verified: true, researches: ['a', 'b'] },
      { title: 'Reformer', doi: '10.1/reformer', verified: true, researches: ['a'] },
      { title: 'Big Bird', verified: false, researches: ['b'] },
    ])
  })

  it('keeps the first DOI and a recorded verification, and matches a title with no letters or digits by the record\'s id', () => {
    const first = research('a', '2026-08-01T00:00:00Z', {
      evidence: [paper('x1', 'Same', { doi: '10.1/first', verified: true }), paper('s1', '—'), paper('s2', '—')],
    })
    const second = research('b', '2026-09-01T00:00:00Z', { evidence: [paper('x2', 'same', { doi: '10.1/second' }), paper('s2', '—')] })
    expect(buildResearchMemory([first, second], options()).literature.items).toEqual([
      { title: 'Same', doi: '10.1/first', verified: true, researches: ['a', 'b'] },
      { title: '—', verified: false, researches: ['a', 'b'] },
      { title: '—', verified: false, researches: ['a'] },
    ])
  })

  it('lists the finished experiments by name, newest first, with the newest run speaking for a name; it calls none a baseline', () => {
    const lab = research('a', '2026-08-01T00:00:00Z', {
      experiments: [
        run('r1', 'ruler-32k-full', { updatedAt: '2026-08-02T00:00:00Z', metrics: { accuracy: 0.7 } }),
        run('r2', 'ruler-32k-full', { updatedAt: '2026-08-04T00:00:00Z', metrics: { accuracy: 0.9 } }),
        run('r3', 'ruler-32k-full', { updatedAt: '2026-08-03T00:00:00Z', metrics: { accuracy: 0.8 } }),
        run('r4', 'ruler-32k-fixed', { updatedAt: '2026-08-06T00:00:00Z', metrics: {} }),
        run('r5', 'running-now', { status: 'running' }),
        run('r6', 'broken', { status: 'failed', message: 'out of memory' }),
      ],
    })
    const page = buildResearchMemory([lab], options())
    expect(page.runs).toEqual({
      total: 2,
      items: [
        { name: 'ruler-32k-fixed', runs: 1, metrics: {}, command: '{python} code/train.py', at: '2026-08-06T00:00:00Z', researches: ['a'] },
        { name: 'ruler-32k-full', runs: 3, metrics: { accuracy: 0.9 }, command: '{python} code/train.py', at: '2026-08-04T00:00:00Z', researches: ['a'] },
      ],
    })
    expect(page.researches[0]?.runs).toBe(2)
    expect(JSON.stringify(page)).not.toMatch(/baseline/i)
  })

  it('lists ready environments only; local uv ones merge, SSH ones merge by host and interpreter, other interpreters by kind and path', () => {
    const first = research('a', '2026-08-01T00:00:00Z', {
      environments: [
        environment('uv-a', { requirements: ['numpy', 'torch'] }),
        environment('uv-a2', { requirements: ['numpy'] }),
        environment('lab', { target: 'ssh', sshHost: 'lab-a100', python: '/usr/bin/python3', requirements: ['torch'] }),
        environment('conda-1', { kind: 'conda', python: '/opt/conda/bin/python' }),
        environment('pending', { status: 'pending' }),
        environment('broken', { status: 'failed' }),
      ],
    })
    const second = research('b', '2026-09-01T00:00:00Z', {
      environments: [
        environment('uv-b', { requirements: ['torch', 'scipy'] }),
        environment('lab-again', { target: 'ssh', sshHost: 'lab-a100', python: '/usr/bin/python3', requirements: ['torch', 'einops'] }),
        environment('lab-other', { target: 'ssh', sshHost: 'lab-a100', python: '/opt/py/bin/python' }),
        environment('conda-2', { kind: 'conda', python: '/opt/conda/bin/python' }),
        environment('conda-3', { kind: 'existing', python: '/opt/conda/bin/python' }),
        environment('no-host', { target: 'ssh', python: '/x/python' }),
      ],
    })
    const { environments } = buildResearchMemory([first, second], options())
    expect(environments.total).toBe(6)
    expect(environments.items).toEqual([
      { name: 'uv-a', kind: 'uv', target: 'local', python: '', requirements: ['numpy', 'torch', 'scipy'], researches: ['a', 'b'] },
      { name: 'lab', kind: 'uv', target: 'ssh', host: 'lab-a100', python: '/usr/bin/python3', requirements: ['torch', 'einops'], researches: ['a', 'b'] },
      { name: 'conda-1', kind: 'conda', target: 'local', python: '/opt/conda/bin/python', requirements: [], researches: ['a', 'b'] },
      { name: 'lab-other', kind: 'uv', target: 'ssh', host: 'lab-a100', python: '/opt/py/bin/python', requirements: [], researches: ['b'] },
      { name: 'conda-3', kind: 'existing', target: 'local', python: '/opt/conda/bin/python', requirements: [], researches: ['b'] },
      { name: 'no-host', kind: 'uv', target: 'ssh', python: '/x/python', requirements: [], researches: ['b'] },
    ])
    expect(environments.items[5]).not.toHaveProperty('host')
  })

  it('counts the venue templates the researches use, named by the library when it knows them', () => {
    const third = research('c', '2026-09-10T00:00:00Z', { venue: 'neurips' })
    const named = buildResearchMemory([older, newer, third], options({ venueName: id => id === 'aaai' ? 'AAAI 2026' : undefined }))
    expect(named.writing.items).toEqual([
      { venue: 'aaai', name: 'AAAI 2026', researches: ['a', 'b'] },
      { venue: 'neurips', researches: ['c'] },
    ])
    expect(named.researches.map(item => item.venue)).toEqual(['AAAI 2026', 'AAAI 2026', 'neurips'])
    const unnamed = buildResearchMemory([older, third], options())
    expect(unnamed.writing.items).toEqual([{ venue: 'aaai', researches: ['a'] }, { venue: 'neurips', researches: ['c'] }])
    expect(unnamed.researches.map(item => item.venue)).toEqual(['aaai', 'neurips'])
    expect(buildResearchMemory([research('d', '2026-09-11T00:00:00Z')], options()).researches[0]).not.toHaveProperty('venue')
  })

  it('records failures that hold a reason or an exit code and decisions other than the mode, newest first, and nothing else', () => {
    const long = 'x'.repeat(300)
    const lab = research('a', '2026-08-01T00:00:00Z', {
      experiments: [
        run('f1', 'train', { status: 'failed', message: ' out of\nmemory ', finishedAt: '2026-08-05T00:00:00Z', exitCode: 137 }),
        run('f2', 'train', { status: 'failed', message: 'out of memory', finishedAt: '2026-08-07T00:00:00Z', exitCode: 137 }),
        run('f3', 'train', { status: 'failed', message: 'out of memory', finishedAt: '2026-08-06T00:00:00Z', exitCode: 137 }),
        run('f4', 'eval', { status: 'failed', message: '', updatedAt: '2026-08-04T00:00:00Z', exitCode: 2 }),
        run('f5', 'quiet', { status: 'failed', message: '  ' }),
        run('f6', 'train', { status: 'failed', message: long, finishedAt: '2026-08-03T00:00:00Z' }),
        run('ok', 'fine', { status: 'completed', message: 'done' }),
      ],
      decisions: [
        decision('d1', { key: 'mode', question: 'Mode', answer: 'ccfa' }),
        decision('d2', { question: ' Use  xelatex? ', answer: 'yes', rationale: 'CJK text', by: 'agent', at: '2026-08-08T00:00:00Z' }),
        decision('d3', { at: '2026-08-02T00:00:00Z', rationale: long }),
      ],
    })
    expect(buildResearchMemory([lab], options()).lessons).toEqual({
      total: 5,
      items: [
        { research: 'a', at: '2026-08-08T00:00:00Z', kind: 'decision', question: 'Use xelatex?', answer: 'yes', rationale: 'CJK text', by: 'agent' },
        { research: 'a', at: '2026-08-07T00:00:00Z', kind: 'failed-run', name: 'train', reason: 'out of memory', exitCode: 137 },
        { research: 'a', at: '2026-08-04T00:00:00Z', kind: 'failed-run', name: 'eval', reason: '', exitCode: 2 },
        { research: 'a', at: '2026-08-03T00:00:00Z', kind: 'failed-run', name: 'train', reason: clipped },
        { research: 'a', at: '2026-08-02T00:00:00Z', kind: 'decision', question: 'Question d3', answer: 'Answer d3', rationale: clipped, by: 'user' },
      ],
    })
  })

  it('shows nothing for a record that holds no lesson, and leaves out examples, removed researches and the untouched draft', () => {
    const quiet = research('a', '2026-08-01T00:00:00Z', { evidence: [paper('p1', 'Only paper')] })
    const draft = { ...research('d', '2026-08-02T00:00:00Z'), title: '新研究', untitled: true }
    const removed = research('r', '2026-08-03T00:00:00Z', { archivedAt: '2026-08-04T00:00:00Z', evidence: [paper('p9', 'Removed paper')] })
    const example = research('e', '2026-08-04T00:00:00Z', { evidence: [paper('p8', 'Example paper')] })
    const page = buildResearchMemory([draft, removed, example, quiet], options({ isExample: root => root === '/research/e' }))
    expect(page.researches.map(item => item.id)).toEqual(['a'])
    expect(page.lessons).toEqual({ total: 0, items: [] })
    expect(page.literature.items.map(item => item.title)).toEqual(['Only paper'])
    expect(buildResearchMemory([], options()))
      .toMatchObject({ researches: [], literature: { total: 0 }, lessons: { total: 0 }, carry: every })
  })

  it('orders researches oldest first, by id when created together, and copies the switches', () => {
    const together = [research('z', '2026-09-01T00:00:00Z'), research('y', '2026-09-01T00:00:00Z'), research('x', '2026-08-01T00:00:00Z')]
    const carry = { ...every, runs: false }
    const page = buildResearchMemory(together, options({ carry }))
    expect(page.researches.map(item => item.id)).toEqual(['x', 'y', 'z'])
    expect(page.carry).toEqual(carry)
    expect(page.carry).not.toBe(carry)
  })

  it('lists at most 100 items of a kind and counts them all', () => {
    const many = research('a', '2026-08-01T00:00:00Z', {
      evidence: Array.from({ length: MEMORY_LIMIT + 1 }, (_, at) => paper(`p${at}`, `Paper number ${at}`)),
    })
    const { literature } = buildResearchMemory([many], options())
    expect(literature.total).toBe(MEMORY_LIMIT + 1)
    expect(literature.items).toHaveLength(MEMORY_LIMIT)
    expect(carriedMemory(buildResearchMemory([many], options())).literature?.items).toHaveLength(AGENT_MEMORY_LIMIT)
  })
})

describe('carriedMemory', () => {
  const lab = research('a', '2026-08-01T00:00:00Z', {
    evidence: [paper('p1', 'Longformer', { doi: '10.1/longformer' }), paper('p2', 'Reformer')],
    experiments: [run('r1', 'ruler-32k-full', { metrics: { accuracy: 0.9 } })],
    environments: [environment('lab', { target: 'ssh', sshHost: 'lab-a100', python: '/usr/bin/python3', requirements: ['torch'] }), environment('local')],
    venue: 'aaai',
    decisions: [decision('d1')],
  })
  const next = research('b', '2026-09-01T00:00:00Z', { evidence: [paper('p3', 'longformer')], venue: 'neurips' })
  const page = buildResearchMemory([next, lab], options({ finished: new Set(['a' as ProjectId]), venueName: id => id === 'aaai' ? 'AAAI 2026' : undefined }))

  it('gives the agent the kinds switched on with research titles instead of ids, and never the lessons', () => {
    const carried = carriedMemory(page)
    expect(carried).toEqual({
      carried: ['literature', 'runs', 'environments', 'writing'],
      researches: [{ title: 'Research a', finished: true }, { title: 'Research b', finished: false }],
      literature: {
        total: 2,
        items: [
          { title: 'Longformer', doi: '10.1/longformer', verified: false, from: ['Research a', 'Research b'] },
          { title: 'Reformer', verified: false, from: ['Research a'] },
        ],
      },
      runs: {
        total: 1,
        items: [{ name: 'ruler-32k-full', runs: 1, metrics: { accuracy: 0.9 }, command: '{python} code/train.py', at: '2026-09-01T00:00:00Z', from: ['Research a'] }],
      },
      environments: {
        total: 2,
        items: [
          { name: 'lab', kind: 'uv', target: 'ssh', host: 'lab-a100', python: '/usr/bin/python3', requirements: ['torch'], from: ['Research a'] },
          { name: 'local', kind: 'uv', target: 'local', python: '', requirements: [], from: ['Research a'] },
        ],
      },
      writing: {
        total: 2,
        items: [{ venue: 'aaai', name: 'AAAI 2026', from: ['Research a'] }, { venue: 'neurips', from: ['Research b'] }],
      },
    })
    expect(carried).not.toHaveProperty('lessons')
    expect(JSON.stringify(carried)).not.toContain('"a"')
  })

  it('cuts each kind to the limit it is given and keeps the count of them all', () => {
    const carried = carriedMemory(page, 1)
    expect(carried.literature).toMatchObject({ total: 2, items: [{ title: 'Longformer' }] })
    expect(carried.literature?.items).toHaveLength(1)
    expect(carried.environments).toMatchObject({ total: 2 })
    expect(carried.environments?.items).toHaveLength(1)
  })

  it('leaves out the kinds that are switched off and names those that are on, even when they hold nothing', () => {
    const some = carriedMemory({ ...page, carry: { literature: false, runs: false, environments: true, writing: true } })
    expect(some.carried).toEqual(['environments', 'writing'])
    expect(some).not.toHaveProperty('literature')
    expect(some).not.toHaveProperty('runs')
    expect(some.environments).toBeDefined()
    const none = carriedMemory({ ...page, carry: { literature: false, runs: false, environments: false, writing: false } })
    expect(none).toEqual({ carried: [], researches: [{ title: 'Research a', finished: true }, { title: 'Research b', finished: false }] })
    const empty = carriedMemory(buildResearchMemory([], options()))
    expect(empty).toEqual({
      carried: ['literature', 'runs', 'environments', 'writing'], researches: [],
      literature: { total: 0, items: [] }, runs: { total: 0, items: [] },
      environments: { total: 0, items: [] }, writing: { total: 0, items: [] },
    })
  })
})
