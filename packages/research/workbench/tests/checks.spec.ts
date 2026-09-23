import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { newProject } from '../src/project.ts'
import { runChecks as runWithMode } from '../src/checks.ts'
import { ModeRegistry } from '../src/modes.ts'
import { bibliographyFiles, flattenPaper, listProjectFiles, originAt, paperDigest, stripComment } from '../src/latex.ts'
import type { ArtifactId, EvidenceId, ResearchProject } from '../src/types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

// A paper pipeline of base checks only; the shipped packs' Python gates are covered by spark-pack.spec.
let registry: ModeRegistry
beforeAll(async () => { registry = await ModeRegistry.load([join(import.meta.dirname, 'fixtures/modes')], { warn: (...args: unknown[]) => { throw new Error(args.join(' ')) } }) })
const runChecks = (project: ResearchProject, limit: number, scope?: string) => runWithMode(project, limit, scope, registry.resolve(project))
type Route = 'idea' | 'proposal' | 'data'

async function write(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

const MAIN = String.raw`\documentclass{article}
\graphicspath{{../figures/}}
\begin{document}
\begin{abstract}We reach 71.5\% accuracy.\end{abstract}
\section{Introduction} As shown by \citep{real} and \cite{missing, real}. % 0.99 in a comment
\section{Related Work} Prior art \cite{incomplete} and \cite{novenue}.
\section{Method} We use width 0.5\linewidth and \input{sections/method}
\section{Experiments}
\begin{tabular}{lc}
Ours & 0.62 \\
Baseline & -- \\
\end{tabular}
We see 3.25 points gain. Accuracy is \tbd{final accuracy}. TODO
\includegraphics[width=0.4\textwidth]{plot}
\includegraphics{absent}
\input{sections/ghost}
\section{Conclusion} Done.
\bibliography{refs}
\end{document}
`

/** A spark-to-paper project on the given route, or a general one without a route. */
async function fixture(route?: Route): Promise<ResearchProject> {
  const root = await mkdtemp(join(tmpdir(), 'research checks 中文 '))
  roots.push(root)
  await write(root, 'paper/main.tex', MAIN)
  await write(root, 'paper/sections/method.tex', 'The method section.\n')
  await write(root, 'paper/refs.bib', [
    '@string{x = "y"}',
    '@article{real, author={A. Author}, title={Real Work}, year={2024}, journal={J}, doi={10.1/real}}',
    '@misc{incomplete, title={No author}}',
    '@misc{novenue, author={B}, title={T}, year={2020}}',
    '@misc{uncited, author={C}, title={U}, year={2021}}',
    '@comment{ignored}',
  ].join('\n'))
  await write(root, 'figures/plot.png', 'png')
  await write(root, 'template/other.tex', '\\documentclass{x}')
  return newProject({ root, title: 'Checks', brief: '', ...(route ? { mode: 'spark-to-paper', route } : {}) }, 'workspace' as WorkspaceId)
}

const errors = (report: Awaited<ReturnType<typeof runChecks>>, check: string) => report.findings.filter(f => f.check === check && f.severity === 'error')
const warnings = (report: Awaited<ReturnType<typeof runChecks>>, check: string) => report.findings.filter(f => f.check === check && f.severity === 'warning')

describe('research checks report on the paper as it is on disk', () => {
  it('finds the main file without registration and reports every class of problem with its location', async () => {
    const p = await fixture('proposal')
    const report = await runChecks(p, 100000)
    expect(report.clean).toBe(false)
    expect(errors(report, 'cite').map(f => f.message)).toEqual(expect.arrayContaining([
      'Citation key has no bibliography entry: missing',
      'Incomplete bibliography entry incomplete: needs author, title and year',
    ]))
    const missing = errors(report, 'cite').find(f => f.message.endsWith('missing'))
    expect(missing).toMatchObject({ file: 'paper/main.tex', line: 5 })
    expect(warnings(report, 'cite').map(f => f.message).join('\n')).toMatch(/novenue names no venue/)
    expect(warnings(report, 'cite').map(f => f.message).join('\n')).toMatch(/real was not verified/)
    expect(report.findings.some(f => f.message.includes('uncited'))).toBe(false)
    // The table value is an error; prose in a results section and the abstract are warnings; comments and layout never count.
    expect(errors(report, 'numbers').map(f => f.message)).toEqual([expect.stringMatching(/^0\.62 does not trace/)])
    expect(warnings(report, 'numbers').map(f => f.message.split(' ')[0]).sort()).toEqual(['3.25', '71.5%'])
    expect(report.findings.some(f => f.message.startsWith('0.99') || f.message.startsWith('0.5') || f.message.startsWith('0.4'))).toBe(false)
    expect(errors(report, 'placeholders').map(f => f.message)).toEqual(expect.arrayContaining([
      'Placeholder remains: \\tbd{final accuracy}', 'Placeholder remains: TODO', 'Placeholder remains: 1 empty result cell(s) "--" in a table',
    ]))
    expect(errors(report, 'figures').map(f => f.message)).toEqual(['Included figure not found: absent'])
    expect(errors(report, 'compile').map(f => f.message)).toEqual(['The paper has not been compiled yet'])
    expect(errors(report, 'structure')).toMatchObject([{ message: '\\input target not found: sections/ghost', file: 'paper/main.tex', line: 16 }])
    expect(warnings(report, 'structure').map(f => f.message)).toEqual(expect.arrayContaining([
      'The paper uses a generic document class; apply the venue template (apply-template) before submission',
    ]))
    expect(warnings(report, 'review').map(f => f.message)).toEqual([expect.stringMatching(/No review yet/)])
    expect(report.findings.findIndex(f => f.severity === 'warning')).toBeGreaterThan(report.findings.findLastIndex(f => f.severity === 'error'))
    expect(report.findings.filter(f => f.check === 'prose')).toEqual([])
  })

  it('counts a review report folder as a review, and a revision ledger as none', async () => {
    const p = await fixture('proposal')
    await write(p.root, 'reviews/revision-ledger.md', '| comment_id | status | location |\n| --- | --- | --- |\n')
    expect(warnings(await runChecks(p, 100000, 'review'), 'review').map(f => f.message)).toEqual([expect.stringMatching(/^No review yet/)])
    await write(p.root, 'ccfa-review-reports/checks-neurips-review.md', '# Review\n')
    await utimes(join(p.root, 'ccfa-review-reports/checks-neurips-review.md'), new Date(Date.now() + 60000), new Date(Date.now() + 60000))
    expect((await runChecks(p, 100000, 'review')).findings).toEqual([])
  })

  it('reports prose worth reconsidering where it stands, as warnings only, and caps a long list', async () => {
    const p = await fixture('proposal')
    await write(p.root, 'paper/sections/method.tex', `The method.\n${'It is worth noting that it plays a crucial role. '.repeat(14)}\n`)
    const report = await runChecks(p, 100000, 'prose')
    const prose = report.findings.filter(f => f.check === 'prose')
    expect(prose.every(f => f.severity === 'warning')).toBe(true)
    expect(prose[0]).toMatchObject({ message: expect.stringMatching(/^"It is worth noting that" reads as machine-written/) as unknown, file: 'paper/sections/method.tex', line: 2 })
    expect(prose).toHaveLength(26)
    expect(prose.at(-1)?.message).toBe('…and 4 more prose findings')
  })

  it('traces numbers to data evidence, run metrics and code, and goes clean once the paper is finished', async () => {
    const p = await fixture('data')
    await write(p.root, 'paper/main.tex', MAIN.replace('Baseline & -- \\\\', 'Baseline & 0.5 \\\\').replace(' Accuracy is \\tbd{final accuracy}. TODO', '').replace('\\includegraphics{absent}\n', '')
      .replace('\\input{sections/ghost}\n', '').replace('\\cite{missing, real}', '\\cite{real}').replace(' Prior art \\cite{incomplete} and \\cite{novenue}.', ''))
    await write(p.root, 'code/config.yaml', 'gain: 3.25\n')
    await write(p.root, 'figures/arch.drawio', '<mxfile/>')
    p.evidence.push({ id: 'data' as EvidenceId, title: 'results.csv', kind: 'file', path: 'x', sha256: 'h', revision: 1, importedAt: '', chunks: [{ text: '["ours","0.6213"]', locator: { line: 2 } }], coverage: 'data', verified: true, stale: false })
    p.experiments.push({ id: 'run' as never, spec: { environmentId: 'e' as never, name: 'r', argv: ['{python}'], cwd: '.', seed: 0, maxSeconds: 1, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'm' }, status: 'completed', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: { accuracy: 0.715, base: 0.5 }, message: '', snapshotPath: '', collected: true })
    p.evidence.push({ id: 'lit' as EvidenceId, title: 'Real', kind: 'literature', path: 'y', sha256: 'h', revision: 1, importedAt: '', chunks: [], doi: '10.1/real', coverage: 'abstract', verified: true, stale: false })
    const manuscript = { id: 'm' as ArtifactId, path: 'paper/main.tex', kind: 'manuscript' as const, revision: 1, sha256: 'x', evidence: [], claimIds: [], inputArtifacts: [], stale: false, updatedAt: '2026-01-01', author: 'agent' as const }
    p.artifacts.push(manuscript)
    const digest = await paperDigest(p.root, await flattenPaper(p.root, 'paper/main.tex', 100000))
    p.compilations.push({ artifactId: manuscript.id, artifactRevision: 1, inputDigest: digest, engine: 'pdflatex', status: 'completed', pdfPath: 'b/main.pdf', logPath: 'b/log', diagnostics: ["LaTeX Warning: Reference `fig' on page 1 undefined", 'Overfull \\hbox'], createdAt: '' })
    p.visualReviews.push({ artifactId: manuscript.id, artifactRevision: 1, status: 'rendered', inputDigest: digest, findings: '', createdAt: '' })
    await write(p.root, 'reviews/review.md', '- [x] [major] fixed\n- [ ] [minor] later\n')
    await utimes(join(p.root, 'reviews/review.md'), new Date(Date.now() + 60000), new Date(Date.now() + 60000))
    const report = await runChecks(p, 100000)
    expect(report.findings.filter(f => f.severity === 'error')).toEqual([])
    expect(report.clean).toBe(true)
    expect(warnings(report, 'compile').map(f => f.message)).toEqual([expect.stringMatching(/Undefined cross-references/), '1 overfull box(es) in the compiled PDF'])
    expect(report).toMatchObject({ mode: 'spark-to-paper', route: 'data' })
    expect(report.phases.map(phase => [phase.id, phase.done])).toEqual([
      ['data', true], ['plan', true], ['cite', true], ['write', true], ['refine', true], ['review', true], ['figures', true], ['latex', true], ['submission', true],
    ])
    // Without a review nothing is wrong, but the review phase is unfinished, so the paper is not done.
    await rm(join(p.root, 'reviews'), { recursive: true })
    const unreviewed = await runChecks(p, 100000)
    expect(unreviewed.findings.filter(f => f.severity === 'error')).toEqual([])
    expect(unreviewed.phases.find(phase => phase.id === 'review')?.missing).toEqual(['No current review — run the adversarial review and write reviews/review.md'])
    expect(unreviewed.clean).toBe(false)
    await write(p.root, 'paper/main.tex', `${MAIN}\n% changed`)
    const changed = await runChecks(p, 100000, 'compile')
    expect(changed.scope).toBe('compile')
    expect(changed.findings.every(f => f.check === 'compile')).toBe(true)
    expect(errors(changed, 'compile').map(f => f.message)).toEqual(['Sources changed since the last successful compile; compile again'])
  })

  it('reports failed compiles, stale review, open review issues, ledger staleness and invalid claims', async () => {
    const p = await fixture('proposal')
    const manuscript = { id: 'm' as ArtifactId, path: 'paper/main.tex', kind: 'manuscript' as const, revision: 1, sha256: 'x', evidence: [], claimIds: [], inputArtifacts: [], stale: true, updatedAt: '', author: 'agent' as const }
    p.artifacts.push(manuscript, { ...manuscript, id: 'plot' as ArtifactId, path: 'figures/plot.png', kind: 'figure', stale: false }, { ...manuscript, id: 'd' as ArtifactId, path: 'diagrams/arch.drawio', kind: 'diagram', stale: false })
    p.compilations.push({ artifactId: manuscript.id, artifactRevision: 1, inputDigest: 'old', engine: 'pdflatex', status: 'failed', pdfPath: '', logPath: 'log', diagnostics: ['! Undefined control sequence.', 'plain'], createdAt: '' })
    p.evidence.push({ id: 'old' as EvidenceId, title: 'old data', kind: 'file', path: 'z', sha256: 'h', revision: 2, importedAt: '', chunks: [], coverage: 'data', verified: true, stale: true })
    p.claims.push({ id: 'c1', text: 'It improves', kind: 'empirical', state: 'contradicted', evidence: [], artifactIds: [] })
    p.claims.push({ id: 'c2', text: 'Broken', kind: 'literature', state: 'proposed', evidence: [{ evidenceId: 'gone' as EvidenceId, revision: 1, locator: {}, quote: '' }], artifactIds: [] })
    await write(p.root, 'reviews/review.md', '- [ ] [blocker] results contradict claim\n')
    await utimes(join(p.root, 'reviews/review.md'), new Date(0), new Date(0))
    const report = await runChecks(p, 100000)
    expect(errors(report, 'compile').map(f => f.message)).toEqual(['The last compile failed: ! Undefined control sequence. (log: log)'])
    expect(errors(report, 'review').map(f => f.message)).toEqual(['Open review issue: [blocker] results contradict claim'])
    expect(warnings(report, 'review').map(f => f.message)).toEqual(['The latest review predates the latest manuscript changes'])
    expect(warnings(report, 'figures').map(f => f.message)).toEqual(expect.arrayContaining([
      'Result plot figures/plot.png does not record the data and script that produced it',
      'Result plot figures/plot.png is raster; export plots as vector PDF',
      'Diagram diagrams/arch.drawio is not included in the paper; export it and \\includegraphics it',
    ]))
    expect(warnings(report, 'stale').map(f => f.file)).toEqual(['paper/main.tex', 'z'])
    expect(warnings(report, 'claims').map(f => f.message)).toEqual(['Contradicted by the evidence — make sure the paper says so: It improves'])
    expect(errors(report, 'claims').map(f => f.message)).toEqual(['c2: Evidence is missing or outdated: gone'])
    const latex = report.phases.find(phase => phase.id === 'latex')
    expect(latex?.done).toBe(false)
    expect(latex?.missing.join('\n')).toMatch(/error\(s\) in compile/)
    const scoped = await runChecks(p, 100000, 'write')
    expect(scoped.clean).toBe(false)
    expect(scoped.findings.every(f => ['structure', 'cite', 'numbers'].includes(f.check))).toBe(true)
  })

  it('derives phase progress on the idea route from notes, runs and files', async () => {
    const p = await fixture('idea')
    await rm(join(p.root, 'paper'), { recursive: true })
    await write(p.root, 'notes/b.tex', 'no class')
    await write(p.root, 'notes/a.tex', 'no class')
    let report = await runChecks(p, 100000)
    expect(errors(report, 'structure').map(f => f.message)).toEqual([expect.stringMatching(/No LaTeX manuscript yet/)])
    expect(report.phases.map(phase => phase.id)).toEqual(['story', 'plan', 'cite', 'write', 'refine', 'review', 'figures', 'latex', 'experiments', 'submission'])
    expect(Object.fromEntries(report.phases.map(phase => [phase.id, phase.missing]))).toMatchObject({
      story: [expect.stringMatching(/write story\.json/)],
      cite: ['No bibliography entries yet'],
      plan: [expect.stringMatching(/1 error/), expect.stringMatching(/blueprint/)],
      write: [expect.stringMatching(/error/), 'No manuscript yet'],
      figures: ['No editable architecture diagram (draw.io file or TikZ picture)'],
      experiments: ['No collected results to report'],
    })
    await write(p.root, 'idea.md', 'idea')
    await write(p.root, 'notes/outline.md', 'outline')
    await write(p.root, 'figures/arch.drawio', '<mxfile/>')
    p.experiments.push({ id: 'r' as never, spec: {} as never, status: 'running', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: {}, message: '', snapshotPath: '', collected: false })
    report = await runChecks(p, 100000, 'story')
    expect(report.clean).toBe(true)
    expect(report.findings).toEqual([])
    const phases = Object.fromEntries((await runChecks(p, 100000)).phases.map(phase => [phase.id, phase.missing]))
    expect(phases.plan).toEqual([expect.stringMatching(/1 error/)])
    expect(phases.figures).toEqual([])
    expect(phases.experiments).toEqual(['No collected results to report', '1 run(s) still in progress'])
  })

  it('has no phases in general mode, skips section expectations there, and treats unknown scopes as all', async () => {
    const general = await fixture()
    const report = await runChecks(general, 100000, 'nonsense')
    expect(report.phases).toEqual([])
    expect(report.mode).toBe('general')
    expect('route' in report).toBe(false)
    expect(report.scope).toBe('nonsense')
    expect(report.findings.some(f => f.check === 'structure' && f.severity === 'warning')).toBe(false)
    expect(report.clean).toBe(report.findings.every(f => f.severity !== 'error'))
    // A pack that is no longer installed leaves the project in general mode, not broken.
    const orphan = await runChecks({ ...general, mode: 'gone', route: 'x' }, 100000, 'story')
    expect(orphan).toMatchObject({ mode: 'general', phases: [] })
  })

  it('reports an unreadable manuscript, an unreadable bibliography and caps repeated findings', async () => {
    const p = await fixture('data')
    await write(p.root, 'paper/main.tex', `\\documentclass{acmart}\n\\begin{document}\n${'\\begin{tabular}{c}1.11 \\\\ \\end{tabular}\n'.repeat(1)}${Array.from({ length: 30 }, (_, i) => `\\section{Results ${i}} ${i}.5 \\tbd{x}`).join('\n')}\n\\cite{a}\n\\addbibresource{refs.bib}\n\\end{document}\n`)
    await rm(join(p.root, 'paper/refs.bib'))
    await mkdir(join(p.root, 'paper/refs.bib'))
    const report = await runChecks(p, 100000)
    expect(errors(report, 'cite').map(f => f.message)).toEqual(expect.arrayContaining([expect.stringMatching(/Bibliography unreadable/), 'Citation key has no bibliography entry: a']))
    expect(errors(report, 'numbers').at(-1)?.message).toMatch(/…and \d+ more untraced numbers/)
    expect(errors(report, 'placeholders').at(-1)?.message).toBe('…and 5 more placeholders')
    expect(report.findings.some(f => f.message.startsWith('The paper uses a generic'))).toBe(false)
    const tiny = await runChecks(p, 10)
    expect(errors(tiny, 'structure').map(f => f.message)).toEqual([expect.stringMatching(/No LaTeX manuscript yet/)])
    p.artifacts.push({ id: 'big' as ArtifactId, path: 'paper/main.tex', kind: 'manuscript', revision: 1, sha256: 'x', evidence: [], claimIds: [], inputArtifacts: [], stale: false, updatedAt: '', author: 'user' })
    await write(p.root, 'paper/main.tex', '\\documentclass{x}\n\\input{a}\n')
    await write(p.root, 'paper/a.tex', 'x'.repeat(60))
    const unreadable = await runChecks(p, 50)
    expect(errors(unreadable, 'structure').map(f => f.message)).toEqual([expect.stringMatching(/The manuscript could not be read: Text exceeds the 50 byte limit/)])
    await write(p.root, 'paper/main.tex', `\\documentclass{x}\n${'\\input{a}'.repeat(5)}\n`)
    await write(p.root, 'paper/a.tex', 'x'.repeat(90))
    const oversized = await runChecks(p, 100)
    expect(errors(oversized, 'structure').map(f => f.message)).toEqual(['The manuscript could not be read: The manuscript and its inputs exceed the configured text limit'])
  })

  it('covers verification matches, figure data and script records, discovery order and compile edges', async () => {
    const p = await fixture('proposal')
    await write(p.root, 'paper/main.tex', String.raw`% \documentclass{article}
\begin{document}
\section{Introduction} Some 1.5 decades ago \cite{byeprint, bybibtex, extra}.
\vspace{2.5em}
\input{sections/method.tex}
\input{sections/loop}
\section{Experiments} We reach 95\% here.
\includegraphics{arch} \includegraphics{../../outside} \includegraphics{curve.pdf}
\includegraphics{dataonly} \includegraphics{good} \includegraphics{mixed}
\bibliography{refs,extra,rootbib,absent,../../x}
\end{document}
`)
    await write(p.root, 'rootbib.bib', '')
    await write(p.root, 'paper/sections/loop.tex', '\\input{sections/loop}\n')
    await write(p.root, 'paper/refs.bib', [
      '@misc{, title={no key}}',
      '@article{byeprint, author={A}, title={T}, year={2020}, eprint={2101.00001}}',
      '@article{bybibtex, author={B}, title={U}, year={2021}, journal={J}}',
    ].join('\n'))
    await write(p.root, 'refs/extra.bib', '@book{extra, author={C}, title={V}, year={2019}, publisher={P}}')
    for (const name of ['arch.pdf', 'curve.pdf', 'dataonly.pdf', 'good.pdf', 'mixed.pdf']) await write(p.root, `figures/${name}`, '%PDF')
    await write(p.root, 'figures/arch.drawio', '<mxfile/>')
    for (const path of ['.hidden/x.tex', 'exports/y.tex', 'a/b/c/d/e/deep.tex', 'paper/aa.tex', 'paper/ab.tex']) await write(p.root, path, 'text')
    const base = { revision: 1, sha256: 'x', evidence: [], claimIds: [], inputArtifacts: [], stale: false, updatedAt: '', author: 'agent' as const }
    const data = { id: 'data' as EvidenceId, title: 'd', kind: 'file' as const, path: 'd', sha256: 'h', revision: 1, importedAt: '', chunks: [], coverage: 'data' as const, verified: true, stale: false }
    p.evidence.push(data,
      { ...data, id: 'eprint' as EvidenceId, kind: 'literature', coverage: 'abstract', sourceUrl: 'https://arxiv.org/abs/2101.00001' },
      { ...data, id: 'bibtex' as EvidenceId, kind: 'literature', coverage: 'metadata', chunks: [{ text: '@article{bybibtex, author={B}, title={U}, year={2021}, journal={J}}', locator: { key: 'bibtex' } }] },
      { ...data, id: 'extra-lit' as EvidenceId, kind: 'literature', coverage: 'metadata', chunks: [{ text: '@book{extra, author={C}, title={V}, year={2019}, publisher={P}}', locator: { key: 'bibtex' } }] })
    const link = (evidenceId: string) => ({ evidenceId: evidenceId as EvidenceId, revision: 1, locator: {}, quote: '' })
    p.artifacts.push(
      { ...base, id: 'notes' as ArtifactId, path: 'paper/aa.tex', kind: 'manuscript', updatedAt: '2026-02-01' },
      { ...base, id: 'main' as ArtifactId, path: 'paper/main.tex', kind: 'manuscript', updatedAt: '2026-01-01' },
      { ...base, id: 'bib' as ArtifactId, path: 'refs/extra.bib', kind: 'bibliography' },
      { ...base, id: 'script' as ArtifactId, path: 'code/plot.py', kind: 'code' },
      { ...base, id: 'arch' as ArtifactId, path: 'figures/arch.drawio', kind: 'diagram' },
      { ...base, id: 'good' as ArtifactId, path: 'figures/good.pdf', kind: 'figure', evidence: [link('data')], inputArtifacts: [{ id: 'script' as ArtifactId, revision: 1 }] },
      { ...base, id: 'dataonly' as ArtifactId, path: 'figures/dataonly.pdf', kind: 'figure', evidence: [link('data')] },
      { ...base, id: 'mixed' as ArtifactId, path: 'figures/mixed.pdf', kind: 'figure', evidence: [link('eprint')], inputArtifacts: [{ id: 'arch' as ArtifactId, revision: 1 }] },
    )
    p.experiments.push(
      { id: 'failed' as never, spec: { argv: ['{python}'] } as never, status: 'failed', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: { acc: 0.1 }, message: '', snapshotPath: '', collected: false },
      { id: 'done' as never, spec: { argv: ['{python}'] } as never, status: 'completed', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: {}, message: '', snapshotPath: '', collected: true },
    )
    const flat = await flattenPaper(p.root, 'paper/main.tex', 100000)
    expect(await bibliographyFiles(p.root, flat)).toEqual(['paper/refs.bib', 'refs/extra.bib', 'rootbib.bib'])
    const digest = await paperDigest(p.root, flat)
    p.compilations.push({ artifactId: 'main' as ArtifactId, artifactRevision: 1, inputDigest: digest, engine: 'pdflatex', status: 'completed', pdfPath: 'b/main.pdf', logPath: 'b/log', diagnostics: [], createdAt: '' })
    const report = await runChecks(p, 100000)
    expect(errors(report, 'cite')).toEqual([])
    expect(warnings(report, 'cite')).toEqual([])
    expect(errors(report, 'structure')).toEqual([])
    expect(report.findings.some(f => f.message.startsWith('The paper uses a generic'))).toBe(false)
    expect(report.findings.filter(f => f.check === 'numbers').map(f => f.message.split(' ')[0])).toEqual(['95%'])
    expect(errors(report, 'figures').map(f => f.message)).toEqual(['Included figure not found: ../../outside'])
    expect(warnings(report, 'figures').map(f => f.message)).toEqual([
      'Result plot figures/dataonly.pdf does not record the data and script that produced it',
      'Result plot figures/mixed.pdf does not record the data and script that produced it',
    ])
    expect(errors(report, 'compile')).toEqual([])
    expect(warnings(report, 'visual').map(f => f.file)).toEqual(['b/main.pdf'])
    const phase = (id: string) => report.phases.find(item => item.id === id)?.missing ?? []
    expect(phase('latex')).toContain('Compiled pages not inspected')
    expect(phase('experiments')).toEqual([expect.stringMatching(/error\(s\) in figures/)])
    expect(phase('review')).toEqual([expect.stringMatching(/^No current review/)])
    expect(phase('submission')).toEqual([expect.stringMatching(/error\(s\) in figures/), 'No current review', 'Compiled pages not inspected'])
    p.compilations.push({ ...p.compilations[0]!, status: 'failed', diagnostics: ['Overfull \\hbox only'] })
    expect(errors(await runChecks(p, 100000, 'compile'), 'compile').map(f => f.message)).toEqual(['The last compile failed (log: b/log)'])
    expect(originAt({ main: 'm.tex', text: '', origins: [], files: [], missingInputs: [] }, 5)).toEqual({ file: 'm.tex', line: 1 })
    expect(await listProjectFiles(join(p.root, 'does-not-exist'), () => true)).toEqual([])
  })

  it('stops reading configuration once its byte budget is spent, and skips unreadable files', async () => {
    const p = await fixture('proposal')
    await write(p.root, 'paper/main.tex', '\\documentclass{x}\n\\begin{tikzpicture}\\end{tikzpicture}\n\\section{Results}\n0.33\n')
    for (const name of ['a', 'b', 'c']) await write(p.root, `code/${name}.yaml`, `v: 0.${name === 'c' ? '33' : '11'}\n${'#'.repeat(80)}`)
    await write(p.root, 'code/big.json', 'x'.repeat(200))
    const report = await runChecks(p, 100)
    expect(warnings(report, 'numbers').map(f => f.message.split(' ')[0])).toEqual(['0.33'])
    expect(report.phases.find(phase => phase.id === 'figures')?.missing.join('\n')).not.toMatch(/architecture diagram/)
  })

  it('reports citations without any bibliography and strips only unescaped comments', async () => {
    const p = await fixture('proposal')
    await write(p.root, 'paper/main.tex', '\\documentclass{article}\n\\cite{x}\n')
    const report = await runChecks(p, 100000)
    expect(errors(report, 'cite').map(f => f.message)).toEqual([
      'The paper cites sources but names no bibliography file (\\bibliography or \\addbibresource)',
      'Citation key has no bibliography entry: x',
    ])
    expect(stripComment('50\\% done % note')).toBe('50\\% done ')
    expect(stripComment('line \\\\% comment')).toBe('line \\\\')
  })
})
