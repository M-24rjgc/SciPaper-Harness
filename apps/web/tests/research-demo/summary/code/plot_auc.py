"""Summary-level discrimination (AUC against the human label) per length bucket, from data/results/agreement.csv.

Run through spark-to-paper's plot-results, which provides plt, OUT and finalize in the house style.
"""
import csv

rows = list(csv.DictReader(open('data/results/agreement.csv', encoding='utf-8')))
buckets = ['short', 'medium', 'long']
colors = [PALETTE['blue_main'], PALETTE['green_3']]
metrics = [('summac_auc', 'SummaC'), ('qafacteval_auc', 'QAFactEval')]
fig, ax = plt.subplots(figsize=(6.4, 4.2))
width = 0.36
for index, (measure, label) in enumerate(metrics):
    values = [float(next(row['value'] for row in rows if row['measure'] == measure and row['length'] == bucket)) for bucket in buckets]
    ax.bar([position + (index - 0.5) * width for position in range(len(buckets))], values, width=width, color=colors[index], label=label, zorder=3)
ax.axhline(0.5, color='#8a8a8a', linewidth=0.8, linestyle='--')
ax.set_xticks(range(len(buckets)))
ax.set_xticklabels(buckets)
ax.set_ylabel('AUC against human label')
ax.set_ylim(0.4, 0.9)
ax.legend(loc='upper right', fontsize=12)
finalize(fig, OUT)
