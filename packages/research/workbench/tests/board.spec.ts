import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ProcessOptions, ProcessResult } from '../src/process.ts'
import type { BoardSpec, EnvironmentId, EnvironmentRecord, ExperimentId, ExperimentRecord, ResearchProject } from '../src/types.ts'

/** Every probe and collector the board starts, answered by the current script. */
const scripted = vi.hoisted(() => ({
  local: [] as { command: string; args: string[]; options: ProcessOptions }[],
  remote: [] as { host: string; args: string[]; options: ProcessOptions }[],
  answer: (_where: 'local' | 'ssh', _args: string[], _options: ProcessOptions): ProcessResult | Promise<ProcessResult> => ({ code: 0, stdout: '{}', stderr: '' }),
}))
vi.mock('../src/process.ts', async (original) => {
  const actual = await original<typeof import('../src/process.ts')>()
  return {
    ...actual,
    runProcess: async (command: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> => {
      scripted.local.push({ command, args: [...args], options })
      return scripted.answer('local', [...args], options)
    },
    ssh: async (host: string, args: readonly string[], options: ProcessOptions = {}): Promise<ProcessResult> => {
      scripted.remote.push({ host, args: [...args], options })
      return scripted.answer('ssh', [...args], options)
    },
  }
})

const board = await import('../src/board.ts')
const {
  ExperimentBoards, applyPatch, collectorOutput, followedRuns, issueText, latestRun, missingScripts, nameMatches, progressRows, thin,
  unmatched,
} = board
const { boardPatchSchema, boardSpecSchema } = await import('../src/schema.ts')
const { newProject } = await import('../src/project.ts')

const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: '' })
const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  scripted.local.length = 0
  scripted.remote.length = 0
  scripted.answer = () => ok('{}')
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function project(): Promise<ResearchProject> {
  const root = await mkdtemp(join(tmpdir(), 'research-board-'))
  roots.push(root)
  return newProject({ root, title: 'Board', brief: '' }, 'w' as WorkspaceId)
}
async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
function environment(id: string, extra: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id: id as EnvironmentId, name: id, kind: 'existing', target: 'local', python: `${id}-python`, requirements: [],
    isDefault: false, fingerprint: 'f', status: 'ready', details: '{}', ...extra,
  }
}
function remote(id: string, host: string, extra: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return environment(id, { target: 'ssh', sshHost: host, remoteRoot: '/data/research', python: '/usr/bin/python3', ...extra })
}
type RunExtra = Partial<ExperimentRecord> & { environmentId?: string; seed?: number }
function run(id: string, name: string, extra: RunExtra = {}): ExperimentRecord {
  const { environmentId = 'here', seed = 1, ...rest } = extra
  return {
    id: id as ExperimentId, status: 'completed', createdAt: `2026-09-24T10:00:0${id.length % 10}.000Z`, updatedAt: '2026-09-24T10:00:00.000Z',
    directory: `/runs/${id}`, inputRevision: 1, environmentFingerprint: 'f', metrics: {}, message: '', snapshotPath: '', collected: true,
    spec: {
      environmentId: environmentId as EnvironmentId, name, argv: ['{python}'], cwd: '.', seed, maxSeconds: 60, gpuIds: [],
      dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json',
    },
    ...rest,
  }
}
function boards(extra: { localPython?: string | undefined; track?: (operation: Promise<unknown>) => void } = {}): {
  boards: InstanceType<typeof ExperimentBoards>
  warnings: string[]
  tracked: Promise<unknown>[]
} {
  const warnings: string[] = []
  const tracked: Promise<unknown>[] = []
  return {
    boards: new ExperimentBoards({
      localPython: async () => 'localPython' in extra ? extra.localPython : 'platform-python',
      signal: new AbortController().signal,
      track: extra.track ?? ((operation) => { tracked.push(operation) }),
      warn: (message) => { warnings.push(message) },
    }),
    warnings, tracked,
  }
}
const signal = new AbortController().signal
/** A probe report as the script prints it, missing values as null. */
function probe(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    host: 'box', os: 'Linux', gpus: [{ name: 'A100', util: 50, memoryUsed: 2048, memoryTotal: 4096, temperature: 60, power: null, powerLimit: 300 }],
    cpu: { util: 0.25, cores: 8 }, memory: { used: 4, total: 16 }, disk: { path: '/data', used: 10, total: 100, free: 90 }, progress: {}, ...extra,
  })
}
const isProbe = (args: string[]): boolean => args.includes('-') && args.some(arg => arg.startsWith('{"disk"'))

describe('board values follow runs by id, or by name and seed', () => {
  const p = { experiments: [run('a', 'main', { seed: 1 }), run('bb', 'main', { seed: 2 }), run('ccc', 'other')] }

  it('matches ids, names, seeds and name patterns', () => {
    expect(followedRuns(p, { run: 'a' }).map(item => item.id)).toEqual(['a'])
    expect(followedRuns(p, { run: 'main' }).map(item => item.id)).toEqual(['a', 'bb'])
    expect(followedRuns(p, { run: 'main', seed: 2 }).map(item => item.id)).toEqual(['bb'])
    expect(followedRuns(p, {})).toEqual([])
    expect(latestRun(p, { run: 'main' })?.id).toBe('bb')
    expect(latestRun(p, { run: 'nothing' })).toBeUndefined()
    expect(nameMatches('ablation/*', 'ablation/no-attn')).toBe(true)
    expect(nameMatches('ablation/*', 'main/ablation/x')).toBe(false)
    expect(nameMatches('a.b(c)', 'a.b(c)')).toBe(true)
    expect(nameMatches('a.b', 'axb')).toBe(false)
  })

  it('names the references no run answers yet, without refusing them', () => {
    const spec: BoardSpec = {
      collectors: [],
      sections: [{
        id: 's', title: 'S', blocks: [
          { type: 'stats', items: [{ label: 'x', run: 'main', metric: 'acc' }, { label: 'fixed', value: 1 }] },
          { type: 'list', items: [{ title: 't', run: 'later' }] },
          { type: 'chart', series: [{ run: 'main', seed: 9, key: 'acc' }, { points: [[1, 2]] }] },
          { type: 'runs', match: 'ablation/*' },
          { type: 'runs', match: 'main' },
          { type: 'table', columns: [{ key: 'c', label: 'C' }], rows: [{ cells: { c: { run: 'other', metric: 'acc' }, d: 'text', e: null } }] },
          { type: 'text', text: 'note' },
        ],
      }],
    }
    expect(unmatched(p, spec)).toEqual(['later', 'main (seed 9)', 'ablation/*'])
  })
})

describe('the layout is changed by patches the agent sends', () => {
  const section = (id: string, title = id) => ({ id, title, blocks: [] })

  it('replaces fields, sections and collectors by id, and an empty title or summary clears it', () => {
    const start: BoardSpec = { title: 'T', summary: 'S', sections: [section('a'), section('b')], collectors: [{ id: 'q', script: 'q.py' }] }
    const next = applyPatch(start, {
      title: ' ', summary: 'New', tags: ['x'],
      sections: [section('b', 'B2'), { id: 'a', remove: true }, section('c')],
      collectors: [{ id: 'q', remove: true }, { id: 'r', script: 'r.py', every: 20 }],
    })
    expect(next).toEqual({ title: undefined, summary: 'New', tags: ['x'], sections: [section('b', 'B2'), section('c')], collectors: [{ id: 'r', script: 'r.py', every: 20 }] })
    expect(applyPatch(start, { title: 'Kept' })).toMatchObject({ title: 'Kept', summary: 'S', sections: start.sections })
    expect(applyPatch(start, { summary: '' }).summary).toBeUndefined()
    expect(start.sections).toHaveLength(2)
  })

  it('reads a null as an absent field, from a model and from a collector alike', () => {
    expect(boardPatchSchema.parse({ title: null, sections: [{ id: 's', title: 'S', note: null, blocks: [{ type: 'table', columns: [{ key: 'c', label: 'C' }], rows: [{ cells: { c: null } }] }] }] }))
      .toEqual({ sections: [{ id: 's', title: 'S', blocks: [{ type: 'table', columns: [{ key: 'c', label: 'C' }], rows: [{ cells: {} }] }] }] })
    expect(boardPatchSchema.safeParse('x').success).toBe(false)
  })

  it('says where a layout fails to parse', () => {
    const failure = boardSpecSchema.safeParse({ sections: [{ id: 'bad id', title: '', blocks: [{ type: 'pie' }] }], collectors: [] })
    expect(failure.success).toBe(false)
    const text = issueText(failure.error!)
    expect(text).toMatch(/^sections\.0\.id: /)
    expect(text).toMatch(/sections\.0\.blocks\.0\.type/)
    expect(issueText(boardSpecSchema.safeParse('x').error!, '')).toMatch(/^board: /)
    expect(issueText(boardSpecSchema.safeParse('x').error!, 'out')).toMatch(/^out: /)
    const series = boardSpecSchema.safeParse({ collectors: [], sections: [{ id: 's', title: 'S', blocks: [{ type: 'chart', series: [{ run: 'r' }] }] }] })
    expect(issueText(series.error!)).toMatch(/a series needs points, or a run and a key/)
  })
})

describe('progress lines become curves', () => {
  it('keeps the numeric fields of object lines and thins long runs, always keeping the last line', () => {
    const fields = Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`f${index}`, index]))
    const text = ['{"epoch": 1, "acc": 0.5, "note": "x", "ok": true, "bad": null}', 'not json', '[1, 2]', 'null', '{"note": "only text"}', JSON.stringify(fields), '{"epoch": 2, "acc":'].join('\r\n')
    const rows = progressRows(text)
    expect(rows[0]).toEqual({ epoch: 1, acc: 0.5 })
    expect(Object.keys(rows[1] ?? {})).toHaveLength(40)
    expect(rows).toHaveLength(2)
    expect(thin([1, 2, 3], 5)).toEqual([1, 2, 3])
    expect(thin(Array.from({ length: 10 }, (_, index) => index), 4)).toEqual([0, 2, 5, 9])
  })
})

describe('a collector\'s output keeps every part that parses', () => {
  it('drops the parts that do not, names them, and defaults an alert to a warning', () => {
    const output = collectorOutput({
      stats: [{ label: 'Queue', value: '3 / 8', progress: 0.4 }, { value: 1 }],
      sections: [{ id: 'q', title: 'Queue', blocks: [{ type: 'list', items: [{ title: 'job', detail: null }] }] }, { id: 'x' }],
      alerts: [{ text: 'disk' }, { level: 'fatal', text: 'x' }],
    })
    expect(output.stats).toEqual([{ label: 'Queue', value: '3 / 8', progress: 0.4 }])
    expect(output.sections).toEqual([{ id: 'q', title: 'Queue', blocks: [{ type: 'list', items: [{ title: 'job' }] }] }])
    expect(output.alerts).toEqual([{ level: 'warning', text: 'disk' }])
    expect(output.error).toMatch(/^stats\[1\]\.label: .*sections\[1\]\.title: .*alerts\[1\]\.level: /)
    expect(collectorOutput({})).toEqual({ stats: [], sections: [], alerts: [] })
    expect(() => collectorOutput([1])).toThrow(/must print one object/)
  })
})

describe('the stored layout', () => {
  it('reads as empty until written, and a hand-broken file reads as empty with the reason', async () => {
    const p = await project()
    const { boards: b } = boards()
    expect(await b.layout(p.root)).toEqual({ spec: { sections: [], collectors: [] } })
    await write(join(p.root, board.BOARD_FILE), '{')
    expect((await b.layout(p.root)).problem).toMatch(/is not JSON/)
    await write(join(p.root, board.BOARD_FILE), '{"sections": 3}')
    expect((await b.layout(p.root)).problem).toMatch(/is invalid: sections/)
    const view = await b.view(p, false)
    expect(view.alerts).toEqual([{ level: 'error', text: expect.stringMatching(/is invalid/) as unknown }])
  })

  it('applies patches one at a time, replaces on request, and refuses a layout past its limits', async () => {
    const p = await project()
    const { boards: b } = boards()
    const section = (id: string) => ({ id, title: id, blocks: [] })
    const [first, second] = await Promise.all([
      b.update(p.root, { title: 'Study', sections: [section('a')] }, false),
      b.update(p.root, { sections: [section('b')] }, false),
    ])
    expect(first.sections.map(item => item.id)).toEqual(['a'])
    expect(second).toMatchObject({ title: 'Study', sections: [section('a'), section('b')] })
    expect(second.updatedAt).toEqual(expect.any(String))
    expect(JSON.parse(await readFile(join(p.root, board.BOARD_FILE), 'utf8'))).toMatchObject({ title: 'Study' })
    const many = Array.from({ length: 41 }, (_, index) => section(`s${index}`))
    await expect(b.update(p.root, { sections: many }, false)).rejects.toThrow(/The board was not saved: sections/)
    // A refused change does not hold up the next.
    expect((await b.update(p.root, { sections: [section('c')] }, true)).sections.map(item => item.id)).toEqual(['c'])
    expect((await b.layout(p.root)).spec.title).toBeUndefined()
  })

  it('names the collector scripts not written yet', async () => {
    const p = await project()
    await write(join(p.root, 'board/q.py'), 'print(1)')
    expect(await missingScripts(p.root, { sections: [], collectors: [{ id: 'q', script: 'board/q.py' }, { id: 'r', script: 'board/r.py' }] })).toEqual(['board/r.py'])
  })
})

describe('reading the board: machines, progress and collectors, by script', () => {
  it('probes each machine once, here or over SSH, and keeps its history', async () => {
    const p = await project()
    p.environments.push(
      environment('here', { isDefault: true }),
      remote('gpu', 'gpu-box'), remote('gpu2', 'gpu-box', { remoteRoot: undefined }),
      remote('bare', 'bare-host', { remoteRoot: undefined }),
      environment('broken', { status: 'failed' }), environment('idle'),
    )
    p.experiments.push(
      run('r1', 'train', { environmentId: 'gpu', status: 'running', directory: '/data/research/runs/r1' }),
      run('r2', 'train', { environmentId: 'gpu2', status: 'queued', directory: '/data/research/runs/r2' }),
      run('r3', 'train', { environmentId: 'broken', status: 'running' }),
    )
    await write(join(p.root, board.BOARD_FILE), JSON.stringify({ sections: [], collectors: [{ id: 'bare', script: 'x.py', environmentId: 'bare' }] }))
    await write(join(p.root, 'x.py'), 'print(1)')
    scripted.answer = (where, args) => {
      if (!isProbe(args)) return ok('{}')
      const request = JSON.parse(args.at(-1) ?? '{}') as { disk: string; progress: string[] }
      if (where === 'local') return ok(probe({ disk: { path: request.disk, used: 95, total: 100, free: 5 }, gpus: [{ name: 'RTX', util: null }], cpu: null, memory: null }))
      return ok(probe({ progress: { '/data/research/runs/r1': [{ epoch: 1, acc: 0.5 }] } }))
    }
    const { boards: b } = boards()
    const report = await b.refresh(p, signal)
    expect(report.machines.map(machine => machine.key).sort()).toEqual(['bare-host', 'gpu-box', 'local'])
    expect(scripted.local.filter(call => isProbe(call.args)).map(call => call.command)).toEqual(['here-python'])
    const boxCall = scripted.remote.find(call => call.host === 'gpu-box' && isProbe(call.args))!
    expect(JSON.parse(boxCall.args.at(-1)!)).toEqual({ disk: '/data/research', progress: ['/data/research/runs/r1', '/data/research/runs/r2'], limit: 400 })
    const bareCall = scripted.remote.find(call => call.host === 'bare-host' && isProbe(call.args))!
    expect((JSON.parse(bareCall.args.at(-1)!) as { disk: string }).disk).toBe('')
    const view = await b.view(p, false)
    const local = view.machines.find(machine => machine.key === 'local')!
    expect(local).toMatchObject({ environments: ['here'], gpus: [{ name: 'RTX' }], disk: { free: 5 } })
    expect(local.history).toEqual([{ t: expect.any(Number) as unknown }])
    const box = view.machines.find(machine => machine.key === 'gpu-box')!
    expect(box).toMatchObject({ host: 'box', os: 'Linux', environments: ['gpu', 'gpu2'], cpu: { util: 0.25, cores: 8 } })
    expect(box.history[0]).toMatchObject({ gpu: 0.5, gpuMemory: 0.5, cpu: 0.25, memory: 0.25 })
    expect(view.alerts).toEqual([{ level: 'warning', text: expect.stringMatching(/^local: .* has 5% free$/) as unknown }])
    expect(view.series).toEqual({ r1: [{ epoch: 1, acc: 0.5 }], r3: [] })
    // A host that stops answering keeps its history and last curve; a report without a host or OS leaves them out.
    scripted.answer = (where, args) => isProbe(args) && where === 'ssh' ? { code: 255, stdout: '', stderr: 'Connection refused' } : ok(where === 'local' && isProbe(args) ? '{"gpus": "oops"}' : '{}')
    const second = await b.refresh(p, signal)
    expect(second.machines.find(machine => machine.key === 'gpu-box')).toEqual({ key: 'gpu-box', error: expect.stringMatching(/Machine probe failed \(255\): Connection refused/) as unknown, gpus: 0 })
    const after = await b.view(p, false)
    expect(after.machines.find(machine => machine.key === 'gpu-box')?.history).toHaveLength(1)
    expect(after.series.r1).toEqual([{ epoch: 1, acc: 0.5 }])
    expect(after.series.r2).toBeUndefined()
    const bare = after.machines.find(machine => machine.key === 'local')!
    expect(bare.host).toBeUndefined()
    expect(bare.gpus).toEqual([])
    expect(bare.history).toHaveLength(2)
    expect(after.alerts.map(alert => alert.text)).toEqual(expect.arrayContaining([expect.stringMatching(/^gpu-box: Machine probe failed/)]))
  })

  it('reads curves of local runs, of finished remote runs and of runs a chart follows, from this machine', async () => {
    const p = await project()
    p.environments.push(environment('here'), remote('gpu', 'gpu-box'))
    const localRun = run('local1', 'local', { status: 'running', directory: join(p.root, '.research/runs/local1') })
    const finished = run('remote1', 'chart/remote', { environmentId: 'gpu', directory: '/data/research/runs/remote1' })
    const orphan = run('orphan', 'chart/orphan', { environmentId: 'gone' })
    p.experiments.push(localRun, finished, orphan, run('ignored', 'ignored'))
    await write(join(localRun.directory, 'progress.jsonl'), '{"epoch": 1, "loss": 2}\n{"epoch": 2, "loss": 1}\n')
    await write(join(p.root, '.research/runs/remote1/progress.jsonl'), '{"step": 10, "acc": 0.9}\n')
    await write(join(p.root, board.BOARD_FILE), JSON.stringify({
      collectors: [],
      sections: [{ id: 's', title: 'S', blocks: [
        { type: 'text', text: 'x' },
        { type: 'chart', series: [{ run: 'chart/remote', key: 'acc' }, { run: 'nothing', key: 'acc' }, { run: 'chart/orphan', key: 'acc' }] },
      ] }],
    }))
    const { boards: b } = boards()
    await b.refresh(p, signal)
    const view = await b.view(p, false, ['ignored', 'local1'])
    expect(view.series).toEqual({
      local1: [{ epoch: 1, loss: 2 }, { epoch: 2, loss: 1 }], remote1: [{ step: 10, acc: 0.9 }], orphan: [], ignored: [],
    })
  })

  it('runs collectors in their environments when due, keeps the last output through a failure, and reports each', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'))
    const p = await project()
    p.environments.push(environment('here', { isDefault: true }), remote('gpu', 'gpu-box', { remoteRoot: undefined }), remote('nohost', 'x', { sshHost: undefined }))
    for (const name of ['queue', 'remote', 'broken', 'text', 'none', 'nohost']) await write(join(p.root, `board/${name}.py`), `# ${name}`)
    await write(join(p.root, board.BOARD_FILE), JSON.stringify({
      sections: [],
      collectors: [
        { id: 'queue', script: 'board/queue.py', every: 60, args: ['--fast'] },
        { id: 'remote', script: 'board/remote.py', environmentId: 'gpu' },
        { id: 'broken', script: 'board/broken.py' },
        { id: 'text', script: 'board/text.py' },
        { id: 'unknown', script: 'board/none.py', environmentId: 'gone' },
        { id: 'missing', script: 'board/missing.py' },
        { id: 'nohost', script: 'board/nohost.py', environmentId: 'nohost' },
      ],
    }))
    let queue = JSON.stringify({ stats: [{ label: 'Queue', value: '1 / 2' }], sections: [{ id: 'q', title: 'Q', blocks: [] }], alerts: [{ level: 'info', text: 'hi' }] })
    scripted.answer = (_where, args, options) => {
      if (isProbe(args)) return ok(probe())
      const script = String(options.input)
      if (script.includes('queue')) return ok(queue)
      if (script.includes('remote')) return ok(JSON.stringify({ stats: [{ label: 'Remote', value: 1, extra: 1 }] }))
      if (script.includes('broken')) return { code: 1, stdout: '', stderr: 'Traceback: boom' }
      if (script.includes('nohost')) return ok('{}')
      return ok('not json at all')
    }
    const { boards: b, tracked: operations } = boards()
    const report = await b.refresh(p, signal)
    expect(report.collectors).toEqual([
      { id: 'queue', ok: true, sections: 1, stats: 1, ms: 0 },
      { id: 'remote', ok: true, sections: 0, stats: 1, ms: 0 },
      { id: 'broken', ok: false, error: expect.stringMatching(/Collector failed \(1\): Traceback: boom/) as unknown, sections: 0, stats: 0, ms: 0 },
      { id: 'text', ok: false, error: 'The collector printed no JSON object: not json at all', sections: 0, stats: 0, ms: 0 },
      { id: 'unknown', ok: false, error: 'Unknown environment gone', sections: 0, stats: 0, ms: 0 },
      { id: 'missing', ok: false, error: expect.any(String) as unknown, sections: 0, stats: 0, ms: 0 },
      { id: 'nohost', ok: true, sections: 0, stats: 0, ms: 0 },
    ])
    expect(scripted.remote.find(call => String(call.options.input).includes('nohost'))?.host).toBe('')
    expect(report.alerts.map(alert => alert.text))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^broken: /), expect.stringMatching(/^text: /)]))
    const queueCall = scripted.local.find(call => String(call.options.input).includes('queue'))!
    expect(queueCall).toMatchObject({ command: 'here-python', args: ['-', '--fast'], options: { cwd: p.root, env: { RESEARCH_PROJECT_ROOT: p.root } } })
    expect(scripted.remote.find(call => String(call.options.input).includes('remote'))).toMatchObject({ host: 'gpu-box', args: ['env', 'RESEARCH_REMOTE_ROOT=', '/usr/bin/python3', '-'] })
    // A background read inside a collector's interval reuses its output; a failure keeps the last one.
    queue = '{"stats": []}'
    scripted.local.length = 0
    vi.setSystemTime(new Date('2026-09-24T12:00:40Z'))
    await b.view(p, true)
    await Promise.all(operations)
    let view = await b.view(p, false)
    expect(view.collected.queue?.stats).toEqual([{ label: 'Queue', value: '1 / 2' }])
    expect(scripted.local.some(call => String(call.options.input).includes('queue'))).toBe(false)
    expect(scripted.local.some(call => String(call.options.input).includes('broken'))).toBe(true)
    vi.setSystemTime(new Date('2026-09-24T12:01:10Z'))
    scripted.answer = (_where, args, options) => isProbe(args) ? ok(probe()) : String(options.input).includes('queue') ? { code: 2, stdout: '', stderr: 'gone' } : ok('{}')
    await b.refresh(p, signal)
    view = await b.view(p, false)
    expect(view.collected.queue).toMatchObject({ stats: [{ label: 'Queue', value: '1 / 2' }], alerts: [{ level: 'info', text: 'hi' }], error: expect.stringMatching(/gone/) as unknown })
    expect(view.collected.broken?.error).toBeUndefined()
  })

  it('runs a collector with the platform Python when the project has no environment, and says when there is none', async () => {
    const p = await project()
    await write(join(p.root, 'c.py'), 'print(1)')
    await write(join(p.root, board.BOARD_FILE), JSON.stringify({ sections: [], collectors: [{ id: 'c', script: 'c.py' }] }))
    scripted.answer = () => ok('{"stats": [{"label": "n", "value": 1}]}')
    expect((await boards().boards.refresh(p, signal)).collectors).toEqual([{ id: 'c', ok: true, sections: 0, stats: 1, ms: expect.any(Number) as unknown }])
    expect(scripted.local[0]?.command).toBe('platform-python')
    const without = await boards({ localPython: undefined }).boards.refresh(p, signal)
    expect(without.collectors[0]?.error).toMatch(/No Python to run the collector/)
    // After a restart the saved output shows at once, and the collector runs on the first read.
    scripted.local.length = 0
    const restarted = boards()
    expect((await restarted.boards.view(p, true)).collected.c?.error).toMatch(/No Python/)
    await Promise.all(restarted.tracked)
    expect(scripted.local.map(call => call.command)).toEqual(['platform-python'])
  })

  it('reads in the background at most every ten seconds, shares a read under way, and restores the last read after a restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'))
    const p = await project()
    p.environments.push(environment('here', { isDefault: true }))
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    scripted.answer = async () => { await held; return ok(probe()) }
    const { boards: b, tracked: operations } = boards()
    const first = await b.view(p, true)
    expect(first).toMatchObject({
      refreshing: true, machines: [], series: {}, collected: {}, alerts: [], spec: { sections: [], collectors: [] },
    })
    expect((await b.view(p, true)).refreshing).toBe(true)
    expect(operations).toHaveLength(1)
    const forced = b.refresh(p, signal)
    release()
    await Promise.all(operations)
    expect((await forced).machines).toEqual([{ key: 'local', gpus: 1 }])
    expect(scripted.local.filter(call => isProbe(call.args))).toHaveLength(2)
    expect((await b.view(p, true)).refreshing).toBe(false)
    expect(operations).toHaveLength(1)
    vi.setSystemTime(new Date('2026-09-24T12:00:11Z'))
    await b.view(p, true)
    expect(operations).toHaveLength(2)
    await Promise.all(operations)
    const saved = JSON.parse(await readFile(join(p.root, '.research/board/snapshot.json'), 'utf8')) as { machines: unknown[] }
    expect(saved.machines).toHaveLength(1)
    const restarted = boards().boards
    expect((await restarted.view(p, false)).machines).toEqual(saved.machines)
    await write(join(p.root, '.research/board/snapshot.json'), '{"machines": 1}')
    expect((await boards().boards.view(p, false)).machines).toEqual([])
    await write(join(p.root, '.research/board/snapshot.json'), 'garbled')
    expect((await boards().boards.view(p, false)).machines).toEqual([])
  })

  it('warns about a background read that fails, and a cancelled read stops at its collector', async () => {
    const p = await project()
    await write(join(p.root, 'c.py'), 'print(1)')
    await write(join(p.root, board.BOARD_FILE), JSON.stringify({ sections: [], collectors: [{ id: 'c', script: 'c.py' }] }))
    await write(join(p.root, '.research/board/snapshot.json/blocked'), 'a directory where the snapshot goes')
    const { boards: b, warnings, tracked: operations } = boards()
    await b.view(p, true)
    // A read asked for while a failing one is under way still runs.
    await expect(b.refresh(p, signal)).rejects.toThrow()
    await Promise.all(operations)
    expect(warnings).toEqual([expect.stringMatching(new RegExp(`^research board read for ${p.id}: `)) as unknown])
    const cancel = new AbortController()
    scripted.answer = () => { cancel.abort(); throw new Error('killed') }
    await expect(boards().boards.refresh(p, cancel.signal)).rejects.toThrow()
  })
})
