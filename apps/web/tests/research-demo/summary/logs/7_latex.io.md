# 7 · 编译排版

## INPUT
- template.json、blueprint.json、sections/*.tex、figures/*.pdf、refs.bib。

## DECISIONS
- assemble-paper 拼出 main.tex（规范标题、表题在上、相邻引用合并）。
- pdflatex 编译，逐页渲染检查。

## OUTPUT
- main.tex 与 PDF（AAAI 格式，7 页），页面逐页看过；评审补记终稿检查。
