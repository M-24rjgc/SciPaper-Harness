"""Write results.facts.json: every number the paper may state, read from data/results/*.csv.

Values keep the spelling of the CSV files; the differences the paper reports are computed here,
never by hand.
"""
import csv
import json
from pathlib import Path

RESULTS = Path('data/results')


def rows(name):
    return list(csv.DictReader((RESULTS / name).open(encoding='utf-8')))


overall = rows('consistency.csv')
by_length = rows('by_length.csv')
agreement = rows('agreement.csv')


def cell(system, length, key):
    return float(next(row[key] for row in by_length if row['system'] == system and row['length'] == length))


def auc(measure, length):
    return float(next(row['value'] for row in agreement if row['measure'] == measure and row['length'] == length))


drops = {}
for row in overall:
    system = row['system']
    drops[system] = {key: f"{cell(system, 'short', key) - cell(system, 'long', key):.3f}"
                     for key in ('summac', 'qafacteval', 'human_consistent_rate')}
facts = {
    'overall': overall,
    'by_length': by_length,
    'agreement': agreement,
    'short_to_long_drop': drops,
    'auc_short_to_long_drop': {measure: f"{auc(measure, 'short') - auc(measure, 'long'):.2f}"
                               for measure in ('summac_auc', 'qafacteval_auc')},
    'documents': sum(int(row['documents']) for row in by_length) // len(overall),
}
Path('results.facts.json').write_text(json.dumps(facts, indent=2), encoding='utf-8')
print('wrote results.facts.json')
