import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { ProcessOptions, ProcessResult } from '../src/process.ts'
import type { ModePack, ModeScript, ResolvedMode } from '../src/modes.ts'
import type { ResearchProject } from '../src/types.ts'

const calls = vi.hoisted(() => [] as { command: string; args: string[]; options: unknown }[])
const answer = vi.hoisted(() => ({ result: { code: 0, stdout: '', stderr: '' } }))
vi.mock('../src/process.ts', async original => ({
  ...await original<typeof import('../src/process.ts')>(),
  runProcess: async (command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> => {
    calls.push({ command, args: [...args], options })
    return answer.result
  },
}))
const { createGateRunner, parseGateOutput, runPackScript } = await import('../src/gates.ts')

const gate: ModeScript = { id: 'draft-lint', script: 'gates/run_gate.py', args: ['draft', '--root', '{root}', '--route', '{route}', '--pack', '{pack}'], timeoutSeconds: 30 }
const pack = { id: 'demo', directory: join('/packs', 'demo') } as ModePack
const mode: ResolvedMode = { pack, route: 'proposal', phases: [], gates: [gate] }
const project = { root: '/projects/p' } as ResearchProject
const signal = new AbortController().signal

describe('pack gates', () => {
  it('reads the last findings line a gate printed, tagging each finding with the gate', () => {
    const stdout = [
      'progress text',
      '{"findings":[{"severity":"warning","message":"early"}]}',
      '{not json',
      '{"other":1}',
      '{"findings":[{"severity":"error","message":"Section has no citation","file":"sections/method.tex","line":3}]}',
      '',
    ].join('\n')
    expect(parseGateOutput({ code: 1, stdout, stderr: '' }, 'citations-lint')).toEqual([
      { check: 'citations-lint', severity: 'error', message: 'Section has no citation', file: 'sections/method.tex', line: 3 },
    ])
    expect(parseGateOutput({ code: 0, stdout: '{"findings":[]}\n', stderr: '' }, 'x')).toEqual([])
    // Broken JSON and objects that are not a findings report are skipped, even as the last lines.
    expect(parseGateOutput({ code: 0, stdout: '{"findings":[]}\n{"summary":"ok"}\n{broken\n', stderr: '' }, 'x')).toEqual([])
  })

  it('turns a gate that printed no findings into one error with its exit code and output', () => {
    expect(parseGateOutput({ code: 2, stdout: 'usage: gate', stderr: 'Traceback …' }, 'blueprint-lint')).toEqual([
      { check: 'blueprint-lint', severity: 'error', message: 'The gate printed no findings (exit code 2): Traceback …\nusage: gate' },
    ])
    expect(parseGateOutput({ code: 0, stdout: '', stderr: '' }, 'x')[0]?.message).toBe('The gate printed no findings (exit code 0)')
  })

  it('runs a gate from its pack in the project folder, isolated from the user\'s Python setup and in UTF-8 mode', async () => {
    answer.result = { code: 0, stdout: '{"findings":[{"severity":"warning","message":"long title"}]}', stderr: '' }
    const findings = await createGateRunner(async () => 'C:/py/python.exe', signal)(gate, mode, project)
    expect(findings).toEqual([{ check: 'draft-lint', severity: 'warning', message: 'long title' }])
    expect(calls.at(-1)).toEqual({
      command: 'C:/py/python.exe',
      args: ['-I', '-X', 'utf8', join('/packs', 'demo', 'gates/run_gate.py'), 'draft', '--root', '/projects/p', '--route', 'proposal', '--pack', join('/packs', 'demo')],
      options: { cwd: '/projects/p', signal, timeoutMs: 30000, maxBytes: 4 * 1024 * 1024 },
    })
  })

  it('reports a gate as not run when no platform Python is installed, instead of installing one', async () => {
    const before = calls.length
    expect(await createGateRunner(async () => undefined, signal)(gate, mode, project)).toEqual([
      { check: 'draft-lint', severity: 'error', message: expect.stringMatching(/needs the platform Python/) as unknown as string },
    ])
    expect(calls.length).toBe(before)
  })

  it('passes the caller\'s arguments after the manifest\'s, with an empty route for a pack without routes', async () => {
    answer.result = { code: 0, stdout: 'done', stderr: '' }
    await runPackScript('py', { ...gate, args: ['--route={route}'] }, { ...mode, route: undefined }, project, ['--extra', 'x'], signal)
    expect(calls.at(-1)?.args.slice(4)).toEqual(['--route=', '--extra', 'x'])
  })
})
