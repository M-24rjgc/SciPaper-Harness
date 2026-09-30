"""Each measure per document-length bucket and system, from data/results/by_length.csv.

Run through spark-to-paper's plot-results, which provides plt, OUT and finalize in the house style.
"""
import csv

rows = list(csv.DictReader(open('data/results/by_length.csv', encoding='utf-8')))
buckets = ['short', 'medium', 'long']
systems = ['lead-3', 'bart-large-rl', 'bart-large']
colors = [PALETTE['grey_dark'], PALETTE['blue_main'], PALETTE['red_strong']]
measures = [('human_consistent_rate', 'Human: consistent'), ('summac', 'SummaC'), ('qafacteval', 'QAFactEval')]
fig, axes = plt.subplots(1, 3, figsize=(15, 4.4), sharey=True)
for ax, (key, title) in zip(axes, measures):
    for index, system in enumerate(systems):
        values = [float(next(row[key] for row in rows if row['system'] == system and row['length'] == bucket)) for bucket in buckets]
        ax.plot(buckets, values, marker='o', color=colors[index], label=system)
    ax.set_title(title)
    ax.set_ylim(0.4, 1.0)
axes[0].set_ylabel('Score / rate')
axes[0].legend(loc='lower left', fontsize=12)
finalize(fig, OUT)
