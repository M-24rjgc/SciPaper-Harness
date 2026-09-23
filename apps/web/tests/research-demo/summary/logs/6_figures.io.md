# 6 · 图表

## INPUT
- 三张结果图：总体对比、按长度的变化、摘要级 AUC。

## DECISIONS
- 全部用 matplotlib 从数据画（plot-results，统一风格），各出一份矢量 PDF；论文里引用 PDF。
- 每张图登记了它的数据和脚本。没有方法示意图，不需要生图。

## OUTPUT
- figures/overall.pdf、length.pdf、auc.pdf 与 figures.manifest.json；vector-figures 与 figure-critique 通过。
