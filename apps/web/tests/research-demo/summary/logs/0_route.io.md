# 0 · 路线

## INPUT
- data/results/ 三张结果表（总体、按长度、摘要级 AUC）和 data/notes.md。
- 用户要求：写成能投 AAAI 的完整论文，全自动，中间不停下来问。

## DECISIONS
- 路线 data：有实测结果，论文里每个数都从这些结果取；results_mode 设为 data_aware。
- 生图接口：不需要。三张图都是结果图，用数据和脚本画（plot-results）。
- 知识图谱：本篇是评测研究，不做想法生成，不调用。
- 环境：平台 Python 与 TeX 已就绪。

## OUTPUT
- 模式 spark-to-paper，路线 data，决策已记录。
