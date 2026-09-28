# 基于证据的摘要一致性

本示例展示如何把一张定义完整的小型结果表组织成研究札记。`data/results.csv` 的六条数值均为编写的合成演示数据，不是模型评测或人工研究的评分。

札记比较普通摘要方法与将事实性陈述限制在源文支持范围内的候选方法，使数值结论、数据和矢量图保持一致，并说明检验机制所需的测量。

## 内容

- `paper/main.pdf`：可阅读的研究札记。
- `paper/paper.md` 与 `paper/paper.zh.md`：英文和中文论文正文。
- `paper/main.tex` 与 `paper/main.zh.tex`：可编辑的论文源文件。
- `figures/consistency.svg`：可编辑的矢量结果图。
- `data/results.csv`：完整合成结果。
- `data/ABOUT.md`：数据来源、单位及限制。
- `experiments/design.md` 与 `experiments/design.zh.md`：评测定义及结论边界。
- `code/analyze.py`：无需第三方依赖的配对计算。

展示的 4 个百分点差异只是合成数据的算术属性，不能证明实际摘要系统的事实性得到提升。
