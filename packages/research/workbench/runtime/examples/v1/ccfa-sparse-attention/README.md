# Content-adaptive sparse attention

A synthetic demonstration of a research idea and its experiment design. All nine measurements in `data/pilot.csv` are authored demonstration values, not observations from a trained model or a public benchmark.

The research question is whether content-dependent block selection can preserve more accuracy than a fixed sparse pattern at the same retained-attention fraction. The note compares dense, fixed sparse and content-adaptive attention under a matched three-seed illustration.

## Contents

- `paper/main.pdf`: readable research note.
- `paper/paper.md` and `paper/paper.zh.md`: English and Chinese manuscript text.
- `paper/main.tex` and `paper/main.zh.tex`: editable manuscript sources.
- `figures/attention-tradeoff.svg`: editable vector comparison.
- `data/pilot.csv`: all demonstration measurements, with units in the header.
- `data/ABOUT.md`: data provenance and interpretation.
- `experiments/design.md` and `experiments/design.zh.md`: a matched evaluation protocol and claim boundaries.
- `code/analyze.py`: a dependency-free calculation of means and sample deviations.

The illustration isolates a comparison, but it establishes no model quality, speed, memory saving or statistical significance on real workloads.
