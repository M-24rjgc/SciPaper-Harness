/** Provision pinned editor and Python tooling into the immutable desktop payload. */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ComponentManager, COMPONENT_RELEASES } from '../../../packages/research/workbench/src/components.ts'
import { checked, runProcess } from '../../../packages/research/workbench/src/process.ts'

/** Bundle platform tools separately from research project environments. */
export async function bundleResearchComponents(stagingRoot: string, runtimeRoot: string): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Research preview packaging targets Windows x64')
  const manager = new ComponentManager(stagingRoot, () => ({}))
  const signal = new AbortController().signal
  const uv = await manager.uv(signal)
  const drawio = await manager.drawio(signal)
  const pythonVersion = '3.12.14'
  const env = { UV_PYTHON_INSTALL_DIR: join(stagingRoot, 'python') }
  checked(await runProcess(uv, ['python', 'install', pythonVersion], { env, timeoutMs: 600000 }), 'Bundled Python installation')
  const python = checked(await runProcess(uv, ['python', 'find', '--managed-python', pythonVersion], { env }), 'Bundled Python resolution')
  const virtualenv = join(stagingRoot, `build-python-${pythonVersion}`)
  const virtualPython = join(virtualenv, 'Scripts', 'python.exe')
  if (!existsSync(virtualPython)) checked(await runProcess(uv, ['venv', '--python', python, virtualenv], { env, timeoutMs: 600000 }), 'Bundled Python environment')
  checked(await runProcess(uv, ['pip', 'install', '--python', virtualPython, 'pypdf==6.0.0', 'python-docx==1.2.0', 'matplotlib==3.10.6', 'pypdfium2==4.30.0'], { env, timeoutMs: 600000 }), 'Bundled document libraries')
  const destination = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-research-workbench', 'runtime', 'components')
  await mkdir(destination, { recursive: true })
  await cp(dirname(uv), join(destination, 'uv'), { recursive: true, dereference: true })
  await cp(dirname(python), join(destination, 'python'), { recursive: true, dereference: true })
  // Windows venv launchers retain an absolute interpreter path. Package the
  // standalone interpreter and its libraries together so installation can move.
  const platformPython = join(destination, 'platform-python')
  await cp(dirname(python), platformPython, { recursive: true, dereference: true })
  await cp(join(virtualenv, 'Lib', 'site-packages'), join(platformPython, 'Lib', 'site-packages'), { recursive: true, dereference: true })
  await rm(join(platformPython, 'pyvenv.cfg'), { force: true })
  checked(await runProcess(join(platformPython, 'python.exe'), ['-I', '-c', 'import pypdf, docx, matplotlib, pypdfium2; print("ready")'], { timeoutMs: 120000 }), 'Relocated platform Python')
  await cp(drawio, join(destination, 'drawio'), { recursive: true, dereference: true })
  await writeFile(join(destination, 'versions.json'), JSON.stringify({ python: pythonVersion, uv: COMPONENT_RELEASES.uv.version, drawio: COMPONENT_RELEASES.drawio.version }))
  console.log('research desktop: bundled Python, document libraries, uv and offline draw.io')
}
