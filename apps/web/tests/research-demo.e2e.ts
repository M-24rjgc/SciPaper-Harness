/**
 * Builds the example projects Research Workbench opens onto: the material for
 * promotion, guided onboarding and the beginner tutorial. A scripted model plays
 * the assistant against the shipped host, so every conversation, ledger record,
 * compile, experiment and question card is one the product itself produced; only
 * the words are fixed. Numbers are example values and the reading notes are the
 * researcher's own paraphrases, as each project's data/README.md says.
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

interface Call { name: string; args: Record<string, unknown> }
interface Reply { text?: string; calls?: Call[]; again?: boolean }
type Step = () => Reply | Promise<Reply>

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

const PHASE_ZH: Record<string, string> = {
  idea: '想法', literature: '文献', plan: '规划', draft: '完整初稿', experiments: '实验', results: '结果',
  polish: '打磨与审阅', submission: '投稿', ingest: '导入结果', write: '写作', figures: '图表',
}

// ── Sparse attention scaling study: the researcher's materials ──────────────

const SPARSE_README = `# 关于本目录的数据

这是 Research Workbench 的示例项目，用来演示一项研究从想法走到论文的过程。

- notes/ 里是研究者读论文时写的笔记，是自己的转述和判断，不是论文原文摘录。
- pilot-8k.csv 和 code/train_eval.py 输出的实验数值都是演示用的示例数值，不是真实测量。
- 参考文献（paper/refs.bib）是真实存在的论文。
`

const LONGFORMER_NOTES = `# 读书笔记：Longformer（Beltagy 等，2020）

- 注意力模式：滑动窗口的局部注意力，加上少量按任务指定的全局注意力。
- 复杂度随序列长度线性增长，可以直接替换标准自注意力。
- 评测：长文档问答、共指消解、文档分类，文档长度大约在 4K token 这一档。
- 我的疑问：窗口固定时，32K 以上的远距离依赖只能靠全局 token 传递，论文没有测到这个长度。
`

const BIGBIRD_NOTES = `# 读书笔记：BigBird（Zaheer 等，2020）

- 稀疏模式：随机注意力 + 窗口注意力 + 全局 token 三者组合。
- 理论部分证明这种稀疏注意力保留了全注意力的表达能力（通用逼近、图灵完备）。
- 实验序列长度到 4096，问答和长文摘要上优于只能看短上下文的模型。
- 块的划分是固定的，不按内容选块。
`

const RULER_NOTES = `# 读书笔记：RULER（Hsieh 等，2024）

- 合成评测，四类任务：检索、多跳追踪、聚合、问答；上下文长度可以从 4K 调到 128K。
- 结论：很多声称支持长上下文的模型，有效上下文远短于标称长度。
- 我自己的判断：聚合类任务要把分散在全文的信息汇总起来，最可能暴露稀疏注意力的短板。
- 对本项目：32K 和 64K 两档都要测，聚合类任务单独报告。
`

const PILOT_CSV = `method,context,accuracy,relative_flops
full,8192,0.842,1.00
fixed-block-4x,8192,0.836,0.26
dynamic-block-4x,8192,0.841,0.27
`

const SPARSE_BIB = String.raw`@article{beltagy2020longformer,
  title = {Longformer: The Long-Document Transformer},
  author = {Beltagy, Iz and Peters, Matthew E. and Cohan, Arman},
  journal = {arXiv preprint arXiv:2004.05150},
  year = {2020},
  doi = {10.48550/arXiv.2004.05150}
}

@inproceedings{zaheer2020bigbird,
  title = {Big Bird: Transformers for Longer Sequences},
  author = {Zaheer, Manzil and Guruganesh, Guru and Dubey, Avinava and Ainslie, Joshua and Alberti, Chris and Ontanon, Santiago and Pham, Philip and Ravula, Anirudh and Wang, Qifan and Yang, Li and Ahmed, Amr},
  booktitle = {Advances in Neural Information Processing Systems},
  year = {2020},
  doi = {10.48550/arXiv.2007.14062}
}

@inproceedings{hsieh2024ruler,
  title = {{RULER}: What's the Real Context Size of Your Long-Context Language Models?},
  author = {Hsieh, Cheng-Ping and Sun, Simeng and Kriman, Samuel and Acharya, Shantanu and Rekesh, Dima and Jia, Fei and Zhang, Yang and Ginsburg, Boris},
  booktitle = {Conference on Language Modeling},
  year = {2024},
  doi = {10.48550/arXiv.2404.06654}
}

@article{bai2023longbench,
  title = {{LongBench}: A Bilingual, Multitask Benchmark for Long Context Understanding},
  author = {Bai, Yushi and Lv, Xin and Zhang, Jiajie and Lyu, Hongchang and Tang, Jiankai and Huang, Zhidian and Du, Zhengxiao and Liu, Xiao and Zeng, Aohan and Hou, Lei and Dong, Yuxiao and Tang, Jie and Li, Juanzi},
  journal = {arXiv preprint arXiv:2308.14508},
  year = {2023},
  doi = {10.48550/arXiv.2308.14508}
}

@article{shah2024flashattention3,
  title = {{FlashAttention-3}: Fast and Accurate Attention with Asynchrony and Low-precision},
  author = {Shah, Jay and Bikshandi, Ganesh and Zhang, Ying and Thakkar, Vijay and Ramani, Pradeep and Dao, Tri},
  journal = {arXiv preprint arXiv:2407.08608},
  year = {2024},
  doi = {10.48550/arXiv.2407.08608}
}
`

const ARCHITECTURE_DRAWIO = `<mxfile host="Research Workbench">
  <diagram id="architecture" name="Architecture">
    <mxGraphModel dx="900" dy="420" grid="1" gridSize="10" guides="1" page="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="blocks" value="Query / key blocks&lt;br&gt;(64 tokens each)" style="rounded=1;whiteSpace=wrap;html=1;strokeColor=#68675f;fillColor=#ffffff;" vertex="1" parent="1">
          <mxGeometry x="0" y="40" width="150" height="56" as="geometry"/>
        </mxCell>
        <mxCell id="score" value="Block scores&lt;br&gt;(mean-pooled keys)" style="rounded=1;whiteSpace=wrap;html=1;strokeColor=#68675f;fillColor=#ffffff;" vertex="1" parent="1">
          <mxGeometry x="200" y="40" width="150" height="56" as="geometry"/>
        </mxCell>
        <mxCell id="select" value="Top-k block selection&lt;br&gt;(k = n / 4)" style="rounded=1;whiteSpace=wrap;html=1;strokeColor=#15635f;fillColor=#e6efed;fontColor=#104f4c;" vertex="1" parent="1">
          <mxGeometry x="400" y="40" width="150" height="56" as="geometry"/>
        </mxCell>
        <mxCell id="attention" value="Block-sparse attention" style="rounded=1;whiteSpace=wrap;html=1;strokeColor=#68675f;fillColor=#ffffff;" vertex="1" parent="1">
          <mxGeometry x="600" y="40" width="150" height="56" as="geometry"/>
        </mxCell>
        <mxCell id="fixed" value="Fixed blocks&lt;br&gt;(baseline)" style="rounded=1;whiteSpace=wrap;html=1;dashed=1;strokeColor=#b65328;fillColor=#f7e9df;fontColor=#8a3d1d;" vertex="1" parent="1">
          <mxGeometry x="300" y="150" width="150" height="56" as="geometry"/>
        </mxCell>
        <mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;html=1;strokeColor=#68675f;" edge="1" parent="1" source="blocks" target="score"><mxGeometry relative="1" as="geometry"/></mxCell>
        <mxCell id="e2" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;html=1;strokeColor=#68675f;" edge="1" parent="1" source="score" target="select"><mxGeometry relative="1" as="geometry"/></mxCell>
        <mxCell id="e3" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;html=1;strokeColor=#68675f;" edge="1" parent="1" source="select" target="attention"><mxGeometry relative="1" as="geometry"/></mxCell>
        <mxCell id="e4" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;html=1;dashed=1;strokeColor=#b65328;" edge="1" parent="1" source="blocks" target="fixed"><mxGeometry relative="1" as="geometry"/></mxCell>
        <mxCell id="e5" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;html=1;dashed=1;strokeColor=#b65328;" edge="1" parent="1" source="fixed" target="attention"><mxGeometry relative="1" as="geometry"/></mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`

const OUTLINE = `# 论文规划：块稀疏注意力在长上下文下的准确率

## 研究问题
在 4× 稀疏、32K 上下文下，块稀疏注意力的长文准确率能否保持在全注意力的 1 个点以内？
按注意力得分动态选块，相对固定分块的优势会不会随长度消失？

## 贡献
1. 在 32K / 64K 两档上下文下，系统比较固定分块与动态选块两种块稀疏注意力。
2. 一个"选块策略 × 上下文长度"的消融，用来分辨动态选块的优势从哪个长度开始消失。
3. 按 RULER 任务类别拆开报告，单独看聚合类任务。

## 章节
1. Introduction：问题、预实验中的矛盾、贡献
2. Related Work：Longformer、BigBird、RULER、FlashAttention-3
3. Method：块打分、Top-k 选块、固定分块基线（图 1 为架构图）
4. Experimental Setup：数据、基线、种子、指标
5. Results：主表（32K / 64K）、准确率-计算量图、消融
6. Limitations
7. Conclusion

## 实验方案
- 数据：RULER（32K、64K 两档）与 LongBench-E。去掉 PG-19：它与预训练语料重叠，留着会把泄漏算进结论。
- 方法：全注意力（基线）、固定分块 4×、动态选块 4×。
- 种子：13、42、97，各跑一遍；先跑 RULER 32K，结果出来再跑 64K 和 LongBench-E。
- 指标：准确率、困惑度、相对 FLOPs、峰值显存。
- 环境：本机 default（Python 3.12）；实验室 lab-a100 作为补充。
`

const TRAIN_EVAL = `"""示例项目的实验脚本（替身）。

真实项目里，这里是块稀疏注意力的训练与评测代码。为了让示例项目在任何机器上
几秒钟就能复现，本脚本不训练模型，而是输出预先给定的示例数值（EXAMPLE_RESULTS），
并像真实脚本一样把指标写进 $RESEARCH_METRICS_PATH。这些数值不是测量结果。
"""
import argparse
import json
import os
import time
from pathlib import Path

EXAMPLE_RESULTS = {
    ('full', 42): {'accuracy': 0.821, 'perplexity': 6.18, 'relative_flops': 1.0, 'peak_memory_gb': 61.5},
    ('fixed', 42): {'accuracy': 0.811, 'perplexity': 6.29, 'relative_flops': 0.25, 'peak_memory_gb': 37.9},
    ('dynamic', 42): {'accuracy': 0.814, 'perplexity': 6.32, 'relative_flops': 0.26, 'peak_memory_gb': 38.2},
    ('dynamic', 97): {'accuracy': 0.806, 'perplexity': 6.41, 'relative_flops': 0.26, 'peak_memory_gb': 38.4},
    ('dynamic', 13): {'accuracy': 0.809, 'perplexity': 6.36, 'relative_flops': 0.26, 'peak_memory_gb': 38.3},
}


def main():
    parser = argparse.ArgumentParser(description='Block-sparse attention evaluation on RULER (example stand-in).')
    parser.add_argument('--variant', choices=['full', 'fixed', 'dynamic'], required=True)
    parser.add_argument('--context', type=int, default=32768)
    parser.add_argument('--seed', type=int, required=True)
    args = parser.parse_args()
    print(f'variant={args.variant} context={args.context} seed={args.seed}', flush=True)
    for step in range(200, 1401, 200):
        time.sleep(0.15)
        print(f'step {step}/1400', flush=True)
    metrics = EXAMPLE_RESULTS[(args.variant, args.seed)]
    target = Path(os.environ.get('RESEARCH_METRICS_PATH', 'metrics.json'))
    target.write_text(json.dumps(metrics), encoding='utf-8')
    print('run-complete', json.dumps(metrics), flush=True)


if __name__ == '__main__':
    main()
`

const PLOT_ACCURACY = `"""Accuracy against relative FLOPs at 32K tokens, from data/results-32k.csv."""
import csv
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

COLORS = {'full': '#68675f', 'fixed': '#b65328', 'dynamic': '#15635f'}
LABELS = {'full': 'Full attention', 'fixed': 'Fixed blocks (4x)', 'dynamic': 'Dynamic blocks (4x)'}

rows = list(csv.DictReader(Path('data/results-32k.csv').open(encoding='utf-8')))
fig, ax = plt.subplots(figsize=(4.2, 3.0))
for method in ('full', 'fixed', 'dynamic'):
    points = [row for row in rows if row['method'] == method]
    ax.scatter([float(p['relative_flops']) for p in points], [float(p['accuracy']) for p in points],
               s=46, color=COLORS[method], label=LABELS[method], zorder=3)
    for p in points:
        ax.annotate(f"seed {p['seed']}", (float(p['relative_flops']), float(p['accuracy'])),
                    textcoords='offset points', xytext=(6, -3), fontsize=7, color='#68675f')
ax.set_xlabel('Relative FLOPs (full attention = 1)')
ax.set_ylabel('RULER accuracy, 32K tokens')
ax.grid(True, color='#eeebe4', zorder=0)
ax.legend(frameon=False, fontsize=7, loc='lower right')
for side in ('top', 'right'):
    ax.spines[side].set_visible(False)
fig.tight_layout()
Path('figures').mkdir(exist_ok=True)
fig.savefig('figures/accuracy_vs_flops.pdf')
print('wrote figures/accuracy_vs_flops.pdf')
`

interface SparseResult { method: 'full' | 'fixed' | 'dynamic'; seed: number; accuracy: number; flops: number; memory: number }

/** The method paper; before the runs every result cell is "--" and every result sentence a placeholder. */
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
  return String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath}
\usepackage{booktabs}
\usepackage{graphicx}
\usepackage{microtype}
\usepackage{tikz}
\usetikzlibrary{positioning,arrows.meta}
\usepackage[numbers]{natbib}
\usepackage{hyperref}
\graphicspath{{../figures/}}
\newcommand{\tbd}[1]{\textcolor{red}{[#1]}}

\title{Does Block-Sparse Attention Keep Long-Context Accuracy\\at a Quarter of the FLOPs?}
\author{Research Workbench example project}
\date{}

\begin{document}
\maketitle

\begin{abstract}
Block-sparse attention cuts the cost of self-attention by letting each query block attend to a few key blocks. The sparse patterns that made long documents tractable were evaluated around 4K tokens \cite{beltagy2020longformer,zaheer2020bigbird}, and whether choosing blocks by content keeps its advantage over fixed blocks at 32K tokens and beyond is open. We compare fixed and dynamic block selection at 4$\times$ sparsity on RULER \cite{hsieh2024ruler} and LongBench-E \cite{bai2023longbench} at 32K and 64K tokens. ${abstractResult}
\end{abstract}

\section{Introduction}
Long-context models pay for every token twice: in the quadratic attention cost and in the memory that holds keys and values. Block-sparse attention keeps a fixed fraction of the key blocks for every query block, so compute and memory fall with the sparsity ratio. The open question is accuracy. Our pilot at 8K tokens shows fixed blocks losing more than dynamic, content-scored blocks, but the published sparse patterns were measured at about 4K tokens and the benchmark that separates task types at long lengths \cite{hsieh2024ruler} suggests aggregation tasks are where sparsity should hurt first.

We ask two questions. Can block-sparse attention stay within one point of full attention at 32K tokens and 4$\times$ sparsity? And does the advantage of dynamic over fixed block selection survive as the context grows?

\section{Related Work}
Longformer combines sliding-window attention with a few global tokens and scales linearly with length \cite{beltagy2020longformer}. BigBird adds random attention to windows and global tokens and proves the pattern keeps the expressiveness of full attention \cite{zaheer2020bigbird}. Both fix the sparsity pattern in advance. RULER measures the effective context of long-context models with retrieval, multi-hop tracing, aggregation and question answering tasks \cite{hsieh2024ruler}; LongBench covers natural long-document tasks \cite{bai2023longbench}. FlashAttention-3 makes dense attention itself faster on current GPUs \cite{shah2024flashattention3}, which raises the bar a sparse method has to clear.

\section{Method}
\subsection{Block scoring and selection}
We split queries and keys into blocks of 64 tokens. For each query block we score every key block by the dot product of their mean-pooled representations and keep the top quarter of key blocks, always including the diagonal block. Attention is then computed only inside the kept blocks (Figure~\ref{fig:arch}).

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
We evaluate on RULER at 32K and 64K tokens and on LongBench-E. We leave out PG-19 because it overlaps the pretraining corpus. Every method runs with seeds 13, 42 and 97. We report accuracy, perplexity, FLOPs relative to full attention and peak memory.

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
We study one sparsity ratio and one block size, and a single model family. RULER's tasks are synthetic; LongBench-E checks that the conclusions carry over to natural documents.

\section{Conclusion}
\tbd{answer both questions once the 64K runs are in}

\bibliographystyle{plainnat}
\bibliography{refs}
\end{document}
`
}

// ── Long-summary consistency evaluation: an evaluation already done ─────────

const SUMMARY_README = `# 关于本目录的数据

这是 Research Workbench 的示例项目，演示"已经有结果，直接写成论文"的做法。

- results/consistency.csv 里的分数是演示用的示例数值，不是真实测量。
- notes.md 是研究者自己的评测笔记。
- 参考文献（paper/refs.bib）是真实存在的论文。
`

const SUMMARY_CSV = `system,summac,qafacteval,human_consistent_rate
lead-3,0.712,0.638,0.91
bart-large,0.583,0.521,0.74
bart-large-rl,0.641,0.577,0.82
`

const SUMMARY_NOTES = `# 评测笔记

- 语料：200 篇长文（新闻特稿和机构报告），每篇生成一段摘要。
- 三个系统：lead-3（抽取式基线）、bart-large（抽象式）、bart-large-rl（加了一致性奖励的强化学习微调）。
- 人工标注：每篇摘要由两名标注者判断是否与原文一致，分歧由第三人裁决；表里是被判为一致的比例。
- 自动指标：SummaC（基于 NLI）和 QAFactEval（基于问答）。
- 观察：两个自动指标给出的系统排序与人工一致，但分数和人工一致率不在同一个尺度上，不能直接比大小。
`

const SUMMARY_BIB = String.raw`@article{laban2022summac,
  title = {{SummaC}: Re-Visiting {NLI}-based Models for Inconsistency Detection in Summarization},
  author = {Laban, Philippe and Schnabel, Tobias and Bennett, Paul N. and Hearst, Marti A.},
  journal = {Transactions of the Association for Computational Linguistics},
  volume = {10},
  year = {2022},
  doi = {10.1162/tacl_a_00453}
}

@inproceedings{fabbri2022qafacteval,
  title = {{QAFactEval}: Improved {QA}-Based Factual Consistency Evaluation for Summarization},
  author = {Fabbri, Alexander R. and Wu, Chien-Sheng and Liu, Wenhao and Xiong, Caiming},
  booktitle = {Proceedings of the 2022 Conference of the North American Chapter of the Association for Computational Linguistics},
  year = {2022},
  doi = {10.18653/v1/2022.naacl-main.187}
}
`

const PLOT_CONSISTENCY = `"""Automatic metrics and human judgement per system, from data/results/consistency.csv."""
import csv
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

rows = list(csv.DictReader(Path('data/results/consistency.csv').open(encoding='utf-8')))
systems = [row['system'] for row in rows]
series = [('summac', 'SummaC', '#15635f'), ('qafacteval', 'QAFactEval', '#7bc4bb'), ('human_consistent_rate', 'Human: consistent', '#b65328')]
fig, ax = plt.subplots(figsize=(4.4, 2.9))
width = 0.26
for index, (key, label, color) in enumerate(series):
    xs = [position + (index - 1) * width for position in range(len(rows))]
    ax.bar(xs, [float(row[key]) for row in rows], width=width, color=color, label=label, zorder=3)
ax.set_xticks(range(len(rows)), systems)
ax.set_ylabel('Score / rate')
ax.grid(True, axis='y', color='#eeebe4', zorder=0)
ax.legend(frameon=False, fontsize=7, loc='upper right')
for side in ('top', 'right'):
    ax.spines[side].set_visible(False)
fig.tight_layout()
Path('figures').mkdir(exist_ok=True)
fig.savefig('figures/consistency.pdf')
print('wrote figures/consistency.pdf')
`

interface SummaryRow { system: string; summac: string; qafacteval: string; human: string }

function summaryPaper(rows: SummaryRow[]): string {
  const [lead, base, rl] = rows as [SummaryRow, SummaryRow, SummaryRow]
  const table = rows.map(row => String.raw`${row.system} & ${row.summac} & ${row.qafacteval} & ${row.human} \\`).join('\n')
  return String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{booktabs}
\usepackage{graphicx}
\usepackage{microtype}
\usepackage[numbers]{natbib}
\usepackage{hyperref}
\graphicspath{{../figures/}}

\title{Do Automatic Consistency Metrics Rank Long-Document Summarizers Like People Do?}
\author{Research Workbench example project}
\date{}

\begin{document}
\maketitle

\begin{abstract}
Automatic factual-consistency metrics are routinely used to compare summarization systems, but they were developed on short news summaries. We score three summarizers of long documents with SummaC \cite{laban2022summac} and QAFactEval \cite{fabbri2022qafacteval} and compare the metrics with human consistency judgements. Both metrics order the systems exactly as the annotators do, with the extractive lead-3 baseline first (human consistency rate ${lead.human}); their scores, however, sit on a different scale from the human rate and should not be read as one.
\end{abstract}

\section{Introduction}
Abstractive summarizers write fluent text that can drift from the source, and long documents give them more room to drift. Evaluations therefore report automatic consistency metrics next to, or instead of, human judgement. We ask whether those metrics still rank systems the way people do when the source is a long document rather than a news article.

\section{Evaluation Setup}
We summarize long feature articles and institutional reports with three systems: lead-3, an extractive baseline; bart-large, an abstractive model; and bart-large-rl, the same model fine-tuned with a consistency reward. Two annotators judge whether each summary is consistent with its source, and a third resolves disagreements. We report the share of summaries judged consistent. The automatic metrics are SummaC, which aggregates natural-language-inference scores over sentence pairs \cite{laban2022summac}, and QAFactEval, which compares answers to questions generated from the summary \cite{fabbri2022qafacteval}.

\section{Results}
Table~\ref{tab:main} and Figure~\ref{fig:scores} give the scores. The human consistency rate is ${lead.human} for lead-3, ${rl.human} for bart-large-rl and ${base.human} for bart-large. SummaC gives ${lead.summac}, ${rl.summac} and ${base.summac}, and QAFactEval gives ${lead.qafacteval}, ${rl.qafacteval} and ${base.qafacteval} for the same systems: both metrics reproduce the human ordering.

\begin{table}[t]
\centering
\caption{Automatic metrics and the human consistency rate per system.}
\label{tab:main}
\begin{tabular}{lccc}
\toprule
System & SummaC & QAFactEval & Human: consistent \\
\midrule
${table}
\bottomrule
\end{tabular}
\end{table}

\begin{figure}[t]
\centering
\includegraphics[width=0.66\linewidth]{consistency.pdf}
\caption{Automatic metrics and the human consistency rate per system.}
\label{fig:scores}
\end{figure}

\section{Discussion}
The metrics agree with people on which system is more faithful, which supports using them to compare systems on long documents. They do not agree on how faithful a system is: a SummaC score is not a probability that a summary is consistent. The consistency reward moves bart-large-rl towards the extractive baseline on every measure, which is the behaviour the reward was designed to produce.

\section{Conclusion}
For long-document summarization, SummaC and QAFactEval rank systems as human annotators do but are not calibrated to the human consistency rate. Report them for comparisons, and keep human judgement for absolute claims about faithfulness.

\bibliographystyle{plainnat}
\bibliography{refs}
\end{document}
`
}

const SUMMARY_REVIEW = `# 自查（paper-review）

- [x] [major] 表 1 与 data/results/consistency.csv 逐格核对，一致。
- [x] [major] 结论只说"排序一致"，没有说"分数可以直接比"。
- [x] [minor] 引用的两个指标都有完整条目（作者、题目、年份、DOI）。
- [ ] [minor] 讨论部分可以补一句：二元一致性标注的粒度较粗。
`

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
  const backup = join(home, 'backups', `demo-${stamp}`)
  await mkdir(backup, { recursive: true })
  if (existsSync(demo)) await rename(demo, join(backup, 'demo'))
  if (existsSync(join(home, 'storages'))) await cp(join(home, 'storages'), join(backup, 'storages'), { recursive: true })

  const sparseRoot = join(demo, 'sparse-attention-scaling')
  const summaryRoot = join(demo, 'long-summary-consistency')
  await writeFiles(sparseRoot, {
    'data/README.md': SPARSE_README,
    'data/notes/longformer.md': LONGFORMER_NOTES,
    'data/notes/bigbird.md': BIGBIRD_NOTES,
    'data/notes/ruler.md': RULER_NOTES,
    'data/pilot-8k.csv': PILOT_CSV,
  })
  await writeFiles(summaryRoot, {
    'data/README.md': SUMMARY_README,
    'data/results/consistency.csv': SUMMARY_CSV,
    'data/notes.md': SUMMARY_NOTES,
  })

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
        if (!text.startsWith('Current runtime context')) transcript.push(`\n## 用户\n${text}`)
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
      const settled = scaffold.whenTurnSettled(600000)
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
      .map(phase => `${PHASE_ZH[phase.id] ?? phase.id} ${phase.done ? '✓' : '…'}`).join(' · ')

    // ── Project 2: from-results, fully automatic ──
    const summary = await ctx.research.create({
      title: '长文摘要一致性评测', root: summaryRoot, autonomy: 'automatic',
      brief: '三个摘要系统在长文上的一致性评测，结果和笔记都已经有了',
    })
    const summarySession = summary.sessionId as SessionId
    // Named before the first message: a title the user set is never replaced by the automatic one.
    await ctx.sessionController.rename({ sessionId: summarySession, title: '从结果直接写成短论文' })
    const liveSession = sessions.get(summarySession)
    if (liveSession) (ctx as unknown as { permissionPresets: { set(session: unknown, name: string): void } }).permissionPresets.set(liveSession, 'research-auto')
    const summaryProject = () => ctx.research.getProject(summary.id)
    await turn(summarySession, 'data 里是我做完的长文摘要一致性评测：结果表和笔记。直接写成一篇短论文，中间你自己拿主意，不用停下来问我。', [
      () => ({ text: '先看项目。', calls: [{ name: 'research_project', args: { action: 'current' } }] }),
      () => ({
        text: '结果已经齐了，走"基于结果"：先把结果收成数据证据，论文里的每个数都从这里取。',
        calls: [
          { name: 'research_project', args: { action: 'set-mode', mode: 'from-results', reason: '评测已经做完，有完整的结果表和笔记' } },
          { name: 'research_evidence', args: { action: 'import', paths: ['data/results/consistency.csv', 'data/notes.md'] } },
        ],
      }),
      () => ({
        text: '全自动模式，关键的两处我自己定，理由记下来。',
        calls: [
          { name: 'research_project', args: { action: 'record-decision', question: '主结论怎么表述', answer: '只说自动指标的系统排序与人工一致，不说分数可以直接比较',
            rationale: '笔记写明两个指标与人工一致率不在同一尺度上' } },
          { name: 'research_project', args: { action: 'record-decision', question: '论文形式', answer: '4 页短论文：引言、评测设置、结果、讨论、结论',
            rationale: '只有一张结果表和一组对照，篇幅不需要更长' } },
          { name: 'research_artifact', args: { action: 'save-artifact', path: 'paper/refs.bib', kind: 'bibliography', content: SUMMARY_BIB } },
          { name: 'research_artifact', args: { action: 'save-artifact', path: 'code/plot_consistency.py', kind: 'code', content: PLOT_CONSISTENCY } },
        ],
      }),
      () => ({ calls: [{ name: 'pwsh', args: { command: `& '${python}' code/plot_consistency.py`, description: '从 data/results/consistency.csv 画对照图' } }] }),
      () => {
        const project = summaryProject()
        const data = linkTo(project, 'consistency.csv', 'lead-3')
        const rows = SUMMARY_CSV.trim().split('\n').slice(1).map((line) => {
          const [system, summac, qafacteval, human] = line.split(',') as [string, string, string, string]
          return { system, summac, qafacteval, human }
        })
        return {
          text: '图画好了，登记来源，再写论文。',
          calls: [
            { name: 'research_artifact', args: { action: 'register-artifact', path: 'figures/consistency.pdf', kind: 'figure', evidence: [data],
              inputArtifacts: [artifactRef(project, 'code/plot_consistency.py')] } },
            { name: 'research_artifact', args: { action: 'save-artifact', path: 'paper/main.tex', kind: 'manuscript', content: summaryPaper(rows), evidence: [data] } },
          ],
        }
      },
      () => ({ calls: [{ name: 'research_artifact', args: { action: 'compile', engine: 'pdflatex' } }] }),
      () => ({ calls: [{ name: 'research_artifact', args: { action: 'render-pages', maxPages: 6 } }] }),
      () => ({
        text: '逐页看过版面。按 paper-review 的清单自查一遍，写进 reviews/review.md。',
        calls: [{ name: 'research_artifact', args: { action: 'save-artifact', path: 'reviews/review.md', kind: 'supplement', content: SUMMARY_REVIEW } }],
      }),
      () => ({ calls: [{ name: 'research_check', args: {} }] }),
      () => summaryProject().lastCheck?.clean
        ? { text: '检查全部通过，打包投稿文件。', calls: [{ name: 'research_artifact', args: { action: 'export' } }] }
        : { calls: [{ name: 'research_project', args: { action: 'current' } }] },
      () => {
        const project = summaryProject()
        const check = project.lastCheck
        return { text: check?.clean
          ? `写完了，检查全部通过（${phaseLine(project)}），投稿包在 exports/ 里。\n\n- **结论**：SummaC 和 QAFactEval 给出的系统排序与人工完全一致（lead-3 > bart-large-rl > bart-large），但分数和人工一致率不在一个尺度上，论文里只说排序一致。\n- **我替你定的两件事**：主结论的表述、篇幅，理由都在右侧的决策记录里。\n- **数字**：表 1 和正文的每个数都来自 data/results/consistency.csv；图由 code/plot_consistency.py 从同一张表画出。\n- **自查**：reviews/review.md 里还留了一条小建议（补一句标注粒度的局限），不影响投稿。\n\n现在用的是通用的 article 模板；要投具体会议，给我模板文件，我换上再检查一遍。`
          : `论文写好了，但检查还没全部通过：${phaseLine(project)}。${check?.findings.filter(finding => finding.severity === 'error').map(finding => finding.message).join('；') ?? ''}` }
      },
    ])


    // ── Project 1: paper-first with checkpoints ──
    const sparse = await ctx.research.create({
      title: 'Sparse attention scaling study', root: sparseRoot, autonomy: 'checkpoints',
      brief: '块稀疏注意力能否在 1/4 FLOPs 下保住长上下文准确率',
    })
    const sparseSession = sparse.sessionId as SessionId
    await ctx.sessionController.rename({ sessionId: sparseSession, title: '块稀疏注意力：从想法到初稿' })
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
    const question = '在 4× 稀疏、32K 上下文下，块稀疏注意力的长文准确率能否保持在全注意力的 1 个点以内？按注意力得分动态选块，相对固定分块的优势会不会随长度消失？'

    await turn(sparseSession, '我只有一个想法：块稀疏注意力能不能在 1/4 的 FLOPs 下，保住长上下文的准确率？data 里是我读 Longformer、BigBird、RULER 的笔记，还有一份 8K 上的预实验。', [
      () => ({ text: '先看看这个项目现在的状态。', calls: [{ name: 'research_project', args: { action: 'current' } }] }),
      () => ({
        text: '还没有定模式。你手上是一个想法、三份阅读笔记和一份预实验，还没有正式结果——按"先写论文"来走：先把方法论文写完整，结果的位置留空，跑完实验再填。先把材料收进证据库。',
        calls: [
          { name: 'research_project', args: { action: 'set-mode', mode: 'paper-first', reason: '只有一个想法、三份阅读笔记和一份 8K 预实验，还没有正式结果' } },
          { name: 'research_evidence', args: { action: 'import', paths: ['data/notes/longformer.md', 'data/notes/bigbird.md', 'data/notes/ruler.md', 'data/pilot-8k.csv'] } },
        ],
      }),
      () => ({
        text: '材料都收进来了，每份都留了版本和行号。研究问题我先收成一句能被证伪的话，请你定一下。',
        calls: [{ name: 'ask_user_question', args: { questions: [{
          id: 'research-question', header: '研究问题', question,
          options: [
            { label: '就按这个定 (Recommended)', description: '两问都保留：能否保住准确率，以及动态选块的优势会不会随长度消失' },
            { label: '只保留第一问', description: '先不比较动态和固定选块，实验更少' },
          ],
        }] } }],
      }),
      () => ({
        calls: [
          { name: 'research_project', args: { action: 'record-decision', question: '研究问题', answer: question, decidedBy: 'user' } },
          { name: 'research_artifact', args: { action: 'save-artifact', path: 'paper/refs.bib', kind: 'bibliography', content: SPARSE_BIB } },
        ],
      }),
      () => ({ text: '研究问题定下来了，记在决策记录里。\n\n参考文献先放了 5 篇：Longformer、BigBird、RULER、LongBench，以及 FlashAttention-3——稠密注意力本身也在变快，稀疏方法要跟它比才有意义。条目的作者、题目、年份和 DOI 都齐，但还没有联网核实，检查会把它们标成"未核实"。\n\n下一步我会先对照你的笔记和预实验，看看现有证据在"稀疏模式怎么选"上到底说了什么，再写方法。' }),
    ], [['就按这个定 (Recommended)']])

    await turn(sparseSession, '先别急着写方法。把那几份材料里关于稀疏模式的结论摆出来，看看谁和谁矛盾。', [
      () => ({ calls: [{ name: 'research_evidence', args: { action: 'search-evidence', query: 'block 固定 聚合 4K' } }] }),
      () => {
        const project = current()
        return {
          text: '有一处对不上，我把它记成一条待验证的论点，并把方法草图画出来，里面留一个能分辨它的消融。',
          calls: [
            { name: 'research_evidence', args: { action: 'claim', claim: {
              id: 'dynamic-advantage-fades', kind: 'hypothesis', state: 'proposed',
              text: '动态选块相对固定分块的优势，在 32K 以上会消失。',
              evidence: [linkTo(project, 'pilot-8k.csv', 'dynamic-block-4x'), linkTo(project, 'ruler.md', '聚合类任务')],
              artifactIds: [],
            } } },
            { name: 'research_artifact', args: { action: 'save-artifact', path: 'figures/architecture.drawio', kind: 'diagram', content: ARCHITECTURE_DRAWIO } },
          ],
        }
      },
      () => ({ text: '三份材料在"稀疏模式怎么选"上说的不是一回事：\n\n- **预实验（pilot-8k.csv）**：8K 上下文、4× 稀疏时，固定分块比全注意力低 0.6 个点，按注意力得分动态选块几乎无损——但只到 8K。\n- **Longformer、BigBird 笔记**：两篇的评测都停在 4K 左右，而且块是固定划分的，说明不了 32K 以上的事。\n- **RULER 笔记**：你记着聚合类任务最可能暴露稀疏注意力的短板，而长度越长，聚合越难。\n\n所以"动态选块更好"在 32K 以上还没有证据。我把它记成了一条**待验证**的论点，两条来源都挂在上面，点开能看到原文那一行。\n\n方法草图在 `figures/architecture.drawio`（可以直接打开改）：块打分 → Top-k 选块 → 块稀疏注意力，虚线是固定分块基线。实验里用"选块策略 × 上下文长度"这个消融来分辨这条论点。' }),
    ])

    await turn(sparseSession, '方法就这样。把实验方案和完整初稿写出来，结果先留空；方案我要确认了再跑。', [
      () => ({
        text: '先把规划、实验脚本和初稿写出来。',
        calls: [
          { name: 'research_project', args: { action: 'record-decision', question: '方法设计', answer: '固定分块与动态选块两套方法；架构图第 1 版定稿', decidedBy: 'user' } },
          { name: 'research_artifact', args: { action: 'save-artifact', path: 'paper/outline.md', kind: 'supplement', content: OUTLINE } },
          { name: 'research_artifact', args: { action: 'save-artifact', path: 'code/train_eval.py', kind: 'code', content: TRAIN_EVAL } },
          { name: 'research_artifact', args: { action: 'save-artifact', path: 'paper/main.tex', kind: 'manuscript', content: sparsePaper(), claimIds: ['dynamic-advantage-fades'] } },
        ],
      }),
      () => ({ text: '编译一下，再逐页看看版面。', calls: [{ name: 'research_artifact', args: { action: 'compile', engine: 'pdflatex' } }] }),
      () => ({ calls: [{ name: 'research_artifact', args: { action: 'render-pages', maxPages: 8 } }] }),
      () => ({ calls: [{ name: 'research_check', args: { scope: 'draft' } }] }),
      () => {
        const draft = current().lastCheck?.phases.find(phase => phase.id === 'draft')
        return {
          text: draft?.done
            ? '初稿编译通过，页面逐页看过，"完整初稿"这一阶段的检查已经通过。结果表里全是 "--"，结论和摘要里各留了一个占位——这些要等实验。开跑前请你确认方案：'
            : `初稿已经写好并编译。"完整初稿"这一阶段还差：${draft?.missing.join('；') ?? '（未知）'}。开跑前请你确认方案：`,
          calls: [{ name: 'ask_user_question', args: { questions: [{
            id: 'run-plan', header: '开跑前确认',
            question: '实验方案在 paper/outline.md：RULER 32K 先跑全注意力基线、固定分块 4×、动态选块 4×（种子 42、97，本机）；种子 13 放到实验室的 lab-a100 上并行跑。PG-19 已去掉（与预训练语料重叠）。64K 和 LongBench-E 等 32K 结果出来再跑。现在开跑吗？',
            options: [
              { label: '按方案跑 32K (Recommended)', description: '先拿到 32K 的结果，再决定 64K 怎么跑' },
              { label: '只跑一个种子', description: '更快，但看不出种子间的波动' },
              { label: '先不跑', description: '我再改改方案' },
            ],
          }] } }],
        }
      },
      async () => {
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
        return { text: `提交了 5 次运行。本机的 ${done} 次已经跑完，指标都收成了数据证据。\n\n种子 13 那次放在 lab-a100 上，${lost ? '提交时连不上那台机器，回执没有回来——它可能起来了，也可能没有。我不会换个编号重新提交，那样同一组配置可能跑两遍；等机器能连上，再确认它到底有没有在跑。' : '也已经提交。'}\n\n代码和数据在提交那一刻都锁了快照，之后改文件不会影响这几次运行。结果要我现在填进论文吗？` }
      },
    ], [['按方案跑 32K (Recommended)']])

    await turn(sparseSession, '填吧，画张图。13 那次先不管，等实验室机器好了再说。', [
      () => ({ calls: [{ name: 'research_project', args: { action: 'current' } }] }),
      () => {
        const project = current()
        const results = collectSparse(project)
        const csv = ['run,method,seed,accuracy,relative_flops,peak_memory_gb',
          ...results.map(item => `ruler-32k-${item.method} · seed ${item.seed},${item.method},${item.seed},${item.accuracy},${item.flops},${item.memory}`)].join('\n') + '\n'
        return {
          text: '把四次运行的指标整理成一张表，再用脚本从这张表画图。',
          calls: [
            { name: 'research_artifact', args: { action: 'save-artifact', path: 'data/results-32k.csv', kind: 'supplement', content: csv,
              evidence: results.map(item => metricLink(project, item, 'accuracy')) } },
            { name: 'research_artifact', args: { action: 'save-artifact', path: 'code/plot_accuracy.py', kind: 'code', content: PLOT_ACCURACY } },
          ],
        }
      },
      () => ({ calls: [{ name: 'pwsh', args: { command: `& '${python}' code/plot_accuracy.py`, description: '从 data/results-32k.csv 画准确率-计算量图' } }] }),
      () => {
        const project = current()
        return {
          calls: [
            { name: 'research_artifact', args: { action: 'register-artifact', path: 'figures/accuracy_vs_flops.pdf', kind: 'figure',
              evidence: collectSparse(project).map(item => metricLink(project, item, 'accuracy')),
              inputArtifacts: [artifactRef(project, 'code/plot_accuracy.py'), artifactRef(project, 'data/results-32k.csv')] } },
          ],
        }
      },
      () => {
        const project = current()
        const results = collectSparse(project)
        const full = results.find(item => item.method === 'full')!
        const dynamic = results.find(item => item.method === 'dynamic' && item.seed === 42)!
        return {
          calls: [
            { name: 'research_evidence', args: { action: 'claim', claim: {
              id: 'within-one-point-32k', kind: 'empirical', state: 'supported',
              text: '在 4× 稀疏、32K 上下文下，动态选块的准确率与全注意力相差不到 1 个点（种子 42）。',
              evidence: [metricLink(project, dynamic, 'accuracy'), metricLink(project, full, 'accuracy')],
              artifactIds: [artifactRef(project, 'figures/accuracy_vs_flops.pdf').id],
            } } },
          ],
        }
      },
      () => {
        const project = current()
        return {
          text: '结果写进 4.1 节和表 1，图放在结果部分。',
          calls: [{ name: 'research_artifact', args: {
            action: 'save-artifact', path: 'paper/main.tex', kind: 'manuscript', content: sparsePaper(collectSparse(project)),
            claimIds: ['dynamic-advantage-fades', 'within-one-point-32k'],
            inputArtifacts: [artifactRef(project, 'figures/accuracy_vs_flops.pdf'), artifactRef(project, 'data/results-32k.csv')],
          } }],
        }
      },
      () => ({ calls: [{ name: 'research_artifact', args: { action: 'compile', engine: 'pdflatex' } }] }),
      () => ({ calls: [{ name: 'research_artifact', args: { action: 'render-pages', maxPages: 8 } }] }),
      () => ({ calls: [{ name: 'research_check', args: {} }] }),
      () => {
        const project = current()
        const results = collectSparse(project)
        const full = results.find(item => item.method === 'full')!
        const fixed = results.find(item => item.method === 'fixed')!
        const dynamic = results.find(item => item.method === 'dynamic' && item.seed === 42)!
        const second = results.find(item => item.method === 'dynamic' && item.seed === 97)!
        const check = project.lastCheck
        const errors = check?.findings.filter(finding => finding.severity === 'error').length ?? 0
        const line = (label: string, item: SparseResult) =>
          `| ${label} | ${item.accuracy.toFixed(3)} | ${item.flops.toFixed(2)} | ${item.memory.toFixed(1)} GB |`
        const table = [
          line('全注意力 · 种子 42', full), line('固定分块 · 种子 42', fixed),
          line('动态选块 · 种子 42', dynamic), line('动态选块 · 种子 97', second),
        ].join('\n')
        return { text: `填好了，也重新编译过。\n\n| 运行 | 准确率（32K） | 相对 FLOPs | 峰值显存 |\n| --- | --- | --- | --- |\n${table}\n\n在 32K 上，两种块稀疏都和全注意力相差不到 1 个点，计算量约为四分之一，显存少了三分之一以上。我把"相差不到 1 个点"记成了一条**有证据支持**的论点，挂着两次运行的原始指标；论文里的每个数都能追到这几次运行。\n\n图在 \`figures/accuracy_vs_flops.pdf\`，由 \`code/plot_accuracy.py\` 从 \`data/results-32k.csv\` 画出，数据和脚本都登记在图的来源里。\n\n检查结果：${phaseLine(project)}。还有 ${errors} 个错误没清掉，主要是 64K 那一列和消融、结论里的占位——要等 64K 的运行。"动态选块的优势会不会随长度消失"这条论点仍是待验证：32K 上它比固定分块只高一点点，得看 64K。` }
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
}, 1_800_000)

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
