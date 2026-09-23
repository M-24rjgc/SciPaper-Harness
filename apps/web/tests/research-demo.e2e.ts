/**
 * Builds the example projects Research Workbench opens onto: the material for
 * promotion, guided onboarding and the beginner tutorial. A scripted model plays
 * the assistant against the shipped host, so every conversation, ledger record,
 * compile, citation import, experiment, check and question card is one the
 * product itself produced; only the words are fixed. The two projects show the
 * two installed modes: a finished evaluation carried to a submission-ready paper
 * by spark-to-paper, automatically, and an idea carried by CCFA from a reviewed
 * idea to running experiments, with checkpoints. Numbers are example values and
 * the reading notes are the researcher's own paraphrases, as each project's
 * data/README.md says; the references are real papers, imported through the
 * providers, so generation needs the network.
 *
 * The texts the assistant writes live beside this file in research-demo/.
 *
 * Runs only when DSH_RESEARCH_DEMO_HOME names the Research Workbench home to
 * write into (normally ~/.research-workbench, with the app closed). The previous
 * demo folder and the storage files are copied to <home>/backups/demo-<time>
 * first. DSH_RESEARCH_TEST_TEX_BIN names the TeX binaries for the compiles.
 */
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { LlmAdapter, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {
  EnvironmentId, EvidenceLink, ExperimentRecord, ProjectId, ResearchCommand, ResearchProject, ResearchResponse,
} from '@deepseek-ai/dsh-research-workbench/types'
import type {} from '@deepseek-ai/dsh-research-workbench'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const HOME = process.env.DSH_RESEARCH_DEMO_HOME
const TEX_BIN = process.env.DSH_RESEARCH_TEST_TEX_BIN
const FIXTURES = join(import.meta.dirname, 'research-demo')

interface Call { name: string; args: Record<string, unknown> }
interface Reply { text?: string; calls?: Call[]; again?: boolean }
type Step = () => Reply | Promise<Reply>
/** A reference the assistant imports: a Crossref DOI or an OpenAlex work, with the key the paper cites it by. */
interface Reference { key: string; title: string; year?: number; doi?: string; openalex?: string }
interface ReviewFix { file: string; issue: string; draft: string; final: string }

/** Plays the scripted assistant turns in order; a step may repeat itself until the state it waits for arrives. */
class ScriptAdapter extends LlmAdapter {
  readonly steps: Step[] = []
  /** Errors thrown while building a scripted reply; the host only sees a failed model call. */
  readonly failures: string[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 1_000_000 })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const step = this.steps.shift()
    if (!step) throw new Error('demo script exhausted')
    let reply: Reply
    try {
      reply = await step()
    } catch (error) {
      this.failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
      throw error
    }
    const { text, calls = [], again } = reply
    if (again) this.steps.unshift(step)
    let index = 0
    if (text) {
      yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'text-delta', index, text }
      yield { type: 'block-end', index, block: { type: 'text', text } }
      index++
    }
    for (const call of calls) {
      const id = ToolCallId(`call_${String(index).padStart(2, '0')}_${randomUUID().replaceAll('-', '').slice(0, 20)}`)
      const args = JSON.stringify(call.args)
      yield { type: 'block-start', index, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      index++
    }
    yield { type: 'usage', usage: { inputTokens: 12000, outputTokens: 600 } }
    yield { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } }
  }
}

const fixture = (path: string): Promise<string> => readFile(join(FIXTURES, path), 'utf8')
const skill = (name: string): Call => ({ name: 'skill', args: { name } })
const check = (scope?: string): Call => ({ name: 'research_check', args: scope ? { scope } : {} })
const save = (path: string, content: string, kind: string, extra: Record<string, unknown> = {}): Call =>
  ({ name: 'research_artifact', args: { action: 'save-artifact', path, kind, content, ...extra } })
const script = (id: string, args: string[] = []): Call => ({ name: 'research_artifact', args: { action: 'run-script', script: id, args } })

/** The item literature-search would have returned: the import re-fetches it by DOI or OpenAlex id. */
function literatureItem(reference: Reference): Record<string, unknown> {
  return reference.openalex
    ? { id: reference.openalex, provider: 'openalex', title: reference.title, authors: [], url: reference.openalex, abstract: '', bibtex: '' }
    : { id: reference.doi, provider: 'crossref', title: reference.title, authors: [], doi: reference.doi, url: `https://doi.org/${reference.doi}`, abstract: '', bibtex: '' }
}

/** The verified BibTeX of each imported reference, keyed as the paper cites it. */
function bibliography(project: ResearchProject, references: Reference[]): string {
  return `${references.map((reference) => {
    const source = project.evidence.find(item => item.kind === 'literature'
      && (reference.doi ? item.doi?.toLowerCase() === reference.doi.toLowerCase() : item.title === reference.title))
    const bibtex = source?.chunks.find(chunk => chunk.locator.key === 'bibtex')?.text
    if (!bibtex) throw new Error(`${reference.key} was not imported`)
    return bibtex.trim().replace(/^@(\w+)\{[^,]+,/, (_, type: string) => `@${type}{${reference.key},`)
  }).join('\n\n')}\n`
}

// ── Sparse attention scaling study (CCFA): the paper ────────────────────────

interface SparseResult { method: 'full' | 'fixed' | 'dynamic'; seed: number; accuracy: number; flops: number; memory: number }

/** The measurement paper in the NeurIPS template; before the runs every result cell is "--" and every result sentence a placeholder. */
function sparsePaper(results?: SparseResult[]): string {
  const find = (method: string, seed: number) => results?.find(item => item.method === method && item.seed === seed)
  const cell = (value: number | undefined, digits: number) => value === undefined ? '--' : value.toFixed(digits)
  const row = (label: string, method: string, seed: number) => {
    const result = find(method, seed)
    return String.raw`${label} & ${seed} & ${cell(result?.accuracy, 3)} & -- & ${cell(result?.flops, 2)} & ${cell(result?.memory, 1)} \\`
  }
  const full = find('full', 42)
  const fixed = find('fixed', 42)
  const dynamic = find('dynamic', 42)
  const second = find('dynamic', 97)
  const abstractResult = full && dynamic
    ? String.raw`At 32K tokens, dynamic selection reaches ${dynamic.accuracy.toFixed(3)} accuracy against ${full.accuracy.toFixed(3)} for full attention while using ${dynamic.flops.toFixed(2)} of its FLOPs (seed 42); the 64K runs are in progress.`
    : String.raw`\tbd{one sentence with the 32K and 64K accuracy once the runs are in}`
  const mainResult = full && fixed && dynamic && second
    ? String.raw`At 32K tokens, dynamic selection reaches ${dynamic.accuracy.toFixed(3)} accuracy with seed 42 and ${second.accuracy.toFixed(3)} with seed 97, against ${full.accuracy.toFixed(3)} for full attention, while using ${dynamic.flops.toFixed(2)} of its FLOPs and ${dynamic.memory.toFixed(1)} GB instead of ${full.memory.toFixed(1)} GB of peak memory. Fixed blocks reach ${fixed.accuracy.toFixed(3)} at ${fixed.flops.toFixed(2)} of the FLOPs. Both sparse variants stay within one point of full attention at this length (Table~\ref{tab:main}, Figure~\ref{fig:tradeoff}).

\begin{figure}[t]
\centering
\includegraphics[width=0.62\linewidth]{accuracy_vs_flops.pdf}
\caption{Accuracy against relative FLOPs on RULER at 32K tokens, one point per run.}
\label{fig:tradeoff}
\end{figure}`
    : String.raw`\tbd{32K and 64K accuracy, compute and memory once the runs are in}

\tbd{accuracy against relative FLOPs, one point per run}`
  return String.raw`\documentclass{article}
\usepackage[]{neurips_2026}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{hyperref}
\usepackage{url}
\usepackage{microtype}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{amsmath}
\usepackage{xcolor}
\usepackage{tikz}
\usetikzlibrary{positioning,arrows.meta}
\graphicspath{{../figures/}}
\providecommand{\tbd}[1]{\textcolor{red}{[TBD: #1]}}

\title{When Does Content-Based Block Selection Pay Off?\\Block-Sparse Attention at 32K and 64K Tokens}
\author{Anonymous Author(s)}

\begin{document}
\maketitle

\begin{abstract}
Block-sparse attention cuts the cost of self-attention by letting each query block attend to a few key blocks. Fixed patterns were evaluated around 4K tokens \citep{beltagy2020longformer,zaheer2020bigbird}, and recent methods choose blocks from the input \citep{jiang2024minference,lu2025moba,yuan2025nsa}, each comparing one mechanism with full attention. Whether choosing blocks by content keeps its advantage over fixed blocks as the context grows has not been measured on its own. We hold the sparsity, the block size and the model fixed and compare fixed and dynamic block selection at 4$\times$ sparsity on RULER \citep{hsieh2024ruler} and LongBench-E \citep{bai2024longbench} at 32K and 64K tokens. ${abstractResult}
\end{abstract}

\section{Introduction}
Long-context models pay for every token twice: in the quadratic attention cost and in the memory that holds keys and values. Block-sparse attention keeps a fixed fraction of the key blocks for every query block, so compute and memory fall with the sparsity ratio. The open question is accuracy. Our pilot at 8K tokens shows fixed blocks losing more than dynamic, content-scored blocks, but the fixed patterns were measured at about 4K tokens, and the benchmark that separates task types at long lengths \citep{hsieh2024ruler} suggests aggregation tasks are where sparsity should hurt first.

Content-based selection is not new. MInference picks a sparse pattern per head at inference time \citep{jiang2024minference}, MoBA routes each query to its top key blocks \citep{lu2025moba}, and NSA trains compressed, selected and sliding branches together \citep{yuan2025nsa}. Each proposes a mechanism and compares it with full attention. We ask a narrower question with a controlled design: at the same sparsity and block size, does the advantage of dynamic over fixed block selection survive as the context grows, and can block-sparse attention stay within one point of full attention at 32K tokens?

\section{Related Work}
Longformer combines sliding-window attention with a few global tokens and scales linearly with length \citep{beltagy2020longformer}. BigBird adds random attention to windows and global tokens and proves the pattern keeps the expressiveness of full attention \citep{zaheer2020bigbird}. Both fix the sparsity pattern in advance. MInference, MoBA and NSA choose blocks or tokens from the input \citep{jiang2024minference,lu2025moba,yuan2025nsa}. RULER measures the effective context of long-context models with retrieval, multi-hop tracing, aggregation and question answering tasks \citep{hsieh2024ruler}; LongBench covers natural long-document tasks \citep{bai2024longbench}. FlashAttention-3 makes dense attention itself faster on current GPUs \citep{shah2024flashattention3}, which raises the bar a sparse method has to clear.

\section{Method}
\subsection{Block scoring and selection}
We split queries and keys into blocks of 64 tokens. For each query block we score every key block by the dot product of their mean-pooled representations and keep the top quarter of key blocks, always including the diagonal block. Attention is then computed only inside the kept blocks (Figure~\ref{fig:arch}). The scoring is deliberately simple: our question concerns selection by content as such, and the conclusions apply to this pooled scoring.

\subsection{Fixed blocks}
The baseline keeps the same number of blocks per query in a fixed pattern: the local window plus evenly strided blocks, chosen before seeing the input.

\begin{figure}[t]
\centering
\begin{tikzpicture}[node distance=5mm and 7mm, >=Stealth,
  box/.style={draw=black!60, rounded corners=2pt, align=center, minimum height=9mm, font=\small}]
\node[box] (blocks) {Query / key\\blocks};
\node[box, right=of blocks] (score) {Block scores\\(pooled keys)};
\node[box, right=of score, fill=teal!10, draw=teal!70!black] (select) {Top-$k$ block\\selection};
\node[box, right=of select] (attention) {Block-sparse\\attention};
\node[box, below=of score, xshift=12mm, dashed, draw=orange!70!black] (fixed) {Fixed blocks\\(baseline)};
\draw[->] (blocks) -- (score);
\draw[->] (score) -- (select);
\draw[->] (select) -- (attention);
\draw[->, dashed] (blocks) |- (fixed);
\draw[->, dashed] (fixed) -| (attention);
\end{tikzpicture}
\caption{Dynamic block selection (solid) and the fixed-block baseline (dashed). The editable source is figures/architecture.drawio.}
\label{fig:arch}
\end{figure}

\section{Experimental Setup}
We evaluate on RULER at 32K and 64K tokens and on LongBench-E. We leave out PG-19 because it overlaps the pretraining corpus. Every method runs with seeds 13, 42 and 97. We report accuracy, FLOPs relative to full attention and peak memory.

\section{Results}
\subsection{Accuracy at 32K and 64K tokens}
${mainResult}

\begin{table}[t]
\centering
\caption{RULER accuracy, compute and memory. Rel.\ FLOPs are relative to full attention.}
\label{tab:main}
\begin{tabular}{lccccc}
\toprule
Method & Seed & Acc.\ (32K) & Acc.\ (64K) & Rel.\ FLOPs & Peak mem.\ (GB) \\
\midrule
${row('Full attention', 'full', 42)}
${row('Fixed blocks (4$\\times$)', 'fixed', 42)}
${row('Dynamic blocks (4$\\times$)', 'dynamic', 42)}
${row('Dynamic blocks (4$\\times$)', 'dynamic', 97)}
\bottomrule
\end{tabular}
\end{table}

\subsection{Selection strategy and context length}
\tbd{ablation: fixed versus dynamic selection at 32K and 64K, per RULER task category}

\section{Limitations}
We study one sparsity ratio, one block size and one scoring rule, with a single model family. RULER's tasks are synthetic; LongBench-E checks that the conclusions carry over to natural documents.

\section{Conclusion}
\tbd{answer both questions once the 64K runs are in}

\bibliographystyle{plainnat}
\bibliography{refs}
\end{document}
`
}

/** The CCFA project state as the orchestrator keeps it. */
function sparseState(stage: string, gate: string, date: string, experiments: string): string {
  return `version: "0.4.0"
project:
  title: "When Does Content-Based Block Selection Pay Off? Block-Sparse Attention at 32K and 64K Tokens"
  short_name: "sparse-attention-scaling"
  root: "."
target_venue:
  name: "NeurIPS"
  year: "2026"
  mode: "review"
stage:
  current: "${stage}"
  gate: "${gate}"
  updated_at: "${date}"
artifacts:
  manuscript: "paper/main.tex"
  bibliography: "paper/refs.bib"
  figures: "figures/"
  tables: "tables/"
  experiments: "experiments/"
  reviews: "reviews/"
  submission: "submission/"
claims:
  - id: "dynamic-advantage-fades"
    text: "The advantage of dynamic over fixed block selection fades above 32K tokens."
    status: "proposed"
experiments:${experiments}
reviews: []
revision_ledger:
  path: "reviews/revision-ledger.md"
  status: "not_started"
submission_checks:
  path: "submission/checks.md"
  status: "not_started"
`
}

// ── Generation ──────────────────────────────────────────────────────────────

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content, 'utf8')
  }
}

function inside(path: string, root: string): boolean {
  const relation = relative(root, path)
  return relation !== '' && !relation.startsWith('..') && !relation.includes(`..${sep}`)
}

it.skipIf(!HOME)('generates the example projects into the Research Workbench home', async () => {
  const home = HOME!
  const demo = join(home, 'demo')
  const python = process.env.DSH_RESEARCH_TEST_PYTHON ?? join(home, 'research', 'components', 'platform-python', 'Scripts', 'python.exe')
  if (!existsSync(python)) throw new Error(`The platform Python is missing: ${python}`)
  if (!TEX_BIN) throw new Error('Set DSH_RESEARCH_TEST_TEX_BIN to the TeX binaries')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const today = new Date().toISOString().slice(0, 10)
  const backup = join(home, 'backups', `demo-${stamp}`)
  await mkdir(backup, { recursive: true })
  if (existsSync(demo)) await rename(demo, join(backup, 'demo'))
  if (existsSync(join(home, 'storages'))) await cp(join(home, 'storages'), join(backup, 'storages'), { recursive: true })

  const sparseRoot = join(demo, 'sparse-attention-scaling')
  const summaryRoot = join(demo, 'long-summary-consistency')
  // The fixtures keep data/README.md as ABOUT.md, so the repository does not take them for its own documentation.
  const materials = async (project: string, paths: string[]): Promise<Record<string, string>> => ({
    'data/README.md': await fixture(`${project}/data/ABOUT.md`),
    ...Object.fromEntries(await Promise.all(paths.map(async path => [path, await fixture(`${project}/${path}`)] as const))),
  })
  await writeFiles(sparseRoot, await materials('sparse', ['data/notes/longformer.md', 'data/notes/bigbird.md', 'data/notes/ruler.md', 'data/pilot-8k.csv']))
  await writeFiles(summaryRoot, await materials('summary', ['data/notes.md', 'data/results/consistency.csv', 'data/results/by_length.csv', 'data/results/agreement.csv']))
  const summaryReferences = JSON.parse(await fixture('summary/references.json')) as Reference[]
  const sparseReferences = JSON.parse(await fixture('sparse/references.json')) as Reference[]
  const reviewFixes = JSON.parse(await fixture('summary/review-fixes.json')) as ReviewFix[]
  const summarySections = ['abstract', 'introduction', 'related_work', 'method', 'experiments', 'conclusion']
  const finalSection = Object.fromEntries(await Promise.all(summarySections.map(async id => [id, await fixture(`summary/sections/${id}.tex`)] as const)))
  // The first draft differs from the final text exactly where the review found something to fix.
  const draftSection = Object.fromEntries(summarySections.map((id) => {
    let text = finalSection[id]!
    for (const fix of reviewFixes.filter(item => item.file === `sections/${id}.tex`)) {
      if (!text.includes(fix.final)) throw new Error(`review fix ${fix.issue} does not match sections/${id}.tex`)
      text = text.replace(fix.final, fix.draft)
    }
    return [id, text]
  }))

  const overlay = join(backup, 'overlay.yml')
  await writeFile(overlay, '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n')
  const scaffold: WebScaffold = await launchWebScaffold({ agentPresets: { roots: [], default: 'research' }, extraOverlayPath: overlay })
  const transcript: string[] = []
  const toolErrors: string[] = []
  try {
    const ctx = scaffold.ctx
    const adapter = new ScriptAdapter()
    // The scaffold holds the shipped route with a stream-less stand-in; the script answers on that same route.
    const route = (ctx.llm as unknown as { adapters: Map<string, { adapter: LlmAdapter }> }).adapters.get('deepseek-official')
    if (!route) throw new Error('the shipped deepseek-official route is missing')
    route.adapter = adapter
    const answers: string[][] = []
    ctx.on('user-questions/request' as never, ((request: { questions: { id: string }[] }) => {
      const selected = answers.shift()
      if (!selected) throw new Error('no scripted answer for this question')
      return Promise.resolve({ answers: request.questions.map(question => ({ id: question.id, selected })) })
    }) as never, { prepend: true, global: true })
    const sessions = new Map<string, unknown>()
    ctx.on('session/created', (session: { id: string }) => { sessions.set(session.id, session) })
    ctx.on('session/event', (_session, event: SessionEvent) => {
      const data = event.data as unknown as Record<string, unknown>
      if (event.type === 'user/message') {
        const content = data.content as { type: string; text?: string }[]
        const text = content.filter(block => block.type === 'text').map(block => block.text).join('')
        if (!text.startsWith('Current runtime context') && !text.startsWith('<system-reminder>')) transcript.push(`\n## 用户\n${text}`)
      } else if (event.type === 'tool/call') {
        transcript.push(`- 调用 ${String(data.name)} ${String(data.arguments).slice(0, 300)}`)
      } else if (event.type === 'tool/result') {
        const serialized = JSON.stringify(data)
        transcript.push(`  - 结果 ${serialized.slice(0, 400)}`)
        if (/"isError":\s*true/.test(serialized)) toolErrors.push(serialized.slice(0, 1200))
      } else if (event.type === 'assistant/message') {
        const message = data.message as { content: { type: string; text?: string }[] }
        const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
        if (text) transcript.push(`\n### 助手\n${text}`)
      }
    })
    await ctx.research.configure({ main: { provider: 'deepseek-official', model: 'deepseek-flash' }, python, texBin: TEX_BIN })
    const { modes } = await ctx.research.snapshot()
    const phaseLabels = new Map(modes.flatMap(mode => mode.phases.map(phase => [phase.id, phase.label.zh] as const)))

    const signal = new AbortController().signal
    const command = async (request: ResearchCommand): Promise<ResearchResponse> => {
      const response = await ctx.research.command(request, signal)
      if (!response.jobId) return response
      const id = response.jobId
      await expect.poll(() => ctx.research.tasks().find(task => task.id === id)?.status, { timeout: 120000 }).not.toBe('running')
      const task = ctx.research.tasks().find(item => item.id === id)
      expect(task?.status, task?.message).toBe('completed')
      return task!.result!
    }
    const turn = async (sessionId: SessionId, text: string, steps: Step[], questionAnswers: string[][] = []): Promise<void> => {
      adapter.steps.push(...steps)
      answers.push(...questionAnswers)
      const settled = scaffold.whenTurnSettled(900000)
      await ctx.sessionController.prompt({
        sessionId, requestId: randomUUID() as SessionRequestId, mode: 'queue', content: [{ type: 'text', text }],
      }, signal)
      await settled
      expect(adapter.failures, 'every scripted reply builds').toEqual([])
      expect(adapter.steps, 'every scripted step runs').toHaveLength(0)
      expect(answers, 'every scripted answer is used').toHaveLength(0)
      expect(toolErrors, 'no tool call fails').toEqual([])
    }
    const mutate = (id: ProjectId, work: (project: ResearchProject) => void): Promise<unknown> =>
      (ctx.research as unknown as { mutate(id: ProjectId, work: (project: ResearchProject) => void): Promise<unknown> }).mutate(id, work)

    // Quotes are taken from the stored chunks, so every link names text that is really at its locator.
    const linkTo = (project: ResearchProject, title: string, contains: string): EvidenceLink => {
      const source = project.evidence.find(item => item.title === title)
      if (!source) throw new Error(`No evidence titled ${title}`)
      const chunk = source.chunks.find(item => item.text.includes(contains))
      if (!chunk) throw new Error(`${title} holds no chunk with ${contains}`)
      const quote = chunk.text.split(/\r?\n/).find(line => line.includes(contains)) ?? contains
      return { evidenceId: source.id, revision: source.revision, locator: chunk.locator, quote }
    }
    const artifactRef = (project: ResearchProject, path: string) => {
      const artifact = project.artifacts.find(item => item.path === path)
      if (!artifact) throw new Error(`No artifact at ${path}`)
      return { id: artifact.id, revision: artifact.revision }
    }
    const phaseLine = (project: ResearchProject): string => (project.lastCheck?.phases ?? [])
      .map(phase => `${phaseLabels.get(phase.id) ?? phase.id} ${phase.done ? '✓' : '…'}`).join(' · ')
    // pdfTeX keeps page objects in compressed object streams, so the count comes from pypdf in the platform Python.
    const pdfPages = (project: ResearchProject): number => {
      const pdf = project.compilations.at(-1)?.pdfPath
      if (!pdf) return 0
      const count = execFileSync(python, ['-c', 'import sys, pypdf; print(len(pypdf.PdfReader(sys.argv[1]).pages))', join(project.root, pdf)], { encoding: 'utf8' })
      return Number(count.trim())
    }

    // ── Project 1: a finished evaluation, carried by spark-to-paper, fully automatic ──
    const summary = await ctx.research.create({
      title: '长文摘要一致性评测', root: summaryRoot, autonomy: 'automatic',
      brief: '三个摘要系统在长文上的一致性评测，结果和笔记都已经有了，要写成能投 AAAI 的完整论文',
    })
    const summarySession = summary.sessionId as SessionId
    // Named before the first message: a title the user set is never replaced by the automatic one.
    await ctx.sessionController.rename({ sessionId: summarySession, title: '从结果写成论文（spark-to-paper）' })
    const liveSession = sessions.get(summarySession)
    if (liveSession) (ctx as unknown as { permissionPresets: { set(session: unknown, name: string): void } }).permissionPresets.set(liveSession, 'research-auto')
    const summaryProject = () => ctx.research.getProject(summary.id)
    const summaryFile = (path: string) => readFile(join(summaryRoot, path), 'utf8')
    const plots = [
      { label: 'overall', data: ['consistency.csv', 'lead-3'] },
      { label: 'length', data: ['by_length.csv', '"bart-large", "long"'] },
      { label: 'auc', data: ['agreement.csv', '"summac_auc", "long"'] },
    ] as const
    await turn(summarySession, 'data 里是我做完的长文摘要一致性评测：三张结果表和一份笔记。写成一篇能投 AAAI 的完整论文，中间你自己拿主意，不用停下来问我。', [
      () => ({ text: '先看项目。', calls: [{ name: 'research_project', args: { action: 'current' } }] }),
      () => ({
        text: '结果已经齐了，论文里的每个数都要从这几张表取——这正是 spark-to-paper 的 data 路线：数据、规划、引用、写作、润色、评审、图表、编译，最后投稿检查。全自动模式，我直接切过去，理由记下来。',
        calls: [
          { name: 'research_project', args: { action: 'set-mode', mode: 'spark-to-paper', route: 'data', reason: '评测已经做完：三张结果表和评测笔记都在，论文里的数字全部来自这些结果' } },
          { name: 'research_project', args: { action: 'record-decision', question: '模式与路线', answer: 'spark-to-paper · data（从实测结果写成论文）', rationale: '结果齐全，每个数都要能追溯到结果表' } },
        ],
      }),
      () => ({ calls: [skill('ts-paper')] }),
      async () => ({
        text: '按 ts-paper 先做预检：三张图都是结果图，用数据和脚本画，不需要生图接口；这是评测研究，不用知识图谱；平台 Python 和 TeX 已就绪。开始数据阶段，把结果收成数据证据。',
        calls: [
          skill('ts-paper-data'),
          { name: 'research_evidence', args: { action: 'import', paths: ['data/results/consistency.csv', 'data/results/by_length.csv', 'data/results/agreement.csv', 'data/notes.md'] } },
          save('logs/0_route.io.md', await fixture('summary/logs/0_route.io.md'), 'supplement'),
          save('code/facts.py', await fixture('summary/code/facts.py'), 'code'),
        ],
      }),
      () => ({ calls: [{ name: 'pwsh', args: { command: `& '${python}' code/facts.py`, description: '从三张结果表生成 results.facts.json（含要报告的差值）' } }] }),
      async () => {
        const project = summaryProject()
        return {
          text: 'results.facts.json 里是论文可以用的全部数字，差值由脚本算出。把它也收成数据证据，并记下这篇论文的核心论点。',
          calls: [
            { name: 'research_evidence', args: { action: 'import', paths: ['results.facts.json'] } },
            { name: 'research_evidence', args: { action: 'claim', claim: {
              id: 'ranking-holds-by-length', kind: 'empirical', state: 'supported',
              text: '在每个长度档里，SummaC 和 QAFactEval 给出的系统排序都与人工一致率的排序相同。',
              evidence: [linkTo(project, 'by_length.csv', '"lead-3", "long"'), linkTo(project, 'by_length.csv', '"bart-large", "long"'), linkTo(project, 'by_length.csv', '"bart-large-rl", "long"')],
              artifactIds: [],
            } } },
            save('logs/0_data.io.md', await fixture('summary/logs/0_data.io.md'), 'supplement'),
          ],
        }
      },
      () => ({ text: '规划阶段：先从会议库里找 AAAI 的官方模板。', calls: [skill('ts-paper-plan'), { name: 'research_artifact', args: { action: 'list-venues', query: 'aaai' } }] }),
      () => ({ calls: [{ name: 'research_artifact', args: { action: 'apply-template', venue: 'aaai', stage: 'review' } }] }),
      async () => {
        const template = JSON.parse(await summaryFile('template.json')) as Record<string, unknown>
        template.results_mode = 'data_aware'
        return {
          text: '模板套上了（审稿版，匿名）。data 路线要把 template.json 的 results_mode 设为 data_aware，再写 blueprint：两张结果表、三张结果图、三条贡献。',
          calls: [
            save('template.json', `${JSON.stringify(template, null, 2)}\n`, 'supplement'),
            save('blueprint.json', await fixture('summary/blueprint.json'), 'supplement'),
            save('logs/1_plan.io.md', await fixture('summary/logs/1_plan.io.md'), 'supplement'),
          ],
        }
      },
      () => ({ calls: [check('plan')] }),
      () => ({
        text: `规划阶段的检查通过。引用阶段：${summaryReferences.length} 篇文献逐篇按 DOI 向 Crossref 重新取回，BibTeX 用返回的记录。`,
        calls: [skill('ts-paper-cite'), ...summaryReferences.map(reference => ({ name: 'research_evidence', args: { action: 'literature-import', item: literatureItem(reference) } }))],
      }),
      async () => ({
        text: '全部核实。refs.bib 只把键名换成易读的形式；claims_map.json 写明每条引用支撑的论点和所在章节。',
        calls: [
          save('refs.bib', bibliography(summaryProject(), summaryReferences), 'bibliography'),
          save('claims_map.json', await fixture('summary/claims_map.json'), 'supplement'),
          save('logs/2_cite.io.md', await fixture('summary/logs/2_cite.io.md'), 'supplement'),
        ],
      }),
      () => ({ calls: [check('cite')] }),
      async () => ({
        text: '引用阶段通过。按模板的写作顺序写六个部分，正文里的小数只用 results.facts.json 里的值。',
        calls: [
          skill('ts-paper-write'),
          ...summarySections.map(id => save(`sections/${id}.tex`, draftSection[id]!, 'manuscript')),
          save('logs/3_write.io.md', await fixture('summary/logs/3_write.io.md'), 'supplement'),
        ],
      }),
      () => ({ calls: [check('write')] }),
      () => ({ text: '写作阶段通过。润色：先列出风险措辞，再逐条看。', calls: [skill('ts-paper-refine'), script('consistency-check', ['sections/experiments.tex'])] }),
      async () => ({ calls: [save('logs/4_refine.io.md', await fixture('summary/logs/4_refine.io.md'), 'supplement'), check('refine')] }),
      async () => ({
        text: '对抗式评审：三个视角各读全文，每条问题带原文引语和关闭标准，再逐条反驳。找到两处 major、两处 minor；三处当场改掉，一处留给你决定。',
        calls: [
          skill('ts-paper-review'),
          ...reviewFixes.map(fix => save(fix.file, finalSection[fix.file.replace(/^sections\/|\.tex$/g, '')]!, 'manuscript')),
          save('reviews/review.md', await fixture('summary/reviews/review.md'), 'supplement'),
          save('logs/5_review.io.md', await fixture('summary/logs/5_review.io.md'), 'supplement'),
        ],
      }),
      () => ({ calls: [check('review'), check('write')] }),
      async () => ({
        text: '评审阶段通过，改过的地方重新检查也没有问题。图表阶段：三张结果图都用 plot-results 从数据画，出矢量 PDF。',
        calls: [skill('ts-paper-figure'), ...await Promise.all(plots.map(async plot => save(`code/plot_${plot.label}.py`, await fixture(`summary/code/plot_${plot.label}.py`), 'code')))],
      }),
      () => ({ calls: plots.map(plot => script('plot-results', ['--script', `code/plot_${plot.label}.py`, '--out', `figures/${plot.label}.png`])) }),
      async () => {
        const project = summaryProject()
        return {
          text: '三张图都画好了。登记每张图的数据和脚本，写图表清单。',
          calls: [
            ...plots.map(plot => ({ name: 'research_artifact', args: {
              action: 'register-artifact', path: `figures/${plot.label}.pdf`, kind: 'figure',
              evidence: [linkTo(project, plot.data[0], plot.data[1])], inputArtifacts: [artifactRef(project, `code/plot_${plot.label}.py`)],
            } })),
            save('figures/figures.manifest.json', await fixture('summary/figures/figures.manifest.json'), 'supplement'),
            save('logs/6_figures.io.md', await fixture('summary/logs/6_figures.io.md'), 'supplement'),
          ],
        }
      },
      () => ({ calls: [check('figures')] }),
      () => ({ text: '图表阶段通过。编译排版：用 assemble-paper 拼出 main.tex，再编译。', calls: [skill('ts-paper-latex'), script('assemble-paper')] }),
      () => ({ calls: [{ name: 'research_artifact', args: { action: 'compile', path: 'main.tex', engine: 'pdflatex' } }] }),
      () => ({ calls: [{ name: 'research_artifact', args: { action: 'render-pages', maxPages: 10 } }] }),
      () => ({ calls: [check('latex')] }),
      async () => {
        const pages = pdfPages(summaryProject())
        const review = `${await fixture('summary/reviews/review.md')}- [x] [minor] I-05 latex: 终稿逐页检查（AAAI 格式，${pages} 页）：两张表、三张图和参考文献都正常，没有溢出。\n`
        return {
          text: `编译通过，${pages} 页逐页看过。评审里补记终稿检查，写完过程记录，然后跑一遍完整检查。`,
          calls: [
            save('reviews/review.md', review, 'supplement'),
            save('logs/7_latex.io.md', await fixture('summary/logs/7_latex.io.md'), 'supplement'),
            save('logs/index.md', await fixture('summary/logs/index.md'), 'supplement'),
          ],
        }
      },
      () => ({ calls: [check()] }),
      () => summaryProject().lastCheck?.clean
        ? { text: '检查全部通过，打包投稿文件。', calls: [{ name: 'research_artifact', args: { action: 'export' } }] }
        : { calls: [{ name: 'research_project', args: { action: 'current' } }] },
      async () => {
        const project = summaryProject()
        const check = project.lastCheck
        const pages = pdfPages(project)
        return { text: check?.clean
          ? `写完了，spark-to-paper 的每个阶段都通过（${phaseLine(project)}），投稿包在 exports/ 里。\n\n- **论文**：AAAI 2026 审稿版，${pages} 页，main.tex 由 sections/ 拼成。\n- **结论**：两个指标在每个长度档都给出与人工一致的系统排序；摘要级别上，SummaC 在长文档上的区分能力明显下降，QAFactEval 比较稳。\n- **数字**：正文和表里的每个数都来自 data/results/ 下的三张表，差值由 code/facts.py 算出。\n- **引用**：${summaryReferences.length} 篇，全部按 DOI 向 Crossref 核实后导入。\n- **图**：三张结果图由 code/plot_*.py 从数据画出，都是矢量 PDF，数据和脚本登记在图的来源里。\n- **评审**：找到的四个问题里三个已改；I-04（讨论大模型评估器）留给你决定。\n- **我替你定的事**：模式与路线、会议模板，理由都在右侧的决策记录里。`
          : `论文写好了，但检查还没全部通过：${phaseLine(project)}。${check?.findings.filter(finding => finding.severity === 'error').map(finding => finding.message).join('；') ?? ''}` }
      },
    ])

    // ── Project 2: an idea, carried by CCFA, with checkpoints ──
    const sparse = await ctx.research.create({
      title: 'Sparse attention scaling study', root: sparseRoot, autonomy: 'checkpoints',
      brief: '块稀疏注意力能否在 1/4 FLOPs 下保住长上下文准确率',
    })
    const sparseSession = sparse.sessionId as SessionId
    await ctx.sessionController.rename({ sessionId: sparseSession, title: '块稀疏注意力：CCFA 从想法到实验' })
    const current = () => ctx.research.getProject(sparse.id)
    // The researcher bound these earlier from settings: this machine, and a lab server that is unreachable today.
    await command({ action: 'environment', projectId: sparse.id, environment: {
      name: 'default', kind: 'existing', target: 'local', python, requirements: [], isDefault: true,
    } })
    await mutate(sparse.id, (project) => {
      project.environments.push({
        id: randomUUID() as EnvironmentId, name: 'lab-a100', kind: 'existing', target: 'ssh', python: '/usr/bin/python3',
        sshHost: 'lab-gpu', remoteRoot: '/data/research/sparse', requirements: [], fingerprint: 'lab-a100', status: 'ready',
        details: JSON.stringify({ executable: '/usr/bin/python3', gpu: 'NVIDIA A100 80GB' }), isDefault: false,
      })
    })
    const idea = 'ccfa-workfiles/ideas/block-sparse-long-context'
    const question = '在 4× 稀疏、32K 以上上下文下，块稀疏注意力的长文准确率能否保持在全注意力的 1 个点以内？按内容动态选块相对固定分块的优势，会不会随长度消失？'

    await turn(sparseSession, '我只有一个想法：块稀疏注意力能不能在 1/4 的 FLOPs 下，保住长上下文的准确率？data 里是我读 Longformer、BigBird、RULER 的笔记，还有一份 8K 上的预实验。想做成一篇能投 NeurIPS 的论文。', [
      () => ({ text: '先看看这个项目现在的状态。', calls: [{ name: 'research_project', args: { action: 'current' } }] }),
      () => ({
        text: '项目还在通用模式。你手上是一个想法、三份笔记和一份预实验，目标是 NeurIPS——整篇论文按一种方法走会更稳。装了两种，请你选：',
        calls: [{ name: 'ask_user_question', args: { questions: [{
          id: 'mode', header: '选择模式', question: '这篇论文按哪种方法推进？',
          options: [
            { label: 'CCFA · 完整论文 (Recommended)', description: '先打磨并评审想法、查清最接近的工作，再设计实验、跑实验、写作，按 CCF-A 的审稿标准检查每一步' },
            { label: 'spark-to-paper · 从提案开始', description: '先写出完整初稿，结果格留空，初稿编译通过后再跑实验' },
            { label: '先用通用模式', description: '不走流程，按你的指示一步步来' },
          ],
        }] } }],
      }),
      () => ({
        text: '好，用 CCFA 的完整论文路线：项目搭建 → 想法 → 文献 → 实验设计 → 实验 → 写作 → 图表 → 诚信审计 → 评审 → 投稿。',
        calls: [
          { name: 'research_project', args: { action: 'set-mode', mode: 'ccfa', route: 'full-paper', reason: '一个想法加阅读笔记和预实验，目标 NeurIPS；想法要先经过评审和文献核实' } },
          { name: 'research_project', args: { action: 'record-decision', question: '模式', answer: 'CCFA · full-paper', decidedBy: 'user' } },
        ],
      }),
      () => ({ calls: [skill('ccf-humanization'), skill('ccf-common'), skill('ccf-pipeline-orchestrator')] }),
      () => ({
        text: '先按 ccf-project-scaffolder 搭项目：材料收进证据库，套 NeurIPS 的官方模板，写 ccfa.yaml。',
        calls: [
          skill('ccf-project-scaffolder'),
          { name: 'research_evidence', args: { action: 'import', paths: ['data/notes/longformer.md', 'data/notes/bigbird.md', 'data/notes/ruler.md', 'data/pilot-8k.csv'] } },
          { name: 'research_artifact', args: { action: 'list-venues', query: 'neurips' } },
        ],
      }),
      () => ({
        calls: [
          { name: 'research_artifact', args: { action: 'apply-template', venue: 'neurips', stage: 'review' } },
          save('ccfa.yaml', sparseState('scaffolded', 'passed', today, ' []'), 'supplement'),
        ],
      }),
      () => ({
        text: '项目搭好了。想法阶段：先用内置的科研模式图谱找最接近的已有工作。',
        calls: [skill('ccf-idea-optimizer'), { name: 'research_knowledge', args: {
          action: 'recall', query: 'block-sparse attention that keeps long-context accuracy at a quarter of the FLOPs, dynamic block selection versus fixed blocks',
          topK: 5, path: `${idea}/recall.json`,
        } }],
      }),
      async () => {
        const recall = JSON.parse(await readFile(join(sparseRoot, idea, 'recall.json'), 'utf8')) as { patterns: { name: string; exemplars: { title: string }[] }[] }
        const [top] = recall.patterns
        return {
          text: `图谱召回的最近模式是 "${top?.name ?? '?'}"，范例里有 ${top?.exemplars.slice(0, 3).map(item => item.title.split(':')[0]).join('、') ?? '?'}——按内容动态选块已经有专门的方法了。想法卡片按这个来写：贡献放在"动态相对固定的优势怎样随长度变化"这一测量上。再请 ccf-idea-reviewer 只看概念做一次评审。`,
          calls: [save(`${idea}/idea-card.md`, await fixture(`sparse/${idea}/idea-card.md`), 'supplement'), skill('ccf-idea-reviewer')],
        }
      },
      async () => ({ calls: [save(`${idea}/idea-review.md`, await fixture(`sparse/${idea}/idea-review.md`), 'supplement')] }),
      () => ({
        text: '评审结论是 revise，加权 3.55：问题具体、可证伪，但如果写成"提出动态选块"，会和 MInference、MoBA、NSA 直接重叠。改成控制变量的测量研究后，两问都值得保留——第二问恰好是已有方法没测过的部分。研究问题请你定：',
        calls: [{ name: 'ask_user_question', args: { questions: [{
          id: 'research-question', header: '研究问题', question,
          options: [
            { label: '两问都保留，定位为测量研究 (Recommended)', description: '固定机制，只测动态相对固定的差距怎样随长度变化' },
            { label: '只保留第一问', description: '只看块稀疏能否保住准确率，实验更少，但与已有方法的区别变弱' },
            { label: '改成提出新的选块方法', description: '需要新的机制，与 MInference、MoBA、NSA 正面竞争' },
          ],
        }] } }],
      }),
      () => ({
        calls: [
          { name: 'research_project', args: { action: 'record-decision', question: '研究问题', answer: `${question}（定位为控制变量的测量研究）`, decidedBy: 'user' } },
          save('ccfa.yaml', sparseState('idea', 'passed', today, ' []'), 'supplement'),
          check('idea'),
        ],
      }),
      () => ({ text: '研究问题定下来了，记在决策记录里；想法阶段的检查已通过。\n\n- **想法卡片**：`ccfa-workfiles/ideas/block-sparse-long-context/idea-card.md`\n- **想法评审**：同目录的 `idea-review.md`，新颖性暂定 3 分，要等文献阶段核实。\n\n下一步是文献阶段：把最接近的工作逐篇查清、核实并导入，再对照你的笔记和预实验，看看现有证据在"稀疏模式怎么选"上说了什么。' }),
    ], [['CCFA · 完整论文 (Recommended)'], ['两问都保留，定位为测量研究 (Recommended)']])

    await turn(sparseSession, '先别急着写方法。把材料里关于稀疏模式的结论摆出来，看看谁和谁矛盾。', [
      () => ({ calls: [skill('ccf-literature-searcher'), { name: 'research_evidence', args: { action: 'search-evidence', query: 'block 固定 聚合 4K' } }] }),
      () => ({
        text: `笔记里提到和图谱召回到的 ${sparseReferences.length} 篇关键论文，逐篇向 OpenAlex 和 Crossref 核实后导入。`,
        calls: sparseReferences.map(reference => ({ name: 'research_evidence', args: { action: 'literature-import', item: literatureItem(reference) } })),
      }),
      async () => {
        const project = current()
        return {
          text: '有一处对不上，我把它记成一条待验证的论点；文献清单写进 papers.md；方法草图画成可编辑的 draw.io。',
          calls: [
            { name: 'research_evidence', args: { action: 'claim', claim: {
              id: 'dynamic-advantage-fades', kind: 'hypothesis', state: 'proposed',
              text: '动态选块相对固定分块的优势，在 32K 以上会消失。',
              evidence: [linkTo(project, 'pilot-8k.csv', 'dynamic-block-4x'), linkTo(project, 'ruler.md', '聚合类任务')],
              artifactIds: [],
            } } },
            save('ccfa-workfiles/literature/block-sparse-attention/papers.md', (await fixture('sparse/ccfa-workfiles/literature/block-sparse-attention/papers.md')).replace('{{date}}', today), 'supplement'),
            save('paper/refs.bib', bibliography(project, sparseReferences), 'bibliography'),
            save('figures/architecture.drawio', await fixture('sparse/figures/architecture.drawio'), 'diagram'),
          ],
        }
      },
      () => ({ calls: [check('literature')] }),
      () => ({ text: '材料之间在"稀疏模式怎么选"上说的不是一回事：\n\n- **预实验（pilot-8k.csv）**：8K 上下文、4× 稀疏时，固定分块比全注意力低 0.6 个点，按内容动态选块几乎无损——但只到 8K。\n- **Longformer、BigBird 笔记**：评测都停在 4K 左右，块是固定划分的，说明不了 32K 以上的事。\n- **RULER 笔记**：你记着聚合类任务最可能暴露稀疏注意力的短板，而长度越长，聚合越难。\n- **动态选块的已有方法**：MInference、MoBA、NSA 都只拿自己的机制和全注意力比，没有在多个长度上对照固定分块——这就是这篇论文的位置。\n\n所以"动态选块更好"在 32K 以上还没有证据，我记成了一条**待验证**的论点，两条来源都挂在上面。8 篇文献全部核实导入，清单和三组最接近的工作在 `ccfa-workfiles/literature/block-sparse-attention/papers.md`。\n\n方法草图在 `figures/architecture.drawio`，可以直接打开改。按 ccf-visual-composer，新的方法图默认先用 gpt-image-2 出一版视觉稿；设置里还没配生图接口，这次先画可编辑版本，配好后可以再出一版。' }),
    ])

    await turn(sparseSession, '方法就这样。把实验方案和完整初稿写出来，结果先留空；方案我要确认了再跑。', [
      async () => ({
        text: '先按 ccf-experiment-designer 写实验方案。',
        calls: [
          { name: 'research_project', args: { action: 'record-decision', question: '方法设计', answer: '固定分块与动态选块两套方法，同一稀疏度与块大小；架构图第 1 版定稿', decidedBy: 'user' } },
          skill('ccf-experiment-designer'),
          save('experiments/design.md', await fixture('sparse/experiments/design.md'), 'supplement'),
          save('code/train_eval.py', await fixture('sparse/code/train_eval.py'), 'code'),
        ],
      }),
      () => ({
        text: '方案写好了。再按 ccf-paper-writer 在 NeurIPS 模板里写初稿，结果格留 "--"，没有的结论用占位标出。',
        calls: [
          skill('ccf-paper-writer'),
          save('paper/main.tex', sparsePaper(), 'manuscript', { claimIds: ['dynamic-advantage-fades'] }),
          save('ccfa.yaml', sparseState('design', 'passed', today, ' []'), 'supplement'),
        ],
      }),
      () => ({ text: '编译一下，再逐页看看版面。', calls: [{ name: 'research_artifact', args: { action: 'compile', path: 'paper/main.tex', engine: 'pdflatex' } }] }),
      () => ({ calls: [{ name: 'research_artifact', args: { action: 'render-pages', maxPages: 8 } }] }),
      () => ({ calls: [check('design')] }),
      () => {
        const design = current().lastCheck?.phases.find(phase => phase.id === 'design')
        return {
          text: design?.done
            ? '实验设计阶段的检查通过，初稿也编译好、逐页看过了：结果表全是 "--"，摘要、消融和结论各留了一个占位。下一步是实验阶段，开跑前请你确认方案：'
            : `初稿已经写好并编译。实验设计阶段还差：${design?.missing.join('；') ?? '（未知）'}。开跑前请你确认方案：`,
          calls: [{ name: 'ask_user_question', args: { questions: [{
            id: 'run-plan', header: '开跑前确认',
            question: '实验方案在 experiments/design.md：RULER 32K 先跑全注意力、固定分块 4×、动态选块 4×（种子 42、97，本机）；种子 13 放到实验室的 lab-a100 上并行跑。PG-19 已去掉（与预训练语料重叠）。64K 和 LongBench-E 等 32K 结果出来再跑。现在开跑吗？',
            options: [
              { label: '按方案跑 32K (Recommended)', description: '先拿到 32K 的结果，再决定 64K 怎么跑' },
              { label: '只跑一个种子', description: '更快，但看不出种子间的波动' },
              { label: '先不跑', description: '我再改改方案' },
            ],
          }] } }],
        }
      },
      () => {
        const project = current()
        const local = project.environments.find(item => item.name === 'default')!
        const lab = project.environments.find(item => item.name === 'lab-a100')!
        const code = artifactRef(project, 'code/train_eval.py').id
        const spec = (variant: string, seed: number, environmentId: EnvironmentId) => ({
          environmentId, name: `ruler-32k-${variant}`,
          argv: ['{python}', 'code/train_eval.py', '--variant', variant, '--context', '32768', '--seed', String(seed)],
          cwd: '.', seed, maxSeconds: 600, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [code], metricsPath: 'metrics.json',
        })
        const submit = (variant: string, seed: number, environmentId: EnvironmentId): Call => ({
          name: 'research_experiment', args: { action: 'experiment', requestId: randomUUID(), spec: spec(variant, seed, environmentId) },
        })
        return {
          text: '好，按方案开跑。',
          calls: [
            { name: 'research_project', args: { action: 'record-decision', question: '实验方案', answer: 'RULER 32K 先跑：全注意力、固定分块 4×、动态选块 4×；种子 13 / 42 / 97', decidedBy: 'user' } },
            submit('full', 42, local.id), submit('fixed', 42, local.id), submit('dynamic', 42, local.id), submit('dynamic', 97, local.id),
            submit('dynamic', 13, lab.id),
          ],
        }
      },
      () => {
        const runs = current().experiments.filter(run => run.spec.environmentId === current().environments.find(item => item.name === 'default')!.id)
        const active = runs.filter(run => ['queued', 'running'].includes(run.status))
        if (active.length) {
          return { calls: [{ name: 'research_experiment', args: { action: 'experiment-wait', runIds: active.map(run => run.id), timeoutSeconds: 120 } }], again: true }
        }
        const broken = runs.filter(run => run.status !== 'completed')
        if (broken.length) {
          throw new Error(`local runs did not complete: ${broken.map(run => `${run.spec.name} seed ${run.spec.seed} ${run.status}: ${run.message}`).join(' | ')}`)
        }
        return { calls: [{ name: 'research_project', args: { action: 'current' } }] }
      },
      () => {
        const runs = current().experiments
        const done = runs.filter(run => run.status === 'completed').length
        const lost = runs.find(run => run.status === 'unknown')
        return { text: `提交了 5 次运行。本机的 ${done} 次已经跑完，指标都收成了数据证据。\n\n种子 13 那次放在 lab-a100 上，${lost ? '提交时连不上那台机器，回执没有回来——它可能起来了，也可能没有。我不会换个编号重新提交，那样同一组配置可能跑两遍；等机器能连上，再确认它到底有没有在跑。' : '也已经提交。'}\n\n代码和数据在提交那一刻都锁了快照，之后改文件不会影响这几次运行。结果要我现在整理进论文吗？` }
      },
    ], [['按方案跑 32K (Recommended)']])

    await turn(sparseSession, '整理吧，画张图。13 那次先不管，等实验室机器好了再说。', [
      () => ({ calls: [{ name: 'research_project', args: { action: 'current' } }] }),
      async () => ({
        text: '先用脚本把收集到的运行指标整理成 experiments/results.csv——不手抄；以后 64K 的运行也进这张表。',
        calls: [save('code/collect_results.py', await fixture('sparse/code/collect_results.py'), 'code')],
      }),
      () => ({ calls: [{ name: 'pwsh', args: { command: `& '${python}' code/collect_results.py`, description: '从本机运行记录整理结果表' } }] }),
      async () => ({
        calls: [
          { name: 'research_evidence', args: { action: 'import', paths: ['experiments/results.csv'] } },
          save('code/plot_accuracy.py', await fixture('sparse/code/plot_accuracy.py'), 'code'),
        ],
      }),
      () => ({ calls: [{ name: 'pwsh', args: { command: `& '${python}' code/plot_accuracy.py`, description: '从 experiments/results.csv 画准确率-计算量图' } }] }),
      () => {
        const project = current()
        const results = collectSparse(project)
        const full = results.find(item => item.method === 'full')!
        const dynamic = results.find(item => item.method === 'dynamic' && item.seed === 42)!
        return {
          calls: [
            { name: 'research_artifact', args: { action: 'register-artifact', path: 'figures/accuracy_vs_flops.pdf', kind: 'figure',
              evidence: [linkTo(project, 'results.csv', '"dynamic", "32768", "42"')], inputArtifacts: [artifactRef(project, 'code/plot_accuracy.py')] } },
            { name: 'research_evidence', args: { action: 'claim', claim: {
              id: 'within-one-point-32k', kind: 'empirical', state: 'supported',
              text: '在 4× 稀疏、32K 上下文下，动态选块的准确率与全注意力相差不到 1 个点（种子 42）。',
              evidence: [metricLink(project, dynamic, 'accuracy'), metricLink(project, full, 'accuracy')],
              artifactIds: [],
            } } },
          ],
        }
      },
      () => {
        const project = current()
        return {
          text: '结果写进 6.1 节和表 1，图放在结果部分；ccfa.yaml 的阶段更新为写作。',
          calls: [
            save('paper/main.tex', sparsePaper(collectSparse(project)), 'manuscript', {
              claimIds: ['dynamic-advantage-fades', 'within-one-point-32k'], inputArtifacts: [artifactRef(project, 'figures/accuracy_vs_flops.pdf')],
            }),
            save('ccfa.yaml', sparseState('writing', 'open', today, `
  - id: "ruler-32k"
    status: "collected"
    runs: 4
    pending: ["seed 13 on lab-a100 (state unknown)", "RULER 64K", "LongBench-E"]`), 'supplement'),
          ],
        }
      },
      () => ({ calls: [{ name: 'research_artifact', args: { action: 'compile', path: 'paper/main.tex', engine: 'pdflatex' } }] }),
      () => ({ calls: [{ name: 'research_artifact', args: { action: 'render-pages', maxPages: 8 } }] }),
      () => ({ calls: [check()] }),
      () => {
        const project = current()
        const results = collectSparse(project)
        const full = results.find(item => item.method === 'full')!
        const fixed = results.find(item => item.method === 'fixed')!
        const dynamic = results.find(item => item.method === 'dynamic' && item.seed === 42)!
        const second = results.find(item => item.method === 'dynamic' && item.seed === 97)!
        const line = (label: string, item: SparseResult) =>
          `| ${label} | ${item.accuracy.toFixed(3)} | ${item.flops.toFixed(2)} | ${item.memory.toFixed(1)} GB |`
        const table = [
          line('全注意力 · 种子 42', full), line('固定分块 · 种子 42', fixed),
          line('动态选块 · 种子 42', dynamic), line('动态选块 · 种子 97', second),
        ].join('\n')
        const open = (project.lastCheck?.phases ?? []).filter(phase => !phase.done && phase.id !== 'writing').map(phase => phaseLabels.get(phase.id) ?? phase.id)
        return { text: `整理好了，也重新编译过。\n\n| 运行 | 准确率（32K） | 相对 FLOPs | 峰值显存 |\n| --- | --- | --- | --- |\n${table}\n\n在 32K 上，两种块稀疏都和全注意力相差不到 1 个点，计算量约为四分之一，显存少了三分之一以上。我把"相差不到 1 个点"记成了一条**有证据支持**的论点，挂着两次运行的原始指标；表和图都来自 \`experiments/results.csv\`，这张表由 \`code/collect_results.py\` 从运行记录生成。\n\n按 CCFA 的阶段看：${phaseLine(project)}。写作阶段还没完成——64K 那一列、消融和结论还是占位，要等 64K 的运行${open.length ? `；之后还有${open.join('、')}` : ''}。"动态选块的优势会不会随长度消失"仍是待验证：32K 上它比固定分块只高一点点，得看 64K。` }
      },
    ])

    // Every transcript, title included, is durable before the files are copied out of the scaffold.
    for (const id of [summarySession, sparseSession]) {
      const live = sessions.get(id)
      if (live) await ctx.sessions.flush(live as never)
    }
    const stage = join(backup, 'generated')
    await cp(scaffold.persistenceRoot, join(stage, 'sessions'), { recursive: true })
    await cp(join(scaffold.workspaceCwd, '.dsh-storages'), join(stage, 'storages'), { recursive: true })
    await writeFile(join(backup, 'transcript.md'), transcript.join('\n'), 'utf8')
    await install(home, demo, stage)
  } finally {
    await writeFile(join(backup, 'transcript.md'), transcript.join('\n'), 'utf8').catch(() => {})
    await scaffold.close()
  }
}, 3_600_000)

function collectSparse(project: ResearchProject): SparseResult[] {
  const order = [['full', 42], ['fixed', 42], ['dynamic', 42], ['dynamic', 97]] as const
  return order.map(([method, seed]) => {
    const run = project.experiments.find((item: ExperimentRecord) => item.spec.name === `ruler-32k-${method}` && item.spec.seed === seed && item.status === 'completed')
    if (!run) throw new Error(`run ruler-32k-${method} · seed ${seed} did not complete`)
    return { method, seed, accuracy: run.metrics.accuracy!, flops: run.metrics.relative_flops!, memory: run.metrics.peak_memory_gb! }
  })
}

function metricLink(project: ResearchProject, result: SparseResult, key: string): EvidenceLink {
  const title = `ruler-32k-${result.method} · seed ${result.seed}`
  const source = project.evidence.find(item => item.title === title && item.kind === 'experiment')
  const chunk = source?.chunks.find(item => item.locator.key === key)
  if (!source || !chunk) throw new Error(`No collected ${key} for ${title}`)
  return { evidenceId: source.id, revision: source.revision, locator: chunk.locator, quote: chunk.text }
}

interface StorageFile<T> { unit: { name: string; version: number }; global: unknown; tables: Record<string, Record<string, T>> }

/**
 * Merge the generated projects, their workspaces and their conversations into
 * the home. Earlier demo projects are replaced; everything else is kept.
 */
async function install(home: string, demo: string, stage: string): Promise<void> {
  const read = async <T>(path: string): Promise<StorageFile<T>> => JSON.parse(await readFile(path, 'utf8')) as StorageFile<T>
  const write = async (path: string, value: unknown): Promise<void> => {
    await writeFile(`${path}.demo-tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(`${path}.demo-tmp`, path)
  }
  const storages = join(home, 'storages')
  await mkdir(storages, { recursive: true })

  const generated = await read<{ root: string }>(join(stage, 'storages', 'research_workbench.json'))
  const researchPath = join(storages, 'research_workbench.json')
  const research = existsSync(researchPath)
    ? await read<{ root: string }>(researchPath)
    : { ...generated, tables: { projects: {}, tasks: {} } }
  const projects = research.tables.projects ??= {}
  for (const [id, project] of Object.entries(projects)) {
    if (inside(project.root, demo)) Reflect.deleteProperty(projects, id)
  }
  for (const [id, project] of Object.entries(generated.tables.projects ?? {})) {
    if (inside(project.root, demo)) projects[id] = project
  }
  await write(researchPath, research)

  const generatedWorkspaces = await read<{ path: string; sessionIds: string[] }>(join(stage, 'storages', 'workspace.json'))
  const workspacePath = join(storages, 'workspace.json')
  const workspaces = existsSync(workspacePath)
    ? await read<{ path: string; sessionIds: string[] }>(workspacePath)
    : { ...generatedWorkspaces, global: { initialized: true, workspaceIds: [], archivedSessionIds: [] }, tables: { workspaces: {} } }
  const global = workspaces.global as { workspaceIds: string[] }
  const sessionIds: string[] = []
  for (const [id, workspace] of Object.entries(workspaces.tables.workspaces ?? {})) {
    if (!inside(workspace.path, demo)) continue
    Reflect.deleteProperty(workspaces.tables.workspaces!, id)
    global.workspaceIds = global.workspaceIds.filter(item => item !== id)
  }
  for (const [id, workspace] of Object.entries(generatedWorkspaces.tables.workspaces ?? {})) {
    if (!inside(workspace.path, demo)) continue
    workspaces.tables.workspaces![id] = workspace
    global.workspaceIds.push(id)
    sessionIds.push(...workspace.sessionIds)
  }
  await write(workspacePath, workspaces)

  const cache = join(stage, 'storages', 'session_projcache', 'sessions')
  await mkdir(join(storages, 'session_projcache', 'sessions'), { recursive: true })
  for (const id of sessionIds) {
    const file = join(cache, `${id}.json`)
    if (existsSync(file)) await cp(file, join(storages, 'session_projcache', 'sessions', `${id}.json`))
  }
  for (const project of await readdir(join(stage, 'sessions'))) {
    for (const session of await readdir(join(stage, 'sessions', project))) {
      if (!sessionIds.includes(session)) continue
      const target = join(home, 'sessions', project, session)
      await rm(target, { recursive: true, force: true })
      await cp(join(stage, 'sessions', project, session), target, { recursive: true })
    }
  }
}
