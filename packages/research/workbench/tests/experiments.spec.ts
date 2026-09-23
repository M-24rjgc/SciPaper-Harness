import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ProcessResult } from '../src/process.ts'
import type { ArtifactId, EnvironmentId, EnvironmentRecord, EvidenceId, EvidenceRecord, ExperimentSpec, ResearchProject } from '../src/types.ts'

/** Every local process and SSH call, answered by the current script. */
const scripted = vi.hoisted(() => ({
  local: [] as { command: string; args: string[] }[],
  remote: [] as { host: string; args: string[]; input?: unknown }[],
  answer: (_where: 'local' | 'ssh', _args: string[]): ProcessResult => ({ code: 0, stdout: '', stderr: '' }),
}))
vi.mock('../src/process.ts', async (original) => {
  const actual = await original<typeof import('../src/process.ts')>()
  return {
    ...actual,
    runProcess: async (command: string, args: readonly string[]): Promise<ProcessResult> => {
      scripted.local.push({ command, args: [...args] })
      return scripted.answer('local', [...args])
    },
    ssh: async (host: string, args: readonly string[], options: { input?: unknown } = {}): Promise<ProcessResult> => {
      scripted.remote.push({ host, args: [...args], input: options.input })
      return scripted.answer('ssh', [...args])
    },
  }
})

const { adoptRunCode, collectRunOutputs, experimentLogs, launchExperiment, newExperiment, observationDue, observeExperiment, validateExperiment } = await import('../src/experiments.ts')
const { newProject } = await import('../src/project.ts')
const { hashBytes } = await import('../src/files.ts')
const { writeArtifact } = await import('../src/artifacts.ts')
const { createEnvironment, inspectEnvironment } = await import('../src/environments.ts')

const DETAILS = '{"executable":"/usr/bin/python3","packages":[]}'
const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: '' })
const signal = new AbortController().signal
const roots: string[] = []
afterEach(async () => {
  scripted.local.length = 0
  scripted.remote.length = 0
  scripted.answer = () => ok('')
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function project(): Promise<ResearchProject> {
  const root = await mkdtemp(join(tmpdir(), 'research-runs-'))
  roots.push(root)
  return newProject({ root, title: 'Runs', brief: '' }, 'w' as WorkspaceId)
}
async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
function environment(target: 'local' | 'ssh', extra: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id: `env-${target}` as EnvironmentId, name: target, kind: 'existing', target, python: target === 'ssh' ? '/usr/bin/python3' : 'python',
    requirements: [], isDefault: true, fingerprint: hashBytes(DETAILS), status: 'ready', details: DETAILS,
    ...(target === 'ssh' ? { sshHost: 'gpu-box', remoteRoot: '/data/research' } : {}),
    ...extra,
  }
}
function spec(environmentId: EnvironmentId, extra: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    environmentId, name: 'train', argv: ['{python}', 'code/train.py'], cwd: '.', seed: 1, maxSeconds: 60,
    gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json', ...extra,
  }
}
/** Answer interpreter inspection with the recorded details and runner calls with the given states. */
function runner(states: Record<string, string>): (where: 'local' | 'ssh', args: string[]) => ProcessResult {
  return (_where, args) => {
    if (args.some(arg => arg.includes('importlib.metadata'))) return ok(DETAILS)
    const action = args.find(arg => ['launch', 'status', 'cancel'].includes(arg))
    if (action && args.some(arg => arg.endsWith('experiment_runner.py'))) return ok(states[action] ?? '{"status":"running"}')
    return ok('')
  }
}

describe('experiment environments are created in the project or bound, never modified', () => {
  const request = (extra: Record<string, unknown>) => ({ name: 'env', kind: 'uv', target: 'local', python: '', requirements: [], isDefault: false, ...extra }) as never
  const components = { root: join(tmpdir(), 'research-components'), uv: async () => 'uv', venvPython: (directory: string) => join(directory, 'bin/python') } as never

  it('creates a managed uv environment locally or over SSH and snapshots its interpreter', async () => {
    const p = await project()
    scripted.answer = (_where, args) => args.some(arg => arg.includes('importlib.metadata'))
      ? ok('{"executable":"/managed/python"}')
      : ok(args[0] === 'pip' && args[1] === 'freeze' ? 'numpy==2.0' : '')
    const local = await createEnvironment(p, request({ requirements: ['numpy'] }), components, signal)
    expect(local).toMatchObject({ python: '/managed/python', status: 'ready' })
    expect(await readFile(join(p.root, `.research/environments/${local.id}.requirements.lock`), 'utf8')).toBe('numpy==2.0\n')
    expect(scripted.local.map(call => call.args[0])).toEqual(expect.arrayContaining(['venv', 'pip']))
    const plain = await createEnvironment(p, request({ python: '3.11' }), components, signal)
    expect(scripted.local.some(call => call.args.includes('3.11'))).toBe(true)
    expect(plain.status).toBe('ready')

    const remote = await createEnvironment(p, request({ target: 'ssh', sshHost: 'gpu', remoteRoot: '/data/research/', requirements: ['torch'] }), components, signal)
    expect(remote.python).toBe(`/data/research/environments/${remote.id}/bin/python`)
    expect(scripted.remote.map(call => call.args.slice(0, 2).join(' '))).toEqual(expect.arrayContaining(['uv venv', 'uv pip']))
    const bare = await createEnvironment(p, request({ target: 'ssh', sshHost: 'gpu', remoteRoot: '/data/research' }), components, signal)
    expect(bare.python).toBe(`/data/research/environments/${bare.id}/bin/python`)
  })

  it('binds an existing interpreter by inspecting it, and refuses what it cannot bind safely', async () => {
    const p = await project()
    scripted.answer = () => ok('{"executable":"/usr/bin/python3"}')
    expect((await createEnvironment(p, request({ kind: 'existing', target: 'ssh', sshHost: 'gpu', remoteRoot: '/data/research', python: '/usr/bin/python3' }), components, signal)).details)
      .toBe('{"executable":"/usr/bin/python3"}')
    expect((await createEnvironment(p, request({ kind: 'existing', python: 'C:/py/python.exe' }), components, signal)).python).toBe('/usr/bin/python3')
    await expect(createEnvironment(p, request({ requirements: ['--index-url=http://evil'] }), components, signal)).rejects.toThrow(/one package requirement/)
    await expect(createEnvironment(p, request({ requirements: [' '] }), components, signal)).rejects.toThrow(/one package requirement/)
    await expect(createEnvironment(p, request({ requirements: ['a\nb'] }), components, signal)).rejects.toThrow(/one package requirement/)
    await expect(createEnvironment(p, request({ target: 'ssh', remoteRoot: '/data' }), components, signal)).rejects.toThrow(/SSH host/)
    await expect(createEnvironment(p, request({ target: 'ssh', sshHost: 'gpu', remoteRoot: 'relative' }), components, signal)).rejects.toThrow(/absolute dedicated remote directory/)
    await expect(createEnvironment(p, request({ kind: 'existing', target: 'ssh', sshHost: 'gpu', remoteRoot: '/data', python: 'python3' }), components, signal)).rejects.toThrow(/absolute path/)
    await expect(createEnvironment(p, request({ kind: 'existing' }), components, signal)).rejects.toThrow(/Choose an existing Python interpreter/)
    await expect(inspectEnvironment(environment('ssh', { sshHost: undefined }), signal)).rejects.toThrow(/SSH host/)
  })
})

describe('experiment runs are described precisely and never guessed', () => {
  it('validates only the shape of a run', async () => {
    const p = await project()
    const local = environment('local')
    p.environments.push(local, environment('ssh', { id: 'env-pending' as EnvironmentId, status: 'pending' }))
    expect(() => validateExperiment(p, spec(local.id, { argv: ['python', 'x.py'] }))).toThrow(/Start argv/)
    expect(() => validateExperiment(p, spec('nope' as EnvironmentId))).toThrow(/ready experiment environment/)
    expect(() => validateExperiment(p, spec('env-pending' as EnvironmentId))).toThrow(/ready experiment environment/)
    expect(() => validateExperiment(p, spec(local.id, { dataEvidenceIds: ['ghost' as EvidenceId] }))).toThrow(/Unknown dataset evidence/)
    expect(() => validateExperiment(p, spec(local.id, { codeArtifactIds: ['ghost' as ArtifactId] }))).toThrow(/Unknown code artifact/)
    expect(() => validateExperiment(p, spec(local.id, { cwd: '..' }))).toThrow(/stay inside the project/)
    expect(() => validateExperiment(p, spec(local.id, { codePaths: ['../elsewhere'] }))).toThrow(/stay inside the project/)
    expect(validateExperiment(p, spec(local.id, { cwd: '' }))).toBe(local)
  })

  it('launches locally from snapshotted code and data, mapping data paths into the run', async () => {
    const p = await project()
    const local = environment('local')
    p.environments.push(local)
    await write(join(p.root, 'code/train.py'), 'print(1)')
    await write(join(p.root, 'code/__pycache__/train.pyc'), 'cache')
    await write(join(p.root, 'code/.hidden'), 'x')
    const code = await writeArtifact(p, { action: 'register-artifact', projectId: p.id, path: 'code/train.py', kind: 'code', evidence: [], claimIds: [], inputArtifacts: [] }, 'agent', 10000)
    const inside: EvidenceRecord = {
      id: 'inside' as EvidenceId, title: 'results.csv', kind: 'file', path: '.research/sources/inside/1.csv', originalPath: join(p.root, 'data/results.csv'),
      sha256: hashBytes('a,b\n1,2\n'), revision: 1, importedAt: '', chunks: [], coverage: 'data', verified: true, stale: false,
    }
    const outside: EvidenceRecord = { ...inside, id: 'outside' as EvidenceId, path: '.research/sources/outside/1.csv', originalPath: join(tmpdir(), 'elsewhere.csv') }
    const anchorless: EvidenceRecord = { ...inside, id: 'anchorless' as EvidenceId, path: '.research/sources/anchorless/1.csv', originalPath: undefined }
    for (const source of [inside, outside, anchorless]) await write(join(p.root, source.path), 'a,b\n1,2\n')
    p.evidence.push(inside, outside, anchorless)
    scripted.answer = runner({ launch: '{"status":"running","startedAt":1700000000,"exitCode":0}' })
    const run = newExperiment(p, spec(local.id, {
      argv: ['{python}', 'code/train.py', '--data', join(p.root, 'data/results.csv')], cwd: 'code',
      dataEvidenceIds: [inside.id, outside.id, anchorless.id], codeArtifactIds: [code.id],
    }), 'run-1')
    const launched = await launchExperiment(p, run, signal)
    expect(launched).toMatchObject({ status: 'running', startedAt: new Date(1700000000 * 1000).toISOString(), exitCode: 0, observeFailures: 0 })
    const directory = join(p.root, '.research/runs/run-1')
    const inputs = JSON.parse(await readFile(join(directory, 'inputs.json'), 'utf8')) as { inputs: { path: string; id?: string }[] }
    expect(inputs.inputs.map(input => input.path).sort()).toEqual(['code/train.py', 'data/anchorless/1.csv', 'data/outside/1.csv', 'data/results.csv'])
    const submitted = JSON.parse(await readFile(join(directory, 'spec.json'), 'utf8')) as { argv: string[]; cwd: string }
    expect(submitted.argv.at(-1)).toBe(`${join(directory, 'work')}/data/results.csv`)
    expect(submitted.cwd).toBe(join(directory, 'work', 'code'))

    // The recorded snapshots are the contract: a changed dataset or interpreter stops the launch.
    await writeFile(join(p.root, inside.path), 'tampered')
    await expect(launchExperiment(p, newExperiment(p, spec(local.id, { dataEvidenceIds: [inside.id] }), 'run-2'), signal)).rejects.toThrow(/dataset snapshot was changed/)
    const changed = { ...local, id: 'changed' as EnvironmentId, fingerprint: 'other' }
    p.environments.push(changed)
    await expect(launchExperiment(p, newExperiment(p, spec(changed.id), 'run-3'), signal)).rejects.toThrow(/environment changed/)
    const orphan = newExperiment(p, spec(local.id, { codeArtifactIds: [code.id], dataEvidenceIds: [outside.id] }), 'run-4')
    await expect(launchExperiment({ ...p, artifacts: [] }, orphan, signal)).rejects.toThrow(/code is missing/)
    const dataOnly = { ...orphan, spec: { ...orphan.spec, codeArtifactIds: [] } }
    await expect(launchExperiment({ ...p, evidence: [] }, dataOnly, signal)).rejects.toThrow(/dataset is missing/)
    await expect(launchExperiment({ ...p, environments: [] }, orphan, signal)).rejects.toThrow(/environment is missing/)
  })

  it('adopts edits to the run code and refuses an oversized snapshot', async () => {
    const p = await project()
    const local = environment('local')
    p.environments.push(local)
    await write(join(p.root, 'code/train.py'), 'v1')
    const code = await writeArtifact(p, { action: 'register-artifact', projectId: p.id, path: 'code/train.py', kind: 'code', evidence: [], claimIds: [], inputArtifacts: [] }, 'agent', 10000)
    await writeFile(join(p.root, 'code/train.py'), 'v2')
    const run = newExperiment(p, spec(local.id, { codeArtifactIds: [code.id] }), 'run-adopt')
    await adoptRunCode(p, run)
    expect(p.artifacts.find(a => a.id === code.id)?.revision).toBe(2)
    await Promise.all(Array.from({ length: 2001 }, (_, index) => write(join(p.root, 'many', `${index}.py`), '')))
    scripted.answer = runner({})
    await expect(launchExperiment(p, newExperiment(p, spec(local.id, { codePaths: ['many'] }), 'run-big'), signal)).rejects.toThrow(/too large/)
  })

  it('runs from the project root with no code directory, and skips code paths that do not exist', async () => {
    const p = await project()
    const local = environment('local')
    p.environments.push(local)
    scripted.answer = runner({})
    expect((await launchExperiment(p, newExperiment(p, spec(local.id, { cwd: '' }), 'bare'), signal)).status).toBe('running')
    const bare = JSON.parse(await readFile(join(p.root, '.research/runs/bare/inputs.json'), 'utf8')) as { inputs: unknown[]; cwd: string }
    expect(bare.inputs).toEqual([])
    expect(bare.cwd).toBe(join(p.root, '.research/runs/bare/work'))
    await write(join(p.root, 'scripts/run.py'), 'print(1)')
    await launchExperiment(p, newExperiment(p, spec(local.id, { codePaths: ['missing', 'scripts'] }), 'partial'), signal)
    const partial = JSON.parse(await readFile(join(p.root, '.research/runs/partial/inputs.json'), 'utf8')) as { inputs: { path: string }[] }
    expect(partial.inputs.map(input => input.path)).toEqual(['scripts/run.py'])
  })

  it('launches over SSH into a dedicated remote directory, and refuses shared roots', async () => {
    const p = await project()
    const remote = environment('ssh')
    p.environments.push(remote, environment('ssh', { id: 'shallow' as EnvironmentId, remoteRoot: '/data' }), environment('ssh', { id: 'rootless' as EnvironmentId, remoteRoot: undefined }))
    await write(join(p.root, 'code/train.py'), 'print(1)')
    scripted.answer = runner({ launch: '{"status":"queued"}' })
    const run = newExperiment(p, spec(remote.id), 'remote-1')
    expect(run.directory).toBe('/data/research/runs/remote-1')
    const launched = await launchExperiment(p, run, signal)
    expect(launched.status).toBe('queued')
    const transfer = scripted.remote.find(call => call.args.some(arg => arg.includes('zipfile')))!
    expect(Object.keys(unzipSync(transfer.input as Uint8Array))).toEqual(expect.arrayContaining(['work/code/train.py', 'spec.json', 'inputs.json', 'experiment_runner.py']))
    expect(scripted.remote.every(call => call.host === 'gpu-box')).toBe(true)
    await expect(launchExperiment(p, newExperiment(p, spec('shallow' as EnvironmentId), 'remote-2'), signal)).rejects.toThrow(/dedicated remote research directory/)
    expect(() => newExperiment(p, spec('rootless' as EnvironmentId), 'remote-3')).toThrow(/dedicated remote directory/)
  })

  it('observes and cancels runs, pulls remote results, and backs off an unreachable host', async () => {
    const p = await project()
    const remote = environment('ssh')
    const hostless = environment('ssh', { id: 'hostless' as EnvironmentId, sshHost: undefined })
    p.environments.push(remote, hostless, environment('local'))
    const run = newExperiment(p, spec(remote.id), 'observe-1')
    scripted.answer = (_where, args) => {
      if (args.some(arg => arg.endsWith('experiment_runner.py'))) return ok('{"status":"completed","metrics":{"acc":0.9},"finishedAt":1700000100}')
      return ok(args.at(-1)?.endsWith('metrics.json') ? '{"acc":0.9}' : 'log')
    }
    const done = await observeExperiment(p, run, 'status', signal)
    expect(done).toMatchObject({ status: 'completed', metrics: { acc: 0.9 }, finishedAt: new Date(1700000100 * 1000).toISOString() })
    expect(await readFile(join(p.root, '.research/runs/observe-1/metrics.json'), 'utf8')).toBe('{"acc":0.9}')
    scripted.answer = runner({ cancel: '{"status":"cancelled"}' })
    expect((await observeExperiment(p, run, 'cancel', signal)).status).toBe('cancelled')
    const local = newExperiment(p, spec('env-local' as EnvironmentId), 'observe-local')
    scripted.answer = runner({ status: '{"status":"running"}' })
    expect((await observeExperiment(p, local, 'status', signal)).metrics).toEqual({})

    scripted.answer = () => ({ code: 255, stdout: '', stderr: 'Connection refused' })
    const lost = await observeExperiment(p, run, 'status', signal)
    expect(lost).toMatchObject({ status: 'unknown', observeFailures: 1 })
    expect(observationDue(lost, Date.now())).toBe(false)
    expect(observationDue(lost, Date.now() + 3 * 60 * 1000)).toBe(true)
    expect((await observeExperiment(p, lost, 'status', signal)).observeFailures).toBe(2)
    expect((await observeExperiment(p, { ...run, spec: { ...run.spec, environmentId: hostless.id } }, 'status', signal)).message).toMatch(/SSH host/)
    const aborted = new AbortController()
    aborted.abort()
    await expect(observeExperiment(p, run, 'status', aborted.signal)).rejects.toThrow()
    await expect(observeExperiment({ ...p, environments: [] }, run, 'status', signal)).rejects.toThrow(/environment is missing/)
  })

  it('turns local and remote outputs into data evidence and reads logs', async () => {
    const p = await project()
    const remote = environment('ssh')
    const local = environment('local')
    p.environments.push(remote, local)
    const localRun = { ...newExperiment(p, spec(local.id), 'out-local'), inputRevision: 0 }
    const outputs = join(localRun.directory, 'outputs')
    await write(join(outputs, 'table.csv'), Array.from({ length: 50 }, (_, index) => `row,${index}`).join('\n'))
    await write(join(outputs, 'plot.png'), 'png')
    await write(join(outputs, 'sub/result.json'), '{"acc":0.9}')
    await write(join(outputs, '.hidden'), 'x')
    await write(join(outputs, 'huge.txt'), 'x'.repeat(2000))
    // A link the run left in outputs/ is neither a file nor a directory to the walk.
    const elsewhere = await mkdtemp(join(tmpdir(), 'research-outputs-link-'))
    roots.push(elsewhere)
    await symlink(elsewhere, join(outputs, 'linked'), 'junction')
    const records = await collectRunOutputs(p, localRun, 1000, signal)
    expect(records.map(record => record.path.split('/outputs/')[1]).sort()).toEqual(['plot.png', 'sub/result.json', 'table.csv'])
    expect(records.find(record => record.path.endsWith('table.csv'))?.chunks.map(chunk => chunk.locator.line)).toEqual([1, 41])
    expect(records.find(record => record.path.endsWith('plot.png'))?.chunks[0]?.text).toMatch(/Run output plot.png/)
    expect(records.every(record => record.stale && record.coverage === 'data')).toBe(true)
    expect(await collectRunOutputs(p, newExperiment(p, spec(local.id), 'no-outputs'), 1000, signal)).toEqual([])

    const remoteRun = newExperiment(p, spec(remote.id), 'out-remote')
    scripted.answer = (_where, args) => args.some(arg => arg.includes('rglob'))
      ? ok(JSON.stringify([{ n: 'metrics.csv', s: 8 }, { n: 'weights.bin', s: 10 ** 9 }]))
      : ok(Buffer.from('acc\n0.9\n').toString('base64'))
    const pulled = await collectRunOutputs(p, remoteRun, 1000, signal)
    expect(pulled.map(record => record.path)).toEqual(['.research/runs/out-remote/outputs/metrics.csv'])
    expect(await readFile(join(p.root, '.research/runs/out-remote/outputs/metrics.csv'), 'utf8')).toBe('acc\n0.9\n')

    scripted.answer = () => ok('stdout.log: done')
    expect(await experimentLogs(p, localRun, signal)).toBe('stdout.log: done')
    expect(await experimentLogs(p, remoteRun, signal)).toBe('stdout.log: done')
    expect(scripted.remote.at(-1)?.host).toBe('gpu-box')
    await expect(experimentLogs({ ...p, environments: [] }, localRun, signal)).rejects.toThrow(/environment is missing/)
  })
})
