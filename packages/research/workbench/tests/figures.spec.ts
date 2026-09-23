import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ProcessOptions, ProcessResult } from '../src/process.ts'

/** The figure scripts, answered by a stand-in that writes what the real ones would. */
const scripted = vi.hoisted(() => ({
  calls: [] as { args: string[]; options: unknown }[],
  answer: undefined as ((args: string[]) => Promise<ProcessResult>) | undefined,
}))
vi.mock('../src/process.ts', async original => ({
  ...await original<typeof import('../src/process.ts')>(),
  runProcess: async (_command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> => {
    scripted.calls.push({ args: [...args], options })
    return (scripted.answer as (args: string[]) => Promise<ProcessResult>)([...args])
  },
}))
const { auditReportPath, auditSvg, exportFigure } = await import('../src/figures.ts')

const signal = new AbortController().signal
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'research figures '))
  roots.push(root)
  await mkdir(join(root, 'figures'), { recursive: true })
  await writeFile(join(root, 'figures', 'arch.svg'), '<svg/>')
  return root
}

/** An audit that writes its report where --json points and exits as the real one does. */
function audit(report: Record<string, unknown>, code = 0): (args: string[]) => Promise<ProcessResult> {
  return async (args) => {
    const target = args[args.indexOf('--json') + 1] as string
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, JSON.stringify(report))
    return { code, stdout: '', stderr: '' }
  }
}
const REPORT = { ok: false, svg: 'C:/abs/arch.svg', stats: { texts: 3 }, errors: [{ code: 'text_overlap', detail: 'a overlaps b', id: 't1' }], warnings: [] }

describe('the SVG audit', () => {
  it('runs the upstream audit isolated in UTF-8 mode and keeps no report unless asked', async () => {
    const root = await project()
    scripted.answer = audit(REPORT, 1)
    const { report, saved } = await auditSvg('py', root, 'figures/arch.svg', {}, signal)
    expect(saved).toBeUndefined()
    expect(report).toMatchObject({ ok: false, svg: 'figures/arch.svg', errors: [{ code: 'text_overlap', id: 't1' }] })
    const { args } = scripted.calls.at(-1)!
    expect(args.slice(0, 3)).toEqual(['-I', '-X', 'utf8'])
    expect(args[3]).toMatch(/runtime[\\/]figures[\\/]audit_svg\.py$/)
    expect(args).not.toContain('--min-font-px')
    expect(existsSync(args[args.indexOf('--json') + 1] as string)).toBe(false)
  })

  it('saves the report where the figure gate reads it, with the project-relative path, and passes the type floor', async () => {
    const root = await project()
    scripted.answer = audit({ ...REPORT, ok: true, errors: [] })
    const { saved } = await auditSvg('py', root, 'figures/arch.svg', { save: true, minFontPx: 16 }, signal)
    expect(saved).toBe('figures/audit_logs/arch.audit.json')
    expect(JSON.parse(await readFile(join(root, saved!), 'utf8'))).toMatchObject({ ok: true, svg: 'figures/arch.svg' })
    expect(scripted.calls.at(-1)!.args).toEqual(expect.arrayContaining(['--min-font-px', '16']))
    expect(auditReportPath('figures/work/round_03.SVG')).toBe('figures/audit_logs/round_03.audit.json')
  })

  it('refuses a file that is not an SVG and reports an audit that could not run', async () => {
    const root = await project()
    await expect(auditSvg('py', root, 'figures/arch.png', {}, signal)).rejects.toThrow(/reads an \.svg file/)
    scripted.answer = async () => ({ code: 2, stdout: '', stderr: 'no such file' })
    await expect(auditSvg('py', root, 'figures/arch.svg', {}, signal)).rejects.toThrow(/The SVG audit could not run: no such file/)
  })
})

describe('the figure export', () => {
  it('writes the PDF beside the SVG or where asked, and returns project-relative paths', async () => {
    const root = await project()
    scripted.answer = async args => ({
      code: 0, stderr: '',
      stdout: `svglib: a warning\n${JSON.stringify({
        pdf: args[5], previews: [join(args[6] as string, 'arch.1440.png'), join(args[6] as string, 'arch.480.png')],
        fonts: ['AAAAAA+TimesNewRomanPSMT'], embedded: true, text: true, images: 0, markers: 2,
      })}\n`,
    })
    const figure = await exportFigure('py', root, 'figures/arch.svg', undefined, signal)
    expect(figure).toEqual({
      pdf: 'figures/arch.pdf', previews: ['figures/previews/arch.1440.png', 'figures/previews/arch.480.png'],
      fonts: ['AAAAAA+TimesNewRomanPSMT'], embedded: true, text: true, images: 0, markers: 2,
    })
    expect(scripted.calls.at(-1)!.args[3]).toMatch(/runtime[\\/]figures[\\/]export_figure\.py$/)
    expect((await exportFigure('py', root, 'figures/arch.svg', 'figures/final/arch.pdf', signal)).pdf).toBe('figures/final/arch.pdf')
  })

  it('refuses wrong file kinds and reports what the export said when it failed', async () => {
    const root = await project()
    await expect(exportFigure('py', root, 'figures/arch.png', undefined, signal)).rejects.toThrow(/reads an \.svg file/)
    await expect(exportFigure('py', root, 'figures/arch.svg', 'figures/arch.png', signal)).rejects.toThrow(/writes a \.pdf file/)
    scripted.answer = async () => ({ code: 1, stdout: '{"error": "arch.svg is not well-formed XML: line 1"}\n', stderr: '' })
    await expect(exportFigure('py', root, 'figures/arch.svg', undefined, signal)).rejects.toThrow(/^arch\.svg is not well-formed XML/)
    scripted.answer = async () => ({ code: 1, stdout: '', stderr: 'Traceback: svglib missing' })
    await expect(exportFigure('py', root, 'figures/arch.svg', undefined, signal)).rejects.toThrow(/The figure export failed \(exit code 1\): Traceback/)
    scripted.answer = async () => ({ code: 0, stdout: '{"pdf": 3}', stderr: '' })
    await expect(exportFigure('py', root, 'figures/arch.svg', undefined, signal)).rejects.toThrow(/exit code 0/)
  })
})
