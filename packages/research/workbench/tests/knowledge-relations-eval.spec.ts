/**
 * The relation graph against the shipped demo projects: the relations an agent
 * would propose from the literature, notes and runs of the sparse-attention
 * (CCFA) and long-summary-consistency (spark-to-paper) projects, each with the
 * outcome the grounding rule gives and whether the source really states it.
 * The fixtures hold short excerpts of the demo records (the sentences quoted
 * here, as the PDF text extraction left them) and the projects' OpenAlex
 * reference lists; the counts below are the numbers the Agent Note reports.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_PROPOSALS, applyCitationWorks, applyProposals, emptyRelations, mergeSuggestions, relationGraph,
  type CitationWork, type EntityRef, type GroundInput, type ProposalOutcome, type RelationProposal, type RelationsFile,
} from '../src/knowledge-relations.ts'
import type { RelationKind } from '../src/knowledge-relations-grounding.ts'
import {
  describeGapMatrix, describePath, findEntities, gapMatrix, neighbourhood, passageIndex, relationPaths, type GapCell,
} from '../src/knowledge-relations-queries.ts'
import type { EvidenceRecord, ExperimentRecord } from '../src/types.ts'

interface Fixture { project: { evidence: EvidenceRecord[]; experiments: ExperimentRecord[] }; citations: CitationWork[] }
const load = (name: string): Fixture => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'knowledge-relations', name), 'utf8')) as Fixture
const NOW = new Date('2026-10-01T10:00:00.000Z')

/** One proposal of the evaluation: what the agent sends, the outcome the rule gives, and whether the passage really states the relation. */
interface Case {
  label: string
  proposal: RelationProposal
  /** The outcome's status, or the refusal code. */
  outcome: string
  true: boolean
}

const method = (name: string, aliases?: string[]): EntityRef => ({ kind: 'method', name, ...aliases ? { aliases } : {} })
const task = (name: string, aliases?: string[]): EntityRef => ({ kind: 'task', name, ...aliases ? { aliases } : {} })
const dataset = (name: string, aliases?: string[]): EntityRef => ({ kind: 'dataset', name, ...aliases ? { aliases } : {} })
const metric = (name: string): EntityRef => ({ kind: 'metric', name })
const paper = (evidenceId: string): EntityRef => ({ kind: 'paper', evidenceId })
const quote = (evidenceId: string, text: string, extra: Partial<Extract<GroundInput, { type: 'quote' }>> = {}): GroundInput =>
  ({ type: 'quote', evidenceId, revision: 1, quote: text, ...extra })
const run = (runId: string, from: string, to: string, extra: Partial<Extract<GroundInput, { type: 'run' }>> = {}): GroundInput =>
  ({ type: 'run', runId, from, to, ...extra })
const relation = (kind: RelationKind, from: EntityRef, to: EntityRef, ground: GroundInput, by: 'agent' | 'user' = 'agent'): RelationProposal =>
  ({ kind, from, to, ground, by })

// ── Sparse attention scaling study ───────────────────────────────────────────

const LF = '8f41e85c-d571-4e26-9be8-aebe07fd2966', BB = '58177e3f-13c1-4855-9f52-653d2ba56393', RU = 'bde31200-fb67-4bea-9cf0-ccbeaae4bacc'
const FA = 'dfdeb724-ff72-451b-bb34-2e221107db1b', MO = 'c6ea09bf-d829-45dc-84c9-6df5a6e5491b', NS = '59da3bba-9e83-4baa-92cd-50ffffb7f333'
const NOTE_LF = '5b050d83-82c6-4e8e-889e-5dadcca0cd4a', NOTE_RU = '30ea6427-6465-4866-ab79-b233135c2c93'
const FULL = 'ff870bcb-d2ff-4868-91cd-c865d004f98d', FIXED = '1a358b2d-a423-4acb-96f0-7fe40a4e9035'
const DYN = 'a5f17845-e9ef-420d-978d-c37474736327', DYN97 = '408f9905-f149-4c0b-9d62-1d417b4f57a2', DYN13 = 'c008449c-2e94-4bc0-955c-587ae789d4f6'

const longformer = method('Longformer'), led = method('Longformer-Encoder-Decoder', ['LED']), roberta = method('RoBERTa')
const bigbird = method('BigBird', ['Big Bird']), etc = method('ETC'), sparse = method('sparse attention', ['稀疏注意力'])
const full = method('full attention', ['dense attention', '全注意力']), moba = method('MoBA', ['Mixture of Block Attention'])
const moe = method('Mixture of Experts'), nsa = method('NSA', ['Native Sparse Attention']), fa3 = method('FlashAttention-3')
const fa2 = method('FlashAttention-2'), standard = method('standard attention'), selfAttention = method('self-attention')
const dynamicSparse = method('dynamic sparse attention'), minference = method('MInference'), cudnn = method('cuDNN')
const dynamic = method('dynamic block selection', ['动态选块']), fixed = method('fixed block sparse attention', ['固定分块'])
const blockSparse = method('block-sparse attention', ['块稀疏注意力'])
const qa = task('question answering', ['QA']), summarization = task('summarization'), coreference = task('coreference resolution')
const longContext = task('long-context modeling', ['长上下文建模']), longDocumentQa = task('long-document question answering', ['长文档问答'])
const text8 = dataset('text8'), enwik8 = dataset('enwik8'), wikihop = dataset('WikiHop'), triviaqa = dataset('TriviaQA')
const arxiv = dataset('arXiv summarization dataset'), ruler = dataset('RULER'), longbench = dataset('LongBench')
const niah = dataset('needle-in-a-haystack', ['NIAH', 'Needle in the Haystack'])
const accuracy = metric('accuracy'), flops = metric('relative FLOPs')

const LF_ABSTRACT = 'Our pretrained Longformer consistently outperforms RoBERTa on long document tasks and sets new state-of-the-art results on WikiHop and TriviaQA.'
const LF_LED = 'We finally introduce the Longformer-Encoder-Decoder (LED), a Longformer variant for supporting long document generative sequence-to-sequence tasks, and demonstrate its effectiveness on the arXiv summarization dataset.'
const LF_TASKS = 'demonstrate that Longformer consistently outperforms RoBERTa on a wide range of document-level natural language tasks including text classification, QA, and coreference resolution'
const BB_INTRO = 'To remedy this, we propose, BigBird, a sparse attention mechanism that reduces this quadratic dependency to linear.'
const BB_TASKS = 'BIGBIRD drastically improves performance on various NLP tasks such as question answering and summarization'
const BB_BETTER = 'both BIGBIRD and Longformer perform better than limited length RoBERTa'
const NS_INTRO = 'We present NSA, a Natively trainable Sparse Attention mechanism that integrates algorithmic innovations with hardware-aligned optimizations to achieve efficient long-context modeling.'
const MO_RULER = 'in the longest benchmark, RULER, where MoBA operates at a sparsity level of up to 1 − 4096×12 128K = 62.5%'

const SPARSE: Case[] = [
  // Relations the sources state, which the rule accepts.
  { label: 'Longformer introduces Longformer', true: true, outcome: 'added', proposal: relation('introduces', paper(LF), longformer, quote(LF, 'To address this limitation, we introduce the Longformer with an attention mechanism that scales linearly with sequence length')) },
  { label: 'Longformer evaluated on text8', true: true, outcome: 'added', proposal: relation('evaluated-on', longformer, text8, quote(LF, 'we evaluate Longformer on character-level language modeling and achieve state-of-the-art results on text8 and enwik8')) },
  { label: 'Longformer evaluated on enwik8', true: true, outcome: 'added', proposal: relation('evaluated-on', longformer, enwik8, quote(LF, 'we evaluate Longformer on character-level language modeling and achieve state-of-the-art results on text8 and enwik8')) },
  { label: 'Longformer improves on RoBERTa', true: true, outcome: 'added', proposal: relation('improves-on', longformer, roberta, quote(LF, 'Our pretrained Longformer consistently outperforms RoBERTa on long document tasks', { locator: { page: 2 } })) },
  { label: 'Longformer evaluated on WikiHop', true: true, outcome: 'added', proposal: relation('evaluated-on', longformer, wikihop, quote(LF, LF_ABSTRACT)) },
  { label: 'Longformer evaluated on TriviaQA', true: true, outcome: 'added', proposal: relation('evaluated-on', longformer, triviaqa, quote(LF, LF_ABSTRACT)) },
  { label: 'LED is a Longformer', true: true, outcome: 'added', proposal: relation('is-a', led, longformer, quote(LF, LF_LED)) },
  { label: 'LED evaluated on arXiv summarization', true: true, outcome: 'added', proposal: relation('evaluated-on', led, arxiv, quote(LF, LF_LED)) },
  { label: 'Longformer applied to coreference', true: true, outcome: 'added', proposal: relation('applied-to', longformer, coreference, quote(LF, LF_TASKS)) },
  { label: 'Longformer applied to QA', true: true, outcome: 'added', proposal: relation('applied-to', longformer, qa, quote(LF, LF_TASKS)) },
  { label: 'BigBird extends ETC (from Longformer)', true: true, outcome: 'added', proposal: relation('extends', bigbird, etc, quote(LF, 'BigBird (Zaheer et al., 2020) is an extension over ETC with evaluation on additional tasks, including summarization.')) },
  { label: 'BigBird introduces BigBird', true: true, outcome: 'added', proposal: relation('introduces', paper(BB), bigbird, quote(BB, BB_INTRO, { locator: { page: 1 } })) },
  { label: 'BigBird is a sparse attention', true: true, outcome: 'added', proposal: relation('is-a', bigbird, sparse, quote(BB, BB_INTRO)) },
  { label: 'BigBird applied to QA', true: true, outcome: 'added', proposal: relation('applied-to', bigbird, qa, quote(BB, BB_TASKS)) },
  { label: 'BigBird applied to summarization', true: true, outcome: 'added', proposal: relation('applied-to', bigbird, summarization, quote(BB, BB_TASKS)) },
  { label: 'BigBird improves on RoBERTa', true: true, outcome: 'added', proposal: relation('improves-on', bigbird, roberta, quote(BB, BB_BETTER)) },
  { label: 'Longformer improves on RoBERTa (BigBird)', true: true, outcome: 'added', proposal: relation('improves-on', longformer, roberta, quote(BB, BB_BETTER)) },
  { label: 'RULER introduces RULER', true: true, outcome: 'added', proposal: relation('introduces', paper(RU), ruler, quote(RU, 'we create a new synthetic benchmark RULER with flexible configurations for customized sequence length and task complexity')) },
  { label: 'MoBA introduces MoBA', true: true, outcome: 'added', proposal: relation('introduces', paper(MO), moba, quote(MO, 'We introduce Mixture of Block Attention (MoBA), an innovative approach that applies the principles of Mixture of Experts (MoE) to the attention mechanism.')) },
  { label: 'MoBA extends mixture of experts', true: true, outcome: 'added', proposal: relation('extends', moba, moe, quote(MO, 'we introduce Mixture of Block Attention (MoBA), a novel architecture that builds upon the innovative principles of Mixture of Experts (MoE)')) },
  { label: 'MoBA compared with full attention', true: true, outcome: 'added', proposal: relation('compares-with', moba, full, quote(MO, 'we perform scaling law experiments by comparing the validation loss of language models trained using either full attention or MoBA')) },
  { label: 'MoBA evaluated on RULER at 128K', true: true, outcome: 'added', proposal: relation('evaluated-on', moba, ruler, quote(MO, MO_RULER, { setting: '128K' })) },
  { label: 'MoBA evaluated on NIAH (self-reference)', true: true, outcome: 'added', proposal: relation('evaluated-on', moba, niah, quote(MO, 'For context lengths of up to 1M tokens, we evaluate the model using the traditional Needle in the Haystack benchmark.')) },
  { label: 'MInference is a dynamic sparse attention', true: true, outcome: 'added', proposal: relation('is-a', minference, dynamicSparse, quote(MO, 'a range of dynamic sparse attention mechanisms, exemplified by Quest (Tang et al. 2024), Minference')) },
  { label: 'NSA introduces NSA', true: true, outcome: 'added', proposal: relation('introduces', paper(NS), nsa, quote(NS, NS_INTRO)) },
  { label: 'NSA is a sparse attention', true: true, outcome: 'added', proposal: relation('is-a', nsa, sparse, quote(NS, NS_INTRO)) },
  { label: 'NSA applied to long-context modeling', true: true, outcome: 'added', proposal: relation('applied-to', nsa, longContext, quote(NS, NS_INTRO)) },
  { label: 'NSA improves on full attention', true: true, outcome: 'added', proposal: relation('improves-on', nsa, full, quote(NS, 'Despite being sparse, NSA surpasses Full Attention baseline on average across general benchmarks, long-context tasks, and reasoning evaluation.')) },
  { label: 'NSA evaluated on LongBench', true: true, outcome: 'added', proposal: relation('evaluated-on', nsa, longbench, quote(NS, 'We also evaluate NSA on LongBench (Bai et al., 2023) against state-of-the-art sparse attention')) },
  { label: 'NSA improves on full attention (Table 2)', true: true, outcome: 'added', proposal: relation('improves-on', nsa, full, quote(NS, 'NSA achieves the highest average score 0.469, outperforming all baselines (+0.032 over Full Attention and +0.046 over Exact-Top)')) },
  { label: 'FlashAttention-3 introduces FlashAttention-3', true: true, outcome: 'added', proposal: relation('introduces', paper(FA), fa3, quote(FA, 'To this end, we propose FlashAttention-3, which contributes and synthesizes three new ideas to further improve performance on newer GPU architectures')) },
  { label: 'FlashAttention-3 improves on standard attention', true: true, outcome: 'added', proposal: relation('improves-on', fa3, standard, quote(FA, 'We also validate that FP16 FlashAttention-3 yields the same numerical error as FlashAttention-2 and is better than the standard attention implementation')) },
  { label: 'Longformer applied to long-document QA (notes)', true: true, outcome: 'added', proposal: relation('applied-to', longformer, longDocumentQa, quote(NOTE_LF, '读书笔记：Longformer（Beltagy 等，2020） - 注意力模式：滑动窗口的局部注意力，加上少量按任务指定的全局注意力。 - 复杂度随序列长度线性增长，可以直接替换标准自注意力。 - 评测：长文档问答')) },
  { label: 'dynamic evaluated on RULER (run 42)', true: true, outcome: 'added', proposal: relation('evaluated-on', dynamic, ruler, run(DYN, 'dynamic', 'ruler', { setting: '32K' })) },
  { label: 'dynamic evaluated on RULER (run 97)', true: true, outcome: 'added', proposal: relation('evaluated-on', dynamic, ruler, run(DYN97, 'dynamic', 'ruler', { setting: '32K' })) },
  { label: 'fixed evaluated on RULER (run)', true: true, outcome: 'added', proposal: relation('evaluated-on', fixed, ruler, run(FIXED, 'fixed', 'ruler', { setting: '32K' })) },
  { label: 'full attention evaluated on RULER (run)', true: true, outcome: 'added', proposal: relation('evaluated-on', full, ruler, run(FULL, 'full', 'ruler', { setting: '32K' })) },
  { label: 'dynamic compared with full attention (runs)', true: true, outcome: 'added', proposal: relation('compares-with', dynamic, full, run(DYN, 'dynamic', 'full', { baselineRunId: FULL })) },
  { label: 'fixed compared with full attention (runs)', true: true, outcome: 'added', proposal: relation('compares-with', fixed, full, run(FIXED, 'fixed', 'full', { baselineRunId: FULL })) },
  { label: 'dynamic measured by accuracy (run)', true: true, outcome: 'added', proposal: relation('measured-by', dynamic, accuracy, run(DYN, 'dynamic', 'accuracy')) },
  { label: 'dynamic measured by relative FLOPs (run)', true: true, outcome: 'added', proposal: relation('measured-by', dynamic, flops, run(DYN, 'dynamic', 'relative_flops')) },
  // Proposals the rule refuses.
  { label: 'paraphrase instead of a quotation', true: false, outcome: 'quote-not-found', proposal: relation('improves-on', moba, full, quote(MO, 'MoBA outperforms full attention on long-context benchmarks.')) },
  { label: 'comparison read as improvement', true: false, outcome: 'missing-cue', proposal: relation('improves-on', moba, full, quote(MO, 'although MoBA exhibits a marginally higher last block LM loss compared to full attention')) },
  { label: 'quotation of another paper', true: false, outcome: 'quote-not-found', proposal: relation('evaluated-on', moba, ruler, quote(RU, MO_RULER)) },
  { label: 'introduction quoted from another paper', true: false, outcome: 'foreign-source', proposal: relation('introduces', paper(LF), bigbird, quote(BB, BB_INTRO)) },
  { label: 'quotation naming one side', true: false, outcome: 'missing-mention', proposal: relation('evaluated-on', nsa, longbench, quote(NS, 'We evaluate NSA through comprehensive experiments on real-world language corpora.')) },
  { label: 'provider abstract of another work', true: false, outcome: 'abstract-only', proposal: relation('introduces', paper(LF), method('Murmurative Attention'), quote(LF, 'We introduce Murmurative Attention, a novel attention mechanism')) },
  { label: 'reversed improvement', true: false, outcome: 'wrong-direction', proposal: relation('improves-on', roberta, longformer, quote(LF, 'Our pretrained Longformer consistently outperforms RoBERTa on long document tasks')) },
  { label: 'setting the quotation does not state', true: false, outcome: 'setting-not-quoted', proposal: relation('evaluated-on', moba, ruler, quote(MO, MO_RULER, { setting: '64K' })) },
  { label: 'run of another method', true: false, outcome: 'run-label', proposal: relation('evaluated-on', longformer, ruler, run(DYN, 'dynamic', 'ruler')) },
  { label: 'interrupted run', true: false, outcome: 'run-not-collected', proposal: relation('evaluated-on', dynamic, ruler, run(DYN13, 'dynamic', 'ruler')) },
  { label: 'a metric as a dataset', true: false, outcome: 'kind-mismatch', proposal: relation('evaluated-on', moba, accuracy, quote(MO, MO_RULER)) },
  { label: 'speed-up without an improvement word', true: true, outcome: 'missing-cue', proposal: relation('improves-on', fa3, fa2, quote(FA, 'We are able to speed up attention by 1.5-2.0×times compared to FlashAttention-2')) },
  { label: 'worse result read as improvement', true: false, outcome: 'missing-cue', proposal: relation('improves-on', fa3, cudnn, quote(FA, 'FP8FlashAttention-3 does not perform as well for small sequence length and causal masking compared to the FP8 cuDNN kernels')) },
  { label: 'is-a without an is-a word', true: true, outcome: 'missing-cue', proposal: relation('is-a', moba, blockSparse, quote(MO, 'MoBA addresses the computational inefficiency of traditional attention mechanisms by partitioning the context into blocks and employing a gating mechanism to selectively route query tokens to the most relevant blocks. This block sparse attention significantly reduces the computational costs')) },
  { label: 'note naming neither side', true: false, outcome: 'missing-mention', proposal: relation('evaluated-on', dynamic, ruler, quote(NOTE_RU, '我自己的判断：聚合类任务要把分散在全文的信息汇总起来，最可能暴露稀疏注意力的短板。')) },
  { label: 'revision the record does not have', true: false, outcome: 'revision-changed', proposal: relation('improves-on', longformer, roberta, quote(LF, 'Our pretrained Longformer consistently outperforms RoBERTa', { revision: 2 })) },
  { label: 'citation by quotation', true: false, outcome: 'ground-not-allowed', proposal: relation('cites', paper(BB), paper(LF), quote(BB, BB_BETTER)) },
  { label: 'three words', true: false, outcome: 'quote-too-short', proposal: relation('evaluated-on', moba, ruler, quote(MO, 'RULER, where MoBA')) },
  // Accepted although the passage does not state the relation: what the rule cannot see.
  { label: 'replacement read as is-a', true: false, outcome: 'added', proposal: relation('is-a', longformer, selfAttention, quote(LF, 'Longformer’s attention mechanism is a drop-in replacement for the standard self-attention')) },
  { label: 'two methods beating others read as a comparison', true: false, outcome: 'added', proposal: relation('compares-with', bigbird, longformer, quote(BB, 'both Longformer and BIGBIRD outperform models with smaller contexts')) },
]

// ── Long-summary consistency ────────────────────────────────────────────────

const QF = '3eb20dfd-e5b9-4a5d-9c5f-5f27dd516a3e', FC = '7c43c309-79b2-4553-bcb4-583100e0a7e3', SC = '2e0053ea-f34a-4e1f-a58e-ad3cc83b03fc'
const AS = '8abc86ac-5068-4ff7-a615-356d1885341c', QG = '05e989d6-9255-4350-a8d1-eee2f1cf82cb', NOTES = '73e04eb9-68d9-41d0-9eda-94886335633e'
const qafacteval = method('QAFactEval'), factcc = method('FactCC'), summacConv = method('SummaCConv', ['SummaC-Conv', 'SCConv'])
const alignscore = method('AlignScore'), qags = method('QAGS'), rouge = metric('ROUGE')
const summacBenchmark = dataset('SummaC benchmark', ['SummaC']), trueBenchmark = dataset('TRUE benchmark', ['TRUE'])
const cnndm = dataset('CNN/DailyMail', ['CNN/DM']), balancedAccuracy = metric('balanced accuracy')
const QF_INTRO = 'we propose an optimized metric, which we call QAFactEval, that leads to a 14% average improvement over previous QA-based metrics on the SummaC factual consistency benchmark'
const AS_EVAL = 'We evaluate AlignScore on the latest large-scale evaluation benchmarks, including SummaC (Laban et al., 2022), TRUE (Honovich et al., 2022b), and other testbeds'
const AS_BASELINES = 'For sentence-level baseline, we use SummaC-ZeroShot and SummaC-Conv introduced in the SummaC Benchmark (Laban et al., 2022) and FactCC (Kryscinski et al., 2020)'
const SC_BOTH = 'We furthermore introduce a new benchmark called SummaC (Summary Consistency) which consists of six large inconsistency detection datasets. On this dataset, SummaCConv obtains state-of-the-art results with a balanced accuracy of 74.4%'

const SUMMARY: Case[] = [
  { label: 'QAFactEval introduces QAFactEval', true: true, outcome: 'added', proposal: relation('introduces', paper(QF), qafacteval, quote(QF, QF_INTRO)) },
  { label: 'QAFactEval evaluated on SummaC', true: true, outcome: 'added', proposal: relation('evaluated-on', qafacteval, summacBenchmark, quote(QF, QF_INTRO)) },
  { label: 'FactCC introduces FactCC', true: true, outcome: 'added', proposal: relation('introduces', paper(FC), factcc, quote(FC, 'We refer to this model as the factual consistency checking model (FactCC).')) },
  { label: 'FactCC evaluated on CNN/DailyMail', true: true, outcome: 'added', proposal: relation('evaluated-on', factcc, cnndm, quote(FC, 'Both FactCC and FactCCX models substantially outperform classifiers trained on the MNLI and FEVER datasets when evaluated on the CNN/DailyMail test set.')) },
  { label: 'SummaC introduces SummaCConv', true: true, outcome: 'added', proposal: relation('introduces', paper(SC), summacConv, quote(SC, 'We provide a highly effective and light-weight method called SummaCConv that enables NLI models to be successfully used for this task')) },
  { label: 'SummaC introduces the SummaC benchmark', true: true, outcome: 'added', proposal: relation('introduces', paper(SC), summacBenchmark, quote(SC, 'We furthermore introduce a new benchmark called SummaC (Summary Consistency) which consists of six large inconsistency detection datasets.')) },
  { label: 'SummaCConv evaluated on SummaC', true: true, outcome: 'added', proposal: relation('evaluated-on', summacConv, summacBenchmark, quote(SC, SC_BOTH)) },
  { label: 'SummaCConv measured by balanced accuracy', true: true, outcome: 'added', proposal: relation('measured-by', summacConv, balancedAccuracy, quote(SC, SC_BOTH)) },
  { label: 'AlignScore introduces AlignScore', true: true, outcome: 'added', proposal: relation('introduces', paper(AS), alignscore, quote(AS, 'In this paper, we propose AlignScore, a new holistic metric that applies to a variety of factual inconsistency scenarios')) },
  { label: 'AlignScore evaluated on SummaC', true: true, outcome: 'added', proposal: relation('evaluated-on', alignscore, summacBenchmark, quote(AS, AS_EVAL)) },
  { label: 'AlignScore evaluated on TRUE', true: true, outcome: 'added', proposal: relation('evaluated-on', alignscore, trueBenchmark, quote(AS, AS_EVAL)) },
  { label: 'AlignScore compared with QAFactEval (our baselines)', true: true, outcome: 'added', proposal: relation('compares-with', alignscore, qafacteval, quote(AS, 'We include the latest QAFactEval (Fabbri et al., 2022), QuestEval (Scialom et al., 2021), and FEQA (Durmus et al., 2020) as our baselines.')) },
  { label: 'AlignScore compared with FactCC', true: true, outcome: 'added', proposal: relation('compares-with', alignscore, factcc, quote(AS, AS_BASELINES)) },
  { label: 'AlignScore compared with SummaCConv', true: true, outcome: 'added', proposal: relation('compares-with', alignscore, summacConv, quote(AS, AS_BASELINES)) },
  { label: 'QAGS introduces QAGS, footnote mark left out', true: true, outcome: 'quote-not-found', proposal: relation('introduces', paper(QG), qags, quote(QG, 'We propose QAGS, an automatic evaluation protocol that is designed to identify factual inconsistencies in a generated summary.')) },
  { label: 'QAGS introduces QAGS, as the PDF text has it', true: true, outcome: 'added', proposal: relation('introduces', paper(QG), qags, quote(QG, 'We propose QAGS,1 an automatic evaluation protocol that is designed to identify factual inconsistencies in a generated summary.')) },
  { label: 'SummaCConv on SummaC through "this dataset"', true: true, outcome: 'missing-mention', proposal: relation('evaluated-on', summacConv, summacBenchmark, quote(SC, 'On this dataset, SummaCConv obtains state-of-the-art results with a balanced accuracy of 74.4%')) },
  { label: 'improvement over unnamed metrics', true: true, outcome: 'missing-mention', proposal: relation('improves-on', qafacteval, summacConv, quote(QF, 'we propose an optimized metric, which we call QAFACT EVAL , that outperforms the entailmentbased metrics of Laban et al. (2021)')) },
  { label: 'higher correlations than unnamed metrics', true: false, outcome: 'missing-mention', proposal: relation('improves-on', qags, method('ROUGE metric'), quote(QG, 'QAGS has substantially higher correlations with these judgments than other automatic evaluation metrics.')) },
  { label: 'a metric as a method', true: false, outcome: 'kind-mismatch', proposal: relation('compares-with', qags, rouge, quote(QG, 'QAGS has substantially higher correlations with these judgments than other automatic evaluation metrics.')) },
  { label: 'the project note read as a comparison', true: false, outcome: 'missing-mention', proposal: relation('compares-with', qafacteval, summacConv, quote(NOTES, '摘要级别用 AUC 看指标能不能区分一致和不一致的摘要：SummaC 在长文档上掉得明显，QAFactEval 比较稳。')) },
]

function tally(cases: readonly Case[], outcomes: readonly ProposalOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {
    proposals: cases.length, accepted: 0, refused: 0, trueAccepted: 0, falseAccepted: 0, trueRefused: 0, falseRefused: 0,
  }
  const bump = (key: string): void => { counts[key] = (counts[key] ?? 0) + 1 }
  outcomes.forEach((outcome, i) => {
    const truth = (cases[i] as Case).true
    const accepted = outcome.status !== 'refused'
    bump(accepted ? 'accepted' : 'refused')
    bump(accepted ? (truth ? 'trueAccepted' : 'falseAccepted') : (truth ? 'falseRefused' : 'trueRefused'))
    if (outcome.status === 'refused') bump(`code:${outcome.code}`)
  })
  return counts
}

/** Propose the cases in calls of at most MAX_PROPOSALS, in order, as the agent would. */
function propose(fixture: Fixture, cases: readonly Case[]): { file: RelationsFile; outcomes: ProposalOutcome[] } {
  let file = emptyRelations()
  const outcomes: ProposalOutcome[] = []
  for (let start = 0; start < cases.length; start += MAX_PROPOSALS) {
    const edit = applyProposals(file, fixture.project, cases.slice(start, start + MAX_PROPOSALS).map(item => item.proposal), NOW)
    file = edit.file
    outcomes.push(...edit.result)
  }
  return { file, outcomes }
}

describe('the sparse-attention demo project', () => {
  const fixture = load('sparse-attention.json')
  const { file, outcomes } = propose(fixture, SPARSE)

  it('gives every proposal the outcome the rule implies', () => {
    expect(outcomes.map((outcome, i) => [SPARSE[i]?.label, outcome.status === 'refused' ? outcome.code : outcome.status]))
      .toEqual(SPARSE.map(item => [item.label, item.outcome]))
  })

  it('accepts 43 of 61 proposals, two of them not stated by their passage, and refuses two that are', () => {
    expect(tally(SPARSE, outcomes)).toEqual({
      'proposals': 61, 'accepted': 43, 'refused': 18, 'trueAccepted': 41, 'falseAccepted': 2, 'trueRefused': 16, 'falseRefused': 2,
      'code:quote-not-found': 2, 'code:missing-cue': 4, 'code:foreign-source': 1, 'code:missing-mention': 2, 'code:abstract-only': 1,
      'code:wrong-direction': 1, 'code:setting-not-quoted': 1, 'code:run-label': 1, 'code:run-not-collected': 1, 'code:kind-mismatch': 1,
      'code:revision-changed': 1, 'code:ground-not-allowed': 1, 'code:quote-too-short': 1,
    })
  })

  it('stores the source\'s words, not the agent\'s, and names the self-reference a ground relied on', () => {
    const bigbirdIntro = file.relations.find(item => item.kind === 'introduces' && item.to === 'method:bigbird')
    expect(bigbirdIntro?.grounds[0]).toMatchObject({ type: 'quote', locator: { page: 1 }, quote: 'To remedy this, we propose, BIGBIRD , a sparse attention mechanism that reduces this quadratic dependency to linear.' })
    const needle = file.relations.find(item => item.id === 'evaluated-on:method:moba>dataset:needle-in-a-haystack')
    expect(needle?.grounds[0]).toMatchObject({ via: 'introduces:paper:c6ea09bf-d829-45dc-84c9-6df5a6e5491b>method:moba' })
    const roberta = file.relations.find(item => item.id === 'improves-on:method:longformer>method:roberta')
    expect(roberta?.grounds.map(ground => ground.type === 'quote' ? ground.evidenceId : '')).toEqual([LF, BB])
  })

  it('explains the refusals in terms the agent can act on', () => {
    const message = (label: string): string => {
      const outcome = outcomes[SPARSE.findIndex(item => item.label === label)]
      return outcome?.status === 'refused' ? outcome.message : ''
    }
    expect(message('paraphrase instead of a quotation')).toContain('does not occur in revision 1 of "MoBA: Mixture of Block Attention for Long-Context LLMs"')
    expect(message('provider abstract of another work')).toContain('only in the provider\'s abstract')
    expect(message('reversed improvement')).toContain('"RoBERTa" is the one that outperforms')
    expect(message('quotation naming one side')).toContain('does not name "LongBench"')
  })

  it('connects citations among the project\'s papers from the OpenAlex reference lists', () => {
    const { result, file: cited } = applyCitationWorks(file, fixture.project, fixture.citations, NOW)
    expect(result).toEqual({ works: 8, added: 2, unchanged: 0, rejected: 0 })
    expect(cited.relations.filter(item => item.kind === 'cites').map(item => item.id)).toEqual([
      `cites:paper:${BB}>paper:${LF}`, `cites:paper:${LF}>paper:${BB}`,
    ])
  })

  it('finds the paths between the project\'s own method and question answering', () => {
    const graph = relationGraph(file, fixture.project)
    const [from] = findEntities(graph, 'dynamic block selection'), [to] = findEntities(graph, 'question answering')
    const result = relationPaths(graph, { from: from as string, to: to as string, k: 3, maxHops: 6 })
    expect(result.paths.map(path => [path.nodes, path.confidence, path.cost])).toEqual([
      [['method:dynamic-block-selection', 'method:full-attention', 'method:nsa', 'method:sparse-attention', 'method:bigbird', 'task:question-answering'], 0.59, 1.777],
      [['method:dynamic-block-selection', 'dataset:ruler', 'method:full-attention', 'method:nsa', 'method:sparse-attention', 'method:bigbird', 'task:question-answering'], 0.585, 2.037],
      [['method:dynamic-block-selection', 'method:full-attention', 'method:nsa', 'method:sparse-attention', 'method:bigbird', 'method:longformer', 'task:question-answering'], 0.531, 2.132],
    ])
    expect(describePath(graph, result.paths[0] as NonNullable<typeof result.paths[0]>).split('\n')[1]).toBe('dynamic block selection —compares-with→ full attention — run ruler-32k-dynamic · seed 42 [compares-with:method:dynamic-block-selection>method:full-attention]')
    // The project's own framing, block-sparse attention, has no grounded relation: its only proposal lacked an is-a word.
    expect(graph.entities.has('method:block-sparse-attention')).toBe(false)
    expect(findEntities(graph, 'block-sparse attention')).toEqual(['method:fixed-block-sparse-attention'])
  })

  it('reports the gap matrix of methods against settings for this project\'s sources only', () => {
    const graph = relationGraph(file, fixture.project)
    const matrix = gapMatrix(graph, { axis: 'setting', rows: ['method:dynamic-block-selection', 'method:fixed-block-sparse-attention', 'method:full-attention', 'method:moba'], columns: ['32K', '64K', '128K'] }, passageIndex(fixture.project))
    expect(matrix.cells.map(row => row.map(cell => cell.state))).toEqual([
      ['project-only', 'uncovered', 'uncovered'],
      ['project-only', 'uncovered', 'uncovered'],
      ['project-only', 'absent', 'absent'],
      ['absent', 'absent', 'reported'],
    ])
    expect(describeGapMatrix(matrix).split('\n')[0]).toContain('over this project\'s own sources only')
  })

  it('reports the gap matrix of methods against datasets', () => {
    const graph = relationGraph(file, fixture.project)
    const matrix = gapMatrix(graph, { axis: 'dataset' }, passageIndex(fixture.project))
    expect(matrix.columns.map(column => column.name)).toEqual([
      'RULER', 'arXiv summarization dataset', 'enwik8', 'LongBench', 'needle-in-a-haystack', 'text8', 'TriviaQA', 'WikiHop',
    ])
    const table = Object.fromEntries(matrix.rows.map((row, r) => [row.name, (matrix.cells[r] as GapCell[]).map(cell => cell.state).join(' ')]))
    expect(table).toEqual({
      'Longformer': 'absent reported reported absent absent reported reported reported',
      'MoBA': 'reported absent absent absent reported absent absent absent',
      'dynamic block selection': 'project-only uncovered uncovered uncovered uncovered uncovered uncovered uncovered',
      'fixed block sparse attention': 'project-only uncovered uncovered uncovered uncovered uncovered uncovered uncovered',
      'full attention': 'project-only absent absent mentioned absent absent absent absent',
      'Longformer-Encoder-Decoder': 'absent reported mentioned absent absent mentioned mentioned mentioned',
      'NSA': 'absent absent absent reported absent absent absent absent',
    })
    // Longformer reports arXiv summarization only through its encoder-decoder variant (is-a, rolled up).
    expect(matrix.cells[0]?.[1]).toMatchObject({ papers: 1, viaSubtypes: 1 })
  })

  it('keeps the neighbourhood of RULER small and centred', () => {
    const graph = relationGraph(file, fixture.project)
    const view = neighbourhood(graph, { center: 'dataset:ruler', maxNodes: 12 })
    expect(view?.nodes.filter(node => node.ring === 1).map(node => node.id)).toEqual([
      'method:dynamic-block-selection', 'method:fixed-block-sparse-attention', 'method:full-attention', 'method:moba', `paper:${RU}`,
    ])
    expect(view?.nodes.filter(node => node.core).map(node => node.id)).toEqual([
      'dataset:ruler', 'method:dynamic-block-selection', 'method:fixed-block-sparse-attention', 'method:full-attention', 'method:moba',
    ])
  })

  it('suggests merging the acronym the agent named separately', () => {
    const { file: withMoe } = applyProposals(file, fixture.project, [
      relation('extends', moba, method('MoE'), quote(MO, 'we introduce Mixture of Block Attention (MoBA), a novel architecture that builds upon the innovative principles of Mixture of Experts (MoE)')),
    ], NOW)
    expect(mergeSuggestions(withMoe)).toContainEqual({ a: 'method:mixture-of-experts', b: 'method:moe', reason: 'acronym', names: ['Mixture of Experts', 'MoE'] })
  })
})

describe('the long-summary-consistency demo project', () => {
  const fixture = load('summary-consistency.json')
  const { file, outcomes } = propose(fixture, SUMMARY)

  it('gives every proposal the outcome the rule implies', () => {
    expect(outcomes.map((outcome, i) => [SUMMARY[i]?.label, outcome.status === 'refused' ? outcome.code : outcome.status]))
      .toEqual(SUMMARY.map(item => [item.label, item.outcome]))
  })

  it('accepts 15 of 21, refusing three that the papers state through a pronoun, an unnamed reference or a footnote mark', () => {
    expect(tally(SUMMARY, outcomes)).toEqual({
      'proposals': 21, 'accepted': 15, 'refused': 6, 'trueAccepted': 15, 'falseAccepted': 0, 'trueRefused': 3, 'falseRefused': 3,
      'code:missing-mention': 4, 'code:kind-mismatch': 1, 'code:quote-not-found': 1,
    })
    const footnote = outcomes[SUMMARY.findIndex(item => item.label.endsWith('footnote mark left out'))]
    expect(footnote?.status === 'refused' ? footnote.message : '').toContain('there the source continues "1 an automatic evaluation protocol')
  })

  it('records 168 citations among the 31 papers and finds both kinds of path between QAFactEval and FactCC', () => {
    const { file: cited, result } = applyCitationWorks(file, fixture.project, fixture.citations, NOW)
    expect(result).toEqual({ works: 31, added: 168, unchanged: 0, rejected: 0 })
    const graph = relationGraph(cited, fixture.project)
    const paths = relationPaths(graph, { from: 'method:qafacteval', to: 'method:factcc', k: 4, maxHops: 4 })
    expect(paths.paths.map(path => [path.hops.map(hop => hop.kind), path.confidence])).toEqual([
      [['compares-with', 'compares-with'], 0.81],
      [['evaluated-on', 'evaluated-on', 'compares-with'], 0.729],
      [['evaluated-on', 'evaluated-on', 'compares-with', 'compares-with'], 0.583],
      [['introduces', 'cites', 'introduces'], 0.405],
    ])
  })
})
