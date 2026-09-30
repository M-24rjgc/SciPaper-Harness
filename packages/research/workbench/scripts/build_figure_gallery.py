#!/usr/bin/env python3
"""Build the figure gallery index the platform ships from Top-Conf Figure Gallery.

    python build_figure_gallery.py <commit> <output directory>

Reads `data/figures.json` and `LICENSE` of qwdwqfwq/topconf-paper-figure-gallery at
<commit> from GitHub and writes, into <output directory> (runtime/figure-gallery):

- index.json.gz: the source (repository, commit, licence) and one record per figure:
  id, venue, year, title, authors, visual pattern, Oral/Spotlight tier and award,
  paper and PDF links, the image's path in the gallery, its size and design score;
- LICENSE: the gallery's MIT licence, which covers its code and index.

The figures themselves are not copied: each stays under the copyright of its paper's
authors and publisher, and src/gallery.ts fetches the ones the agent or the person
chooses from the gallery itself, so an image the gallery takes down is gone here too.

Standard library only. Offline tooling: not shipped with the package.
"""
from __future__ import annotations

import gzip
import json
import re
import sys
import urllib.request
from pathlib import Path

REPOSITORY = "qwdwqfwq/topconf-paper-figure-gallery"
PATTERNS = {"teaser", "architecture", "conceptual", "pipeline", "framework", "taxonomy", "comparison", "results"}
TIERS = {"oral", "spotlight"}
AWARDS = {"best", "honorable"}
ID = re.compile(r"^[a-z]+\d{4}-[A-Za-z0-9_.-]+$")
IMAGE = re.compile(r"^images/[a-z]+/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png|webp)$")


def fetch(commit: str, path: str) -> bytes:
    url = f"https://raw.githubusercontent.com/{REPOSITORY}/{commit}/{path}"
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def record(item: dict) -> dict:
    """One figure as the platform keeps it; raises on anything the gallery did not promise."""
    if not ID.match(item["id"]) or not IMAGE.match(item["image"]) or item["pattern"] not in PATTERNS:
        raise ValueError(f"unexpected figure record {item.get('id')!r}")
    out = {
        "id": item["id"], "venue": item["venue"], "year": int(item["year"]), "title": " ".join(item["title"].split()),
        "authors": [" ".join(author.split()) for author in item["authors"]], "pattern": item["pattern"],
        "paper": item["paper"], "image": item["image"], "width": int(item["w"]), "height": int(item["h"]),
    }
    if item.get("pdf_source") and item["pdf_source"] != item["paper"]:
        out["pdf"] = item["pdf_source"]
    if item.get("tier") in TIERS:
        out["tier"] = item["tier"]
    if item.get("award") in AWARDS:
        out["award"] = item["award"]
    if isinstance(item.get("score"), (int, float)):
        out["score"] = round(float(item["score"]), 2)
    return out


def main() -> None:
    if len(sys.argv) != 3 or not re.fullmatch(r"[0-9a-f]{40}", sys.argv[1]):
        sys.exit(__doc__)
    commit, output = sys.argv[1], Path(sys.argv[2])
    figures = [record(item) for item in json.loads(fetch(commit, "data/figures.json").decode("utf-8-sig"))]
    if len({figure["id"] for figure in figures}) != len(figures):
        raise ValueError("duplicate figure ids")
    index = {
        "source": {
            "name": "Top-Conf Figure Gallery", "repository": f"https://github.com/{REPOSITORY}", "commit": commit,
            "license": "MIT for the index; every figure keeps its paper's copyright",
        },
        "figures": figures,
    }
    output.mkdir(parents=True, exist_ok=True)
    body = json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    # A fixed timestamp keeps the archive byte-identical across rebuilds of the same commit.
    (output / "index.json.gz").write_bytes(gzip.compress(body, compresslevel=9, mtime=0))
    (output / "LICENSE").write_bytes(fetch(commit, "LICENSE").replace(b"\r\n", b"\n"))
    print(f"{len(figures)} figures from {REPOSITORY}@{commit[:7]} -> {output}")


if __name__ == "__main__":
    main()
