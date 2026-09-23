/** Project-local Python environments and explicit adoption of existing interpreters. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ComponentManager } from './components.ts'
import { atomicWrite, hashBytes, projectPath } from './files.ts'
import { checked, runProcess, ssh } from './process.ts'
import type { EnvironmentId, EnvironmentRecord, ResearchProject } from './types.ts'

const INSPECT = `import sys,json,importlib.metadata,platform,subprocess,shutil
gpu = None
if shutil.which('nvidia-smi'):
 try:
  result = subprocess.run(['nvidia-smi','--query-gpu=uuid,name,driver_version,memory.total','--format=csv,noheader'],capture_output=True,text=True,timeout=5)
  gpu = result.stdout.strip() if result.returncode == 0 else None
 except (OSError,subprocess.TimeoutExpired):
  pass
print(json.dumps({'executable':sys.executable,'version':sys.version,'platform':platform.platform(),'gpu':gpu,'packages':sorted([(d.metadata.get('Name',''),d.version) for d in importlib.metadata.distributions()])}))`

/** Create a uv environment or inspect an existing one without modifying its packages. */
export async function createEnvironment(project: ResearchProject, request: Omit<EnvironmentRecord, 'id' | 'fingerprint' | 'status' | 'details'>, components: ComponentManager, signal: AbortSignal): Promise<EnvironmentRecord> {
  const id = randomUUID() as EnvironmentId
  let python = request.python
  for (const requirement of request.requirements) if (!requirement.trim() || requirement.startsWith('-') || /[\r\n]/.test(requirement)) throw new Error('Each dependency must be one package requirement, without installer options')
  if (request.target === 'ssh') {
    if (!request.sshHost || !request.remoteRoot?.startsWith('/')) throw new Error('A remote environment requires an SSH host and an absolute dedicated remote directory')
    if (request.kind === 'uv') {
      const target = `${request.remoteRoot.replace(/\/$/, '')}/environments/${id}`
      checked(await ssh(request.sshHost, ['uv', 'venv', '--python', python || '3.12', target], { signal, timeoutMs: 600000 }), 'Remote environment creation')
      python = `${target}/bin/python`
      if (request.requirements.length) checked(await ssh(request.sshHost, ['uv', 'pip', 'install', '--python', python, ...request.requirements], { signal, timeoutMs: 600000 }), 'Remote dependencies')
    }
    if (!python.startsWith('/')) throw new Error('Select the absolute path to the remote Python interpreter')
    const details = checked(await ssh(request.sshHost, [python, '-c', INSPECT], { signal }), 'Remote Python inspection')
    return { ...request, id, python, fingerprint: hashBytes(details), status: 'ready', details }
  }
  if (request.kind === 'uv') {
    const uv = await components.uv(signal)
    const target = await projectPath(project.root, `.research/environments/${id}`)
    checked(await runProcess(uv, ['venv', '--python', python || '3.12', target], { signal, timeoutMs: 600000, env: { UV_PYTHON_INSTALL_DIR: join(components.root, 'interpreters') } }), 'Project environment creation')
    python = components.venvPython(target)
    if (request.requirements.length) checked(await runProcess(uv, ['pip', 'install', '--python', python, ...request.requirements], { signal, timeoutMs: 600000 }), 'Project dependencies')
    const lock = checked(await runProcess(uv, ['pip', 'freeze', '--python', python], { signal }), 'Dependency snapshot')
    await atomicWrite(await projectPath(project.root, `.research/environments/${id}.requirements.lock`), `${lock}\n`)
  }
  if (!python) throw new Error('Choose an existing Python interpreter or create a managed uv environment')
  const details = checked(await runProcess(python, ['-c', INSPECT], { signal }), 'Python inspection')
  const info = JSON.parse(details) as { executable: string }
  return { ...request, id, python: info.executable, fingerprint: hashBytes(details), status: 'ready', details }
}

/** Snapshot the interpreter immediately before a run, catching changed adopted environments. */
export async function inspectEnvironment(environment: EnvironmentRecord, signal: AbortSignal): Promise<string> {
  const host = environment.sshHost
  if (environment.target === 'ssh') {
    if (!host) throw new Error('A remote experiment environment needs an SSH host')
    return checked(await ssh(host, [environment.python, '-c', INSPECT], { signal }), 'Experiment environment inspection')
  }
  return checked(await runProcess(environment.python, ['-c', INSPECT], { signal }), 'Experiment environment inspection')
}
