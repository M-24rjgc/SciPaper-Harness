# 数据

## INPUT
- data/results/consistency.csv、by_length.csv、agreement.csv，data/notes.md。

## DECISIONS
- 三张表导入为数据证据，笔记导入为文本资料。
- 论文要报告的差值（短档到长档的下降）由 code/facts.py 计算，不手算。

## OUTPUT
- results.facts.json：三张表的全部数值加上脚本算出的差值，已导入为数据证据。
