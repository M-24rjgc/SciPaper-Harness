"""Accuracy against relative FLOPs at 32K tokens, one point per run, from experiments/results.csv."""
import csv
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

plt.rcParams.update({'font.family': 'serif', 'font.serif': ['Times New Roman', 'Times', 'DejaVu Serif'], 'pdf.fonttype': 42})
COLORS = {'full': '#68675f', 'fixed': '#b65328', 'dynamic': '#15635f'}
LABELS = {'full': 'Full attention', 'fixed': 'Fixed blocks (4x)', 'dynamic': 'Dynamic blocks (4x)'}

rows = [row for row in csv.DictReader(Path('experiments/results.csv').open(encoding='utf-8')) if row['context'] == '32768']
fig, ax = plt.subplots(figsize=(4.2, 3.0))
for method in ('full', 'fixed', 'dynamic'):
    points = [row for row in rows if row['method'] == method]
    ax.scatter([float(p['relative_flops']) for p in points], [float(p['accuracy']) for p in points],
               s=46, color=COLORS[method], label=LABELS[method], zorder=3)
    for p in points:
        ax.annotate(f"seed {p['seed']}", (float(p['relative_flops']), float(p['accuracy'])),
                    textcoords='offset points', xytext=(6, -3), fontsize=7, color='#68675f')
ax.set_xlabel('Relative FLOPs (full attention = 1)')
ax.set_ylabel('RULER accuracy, 32K tokens')
ax.grid(True, color='#eeebe4', zorder=0)
ax.legend(frameon=False, fontsize=7, loc='lower right')
for side in ('top', 'right'):
    ax.spines[side].set_visible(False)
fig.tight_layout()
Path('figures').mkdir(exist_ok=True)
fig.savefig('figures/accuracy_vs_flops.pdf')
print('wrote figures/accuracy_vs_flops.pdf')
