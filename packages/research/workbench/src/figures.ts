/**
 * SVG figures, shared by every mode. The audit is spark-to-paper's own
 * (runtime/figures/audit_svg.py from ts-figure-svg, unchanged): overflow,
 * overlapping text, shapes over labels, stroke-scaled or clipped arrowheads,
 * dangling connectors, small type, font-fallback glyphs, cascade colour traps
 * and traced path soup. The export turns an SVG into a vector PDF with live
 * text and renders PNG previews (runtime/figures/export_figure.py: svglib and
 * reportlab, markers expanded first). Both run with the platform Python.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { z } from 'zod'
import { runtimeAsset } from './components.ts'
import { atomicWrite, projectPath } from './files.ts'
import { runProcess } from './process.ts'

const findingSchema = z.looseObject({ code: z.string(), detail: z.string() })
const auditSchema = z.object({
  ok: z.boolean(),
  svg: z.string(),
  stats: z.record(z.string(), z.unknown()),
  errors: z.array(findingSchema),
  warnings: z.array(findingSchema),
})
/** The audit's report, as audit_svg.py writes it. */
export type SvgAudit = z.infer<typeof auditSchema>

const exportSchema = z.object({
  pdf: z.string(),
  previews: z.array(z.string()),
  fonts: z.array(z.string()),
  embedded: z.boolean(),
  text: z.boolean(),
  images: z.number().int(),
  markers: z.number().int(),
})
/** What an export wrote, with project-relative paths. */
export type ExportedFigure = z.infer<typeof exportSchema>

const SVG_FILE = /\.svg$/i

/** Where an SVG's saved audit goes: the path spark-to-paper's figure gate reads. */
export function auditReportPath(path: string): string {
  return `figures/audit_logs/${basename(path).replace(SVG_FILE, '')}.audit.json`
}

/**
 * Audit one SVG figure.
 * @param python - the platform Python.
 * @param root - the project root.
 * @param path - the SVG, project-relative.
 * @param options - the legibility floor in pixels at the SVG's own width, and whether to save the report.
 * @param signal - cancellation.
 * @returns the report, and where it was saved.
 */
export async function auditSvg(
  python: string, root: string, path: string, options: { minFontPx?: number | undefined; save?: boolean | undefined }, signal: AbortSignal,
): Promise<{ report: SvgAudit; saved?: string }> {
  if (!SVG_FILE.test(path)) throw new Error('audit-svg reads an .svg file')
  const source = await projectPath(root, path)
  const saved = options.save ? auditReportPath(path) : undefined
  const target = saved ? await projectPath(root, saved) : join(tmpdir(), `research-audit-${randomUUID()}.json`)
  await mkdir(dirname(target), { recursive: true })
  const floor = options.minFontPx === undefined ? [] : ['--min-font-px', String(options.minFontPx)]
  const result = await runProcess(python, ['-I', '-X', 'utf8', runtimeAsset('figures/audit_svg.py'), source, '--json', target, '--quiet', ...floor], {
    cwd: root, signal, timeoutMs: 120_000,
  })
  // Exit 0 is clean and 1 has findings; anything else means the audit itself could not run.
  if (result.code !== 0 && result.code !== 1) throw new Error(`The SVG audit could not run: ${`${result.stderr}\n${result.stdout}`.trim()}`)
  const report = { ...auditSchema.parse(JSON.parse(await readFile(target, 'utf8'))), svg: path }
  if (saved) await atomicWrite(target, `${JSON.stringify(report, null, 2)}\n`)
  else await rm(target, { force: true })
  return { report, ...saved ? { saved } : {} }
}

/**
 * Export one SVG figure to a vector PDF and render its previews.
 * @param python - the platform Python.
 * @param root - the project root.
 * @param path - the SVG, project-relative.
 * @param output - the PDF, project-relative; beside the SVG with the same name when omitted.
 * @param signal - cancellation.
 * @returns what was written.
 */
export async function exportFigure(
  python: string, root: string, path: string, output: string | undefined, signal: AbortSignal,
): Promise<ExportedFigure> {
  if (!SVG_FILE.test(path)) throw new Error('export-figure reads an .svg file')
  const pdf = output ?? path.replace(SVG_FILE, '.pdf')
  if (!/\.pdf$/i.test(pdf)) throw new Error('export-figure writes a .pdf file')
  const result = await runProcess(python, [
    '-I', '-X', 'utf8', runtimeAsset('figures/export_figure.py'), await projectPath(root, path), await projectPath(root, pdf), await projectPath(root, 'figures/previews'),
  ], { cwd: root, signal, timeoutMs: 300_000 })
  const line = result.stdout.trim().split(/\r?\n/).at(-1) as string
  let value: unknown
  try { value = JSON.parse(line) } catch { value = undefined }
  const failure = z.object({ error: z.string() }).safeParse(value)
  if (failure.success) throw new Error(failure.data.error)
  const parsed = exportSchema.safeParse(value)
  if (result.code !== 0 || !parsed.success) throw new Error(`The figure export failed (exit code ${result.code}): ${`${result.stderr}\n${result.stdout}`.trim().slice(-1500)}`)
  const local = (file: string): string => relative(root, file).replaceAll('\\', '/')
  return { ...parsed.data, pdf: local(parsed.data.pdf), previews: parsed.data.previews.map(local) }
}
