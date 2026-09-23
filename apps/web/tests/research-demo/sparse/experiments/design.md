# 实验设计：块稀疏注意力在长上下文下的准确率

Mode: design

## Venue and assumptions

NeurIPS 2026 审稿版。同一模型、4 倍稀疏、块大小 64；动态选块用均值池化的键打分、保留前四分之一的块并总是保留对角块；固定分块用局部窗口加等距跨步块，块数相同。

## Claim-evidence matrix

| 论点 | 证据 | 数据 | 对照 | 指标 |
| --- | --- | --- | --- | --- |
| C1 32K 下块稀疏与全注意力相差不到 1 个点 | 主表 | RULER 32K | 全注意力 | 准确率 |
| C2 动态选块的优势随长度变化 | 选块策略 × 长度消融 | RULER 32K、64K | 固定分块 | 准确率差 |
| C3 差异集中在聚合类任务 | 按任务类别拆开 | RULER 四类 | 固定分块 | 分类准确率 |
| C4 结论可迁移到自然文本 | 补充表 | LongBench-E | 全注意力 | 任务指标 |

## Dataset / benchmark needs

RULER（32K、64K 两档），LongBench-E。去掉 PG-19：与预训练语料重叠，会把泄漏算进结论。

## Baseline matrix

| 方法 | 稀疏度 | 选块 | 实现 |
| --- | --- | --- | --- |
| 全注意力 | 1 | 无 | FlashAttention-3 |
| 固定分块 | 4 倍 | 局部窗口 + 跨步块 | 块稀疏核 |
| 动态选块 | 4 倍 | 均值池化打分 Top-k | 块稀疏核 |

## Main experiments

RULER 32K：三种方法，种子 13、42、97。32K 结果出来后再跑 64K 与 LongBench-E。

## Ablations

"选块策略 × 上下文长度"（32K、64K），按 RULER 任务类别拆开，聚合类单独报告。

## Robustness / failure / efficiency

相对 FLOPs 与峰值显存随准确率一起报告；不另加与论点无关的鲁棒性实验。

## Smoke scope and deduplication

只对改动过的评测脚本跑一次最短配置，结果不进论文。

## Result tables

| 方法 | 种子 | 准确率 32K | 准确率 64K | 相对 FLOPs | 峰值显存 |
| --- | --- | --- | --- | --- | --- |
| 全注意力 | 42 | TBD | TBD | TBD | TBD |
| 固定分块 | 42 | TBD | TBD | TBD | TBD |
| 动态选块 | 42 | TBD | TBD | TBD | TBD |
| 动态选块 | 97 | TBD | TBD | TBD | TBD |

## Missing values

全部结果待实验；8K 预实验只作动机，不进结果表。

## Execution priority

1. RULER 32K 三种方法（本机 default，种子 42、97；种子 13 放实验室 lab-a100 并行）。
2. RULER 64K 与消融。
3. LongBench-E。

## No-fabrication status

表中没有任何数字；结果只来自 research_experiment 收集的运行指标。

## Next CCFA owner

ccf-paper-writer 按此方案写初稿（结果留空）；开跑前由用户确认方案。
