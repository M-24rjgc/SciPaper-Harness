#!/usr/bin/env python3
"""Distil the upstream AI research-pattern graph into the compact graph the platform ships.

    python build_kg.py <kg_ai directory> <output .json.gz>

Input: the extracted kg/kg_ai archive of spark-to-paper-skills (nodes_*.json and
knowledge_graph_v2.gpickle). Output: runtime/kg/ai-kg.json.gz, read by src/knowledge.ts.

What is kept: every pattern (name, domain, sub-domains, size, coherence, a tier, its story as
the summary and its other summary facets as details, a few representative ideas, exemplars,
where it works well), every paper (title,
idea, base problem, solution pattern, story, mean review score, pattern, domain) and each
paper's five nearest papers from the graph's idea-to-paper similarity edges. What is dropped:
the embedding vectors, individual reviews, and the per-paper application text.

The graph edges live in a networkx pickle. It is read by an unpickler that resolves only
the five globals that pickle names, each to an inert stand-in, and refuses every other
global, so loading it runs no code from the file; networkx and numpy are not needed.

Standard library only. Offline tooling: not shipped with the package.
"""
from __future__ import annotations

import gzip
import json
import pickle
import statistics
import struct
import sys
from collections import defaultdict
from pathlib import Path

NEIGHBOURS = 5
IDEAS_PER_PATTERN = 3
# The summary facets upstream wrote for each pattern; its "story" facet becomes the one-line summary.
FACETS = (("representative_ideas", "Ideas"), ("common_problems", "Problems"), ("solution_approaches", "Solutions"))


class Inert:
    """Stands in for a pickled class: keeps its arguments and state, runs nothing."""

    def __init__(self, *args):
        self.args = args
        self.state = None

    def __setstate__(self, state):
        self.state = state


def inert(name):
    return type(name, (Inert,), {})


def scalar(dtype, raw):
    code = dtype.args[0] if isinstance(dtype, Inert) and dtype.args else None
    if code == "f8" and len(raw) == 8:
        return struct.unpack("<d", raw)[0]
    if code == "f4" and len(raw) == 4:
        return struct.unpack("<f", raw)[0]
    raise pickle.UnpicklingError(f"unsupported scalar {code!r}")


GLOBALS = {
    ("networkx.classes.digraph", "DiGraph"): inert("DiGraph"),
    ("networkx.classes.coreviews", "AdjacencyView"): inert("AdjacencyView"),
    ("networkx.classes.reportviews", "OutEdgeView"): inert("OutEdgeView"),
    ("numpy", "dtype"): inert("dtype"),
    ("numpy._core.multiarray", "scalar"): scalar,
    ("numpy.core.multiarray", "scalar"): scalar,
}


class InertUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        try:
            return GLOBALS[(module, name)]
        except KeyError:
            raise pickle.UnpicklingError(f"refusing to load {module}.{name}") from None


def read_json(directory, name):
    return json.loads((directory / name).read_text(encoding="utf-8"))


def number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def tiers(patterns):
    """A/B/C by size and coherence together: A is at or above the median on both, C below it on both, B the rest."""
    size_mid = statistics.median(p["size"] for p in patterns)
    coh_mid = statistics.median(p["coherence"] for p in patterns if p["coherence"] is not None)
    for p in patterns:
        big = p["size"] >= size_mid
        coherent = p["coherence"] is not None and p["coherence"] >= coh_mid
        p["tier"] = "A" if big and coherent else "C" if not big and not coherent else "B"


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    source, output = Path(argv[0]), Path(argv[1])
    raw_patterns = read_json(source, "nodes_pattern.json")
    raw_papers = read_json(source, "nodes_paper.json")
    raw_domains = read_json(source, "nodes_domain.json")
    with open(source / "knowledge_graph_v2.gpickle", "rb") as handle:
        graph = InertUnpickler(handle).load()
    succ = graph.state["_succ"]

    domains = [d["name"] for d in raw_domains]
    domain_index = {name: i for i, name in enumerate(domains)}
    domain_by_id = {d["domain_id"]: domain_index[d["name"]] for d in raw_domains}
    paper_index = {p["paper_id"]: i for i, p in enumerate(raw_papers)}
    pattern_index = {p["pattern_id"]: i for i, p in enumerate(raw_patterns)}
    idea_paper = {p["idea_id"]: paper_index[p["paper_id"]] for p in raw_papers if p.get("idea_id")}

    works = defaultdict(list)
    neighbours = defaultdict(list)
    for node, targets in succ.items():
        for target, attrs in targets.items():
            relation = attrs.get("relation")
            if relation == "works_well_in" and node in pattern_index and target in domain_by_id:
                works[node].append([domain_by_id[target], round(number(attrs.get("effectiveness")) or 0.0, 4), round(number(attrs.get("confidence")) or 0.0, 3)])
            elif relation == "similar_to_paper" and node in idea_paper and target in paper_index:
                own = idea_paper[node]
                if paper_index[target] != own:
                    neighbours[own].append((number(attrs.get("similarity")) or 0.0, paper_index[target]))

    patterns = []
    for p in raw_patterns:
        facets = p.get("llm_enhanced_summary") if isinstance(p.get("llm_enhanced_summary"), dict) else {}
        summary = p.get("summary") if isinstance(p.get("summary"), dict) else {}
        coherence = (p.get("coherence") or {}).get("centroid_mean")
        patterns.append({
            "id": p["pattern_id"],
            "name": p.get("name", ""),
            "domain": domain_index.get(p.get("domain"), -1),
            "subDomains": p.get("sub_domains", []),
            "size": int(p.get("size", 0)),
            "coherence": round(coherence, 4) if coherence is not None else None,
            "summary": str(facets.get("story", "")),
            "details": "\n".join(f"{label}: {facets[key]}" for key, label in FACETS if facets.get(key)),
            "ideas": [str(idea) for idea in (summary.get("representative_ideas") or [])[:IDEAS_PER_PATTERN]],
            "exemplars": [paper_index[e] for e in p.get("exemplar_paper_ids", []) if e in paper_index],
            "works": sorted(works.get(p["pattern_id"], []), key=lambda w: -w[2])[:8],
        })
    tiers(patterns)

    papers = []
    for i, p in enumerate(raw_papers):
        details = p.get("pattern_details") or {}
        stats = p.get("review_stats") or {}
        score = number(stats.get("avg_score"))
        papers.append({
            "id": p["paper_id"],
            "title": p.get("title", ""),
            "pattern": pattern_index.get(p.get("pattern_id"), -1),
            "domain": domain_by_id.get(p.get("domain_id"), domain_index.get(p.get("domain"), -1)),
            "idea": p.get("idea", ""),
            "problem": details.get("base_problem", ""),
            "solution": details.get("solution_pattern", ""),
            "story": details.get("story", ""),
            "score": round(score, 3) if score is not None else None,
            "similar": [index for _, index in sorted(neighbours.get(i, []), reverse=True)[:NEIGHBOURS]],
        })

    graph_file = {
        "version": 1,
        "name": "ai",
        "description": "Research patterns distilled from machine-learning conference papers on OpenReview, with their reviews "
                       "(spark-to-paper-skills kg_ai, commit c17149d, MIT).",
        "paperUrl": "https://openreview.net/forum?id={id}",
        "domains": domains,
        "patterns": patterns,
        "papers": papers,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(graph_file, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with gzip.GzipFile(output, "wb", compresslevel=9, mtime=0) as handle:
        handle.write(data)
    linked = sum(1 for p in papers if p["similar"])
    print(json.dumps({"patterns": len(patterns), "papers": len(papers), "domains": len(domains), "withNeighbours": linked,
                      "rawBytes": len(data), "gzipBytes": output.stat().st_size}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
