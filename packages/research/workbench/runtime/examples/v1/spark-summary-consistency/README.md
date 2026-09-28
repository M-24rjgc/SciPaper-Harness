# Evidence-grounded summary consistency

A synthetic demonstration of turning a small, fully described results table into a research note. All six rows in `data/results.csv` are authored demonstration values, not scores from a model evaluation or a human study.

The note compares a baseline summarizer with a candidate that restricts factual statements to source-supported content. It keeps the numerical claims, data and vector figure aligned and describes which measurements would be needed to test the mechanism.

## Contents

- `paper/main.pdf`: readable research note.
- `paper/paper.md` and `paper/paper.zh.md`: English and Chinese manuscript text.
- `paper/main.tex` and `paper/main.zh.tex`: editable manuscript sources.
- `figures/consistency.svg`: editable vector result figure.
- `data/results.csv`: complete synthetic results.
- `data/ABOUT.md`: data provenance, units and limitations.
- `experiments/design.md` and `experiments/design.zh.md`: evaluation definition and claim boundaries.
- `code/analyze.py`: dependency-free paired arithmetic.

The displayed four-point difference is an arithmetic property of synthetic data; it is not evidence of improved factuality in a deployed summarizer.
