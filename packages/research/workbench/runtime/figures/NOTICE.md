# Figure scripts: notice

`audit_svg.py` is taken unchanged (line endings aside) from [spark-to-paper-skills](https://github.com/Spark-To-Paper-Skills/spark-to-paper-skills) at commit `c17149d`, `skills/ts-figure-svg/scripts/audit_svg.py`, released under the MIT licence (the text is in `runtime/modes/spark-to-paper/LICENSE`).

`export_figure.py` is written for this package. It replaces the upstream `svg_to_pdf.py`, which looks for rsvg-convert, a browser, Inkscape or CairoSVG on the machine: it uses svglib and reportlab from the platform Python instead, expands `<marker>` references into ordinary shapes because svglib draws none, embeds Times New Roman from the system fonts when they are there, and renders previews with pdfium.
