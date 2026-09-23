"""Automatic metrics and the human consistency rate per system, from data/results/consistency.csv.

Run through spark-to-paper's plot-results, which provides plt, OUT and finalize in the house style.
"""
import csv

rows = list(csv.DictReader(open('data/results/consistency.csv', encoding='utf-8')))
colors = [PALETTE['blue_main'], PALETTE['blue_secondary'], PALETTE['red_strong']]
series = [('summac', 'SummaC'), ('qafacteval', 'QAFactEval'), ('human_consistent_rate', 'Human: consistent')]
fig, ax = plt.subplots(figsize=(6.4, 4.2))
width = 0.26
for index, (key, label) in enumerate(series):
    xs = [position + (index - 1) * width for position in range(len(rows))]
    ax.bar(xs, [float(row[key]) for row in rows], width=width, color=colors[index], label=label, zorder=3)
ax.set_xticks(range(len(rows)))
ax.set_xticklabels([row['system'] for row in rows])
ax.set_ylabel('Score / rate')
ax.set_ylim(0, 1)
ax.legend(loc='upper center', bbox_to_anchor=(0.5, 1.2), ncol=3, fontsize=12)
finalize(fig, OUT)
