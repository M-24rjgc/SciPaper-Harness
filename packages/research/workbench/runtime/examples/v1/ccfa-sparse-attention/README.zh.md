# 内容自适应稀疏注意力

[English](README.md) | 中文

本示例展示一个研究想法及其配套实验设计。`data/pilot.csv` 中的九条数值均为编写的合成演示数据，不是模型训练或公开基准的实测结果。

研究问题是：在保留的注意力比例相同时，按内容选择块能否比固定稀疏模式保留更多准确率？研究札记以三个配对种子为例，比较稠密注意力、固定稀疏注意力和内容自适应注意力。

## 内容

- `paper/main.pdf`：可阅读的研究札记。
- `paper/paper.md` 与 `paper/paper.zh.md`：英文和中文论文正文。
- `paper/main.tex` 与 `paper/main.zh.tex`：可编辑的论文源文件。
- `figures/attention-tradeoff.svg`：可编辑的矢量比较图。
- `data/pilot.csv`：完整演示数据，表头标注单位。
- `data/ABOUT.md`：数据来源及解释。
- `experiments/design.md` 与 `experiments/design.zh.md`：匹配的评测协议及结论边界。
- `code/analyze.py`：无需第三方依赖的均值、样本标准差计算程序。

这些数据说明如何组织一项比较，不证明真实任务上的模型效果、速度、显存收益或统计显著性。
