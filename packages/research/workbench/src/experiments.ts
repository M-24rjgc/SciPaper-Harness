/** Independent local and SSH experiment submission with immutable input snapshots. */
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'
import { z } from 'zod'
import { adoptExternalEdit } from './artifacts.ts'
import { runtimeAsset } from './components.ts'
import { atomicWrite, hashBytes, hashFile, projectPath, readText } from './files.ts'
import { inspectEnvironment } from './environments.ts'
import { checked, runProcess, ssh } from './process.ts'
import type { EnvironmentRecord, EvidenceId, EvidenceRecord, ExperimentId, ExperimentRecord, ExperimentSpec, ResearchProject } from './types.ts'

const stateSchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown']),
  message: z.string().optional(),
  metrics: z.record(z.string(), z.number()).optional(),
  exitCode: z.number().int().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  progress: z.object({
    values: z.record(z.string(), z.number()),
    fraction: z.number().min(0).max(1).optional(),
    note: z.string().optional(),
    at: z.number(),
  }).optional(),
})
const MS_PER_SECOND = 1000
const MINUTES_PER_HOUR = 60
const MAX_OBSERVE_BACKOFF_MINUTES = 30

/**
 * Fold one supervisor report into the durable record. The supervisor times in
 * epoch seconds and the record keeps ISO strings, so the two clocks are
 * converted here rather than spread across the caller.
 */
function applyState(run: ExperimentRecord, state: z.infer<typeof stateSchema>, metrics: Record<string, number>): ExperimentRecord {
  const { progress } = state
  return {
    ...run,
    ...(progress === undefined ? {} : { progress: { ...progress, at: new Date(progress.at * MS_PER_SECOND).toISOString() } }),
    status: state.status,
    ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    ...(state.startedAt === undefined ? {} : { startedAt: new Date(state.startedAt * MS_PER_SECOND).toISOString() }),
    ...(state.finishedAt === undefined ? {} : { finishedAt: new Date(state.finishedAt * MS_PER_SECOND).toISOString() }),
    metrics,
    message: state.message ?? '',
    updatedAt: new Date().toISOString(),
    observeFailures: 0,
    nextObserveAt: undefined,
  }
}

/** The remote bundle extractor refuses absolute paths and parent traversal before writing. */
const remoteInstall = 'import sys,zipfile,io,pathlib,os; root=pathlib.Path(sys.argv[1]); root.mkdir(parents=True,exist_ok=True);'
  + ' archive=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); names=archive.namelist();'
  + " assert all(not pathlib.PurePosixPath(n).is_absolute() and '..' not in pathlib.PurePosixPath(n).parts for n in names);"
  + ' archive.extractall(root)'

/** Directory names never copied into a run snapshot. */
const SNAPSHOT_SKIPPED = new Set(['__pycache__', '.git', '.venv', 'venv', 'node_modules', '.ipynb_checkpoints', '.research'])
const MAX_SNAPSHOT_FILES = 2000
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024

/**
 * Validate that a run can be described precisely. This is shape validation
 * only: whether and how much to run is the agent's and the user's judgement,
 * not the program's.
 */
export function validateExperiment(project: ResearchProject, spec: ExperimentSpec): EnvironmentRecord {
  if (spec.argv[0] !== '{python}') {
    throw new Error('Start argv with "{python}" so the run uses the selected environment, e.g. ["{python}", "code/train.py"]')
  }
  const environment = project.environments.find(e => e.id === spec.environmentId)
  if (!environment || environment.status !== 'ready') throw new Error('Choose a ready experiment environment (research_environment)')
  for (const id of spec.dataEvidenceIds) {
    if (!project.evidence.some(e => e.id === id && e.coverage === 'data')) throw new Error(`Unknown dataset evidence: ${id}`)
  }
  for (const id of spec.codeArtifactIds) {
    if (!project.artifacts.some(a => a.id === id)) throw new Error(`Unknown code artifact: ${id}`)
  }
  for (const path of [spec.cwd || '.', spec.metricsPath, ...spec.codePaths ?? []]) {
    const rel = relative(project.root, resolve(project.root, path))
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Run paths stay inside the project: ${path}`)
  }
  return environment
}

/** Every file under the given project paths, skipping caches, environments and hidden entries. */
async function snapshotFiles(project: ResearchProject, paths: string[]): Promise<string[]> {
  const files: string[] = []
  let bytes = 0
  const visit = async (absolute: string): Promise<void> => {
    const info = await stat(absolute)
    if (info.isFile()) {
      files.push(relative(project.root, absolute).replaceAll('\\', '/'))
      bytes += info.size
      if (files.length > MAX_SNAPSHOT_FILES || bytes > MAX_SNAPSHOT_BYTES) {
        throw new Error('The code to snapshot is too large; pass codePaths naming only what the run needs, and keep datasets as data evidence')
      }
      return
    }
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SNAPSHOT_SKIPPED.has(entry.name) || entry.name.endsWith('.pyc')) continue
      await visit(join(absolute, entry.name))
    }
  }
  for (const path of paths) {
    const absolute = await projectPath(project.root, path)
    if (existsSync(absolute)) await visit(absolute)
  }
  return [...new Set(files)]
}

/** Prepare a durable run before any launch can cross a transport boundary. */
export function newExperiment(project: ResearchProject, spec: ExperimentSpec, requestId: string): ExperimentRecord {
  const environment = validateExperiment(project, spec)
  const id = requestId as ExperimentId
  const now = new Date().toISOString()
  const directory = environment.target === 'ssh'
    ? `${remoteRootOf(environment).replace(/\/$/, '')}/runs/${id}`
    : join(project.root, '.research', 'runs', id)
  return {
    id, spec, status: 'queued', createdAt: now, updatedAt: now, directory,
    inputRevision: project.researchRevision, environmentFingerprint: environment.fingerprint,
    metrics: {}, message: 'Preparing immutable inputs', snapshotPath: `.research/runs/${id}/inputs.json`, collected: false,
  }
}

function remoteRootOf(environment: EnvironmentRecord): string {
  const root = environment.remoteRoot
  if (!root) throw new Error('A remote experiment environment needs a dedicated remote directory')
  return root
}

function sshHostOf(environment: EnvironmentRecord): string {
  const host = environment.sshHost
  if (!host) throw new Error('A remote experiment environment needs an SSH host')
  return host
}

/**
 * Record edits made outside the research tools to the run's registered code,
 * so its input snapshot names the revisions it actually ran.
 */
export async function adoptRunCode(project: ResearchProject, run: ExperimentRecord): Promise<void> {
  for (const artifact of project.artifacts.filter(a => run.spec.codeArtifactIds.includes(a.id))) await adoptExternalEdit(project, artifact)
}

/**
 * Copy selected code/data, snapshot the interpreter, and submit exactly one
 * supervisor. Reads the project without changing it; adopt the run's code
 * edits first with {@link adoptRunCode}.
 */
export async function launchExperiment(project: ResearchProject, run: ExperimentRecord, signal: AbortSignal): Promise<ExperimentRecord> {
  const environment = project.environments.find(e => e.id === run.spec.environmentId)
  if (!environment) throw new Error('Experiment environment is missing')
  const directory = await projectPath(project.root, `.research/runs/${run.id}`)
  const work = join(directory, 'work')
  await mkdir(work, { recursive: true })
  const environmentDetails = await inspectEnvironment(environment, signal)
  if (hashBytes(environmentDetails) !== run.environmentFingerprint) {
    throw new Error('The selected environment changed; bind or rebuild it before running this experiment')
  }
  const bundle: Record<string, Uint8Array> = {}
  const inputs: Array<{ id?: string; path: string; sha256: string; revision?: number }> = []
  const argumentMap = new Map<string, string>()
  const selected: string[] = []
  for (const id of run.spec.codeArtifactIds) {
    const artifact = project.artifacts.find(a => a.id === id)
    if (!artifact) throw new Error(`Experiment code is missing: ${id}`)
    selected.push(artifact.path)
  }
  const codePaths = run.spec.codePaths ?? (existsSync(join(project.root, 'code')) ? ['code'] : [])
  for (const path of await snapshotFiles(project, [...selected, ...codePaths])) {
    const source = await projectPath(project.root, path)
    const content = await readFile(source)
    const target = join(work, path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    bundle[`work/${path}`] = content
    const artifact = project.artifacts.find(a => a.path === path)
    inputs.push({ ...(artifact ? { id: artifact.id, revision: artifact.revision } : {}), path, sha256: hashBytes(content) })
    argumentMap.set(source, path)
  }
  for (const id of run.spec.dataEvidenceIds) {
    const evidence = project.evidence.find(e => e.id === id)
    if (!evidence) throw new Error(`Experiment dataset is missing: ${id}`)
    const source = await projectPath(project.root, evidence.path)
    if (await hashFile(source) !== evidence.sha256) throw new Error('An immutable dataset snapshot was changed')
    const originalRelative = evidence.originalPath ? relative(project.root, evidence.originalPath).replaceAll('\\', '/') : ''
    const destination = originalRelative && !originalRelative.startsWith('../') && !isAbsolute(originalRelative) && !originalRelative.startsWith('.research/')
      ? originalRelative
      : `data/${id}/${basename(evidence.path)}`
    const target = join(work, destination)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    bundle[`work/${destination}`] = await readFile(source)
    inputs.push({ id, path: destination, sha256: evidence.sha256, revision: evidence.revision })
    if (evidence.originalPath) argumentMap.set(evidence.originalPath, destination)
  }
  const requestedCwd = await projectPath(project.root, run.spec.cwd || '.')
  const relativeCwd = relative(project.root, requestedCwd).replaceAll('\\', '/')
  const localCwd = join(work, relativeCwd)
  await mkdir(localCwd, { recursive: true })
  const remote = environment.target === 'ssh'
  const targetWork = remote ? `${run.directory}/work` : work
  const argv = run.spec.argv.map((value) => {
    const mapped = argumentMap.get(value)
    return mapped !== undefined ? `${targetWork}/${mapped}` : value
  })
  const spec = { ...run.spec, argv, python: environment.python, cwd: remote ? `${targetWork}/${relativeCwd}` : localCwd }
  // The run's own record of what it is: kept beside the snapshot locally, and shipped with it to a remote host.
  const record: Record<string, Uint8Array> = {
    'spec.json': strToU8(JSON.stringify(spec)),
    'inputs.json': strToU8(JSON.stringify({
      inputs, researchRevision: run.inputRevision, code: run.spec.codeArtifactIds, seed: run.spec.seed, argv, cwd: spec.cwd,
    }, null, 2)),
    'environment.json': strToU8(environmentDetails),
    'experiment_runner.py': await readFile(runtimeAsset('experiment_runner.py')),
  }
  Object.assign(bundle, record)
  for (const [name, content] of Object.entries(record)) await atomicWrite(join(directory, name), content)
  let output: string
  if (remote) {
    const root = remoteRootOf(environment)
    const shallow = root.split('/').filter(Boolean).length < 2
    if (shallow || ['/', '/root', '/home', '/tmp'].includes(root)) {
      throw new Error('Choose a dedicated remote research directory, not a shared system or home root')
    }
    checked(await ssh(sshHostOf(environment), [environment.python, '-c', remoteInstall, run.directory], { signal, input: zipSync(bundle), timeoutMs: 600000 }), 'Remote input transfer')
    output = checked(
      await ssh(sshHostOf(environment), [environment.python, `${run.directory}/experiment_runner.py`, 'launch', run.directory], { signal }),
      'Remote experiment submission',
    )
  } else {
    output = checked(
      await runProcess(environment.python, [join(directory, 'experiment_runner.py'), 'launch', directory], { signal }),
      'Local experiment submission',
    )
  }
  const state = stateSchema.parse(JSON.parse(output))
  return applyState(run, state, state.metrics ?? {})
}

/**
 * Query or cancel an existing supervisor; transport failure never relaunches it.
 * Repeated failures back off exponentially so a dead remote does not occupy
 * every poll interval, and any successful read resets the backoff.
 */
export async function observeExperiment(
  project: ResearchProject,
  run: ExperimentRecord,
  action: 'status' | 'cancel',
  signal: AbortSignal,
): Promise<ExperimentRecord> {
  const environment = project.environments.find(e => e.id === run.spec.environmentId)
  if (!environment) throw new Error('Experiment environment is missing')
  try {
    const result = environment.target === 'ssh'
      ? await ssh(sshHostOf(environment), [environment.python, `${run.directory}/experiment_runner.py`, action, run.directory], { signal })
      : await runProcess(environment.python, [`${run.directory}/experiment_runner.py`, action, run.directory], { signal })
    const state = stateSchema.parse(JSON.parse(checked(result, 'Experiment observation')))
    const updated = applyState(run, state, state.metrics ?? run.metrics)
    if (environment.target === 'ssh' && ['completed', 'failed', 'cancelled', 'interrupted'].includes(updated.status)) {
      const local = await projectPath(project.root, `.research/runs/${run.id}`)
      // The progress lines come along too, so the board draws a finished remote run's curves without the host.
      for (const name of ['metrics.json', 'stdout.log', 'stderr.log', 'state.json', 'progress.jsonl']) {
        const empty = name.endsWith('.jsonl') ? 'b""' : 'b"{}"'
        const code = `import pathlib,sys; p=pathlib.Path(sys.argv[1]); sys.stdout.buffer.write(p.read_bytes()[-8388608:] if p.exists() else ${empty})`
        const content = checked(
          await ssh(sshHostOf(environment), [environment.python, '-c', code, `${run.directory}/${name}`], { signal, maxBytes: 9 * 1024 * 1024 }),
          'Remote result collection',
        )
        await atomicWrite(join(local, name), content)
      }
    }
    return updated
  } catch (error) {
    if (signal.aborted) throw error
    const failures = (run.observeFailures ?? 0) + 1
    const backoffMinutes = Math.min(2 ** failures, MAX_OBSERVE_BACKOFF_MINUTES)
    return {
      ...run,
      status: 'unknown',
      message: `Execution state has not been confirmed: ${String(error)}`,
      updatedAt: new Date().toISOString(),
      observeFailures: failures,
      nextObserveAt: Date.now() + backoffMinutes * MINUTES_PER_HOUR * MS_PER_SECOND,
    }
  }
}

/** Whether a run in 'unknown' is due for another observation at this instant. */
export function observationDue(run: ExperimentRecord, now: number): boolean {
  return run.nextObserveAt === undefined || run.nextObserveAt <= now
}

const RUN_OUTPUT_TEXT = /\.(txt|md|csv|json|log|py|tex|yaml|yml|tsv)$/i
const RUN_OUTPUT_LIMIT = 256 * 1024

/**
 * List one run's `outputs/` files. Remote runs answer through the recorded
 * environment's SSH transport; local runs read the run directory directly.
 */
async function listRunOutputs(
  environment: EnvironmentRecord | undefined,
  run: ExperimentRecord,
  signal: AbortSignal,
): Promise<{ name: string; size: number }[]> {
  if (environment?.target === 'ssh') {
    const list = 'import pathlib,json,sys; o=pathlib.Path(sys.argv[1])/"outputs";'
      + ' print(json.dumps([{"n":str(p.relative_to(o)).replace(chr(92),"/"),"s":p.stat().st_size}'
      + ' for p in o.rglob("*") if p.is_file() and not p.name.startswith(".")] if o.is_dir() else []))'
    const output = checked(await ssh(sshHostOf(environment), [environment.python, '-c', list, run.directory], { signal }), 'Remote output listing')
    return z.array(z.object({ n: z.string(), s: z.number().nonnegative() })).parse(JSON.parse(output))
      .map(item => ({ name: item.n, size: item.s }))
  }
  const outputs = join(run.directory, 'outputs')
  const found: { name: string; size: number }[] = []
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(directory, entry.name)
      if (entry.isDirectory()) await walk(full, name)
      else if (entry.isFile()) found.push({ name, size: (await stat(full)).size })
    }
  }
  await walk(outputs, '')
  return found
}

/**
 * Turn a completed run's durable outputs into verified data evidence: every
 * file the experiment wrote under `outputs/` becomes its own record that
 * claims and figures can cite. Remote outputs are pulled into the local run
 * directory first so every cited path exists under the project.
 */
export async function collectRunOutputs(
  project: ResearchProject,
  run: ExperimentRecord,
  limit: number,
  signal: AbortSignal,
): Promise<EvidenceRecord[]> {
  const environment = project.environments.find(e => e.id === run.spec.environmentId)
  const cap = Math.min(limit, RUN_OUTPUT_LIMIT)
  const records: EvidenceRecord[] = []
  const importedAt = new Date().toISOString()
  const stale = run.inputRevision !== project.researchRevision
  for (const output of await listRunOutputs(environment, run, signal)) {
    if (output.size > cap) continue
    const relativePath = `.research/runs/${run.id}/outputs/${output.name}`
    let localFile = join(run.directory, 'outputs', output.name)
    if (environment?.target === 'ssh') {
      localFile = await projectPath(project.root, relativePath)
      // Base64 over the text channel: outputs are often binary (plots), and the byte-exact copy is what gets hashed.
      const read = 'import pathlib,sys,base64; sys.stdout.write(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode())'
      const content = checked(
        await ssh(sshHostOf(environment), [environment.python, '-c', read, `${run.directory}/outputs/${output.name}`], { signal, maxBytes: Math.ceil(cap * 4 / 3) + 1024 }),
        'Remote output collection',
      )
      await atomicWrite(localFile, Buffer.from(content, 'base64'))
    }
    const sha256 = await hashFile(localFile)
    let chunks: EvidenceRecord['chunks']
    if (RUN_OUTPUT_TEXT.test(output.name)) {
      const lines = (await readText(localFile, cap)).split(/\r?\n/)
      chunks = []
      for (let i = 0; i < lines.length; i += 40) chunks.push({ text: lines.slice(i, i + 40).join('\n'), locator: { key: `outputs/${output.name}`, line: i + 1 } })
    } else {
      chunks = [{ text: `Run output ${output.name} produced by experiment ${run.id}`, locator: { key: `outputs/${output.name}` } }]
    }
    records.push({
      id: randomUUID() as EvidenceId, title: `${run.spec.name}: ${output.name}`, kind: 'experiment',
      path: relativePath, sha256, revision: 1, importedAt, chunks,
      coverage: 'data', verified: true, stale,
    })
  }
  return records
}

/** Read bounded stdout and stderr without consuming or modifying training output. */
export async function experimentLogs(project: ResearchProject, run: ExperimentRecord, signal: AbortSignal): Promise<string> {
  const environment = project.environments.find(e => e.id === run.spec.environmentId)
  if (!environment) throw new Error('Experiment environment is missing')
  const code = 'import pathlib,sys; root=pathlib.Path(sys.argv[1]);'
    + ' [(print("\\n"+n+":"),sys.stdout.write((root/n).read_text(errors="replace")[-32000:] if (root/n).exists() else ""))'
    + ' for n in ["stdout.log","stderr.log","supervisor.log"]]'
  const result = environment.target === 'ssh'
    ? await ssh(sshHostOf(environment), [environment.python, '-c', code, run.directory], { signal })
    : await runProcess(environment.python, ['-c', code, run.directory], { signal })
  return checked(result, 'Experiment logs')
}
