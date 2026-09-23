# 2 · 引用

## INPUT
- 31 篇候选文献：一致性指标及其元评测、长文档摘要数据与评测、三个系统的来源。

## DECISIONS
- 每篇都用 literature-import 按 DOI 向 Crossref 重新取回元数据，BibTeX 用返回的记录，只把键名换成易读的形式。
- claims_map.json 为每条引用写明它支撑的论点和所在章节。

## OUTPUT
- refs.bib 31 条，全部核实；模板下限 30 条。
