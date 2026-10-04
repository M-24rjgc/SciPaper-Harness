/** Opt-in compilation through the installed system TeX; no distribution or package downloads. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { compilePaper, writeArtifact } from '../src/artifacts.ts'
import { ComponentManager } from '../src/components.ts'
import * as processes from '../src/process.ts'
import { newProject } from '../src/project.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true })
})

describe.skipIf(process.env.RESEARCH_TEX_SMOKE !== '1')('actual system TeX compilation', () => {
  it.each(['pdflatex', 'xelatex', 'lualatex'] as const)('uses the detected %s engine to write a real PDF', async (engine) => {
    const root = await mkdtemp(join(tmpdir(), 'scipaper-latex-real-'))
    roots.push(root)
    const home = join(root, 'home')
    vi.stubEnv('DSH_HOME', home)
    const fetch = vi.fn(() => { throw new Error('Runtime downloads are forbidden in this test') })
    vi.stubGlobal('fetch', fetch)
    const components = new ComponentManager(join(home, 'research', 'components'), () => ({}))
    const selected = (await components.status()).find(component => component.id === 'latex')!
    expect(selected).toMatchObject({ installed: true, source: 'system' })
    expect(selected.engines).toContain(engine)
    const signal = new AbortController().signal
    expect(await components.latex(signal, engine)).toBe(selected.path)
    const actualRun = processes.runProcess
    const executed: { command: string; args: readonly string[] }[] = []
    vi.spyOn(processes, 'runProcess').mockImplementation(async (command, args, options) => {
      executed.push({ command, args })
      return actualRun(command, args, options)
    })
    const projectRoot = join(root, 'research')
    await mkdir(projectRoot)
    const project = newProject({ title: 'Engine compilation', root: projectRoot, brief: 'Typeset a formula' }, randomUUID() as WorkspaceId)
    const unicode = engine === 'xelatex'
    const content = unicode
      ? '\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Microsoft YaHei}\n\\begin{document}\n科研编译验证。$E=mc^2$\n\\end{document}\n'
      : '\\documentclass{article}\n\\begin{document}\nScientific compilation. $E=mc^2$\n\\end{document}\n'
    const artifact = await writeArtifact(project, {
      action: 'save-artifact', projectId: project.id, kind: 'manuscript', path: 'paper/main.tex', content,
      evidence: [], claimIds: [], inputArtifacts: [],
    }, 'user', 100000)
    const result = await compilePaper(project, artifact, engine, components, signal, 100000)
    expect(result.status, await readFile(join(project.root, result.logPath), 'utf8')).toBe('completed')
    const pdf = join(project.root, result.pdfPath)
    expect((await readFile(pdf)).subarray(0, 5).toString()).toBe('%PDF-')
    expect((await stat(pdf)).size).toBeGreaterThan(1000)
    const compilerCalls = executed.filter(call => call.args.some(arg => arg.startsWith('-output-directory=')))
    expect(compilerCalls.some(call => call.command === join(selected.path, `${engine}${process.platform === 'win32' ? '.exe' : ''}`))).toBe(true)
    expect(compilerCalls.every(call => call.args.includes('--disable-installer') === selected.version.startsWith('MiKTeX'))).toBe(true)
    expect(executed.some(call => /tlmgr/.test(call.command))).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  }, 60000)
})

it.skipIf(!process.env.RESEARCH_MANAGED_TEX_ROOT)('initializes managed TeX in its writable cache and compiles CJK', async () => {
  const componentRoot = process.env.RESEARCH_MANAGED_TEX_ROOT!
  const root = await mkdtemp(join(tmpdir(), 'scipaper-managed-real-'))
  roots.push(root)
  vi.stubEnv('DSH_HOME', join(root, 'home'))
  const components = new ComponentManager(componentRoot, () => ({}))
  const selected = (await components.status()).find(component => component.id === 'latex')!
  expect(selected).toMatchObject({ installed: true, source: 'managed' })
  const project = newProject({ title: 'Typesetting', root, brief: '' }, randomUUID() as WorkspaceId)
  const artifact = await writeArtifact(project, {
    action: 'save-artifact', projectId: project.id, kind: 'manuscript', path: 'paper/main.tex',
    content: '\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{Microsoft YaHei}\n\\begin{document}\n科研排版验证。$E=mc^2$\n\\end{document}\n',
    evidence: [], claimIds: [], inputArtifacts: [],
  }, 'user', 100000)
  const signal = new AbortController().signal
  const runtime = await components.latexRuntime(signal, 'xelatex')
  expect(runtime.env.TEXMFVAR?.startsWith(join(root, 'home', 'research', 'cache', 'latex'))).toBe(true)
  const result = await compilePaper(project, artifact, 'xelatex', components, signal, 100000)
  expect(result.status, await readFile(join(project.root, result.logPath), 'utf8')).toBe('completed')
  expect((await readFile(join(project.root, result.pdfPath))).subarray(0, 5).toString()).toBe('%PDF-')
}, 180000)
