"""Arithmetic inspection of authored synthetic attention data."""
import csv
import statistics
from pathlib import Path

root = Path(__file__).resolve().parents[1]
with (root / "data" / "pilot.csv").open(encoding="utf-8", newline="") as source:
    rows = list(csv.DictReader(source))
print("Synthetic demonstration data; no trained model measurements.")
for method in dict.fromkeys(row["method"] for row in rows):
    selected = [row for row in rows if row["method"] == method]
    accuracy = [float(row["accuracy_percent"]) for row in selected]
    print(f"{method}: retained={selected[0]['retained_fraction']}, "
          f"mean={statistics.mean(accuracy):.1f}%, "
          f"sample_sd={statistics.stdev(accuracy):.1f} percentage points")
