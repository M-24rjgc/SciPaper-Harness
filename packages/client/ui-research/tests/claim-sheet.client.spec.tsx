// @vitest-environment jsdom

/**
 * The claim sheet over the real state machine. The project it draws comes out
 * of the service's own transitions, every claim on screen was admitted by the
 * real `putClaim`, and each source the sheet stops vouching for is one the
 * backend itself refuses the next time the claim is written.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { invalidate, newProject, putClaim } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { importEvidence, writeArtifact } from '@deepseek-ai/dsh-research-workbench/src/artifacts.ts'
import { hashBytes } from '@deepseek-ai/dsh-research-workbench/src/files.ts'
import type {
  ClaimRecord, EnvironmentId, EvidenceId, EvidenceRecord, ExperimentId, ExperimentRecord,
  ResearchProject, ResearchSnapshot,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchClaimSheet } from '../src/client/ClaimSheet.tsx'
import type { ResearchFocus, ResearchView, WorkbenchProps } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'

const LIMIT = 100_000
const RUN_ID = 'run-block-sparse' as ExperimentId
const WARMUP_ID = 'run-warmup' as ExperimentId
const ABSTRACT = 'Block-sparse attention retains 97% of dense accuracy at one quarter of the FLOPs.'
const PREPRINT_ABSTRACT = 'Decoding stays memory-bound below 8k context, where sparsity buys nothing.'
const WITHDRAWN_ABSTRACT = 'A scaling note the authors withdrew after a measurement error.'
const BIBTEX = '@inproceedings{sparse2026, title={Block-sparse attention at quarter FLOPs}}'
const NOTES = '# 长上下文笔记\n\n32k 上下文下，稠密注意力的显存占用是块稀疏的 3.1 倍。\n'
const NOTES_QUOTE = '显存占用是块稀疏的 3.1 倍'
const NOTES_FILE = 'long-context-notes.md'
// `.md` extraction is pure Node line chunking; the component manager is only
// consulted on the pdf/docx/csv/json branch of `importEvidence`.
const NO_COMPONENTS = null as unknown as Parameters<typeof importEvidence>[2]

const roots: string[] = []

afterEach(async () => {
  cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** The elided digest the sheet prints for a source it still vouches for. */
function digest(sha256: string): string {
  return `sha256 ${sha256.slice(0, 6)}…${sha256.slice(-4)}`
}

/**
 * A verified reference in the shape `literature-import` stores it. The real
 * path needs a Crossref round-trip, so only the record is assigned; every claim
 * that points at it still goes through the real `putClaim`.
 */
function reference(id: string, title: string, abstract: string, verified: boolean, doi?: string): EvidenceRecord {
  const content = JSON.stringify({ title, abstract, doi })
  return {
    id: id as EvidenceId,
    title,
    kind: 'literature',
    path: `.research/sources/${id}/reference.json`,
    sha256: hashBytes(content),
    revision: 1,
    importedAt: '2026-09-18T09:20:00.000Z',
    chunks: [{ text: abstract, locator: { key: 'abstract' } }, { text: BIBTEX, locator: { key: 'bibtex' } }],
    sourceUrl: `https://example.org/${id}`,
    ...(doi === undefined ? {} : { doi }),
    coverage: 'abstract',
    verified,
    stale: false,
  }
}

/** Exactly the evidence the service's `collect` derives from a finished run. */
function runEvidence(run: ExperimentRecord): EvidenceRecord {
  const text = JSON.stringify(run.metrics, null, 2)
  return {
    id: `evidence-${run.id}` as EvidenceId,
    title: run.spec.name,
    kind: 'experiment',
    path: `.research/runs/${run.id}/metrics.json`,
    sha256: hashBytes(text),
    revision: 1,
    importedAt: '2026-09-19T14:06:00.000Z',
    chunks: Object.entries(run.metrics).map(([key, value]) => ({ text: String(value), locator: { key } })),
    coverage: 'data',
    verified: true,
    stale: false,
  }
}

interface Scene {
  project: ResearchProject
  notes: EvidenceRecord
  paper: EvidenceRecord
  preprint: EvidenceRecord
  runData: EvidenceRecord
  warmupData: EvidenceRecord
  supported: ClaimRecord
  fileOnly: ClaimRecord
  ghosted: ClaimRecord
}

/** One project carrying every shape of claim the sheet has to draw. */
async function scene(): Promise<Scene> {
  const root = await mkdtemp(join(tmpdir(), 'research-claim-'))
  roots.push(root)
  const project = newProject({
    root,
    title: 'Sparse attention scaling study',
    mode: 'spark-to-paper', route: 'data',
    brief: '块稀疏能否在 1/4 FLOPs 下保住长上下文准确率',
  }, 'workspace' as WorkspaceId)

  // A real import: the machine copies, chunks and hashes this file itself.
  await writeFile(join(root, NOTES_FILE), NOTES, 'utf8')
  const notes = await importEvidence(project, join(root, NOTES_FILE), NO_COMPONENTS, new AbortController().signal, LIMIT)
  project.evidence.push(notes)

  const results = await writeArtifact(project, {
    action: 'save-artifact', projectId: project.id, path: 'paper/results.md',
    content: '# 结果\n\n块稀疏在 1/4 FLOPs 下保住了精度。\n',
    kind: 'manuscript', expectedRevision: 0, evidence: [], claimIds: [], inputArtifacts: [],
  }, 'agent', LIMIT)

  // Runs come from the experiment supervisor, which needs a real child process
  // and a metrics file on disk, so both records are assigned in the shape the
  // supervisor writes them; everything derived from them is machine-made.
  const run: ExperimentRecord = {
    id: RUN_ID,
    spec: {
      environmentId: 'env-local' as EnvironmentId,
      name: '块稀疏 1/4 FLOPs 复现',
      argv: ['python', 'train.py'],
      cwd: 'code',
      seed: 20260919,
      maxSeconds: 600,
      gpuIds: ['0'],
      dataEvidenceIds: [notes.id],
      codeArtifactIds: [results.id],
      metricsPath: 'metrics.json',
    },
    status: 'completed',
    createdAt: '2026-09-19T13:40:00.000Z',
    updatedAt: '2026-09-19T14:05:00.000Z',
    directory: `.research/runs/${RUN_ID}`,
    inputRevision: project.researchRevision,
    environmentFingerprint: 'py3.12-torch2.6',
    metrics: { accuracy: 0.812, flops: 0.25 },
    exitCode: 0,
    message: '',
    snapshotPath: `.research/runs/${RUN_ID}/snapshot.json`,
    collected: true,
    startedAt: '2026-09-19T13:41:00.000Z',
    finishedAt: '2026-09-19T14:05:00.000Z',
  }
  const warmup: ExperimentRecord = {
    id: WARMUP_ID,
    spec: {
      environmentId: 'env-local' as EnvironmentId,
      name: '预热运行',
      argv: ['python', 'warmup.py'],
      cwd: 'code',
      seed: 7,
      maxSeconds: 60,
      gpuIds: [],
      dataEvidenceIds: [],
      codeArtifactIds: [],
      metricsPath: 'metrics.json',
    },
    status: 'cancelled',
    createdAt: '2026-09-19T13:10:00.000Z',
    updatedAt: '2026-09-19T13:12:00.000Z',
    directory: `.research/runs/${WARMUP_ID}`,
    inputRevision: project.researchRevision,
    environmentFingerprint: 'py3.12-torch2.6',
    metrics: {},
    message: '用户取消',
    snapshotPath: `.research/runs/${WARMUP_ID}/snapshot.json`,
    collected: true,
    startedAt: '2026-09-19T13:11:00.000Z',
  }
  project.experiments.push(run, warmup)

  const runData = runEvidence(run)
  // A cancelled run reported nothing, so `collect` skips it; the sheet still has
  // to survive the record, which is why this one is assigned alongside it.
  const warmupData = runEvidence(warmup)
  const paper = reference('lit-sparse', 'Block-sparse attention at quarter FLOPs', ABSTRACT, true, '10.1145/3592979')
  const preprint = reference('lit-preprint', 'Memory-bound decoding limits', PREPRINT_ABSTRACT, false)
  const withdrawn = reference('lit-withdrawn', 'A withdrawn scaling note', WITHDRAWN_ABSTRACT, true, '10.5555/withdrawn')
  project.evidence.push(paper, preprint, withdrawn, runData, warmupData)

  const supported: ClaimRecord = {
    id: 'claim-accuracy',
    text: '在 1/4 FLOPs 预算下，块稀疏注意力保住了长上下文精度。',
    kind: 'empirical',
    state: 'supported',
    evidence: [
      { evidenceId: paper.id, revision: 1, locator: { key: 'abstract' }, quote: ABSTRACT },
      { evidenceId: runData.id, revision: 1, locator: { key: 'accuracy' }, quote: '0.81' },
    ],
    artifactIds: [results.id],
  }
  putClaim(project, supported)

  // The other direction of the appearance link: this artifact names the claim,
  // and the claim will never learn about it.
  await writeArtifact(project, {
    action: 'save-artifact', projectId: project.id, path: 'paper/appendix.md',
    content: '# 附录\n', kind: 'supplement', expectedRevision: 0,
    evidence: [], claimIds: [supported.id], inputArtifacts: [],
  }, 'agent', LIMIT)

  putClaim(project, {
    id: 'claim-warmup',
    text: '预热运行还没有给出任何可以引用的数字。',
    kind: 'method',
    state: 'proposed',
    evidence: [{ evidenceId: warmupData.id, revision: 1, locator: {}, quote: '' }],
    artifactIds: [],
  })

  const fileOnly: ClaimRecord = {
    id: 'claim-memory',
    text: '32k 上下文下，稠密注意力的显存占用明显更高。',
    kind: 'method',
    state: 'proposed',
    evidence: [{ evidenceId: notes.id, revision: notes.revision, locator: { line: 1 }, quote: NOTES_QUOTE }],
    artifactIds: [],
  }
  putClaim(project, fileOnly)

  putClaim(project, {
    id: 'claim-orphan',
    text: '低秩近似也许同样够用。',
    kind: 'hypothesis',
    state: 'proposed',
    evidence: [],
    artifactIds: [],
  })

  const ghosted: ClaimRecord = {
    id: 'claim-ghosted',
    text: '撤稿那篇给出的缩放系数。',
    kind: 'literature',
    state: 'proposed',
    evidence: [{ evidenceId: withdrawn.id, revision: 1, locator: { key: 'abstract' }, quote: 'A scaling note' }],
    artifactIds: [],
  }
  putClaim(project, ghosted)
  // The backend validated this claim against a source that has since left the
  // project; `validateLinks` would never admit the same claim again.
  project.evidence = project.evidence.filter(item => item.id !== withdrawn.id)

  putClaim(project, {
    id: 'claim-decoding',
    text: '解码阶段同样能从稀疏化里拿到收益。',
    kind: 'hypothesis',
    state: 'contradicted',
    evidence: [{ evidenceId: preprint.id, revision: 1, locator: { key: 'abstract' }, quote: 'Decoding stays memory-bound below 8k context' }],
    artifactIds: [],
  })

  return { project, notes, paper, preprint, runData, warmupData, supported, fileOnly, ghosted }
}

/** What the plugin injects: the two store faces the sheet reads, and a recording `focusClaim`. */
function propsFor(
  snapshot: ResearchSnapshot | null, claimId: string | null, closed: (string | null)[], opened: string[] = [],
): WorkbenchProps {
  const view: ResearchView = { snapshot, tasks: [], busy: false, error: '', response: null }
  return {
    t: (key: string, params?: Record<string, unknown>) => {
      const template = (zh as Record<string, string>)[key] ?? key
      const values = params ?? {}
      return template.replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match)
    },
    run: () => Promise.resolve({ message: '' }),
    useResearch: (select: (value: ResearchView) => unknown) => select(view),
    useFocus: (select: (value: ResearchFocus) => unknown) => select({ claimId }),
    focusClaim: (next: string | null) => { closed.push(next) },
    openFile: (_root: string, path: string) => { opened.push(path) },
    expand: () => {},
    install: () => Promise.resolve(),
    configure: () => Promise.resolve(),
    refresh: () => Promise.resolve(),
    create: () => Promise.resolve(),
    openConversation: () => Promise.resolve(),
  } as unknown as WorkbenchProps
}

/** The snapshot the plugin publishes for one project. */
function snapshotOf(project: ResearchProject): ResearchSnapshot {
  return { projects: [project], preferences: {}, components: [] }
}

describe('the claim sheet shows what stands under one claim', () => {
  it('stays shut until the rail puts a claim that exists in focus', async () => {
    const { project } = await scene()
    const closed: (string | null)[] = []
    const view = render(<ResearchClaimSheet {...propsFor(snapshotOf(project), null, closed)} />)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    // Focused before the first snapshot arrived.
    view.rerender(<ResearchClaimSheet {...propsFor(null, 'claim-accuracy', closed)} />)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()

    // Focused on a claim this project no longer carries.
    view.rerender(<ResearchClaimSheet {...propsFor(snapshotOf(project), 'claim-withdrawn', closed)} />)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(closed).toEqual([])
  })

  it('draws a supported claim, both directions of its appearances, and both kinds of source', async () => {
    const { project, paper, runData } = await scene()
    const closed: (string | null)[] = []
    const opened: string[] = []
    const view = render(<ResearchClaimSheet {...propsFor(snapshotOf(project), 'claim-accuracy', closed, opened)} />)

    expect(view.getByRole('dialog').getAttribute('aria-label')).toBe(zh.claim)
    expect(view.getByText(zh.supported).getAttribute('data-tone')).toBe('success')
    expect(view.getByText('在 1/4 FLOPs 预算下，块稀疏注意力保住了长上下文精度。')).toBeTruthy()

    // The claim names one artifact; the other names the claim back.
    expect(view.getByText(zh.claimAppearsIn)).toBeTruthy()
    expect(view.getByText('paper/results.md · 第 1 版')).toBeTruthy()
    expect(view.getByText('paper/appendix.md · 第 1 版')).toBeTruthy()

    // The reference: doi, verification, quote, and the digest of a current source.
    expect(view.getByText('DOI 10.1145/3592979 · abstract · 第 1 版')).toBeTruthy()
    expect(view.getByText(zh.verified).getAttribute('data-tone')).toBe('success')
    expect(view.getByText(ABSTRACT)).toBeTruthy()
    expect(view.getByText(digest(paper.sha256))).toBeTruthy()
    fireEvent.click(view.getByText(zh.claimOpenSource))
    expect(opened).toEqual([paper.path])

    // The run behind the data source: seed, finish time, metrics, input snapshot.
    expect(view.getByText(zh.claimProjectData).getAttribute('data-tone')).toBe('info')
    const runMeta = view.getByText(/种子 20260919/)
    fireEvent.click(view.getByText(zh.claimOpenRun))
    expect(opened).toEqual([paper.path, runData.path])
    fireEvent.click(view.getByText('paper/results.md · 第 1 版'))
    expect(opened.at(-1)).toBe('paper/results.md')
    expect(runMeta.textContent).toMatch(/\d+ 月 \d+ 日 \d{2}:\d{2}/)
    expect(runMeta.textContent).toContain('第 1 版')
    expect(view.getByText('0.81')).toBeTruthy()
    expect(view.getByText('accuracy')).toBeTruthy()
    expect(view.getByText('0.812')).toBeTruthy()
    expect(view.getByText('flops')).toBeTruthy()
    expect(view.getByText('0.25')).toBeTruthy()
    expect(view.getByText(zh.claimOpenRun)).toBeTruthy()
    expect(view.getByText('输入快照 2 项 · 已锁定')).toBeTruthy()

    // One run, one reference.
    expect(view.getByText(zh.claimSourceMix)).toBeTruthy()
    expect(view.getByText('1 份本项目实验数据')).toBeTruthy()
    expect(view.getByText('1 篇已核实文献')).toBeTruthy()
    expect(view.getByText(zh.claimIfSourceChanges)).toBeTruthy()
    expect(view.getByText(zh.claimStaleExplain)).toBeTruthy()
    expect(view.getByText(zh.claimSupporting)).toBeTruthy()
    expect(view.getByText(zh.claimFooter)).toBeTruthy()

    fireEvent.click(view.getByTitle(zh.close))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closed).toEqual([null, null])
  })

  it('leaves a cancelled run without a quote, without measurements and without appearances', async () => {
    const { project, warmupData } = await scene()
    const opened: string[] = []
    const view = render(<ResearchClaimSheet {...propsFor(snapshotOf(project), 'claim-warmup', [], opened)} />)

    expect(view.getByText(zh.proposed).getAttribute('data-tone')).toBe('warning')
    expect(view.queryByText(zh.claimAppearsIn)).toBeNull()
    expect(view.getByText(zh.claimProjectData)).toBeTruthy()
    expect(view.getByText('种子 7 · 第 1 版')).toBeTruthy()
    fireEvent.click(view.getByText(zh.claimOpenRun))
    expect(opened).toEqual([warmupData.path])
    expect(document.body.querySelector('blockquote')).toBeNull()
    expect(view.queryByText('accuracy')).toBeNull()
    expect(view.getByText('输入快照 0 项 · 已锁定')).toBeTruthy()

    // Run data only.
    expect(view.getByText('1 份本项目实验数据')).toBeTruthy()
    expect(view.queryByText(/篇已核实文献/)).toBeNull()
  })

  it('keeps an unverified preprint on screen behind a contradicted claim', async () => {
    const { project, preprint } = await scene()
    const view = render(<ResearchClaimSheet {...propsFor(snapshotOf(project), 'claim-decoding', [])} />)

    expect(view.getByText(zh.contradicted).getAttribute('data-tone')).toBe('danger')
    expect(view.queryByText(zh.verified)).toBeNull()
    expect(view.getByText('abstract · 第 1 版')).toBeTruthy()
    expect(view.getByText('Decoding stays memory-bound below 8k context')).toBeTruthy()
    expect(view.getByText(digest(preprint.sha256))).toBeTruthy()

    // Literature only.
    expect(view.getByText('1 篇已核实文献')).toBeTruthy()
    expect(view.queryByText(/份本项目实验数据/)).toBeNull()
    // A contradiction is a recorded result; nothing downstream was reset by it.
    expect(project.artifacts.every(artifact => !artifact.stale)).toBe(true)
  })

  it('draws nothing for a source that left the project, and the backend refuses that claim', async () => {
    const { project, ghosted } = await scene()
    const view = render(<ResearchClaimSheet {...propsFor(snapshotOf(project), 'claim-ghosted', [])} />)

    expect(view.getByText('撤稿那篇给出的缩放系数。')).toBeTruthy()
    expect(view.getByText(zh.claimSupporting)).toBeTruthy()
    expect(document.body.querySelector('article')).toBeNull()
    expect(view.queryByText(zh.claimSourceMix)).toBeNull()
    expect(view.getByText(zh.claimFooter)).toBeTruthy()
    expect(() => { putClaim(project, ghosted) }).toThrow(/missing or outdated/)
  })

  it('says outright when a claim has nothing under it', async () => {
    const { project } = await scene()
    const view = render(<ResearchClaimSheet {...propsFor(snapshotOf(project), 'claim-orphan', [])} />)

    expect(view.getByText(zh.claimNoSources)).toBeTruthy()
    expect(view.queryByText(zh.claimSourceMix)).toBeNull()
    expect(document.body.querySelector('article')).toBeNull()
  })

  it('counts an imported file as neither, and drops its digest once the file is re-imported', async () => {
    const { project, notes, fileOnly } = await scene()
    const closed: (string | null)[] = []
    const opened: string[] = []
    const view = render(<ResearchClaimSheet {...propsFor(snapshotOf(project), 'claim-memory', closed, opened)} />)

    expect(view.getByText('第 1 行 · 第 1 版')).toBeTruthy()
    expect(view.getByText(NOTES_QUOTE)).toBeTruthy()
    expect(view.getByText(digest(notes.sha256))).toBeTruthy()
    expect(view.getByText(zh.claimOpenSource)).toBeTruthy()
    // An imported file is neither run data nor literature, so there is no mix.
    expect(view.queryByText(zh.claimSourceMix)).toBeNull()

    // The service's own refresh: changed content becomes a new revision, and the
    // link the claim holds is left pointing at the old one.
    await writeFile(join(project.root, NOTES_FILE), `${NOTES}\n4k 以下没有差别。\n`, 'utf8')
    const next = await importEvidence(project, join(project.root, NOTES_FILE), NO_COMPONENTS, new AbortController().signal, LIMIT, notes)
    expect(next.revision).toBe(2)
    project.evidence = project.evidence.map(item => item.id === notes.id ? next : item)
    view.rerender(<ResearchClaimSheet {...propsFor(snapshotOf(project), 'claim-memory', closed, opened)} />)

    expect(view.getByText('第 1 行 · 第 1 版')).toBeTruthy()
    fireEvent.click(view.getByText(zh.claimOpenSource))
    expect(opened).toEqual([next.path])
    expect(view.queryByText(digest(notes.sha256))).toBeNull()
    expect(view.queryByText(digest(next.sha256))).toBeNull()
    expect(() => { putClaim(project, fileOnly) }).toThrow(/missing or outdated/)
  })

  it('marks a claim stale the moment the run under it loses its inputs', async () => {
    const { project, notes, runData, supported } = await scene()
    // The real invalidation: the data the run consumed changed, so the run's
    // evidence goes stale and every claim resting on it goes with it.
    invalidate(project, { evidenceId: notes.id })
    expect(project.evidence.find(item => item.id === runData.id)?.stale).toBe(true)

    const view = render(<ResearchClaimSheet {...propsFor(snapshotOf(project), 'claim-accuracy', [])} />)
    expect(view.getAllByText(zh.stale).every(tag => tag.getAttribute('data-tone') === 'warning')).toBe(true)
    // A run stays openable with its locked input snapshot even once it is stale.
    expect(view.getByText('输入快照 2 项 · 已锁定')).toBeTruthy()
    expect(view.getByText(zh.claimOpenRun)).toBeTruthy()
    expect(() => { putClaim(project, supported) }).toThrow(/missing or outdated/)
  })

  it('still opens when the stylesheet ships no class for the dialog', async () => {
    const { project } = await scene()
    expect(render(<ResearchClaimSheet {...propsFor(snapshotOf(project), 'claim-orphan', [])} />)
      .getByRole('dialog').className.split(' ')).toHaveLength(2)
    cleanup()

    // A class named in the TSX but absent from the stylesheet resolves to
    // `undefined` in a build — `.metric`, `.metricName` and `.metricValue` are
    // exactly that today. Vitest answers every CSS-module lookup with a
    // generated name, so the missing class is staged with an empty stylesheet.
    vi.resetModules()
    vi.doMock('../src/client/ClaimSheet.module.css', () => ({ default: {} }))
    const { ResearchClaimSheet: Unstyled } = await import('../src/client/ClaimSheet.tsx')
    const view = render(<Unstyled {...propsFor(snapshotOf(project), 'claim-orphan', [])} />)
    expect(view.getByRole('dialog').className.split(' ')).toHaveLength(1)
    expect(view.getByText(zh.claimNoSources)).toBeTruthy()
    vi.doUnmock('../src/client/ClaimSheet.module.css')
  })
})
