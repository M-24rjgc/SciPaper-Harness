"""Tabulate the collected RULER runs into experiments/results.csv, one row per run and context length.

Reads each local run's recorded arguments (inputs.json) and metrics (metrics.json) under
.research/runs; a run without local metrics (not finished, or on a machine not reached) is left out.
"""
import csv
import json
from pathlib import Path

ORDER = {'full': 0, 'fixed': 1, 'dynamic': 2}
rows = []
for run in sorted(Path('.research/runs').iterdir()):
    inputs, metrics = run / 'inputs.json', run / 'metrics.json'
    if not (inputs.is_file() and metrics.is_file()):
        continue
    argv = json.loads(inputs.read_text(encoding='utf-8'))['argv']
    values = json.loads(metrics.read_text(encoding='utf-8'))
    rows.append({
        'method': argv[argv.index('--variant') + 1], 'context': int(argv[argv.index('--context') + 1]),
        'seed': int(argv[argv.index('--seed') + 1]), 'accuracy': values['accuracy'],
        'relative_flops': values['relative_flops'], 'peak_memory_gb': values['peak_memory_gb'],
    })
rows.sort(key=lambda row: (row['context'], ORDER[row['method']], row['seed']))
target = Path('experiments/results.csv')
target.parent.mkdir(exist_ok=True)
with target.open('w', newline='', encoding='utf-8') as handle:
    writer = csv.DictWriter(handle, fieldnames=['method', 'context', 'seed', 'accuracy', 'relative_flops', 'peak_memory_gb'])
    writer.writeheader()
    writer.writerows(rows)
print(f'wrote {target} with {len(rows)} runs')
