"""Arithmetic inspection of authored synthetic summary data."""
import csv
import statistics
from pathlib import Path

root = Path(__file__).resolve().parents[1]
with (root / "data" / "results.csv").open(encoding="utf-8", newline="") as source:
    rows = list(csv.DictReader(source))
print("Synthetic demonstration data; no model or annotation study.")
methods = {}
for row in rows:
    methods.setdefault(row["method"], {})[row["seed"]] = float(row["consistency_percent"])
for method, scores in methods.items():
    print(f"{method}: mean={statistics.mean(scores.values()):.1f}%, "
          f"sample_sd={statistics.stdev(scores.values()):.1f} percentage points")
differences = [methods["evidence_grounded"][seed] - score
               for seed, score in methods["baseline"].items()]
print(f"Paired mean difference: {statistics.mean(differences):.1f} percentage points")
