import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { newProject, putClaim, searchEvidence, invalidate, validateLinks } from '../src/project.ts'
import { assertUsableProjectRoot, errorText, isInside, isMetadataPath, keepRevision, projectPath, hashBytes, protectedDirectories, sameDirectory, truncateBytes, writeNew } from '../src/files.ts'
import { adoptExternalEdit, importEvidence, importTemplate, texExecutable, writeArtifact, exportPaper } from '../src/artifacts.ts'
import { collectRunOutputs, observationDue, validateExperiment } from '../src/experiments.ts'
import { migrateProject, researchDomain } from '../src/schema.ts'
import type { ArtifactId, CheckReport, EnvironmentId, EvidenceId, ExperimentRecord, ExperimentSpec, ResearchProject } from '../src/types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

const roots: string[] = []
let savedHome: string | undefined
beforeEach(() => { savedHome = process.env.DSH_HOME })
afterEach(async () => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
async function project(): Promise<ResearchProject> {
  return newProject({ root: await temporary('research 中文 path '), title: 'Evidence study', brief: 'Test a falsifiable hypothesis' }, 'workspace' as WorkspaceId)
}
const input = { evidence: [], claimIds: [], inputArtifacts: [] }
const components = { python: async () => 'python' } as never
const signal = new AbortController().signal

describe('artifacts are recorded, never refused for being edited elsewhere', () => {
  it('adopts external edits as revisions, keeps every version, and only a supplied stale revision conflicts', async () => {
    const p = await project()
    const first = await writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'paper/main.tex', content: 'first', kind: 'manuscript', ...input }, 'agent', 10000)
    await writeFile(join(p.root, first.path), 'human edit')
    await expect(writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: first.path, content: 'stale view', kind: 'manuscript', expectedRevision: 1, ...input }, 'user', 10000))
      .rejects.toThrow(/revision 2, not 1/)
    expect(await readFile(join(p.root, first.path), 'utf8')).toBe('human edit')
    const saved = await writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: first.path, content: 'agent rewrite', kind: 'manuscript', ...input }, 'agent', 10000)
    expect(saved.revision).toBe(3)
    for (const [revision, text] of [[1, 'first'], [2, 'human edit'], [3, 'agent rewrite']] as const) {
      expect(await readFile(join(p.root, `.research/history/${first.id}/${revision}.tex`), 'utf8')).toBe(text)
    }
    const same = await writeArtifact(p, { action: 'register-artifact', projectId: p.id, path: first.path, kind: 'supplement', ...input }, 'user', 10000)
    expect(same).toMatchObject({ revision: 3, kind: 'supplement' })
    expect(await adoptExternalEdit(p, same)).toBe(false)
    await rm(join(p.root, first.path))
    expect(await adoptExternalEdit(p, same)).toBe(false)
  })

  it('adopts an unregistered existing file before replacing it and rejects unknown inputs, claims and missing files', async () => {
    const p = await project()
    await mkdir(join(p.root, 'paper'), { recursive: true })
    await writeFile(join(p.root, 'paper/notes.md'), 'hand written')
    const saved = await writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'paper/notes.md', content: 'replaced', kind: 'supplement', ...input }, 'agent', 10000)
    expect(saved.revision).toBe(2)
    expect(await readFile(join(p.root, `.research/history/${saved.id}/1.md`), 'utf8')).toBe('hand written')
    await expect(writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'a.txt', content: 'x', kind: 'supplement', ...input, inputArtifacts: [{ id: 'ghost' as ArtifactId, revision: 1 }] }, 'agent', 10000)).rejects.toThrow(/Unknown input artifact/)
    await expect(writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'a.txt', content: 'x', kind: 'supplement', ...input, claimIds: ['c'] }, 'agent', 10000)).rejects.toThrow(/Unknown claim/)
    await expect(writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'a.txt', content: 'x'.repeat(20), kind: 'supplement', ...input }, 'agent', 10)).rejects.toThrow(/limit/)
    await expect(writeArtifact(p, { action: 'register-artifact', projectId: p.id, path: 'missing.txt', kind: 'supplement', ...input }, 'agent', 10000)).rejects.toThrow(/File not found/)
    await expect(writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'fresh.txt', content: 'x', kind: 'supplement', expectedRevision: 1, ...input }, 'agent', 10000))
      .rejects.toThrow(/revision 0, not 1/)
    const stale = await writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'b.txt', content: 'y', kind: 'figure', ...input, inputArtifacts: [{ id: saved.id, revision: 1 }] }, 'agent', 10000)
    expect(stale.inputArtifacts).toEqual([{ id: saved.id, revision: 1 }])
  })

  it('refuses the metadata directory however the path is spelled (B4)', async () => {
    const p = await project()
    for (const path of ['.research/runs/x/metrics.json', './.research/x', 'paper/../.research/x', '.RESEARCH/x', '.Research\\runs\\script.py']) {
      await expect(writeArtifact(p, { action: 'save-artifact', projectId: p.id, path, content: '{}', kind: 'code', ...input }, 'agent', 10000)).rejects.toThrow(/metadata directory/)
    }
    expect(isMetadataPath('research/x')).toBe(false)
    expect(isMetadataPath('.researchers/x')).toBe(false)
    await expect(projectPath(p.root, '../outside.tex')).rejects.toThrow(/outside/)
    expect(await projectPath(p.root, 'paper/中文.tex')).toBe(join(p.root, 'paper/中文.tex'))
    const elsewhere = await temporary('research-elsewhere-')
    await symlink(elsewhere, join(p.root, 'linked'), 'junction')
    await expect(projectPath(p.root, 'linked/secret.txt')).rejects.toThrow(/symlink points outside/)
    await expect(projectPath(p.root, 'bad\0name')).rejects.toThrow()
  })

  it('exports every time, and names the archive a submission only when the check is clean and the PDF current', async () => {
    const p = await project()
    await writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'paper/main.tex', content: '\\documentclass{article}', kind: 'manuscript', ...input }, 'agent', 10000)
    await writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'paper/gone.txt', content: 'x', kind: 'supplement', ...input }, 'agent', 10000)
    await rm(join(p.root, 'paper/gone.txt'))
    const report = (clean: boolean): CheckReport => ({ clean, scope: 'all', phases: [], findings: [], checkedAt: '' })
    const draft = await exportPaper(p, 10000, report(false))
    expect(draft.final).toBe(false)
    expect(draft.path).toMatch(/draft-\d+\.zip$/)
    expect((await readFile(draft.path)).subarray(0, 2).toString()).toBe('PK')
    expect((await exportPaper(p, 10000, report(true))).final).toBe(false)
    await expect(exportPaper(p, 1, report(true))).rejects.toThrow(/export size limit/)
  })

  it('carries every source the paper reads into the archive, registered or not', async () => {
    const p = await project()
    const files: Record<string, string> = {
      'paper/main.tex': '\\documentclass{venue}\\input{intro}\\includegraphics{plot}\\includegraphics{missing}\\bibliography{refs}',
      'paper/intro.tex': 'Intro',
      'paper/refs.bib': '@article{a, title={A}}',
      'figures/plot.pdf': '%PDF',
      'template/venue.cls': '% class',
      'styles/extra.sty': '% style',
      'data/raw.csv': 'a\n1',
    }
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(p.root, path, '..'), { recursive: true })
      await writeFile(join(p.root, path), text)
    }
    const { path } = await exportPaper(p, 10000, { clean: true, scope: 'all', phases: [], findings: [], checkedAt: '' })
    const archive = unzipSync(await readFile(path))
    for (const name of ['paper/main.tex', 'paper/intro.tex', 'paper/refs.bib', 'figures/plot.pdf', 'template/venue.cls', 'styles/extra.sty']) {
      expect(Object.keys(archive)).toContain(name)
    }
    expect(Object.keys(archive)).not.toContain('data/raw.csv')
    const bare = await project()
    const { path: empty } = await exportPaper(bare, 10000, { clean: false, scope: 'all', phases: [], findings: [], checkedAt: '' })
    expect(Object.keys(unzipSync(await readFile(empty)))).toEqual(['research-manifest.json'])
  })
})

describe('imports stay inside the project unless the user chose otherwise, and never touch credential stores', () => {
  it('imports sources relative to the project root and keeps the anchored original', async () => {
    const p = await project()
    await mkdir(join(p.root, 'data'), { recursive: true })
    await writeFile(join(p.root, 'data', 'notes.txt'), 'a,b\n1,2\n')
    const evidence = await importEvidence(p, 'data/notes.txt', components, signal, 10000)
    expect(evidence.originalPath).toBe(join(p.root, 'data', 'notes.txt'))
    expect(evidence.coverage).toBe('full-text')
    expect(await readFile(join(p.root, evidence.path), 'utf8')).toBe('a,b\n1,2\n')
    expect(await importEvidence(p, 'data/notes.txt', components, signal, 10000, evidence)).toBe(evidence)
    await expect(importEvidence(p, '.research/sources/x.txt', components, signal, 10000)).rejects.toThrow(/metadata directory/)
    await writeFile(join(p.root, 'data', 'bad.exe'), 'x')
    await expect(importEvidence(p, 'data/bad.exe', components, signal, 10000)).rejects.toThrow(/Unsupported/)
    await expect(importEvidence(p, 'data/notes.txt', components, signal, 3)).rejects.toThrow(/smaller than/)
  })

  it('refuses the product home (its credential store) and key directories even for absolute paths (B2)', async () => {
    const home = await temporary('research-home-')
    process.env.DSH_HOME = home
    await writeFile(join(home, '.credentials.yaml'), 'DEEPSEEK_API_KEY: secret')
    const p = await project()
    await expect(importEvidence(p, join(home, '.credentials.yaml'), components, signal, 10000)).rejects.toThrow(/credential or key directory/)
    await expect(importTemplate(p, [home], 10000)).rejects.toThrow(/credential or key directory/)
    expect(protectedDirectories(home)).toEqual(expect.arrayContaining([home, join(homedir(), '.ssh')]))
  })

  it('copies only template file types, skips hidden entries and bounds size and count (B3)', async () => {
    const p = await project()
    const outside = await temporary('research-template-')
    await mkdir(join(outside, 'acmart', 'samples'), { recursive: true })
    await mkdir(join(outside, '.git'), { recursive: true })
    await writeFile(join(outside, 'acmart', 'acmart.cls'), 'class')
    await writeFile(join(outside, 'acmart', 'samples', 'guide.tex'), 'guide')
    await writeFile(join(outside, 'acmart', 'id_rsa'), 'key')
    await writeFile(join(outside, '.git', 'config'), 'x')
    // A link inside the template is neither a file nor a directory to the walk, and is left behind.
    await symlink(await temporary('research-linked-template-'), join(outside, 'acmart', 'linked'), 'junction')
    const copied = await importTemplate(p, [outside, join(outside, 'acmart', 'acmart.cls')], 10000)
    expect(copied.sort()).toEqual(['template/acmart.cls', 'template/acmart/acmart.cls', 'template/acmart/samples/guide.tex'])
    expect(await readFile(join(p.root, 'template', 'acmart', 'acmart.cls'), 'utf8')).toBe('class')
    await expect(importTemplate(p, [outside], 3)).rejects.toThrow(/byte limit/)
    for (let index = 0; index < 9; index++) await writeFile(join(outside, 'acmart', `part${index}.sty`), 'x'.repeat(9))
    await expect(importTemplate(p, [outside], 9)).rejects.toThrow(/configured size limit/)
    const many = await temporary('research-many-')
    for (let index = 0; index < 401; index++) await writeFile(join(many, `f${index}.sty`), '')
    await expect(importTemplate(p, [many], 10000)).rejects.toThrow(/at most 400/)
    await expect(importTemplate(p, [join(outside, 'nothing-here')], 10000)).rejects.toThrow()
    const device = process.platform === 'win32' ? '\\\\.\\NUL' : '/dev/null'
    await expect(importTemplate(p, [device], 10000)).rejects.toThrow(/neither a file nor a directory/)
  })

  it('names TeX programs the way each platform installs them', () => {
    expect(texExecutable(join('tex', 'bin'), 'pdflatex', 'win32')).toBe(join('tex', 'bin', 'pdflatex.exe'))
    expect(texExecutable(join('tex', 'bin'), 'biber', 'linux')).toBe(join('tex', 'bin', 'biber'))
  })
})

describe('the ledger records and marks stale; nothing downstream is reset', () => {
  it('invalidates data-driven figures and their manuscript dependents, transitively through runs', async () => {
    const p = await project(), id = 'data' as EvidenceId
    p.evidence.push({ id, title: 'results', kind: 'file', path: 'data.csv', sha256: hashBytes('1'), revision: 1, importedAt: '', chunks: [{ text: '1', locator: { key: 'accuracy' } }], coverage: 'data', verified: true, stale: false })
    const figure = await writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'figures/a.svg', content: '<svg/>', kind: 'figure', ...input, evidence: [{ evidenceId: id, revision: 1, locator: { key: 'accuracy' }, quote: '1' }] }, 'agent', 10000)
    const manuscript = await writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'paper/main.tex', content: 'result', kind: 'manuscript', ...input, inputArtifacts: [{ id: figure.id, revision: 1 }] }, 'agent', 10000)
    p.experiments.push({ id: 'run' as ExperimentRecord['id'], spec: { dataEvidenceIds: [id], codeArtifactIds: [] } as unknown as ExperimentSpec, status: 'completed', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: {}, message: '', snapshotPath: '', collected: true })
    p.evidence.push({ id: 'metrics' as EvidenceId, title: 'm', kind: 'experiment', path: '.research/runs/run/metrics.json', sha256: 'h', revision: 1, importedAt: '', chunks: [], coverage: 'data', verified: true, stale: false })
    p.claims.push({ id: 'claim', text: 'c', kind: 'empirical', state: 'supported', evidence: [{ evidenceId: id, revision: 1, locator: {}, quote: '' }], artifactIds: [figure.id] })
    p.claims.push({ id: 'unrelated', text: 'u', kind: 'method', state: 'proposed', evidence: [], artifactIds: [] })
    invalidate(p, { evidenceId: id })
    expect(figure.stale).toBe(true); expect(manuscript.stale).toBe(true)
    expect(p.evidence.find(e => e.id === 'metrics')?.stale).toBe(true)
    expect(p.claims[0]?.state).toBe('stale')
    const code = await writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'code/train.py', content: 'print()', kind: 'code', ...input }, 'agent', 10000)
    p.experiments.push({ ...p.experiments[0]!, id: 'run2' as ExperimentRecord['id'], spec: { dataEvidenceIds: [], codeArtifactIds: [code.id] } as unknown as ExperimentSpec })
    p.evidence.push({ id: 'metrics2' as EvidenceId, title: 'm', kind: 'experiment', path: '.research/runs/run2/metrics.json', sha256: 'h', revision: 1, importedAt: '', chunks: [], coverage: 'data', verified: true, stale: false })
    invalidate(p, { artifactId: code.id })
    expect(p.evidence.find(e => e.id === 'metrics2')?.stale).toBe(true)
  })

  it('records contradicted claims without resetting anything, and keeps claim anti-fabrication rules', async () => {
    const p = await project()
    const figure = await writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'figures/a.svg', content: '<svg/>', kind: 'figure', ...input }, 'agent', 10000)
    putClaim(p, { id: 'negative', text: 'No improvement', kind: 'empirical', state: 'contradicted', evidence: [], artifactIds: [figure.id] })
    expect(figure.stale).toBe(false)
    putClaim(p, { id: 'negative', text: 'Changed wording', kind: 'empirical', state: 'contradicted', evidence: [], artifactIds: [figure.id] })
    expect(p.artifacts.find(a => a.id === figure.id)?.stale).toBe(true)
    expect(() => { putClaim(p, { id: 'x', text: 't', kind: 'method', state: 'supported', evidence: [], artifactIds: [] }) }).toThrow(/requires source evidence/)
    p.evidence.push({ id: 'txt' as EvidenceId, title: 't', kind: 'file', path: 't', sha256: 'h', revision: 1, importedAt: '', chunks: [{ text: 'abc', locator: { line: 1 } }], coverage: 'full-text', verified: true, stale: false })
    expect(() => { putClaim(p, { id: 'x', text: 't', kind: 'method', state: 'supported', evidence: [{ evidenceId: 'txt' as EvidenceId, revision: 1, locator: {}, quote: '' }], artifactIds: [] }) }).toThrow(/exact quoted content/)
    expect(() => { putClaim(p, { id: 'x', text: 't', kind: 'empirical', state: 'supported', evidence: [{ evidenceId: 'txt' as EvidenceId, revision: 1, locator: { line: 1 }, quote: 'abc' }], artifactIds: [] }) }).toThrow(/verified experiment or imported data/)
    expect(() => { putClaim(p, { id: 'x', text: 't', kind: 'hypothesis', state: 'proposed', evidence: [], artifactIds: ['ghost' as ArtifactId] }) }).toThrow(/Unknown artifact/)
    p.evidence.push({ id: 'unverified' as EvidenceId, title: 'u', kind: 'file', path: 'u', sha256: 'h', revision: 1, importedAt: '', chunks: [{ text: '0.5', locator: { line: 1 } }], coverage: 'data', verified: false, stale: false })
    expect(() => { putClaim(p, { id: 'x', text: 't', kind: 'empirical', state: 'supported', evidence: [{ evidenceId: 'unverified' as EvidenceId, revision: 1, locator: { line: 1 }, quote: '0.5' }], artifactIds: [] }) }).toThrow(/verified experiment/)
    // A claim whose figure was deleted can still be revised.
    p.artifacts = p.artifacts.filter(a => a.id !== figure.id)
    putClaim(p, { id: 'negative', text: 'Revised after removal', kind: 'empirical', state: 'contradicted', evidence: [], artifactIds: [] })
    expect(p.claims.find(c => c.id === 'negative')?.text).toBe('Revised after removal')
  })

  it('marks files stating a claim out of date when the claim goes stale', async () => {
    const p = await project(), id = 'data' as EvidenceId
    p.evidence.push({ id, title: 'results', kind: 'file', path: 'data.csv', sha256: 'h', revision: 1, importedAt: '', chunks: [], coverage: 'data', verified: true, stale: false })
    p.claims.push({ id: 'claim', text: 'c', kind: 'empirical', state: 'supported', evidence: [{ evidenceId: id, revision: 1, locator: {}, quote: '' }], artifactIds: [] })
    p.claims.push({ id: 'fine', text: 'f', kind: 'method', state: 'proposed', evidence: [], artifactIds: [] })
    const states = await writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'paper/claims.tex', content: 'x', kind: 'manuscript', ...input, claimIds: ['claim'] }, 'agent', 10000)
    const other = await writeArtifact(p, { action: 'save-artifact', projectId: p.id, path: 'paper/other.tex', content: 'x', kind: 'manuscript', ...input, claimIds: ['fine'] }, 'agent', 10000)
    invalidate(p, { evidenceId: id })
    expect(states.stale).toBe(true)
    expect(other.stale).toBe(false)
  })

  it('matches quotes across extracted line-break whitespace and rejects moved locations', async () => {
    const p = await project()
    p.evidence.push({ id: 'pdf' as EvidenceId, title: 'paper', kind: 'file', path: 'p.pdf', sha256: hashBytes('p'), revision: 3, importedAt: '', chunks: [{ text: 'the accuracy\n   reaches 99 percent', locator: { page: 2 } }], coverage: 'full-text', verified: true, stale: false })
    expect(() => { validateLinks(p, [{ evidenceId: 'pdf' as EvidenceId, revision: 3, locator: { page: 2 }, quote: 'accuracy reaches' }]) }).not.toThrow()
    expect(() => { validateLinks(p, [{ evidenceId: 'pdf' as EvidenceId, revision: 3, locator: { page: 1 }, quote: 'accuracy reaches' }]) }).toThrow(/location/)
    expect(() => { validateLinks(p, [{ evidenceId: 'pdf' as EvidenceId, revision: 2, locator: {}, quote: '' }]) }).toThrow(/outdated/)
  })

  it('ranks whole-phrase evidence hits above scattered term hits within the byte cap', async () => {
    const p = await project()
    p.evidence.push(
      { id: 'scattered' as EvidenceId, title: 'notes', kind: 'file', path: 'a.txt', sha256: hashBytes('a'), revision: 1, importedAt: '', chunks: [{ text: 'alpha is far from gamma in this note', locator: { line: 1 } }], coverage: 'full-text', verified: true, stale: false },
      { id: 'phrase' as EvidenceId, title: 'report', kind: 'file', path: 'b.txt', sha256: hashBytes('b'), revision: 2, importedAt: '', chunks: [{ text: `prefix ${'x'.repeat(200)} the alpha gamma result suffix`, locator: { line: 1 } }], coverage: 'full-text', verified: true, stale: false },
    )
    p.evidence.push(
      { id: 'partial' as EvidenceId, title: 'gamma notes', kind: 'file', path: 'c.txt', sha256: hashBytes('c'), revision: 1, importedAt: '', chunks: [{ text: 'only alpha here', locator: { line: 1 } }, { text: 'nothing relevant', locator: { line: 2 } }], coverage: 'full-text', verified: true, stale: false },
    )
    const hits = JSON.parse(searchEvidence(p, 'alpha gamma', 100000).content) as { evidenceId: string; text: string; score: number }[]
    expect(hits[0]?.evidenceId).toBe('phrase')
    expect(hits[0]?.text).toContain('alpha gamma')
    expect(hits.find(hit => hit.evidenceId === 'partial')?.score).toBe(2)
    expect(hits).toHaveLength(3)
    expect(searchEvidence(p, 'alpha', 40).content).toBe('[]')
  })

  it('creates projects in the chosen mode, or the general one, with checkpoint autonomy by default', () => {
    const routed = newProject({ root: 'r', title: ' T ', brief: '', mode: 'spark-to-paper', route: 'idea', autonomy: 'automatic' }, 'w' as WorkspaceId)
    expect(routed).toMatchObject({ title: 'T', mode: 'spark-to-paper', route: 'idea', modeSetBy: 'user', autonomy: 'automatic', decisions: [] })
    const general = newProject({ root: 'r', title: 'T', brief: '' }, 'w' as WorkspaceId)
    expect(general.mode).toBe('general')
    expect('route' in general || 'modeSetBy' in general).toBe(false)
    expect(general.autonomy).toBe('checkpoints')
  })
})

describe('version-1 records migrate into the ledger shape', () => {
  it('drops the stage machine and budget, keeps confirmations as user decisions and maps the old modes', () => {
    const legacy = {
      id: 'p', mode: 'spark', updatedAt: '2026-09-01T00:00:00.000Z', paused: true, budget: { maxRuns: 1 }, pendingPrompt: {},
      stages: [
        { id: 'question', summary: ' Does X help? ', confirmedRevision: 2, confirmedAt: '2026-09-02T00:00:00.000Z' },
        { id: 'method', confirmedRevision: 1 },
        { id: 'draft' },
      ],
    }
    const migrated = migrateProject(legacy) as Record<string, unknown>
    expect(migrated).toMatchObject({ id: 'p', mode: 'spark-to-paper', route: 'proposal', modeSetBy: 'user', autonomy: 'checkpoints' })
    expect(migrated.decisions).toEqual([
      { id: 'stage-question', question: 'Confirm the question proposal', answer: 'Does X help?', by: 'user', rationale: '', at: '2026-09-02T00:00:00.000Z' },
      { id: 'stage-method', question: 'Confirm the method proposal', answer: 'Confirmed', by: 'user', rationale: '', at: '2026-09-01T00:00:00.000Z' },
    ])
    for (const key of ['stages', 'paused', 'budget', 'pendingPrompt']) expect(key in migrated).toBe(false)
    expect((migrateProject({ stages: [{ id: 'x', confirmedRevision: 0 }], mode: 'evidence' }) as { mode: string; decisions: { at: string }[] }))
      .toMatchObject({ mode: 'spark-to-paper', route: 'data', decisions: [{ at: new Date(0).toISOString() }] })
    expect(migrateProject({ stages: undefined, mode: 'other' })).toMatchObject({ mode: 'general' })
    const current = { id: 'p', mode: 'spark-to-paper', route: 'idea', lastCheck: { phases: [] }, decisions: [] }
    expect(migrateProject(current)).toBe(current)
    expect(migrateProject(null)).toBeNull()
    // The single-document layout rejects other stamped versions, so the schema carries old records forward instead.
    expect(researchDomain.version).toBe(1)
  })

  it('moves the built-in modes onto the packs that succeeded them and drops their stale last check', () => {
    const lastCheck = { clean: false, scope: 'all', mode: 'paper-first', phases: [{ id: 'draft', done: false, missing: [] }], findings: [], checkedAt: 'x' }
    expect(migrateProject({ id: 'a', mode: 'paper-first', lastCheck })).toEqual({ id: 'a', mode: 'spark-to-paper', route: 'proposal' })
    expect(migrateProject({ id: 'b', mode: 'from-results', lastCheck })).toEqual({ id: 'b', mode: 'spark-to-paper', route: 'data' })
    expect(migrateProject({ id: 'c', mode: 'free', lastCheck })).toEqual({ id: 'c', mode: 'general' })
    expect(migrateProject({ id: 'd', lastCheck })).toEqual({ id: 'd', mode: 'general' })
    expect(migrateProject('text')).toBe('text')
  })
})

describe('project root floor, containment helpers and text limits', () => {
  it('rejects filesystem roots, the home directory and system locations on any drive, but not shallow dedicated folders', () => {
    expect(() => { assertUsableProjectRoot('C:\\', 'win32', 'C:\\Users\\me') }).toThrow(/filesystem root/)
    expect(() => { assertUsableProjectRoot('c:\\users\\ME', 'win32', 'C:\\Users\\me') }).toThrow(/home directory/)
    expect(() => { assertUsableProjectRoot('D:\\Program Files\\x', 'win32', 'C:\\Users\\me') }).toThrow(/system locations/)
    expect(() => { assertUsableProjectRoot('E:\\WINDOWS', 'win32', 'C:\\Users\\me') }).toThrow(/system locations/)
    expect(() => { assertUsableProjectRoot('D:\\research', 'win32', 'C:\\Users\\me') }).not.toThrow()
    expect(() => { assertUsableProjectRoot('/', 'linux', '/home/me') }).toThrow(/filesystem root/)
    expect(() => { assertUsableProjectRoot('/home/me', 'linux', '/home/me') }).toThrow(/home directory/)
    expect(() => { assertUsableProjectRoot('/usr/local/x', 'linux', '/home/me') }).toThrow(/system locations/)
    expect(() => { assertUsableProjectRoot('/tmp', 'darwin', '/Users/me') }).toThrow(/system locations/)
    expect(() => { assertUsableProjectRoot('/research', 'linux', '/home/me') }).not.toThrow()
    expect(() => { assertUsableProjectRoot(homedir()) }).toThrow(/dedicated/)
    const root = process.platform === 'win32' ? 'C:\\' : '/'
    expect(isInside(root, join(root, 'a'))).toBe(true)
    expect(isInside(join(root, 'a'), join(root, 'b'))).toBe(false)
    expect(sameDirectory(join(root, 'A'), join(root, 'A', '.'))).toBe(true)
    expect(sameDirectory('C:\\Data\\A', 'c:\\data\\a\\', 'win32')).toBe(true)
    expect(sameDirectory('/data/A', '/data/a', 'linux')).toBe(false)
    expect(isInside('C:\\Data\\Proj', 'c:\\data\\proj\\x', 'win32')).toBe(true)
    expect(isInside('/data/Proj', '/data/proj/x', 'linux')).toBe(false)
    expect(isInside('/data/proj', '/data/proj', 'linux')).toBe(true)
    expect(isInside('/data/proj', '/data', 'linux')).toBe(false)
    expect(errorText(new Error('boom'))).toBe('boom')
    expect(errorText('plain')).toBe('plain')
  })

  it('truncates on byte boundaries without splitting multibyte characters', () => {
    const text = '中文汉字' // four 3-byte characters
    expect(truncateBytes(text, 20)).toBe(text)
    expect(Buffer.byteLength(truncateBytes(text, 7))).toBeLessThanOrEqual(7)
    expect(truncateBytes(text, 7)).toBe('中文')
    expect(truncateBytes('abcdef', 4)).toBe('abcd')
    expect(truncateBytes('中', 2)).toBe('')
    expect(truncateBytes('a😀', 4)).toBe('a')
  })

  it('keeps an immutable revision once, tolerating an identical copy and refusing a different one', async () => {
    const root = await temporary('research-revisions-')
    await writeFile(join(root, 'a.txt'), 'same')
    await keepRevision(join(root, 'a.txt'), join(root, 'history', '1.txt'))
    await keepRevision(join(root, 'a.txt'), join(root, 'history', '1.txt'))
    await writeFile(join(root, 'a.txt'), 'different')
    await expect(keepRevision(join(root, 'a.txt'), join(root, 'history', '1.txt'))).rejects.toThrow()
    await expect(keepRevision(join(root, 'missing.txt'), join(root, 'history', '2.txt'))).rejects.toThrow()
  })

  it('creates a new file only once and reports other write failures', async () => {
    const root = await temporary('research-new-')
    expect(await writeNew(join(root, 'image.png'), new Uint8Array([1]))).toBe(true)
    expect(await writeNew(join(root, 'image.png'), new Uint8Array([2]))).toBe(false)
    expect(await readFile(join(root, 'image.png'))).toEqual(Buffer.from([1]))
    await expect(writeNew(join(root, 'missing', 'image.png'), new Uint8Array([1]))).rejects.toThrow(/ENOENT/)
  })
})

describe('experiments are validated for shape only', () => {
  const ready = (p: ResearchProject): void => {
    p.environments.push({ id: 'env' as EnvironmentId, name: 'e', kind: 'uv', target: 'local', python: 'py', requirements: [], fingerprint: 'f', status: 'ready', details: '', isDefault: true })
  }
  const spec = (overrides: Partial<ExperimentSpec> = {}): ExperimentSpec => ({
    environmentId: 'env' as EnvironmentId, name: 'train', argv: ['{python}', 'code/train.py'], cwd: '.', seed: 0, maxSeconds: 86400, gpuIds: ['0', '1'],
    dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json', ...overrides,
  })
  it('runs without any confirmation, budget or registered entry script, and explains each shape problem', async () => {
    const p = await project()
    expect(() => validateExperiment(p, spec())).toThrow(/ready experiment environment/)
    ready(p)
    expect(validateExperiment(p, spec()).id).toBe('env')
    expect(() => validateExperiment(p, spec({ argv: ['python', 'x.py'] }))).toThrow(/\{python\}/)
    expect(() => validateExperiment(p, spec({ dataEvidenceIds: ['nope' as EvidenceId] }))).toThrow(/Unknown dataset/)
    expect(() => validateExperiment(p, spec({ codeArtifactIds: ['nope' as ArtifactId] }))).toThrow(/Unknown code artifact/)
    expect(() => validateExperiment(p, spec({ codePaths: ['../elsewhere'] }))).toThrow(/stay inside the project/)
    expect(() => validateExperiment(p, spec({ cwd: '' }))).not.toThrow()
  })
})

describe('experiment observation and output collection', () => {
  const run = (overrides: Partial<ExperimentRecord>): ExperimentRecord => ({
    id: 'run-1' as ExperimentRecord['id'],
    spec: { environmentId: 'env', name: 'train', argv: ['{python}', 'code/train.py'], cwd: '.', seed: 0, maxSeconds: 10, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' },
    status: 'unknown', createdAt: '', updatedAt: '', directory: '',
    inputRevision: 1, environmentFingerprint: '', metrics: {}, message: '', snapshotPath: '', collected: false,
    ...overrides,
  }) as ExperimentRecord
  it('honours the unknown-status observation backoff', () => {
    const now = 1000000
    expect(observationDue(run({}), now)).toBe(true)
    expect(observationDue(run({ nextObserveAt: now + 60000 }), now)).toBe(false)
    expect(observationDue(run({ nextObserveAt: now - 1 }), now)).toBe(true)
  })
  it('collects outputs/ files as verified data evidence', async () => {
    const p = await project()
    const directory = join(p.root, '.research', 'runs', 'run-1')
    await mkdir(join(directory, 'outputs', 'plots'), { recursive: true })
    await writeFile(join(directory, 'outputs', 'results.csv'), 'm,v\nacc,0.9\n')
    await writeFile(join(directory, 'outputs', 'plots', 'curve.png'), 'png')
    await writeFile(join(directory, 'outputs', '.hidden'), 'x')
    await writeFile(join(directory, 'outputs', 'huge.csv'), 'x'.repeat(300 * 1024))
    const record = run({ status: 'completed', directory })
    const evidence = await collectRunOutputs(p, record, 1024 * 1024, signal)
    expect(evidence.map(e => e.path).sort()).toEqual([
      '.research/runs/run-1/outputs/plots/curve.png',
      '.research/runs/run-1/outputs/results.csv',
    ])
    expect(evidence.every(e => e.verified && e.coverage === 'data' && e.kind === 'experiment')).toBe(true)
    expect(evidence.find(e => e.path.endsWith('results.csv'))?.chunks[0]?.text).toContain('acc')
    const empty = run({ status: 'completed', directory: join(p.root, '.research', 'runs', 'run-2') })
    expect(await collectRunOutputs(p, empty, 10000, signal)).toEqual([])
  })
})
