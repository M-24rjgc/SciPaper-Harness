# 3 · 写作

## INPUT
- blueprint.json、refs.bib、claims_map.json、results.facts.json。

## DECISIONS
- 按模板的写作顺序：方法、相关工作、引言、实验、结论、摘要。
- 正文里的小数只用 results.facts.json 里的值；分数和人工一致率不放在一个尺度上比较。

## OUTPUT
- sections/ 下六个文件，draft-lint 与 citations-lint 通过。
