#!/usr/bin/env python3
"""Build the domain map of the built-in knowledge graph: one 2D position per paper, labelled regions and gaps.

    python build_kg_map.py <runtime/kg/ai-kg.json.gz> <runtime/kg/ai-map.bin> [--preview map.png]

Input: the graph src/knowledge.ts loads (papers with title, idea, problem, solution, story and their five
recorded neighbours). Output: the binary asset src/knowledge-map.ts parses; runtime/kg/MAP-FORMAT.md documents
it and runtime/kg/MAP-QUALITY.md records why this method was chosen and how well it does.

Method (fixed seeds, no network, no model endpoint):

1. Text space. TF-IDF over unigrams and bigrams of title (twice), idea, problem, solution and story (terms in at
   least 5 papers and at most 20% of them, 80,000 terms at most), reduced to 128 dimensions by randomized SVD
   (seed 0) and normalised; exact cosine nearest neighbours.
2. Graph. UMAP's fuzzy neighbour graph of that space, fused (fuzzy union) with the graph's recorded neighbours
   at weight 0.5 (rank r of five gets 1 - 0.1 r before scaling).
3. Layout. UMAP's embedding of the fused graph (min_dist 0, spread 1, 200 epochs, spectral start) with seed 11 is
   shipped. Nine more runs only test which gaps recur: seeds 12 to 15, and seed 11 with 15 or 50 neighbours, recorded
   weight 0.3 or 1.0, or min_dist 0.05.
4. Frame. The layout is scaled uniformly into [0.02, 0.98]^2, y pointing down (screen convention).
5. Density. A Gaussian kernel density (bandwidth 0.006) on a 256 x 256 grid, in papers per unit area.
6. Regions. Density basins (ToMATo-style persistence merging), merged along their shallowest valleys into at
   most 40 regions of at least 150 papers (a merge may not exceed 1,600 papers until no other merge is
   possible). Smaller isolated specks keep no region. Empty cells within 0.06 of a region join the nearest one.
7. Labels. Each region's keywords are the title terms (one to three words, generic words removed) with the
   highest p(term | region) * log(p(term | region) / p(term)); a word usually seen inside a longer term is shown as
   that term. The label is the first keyword, with the second when the label stays within 32 characters, placed so
   that no two label boxes overlap on a 1000 px map with 12 px type (box: 7.2 px per character + 8 px, 22 px high).
8. Gaps. Cells below 10% of the median paper density that are enclosed by denser cells (holes, and inlets
   narrower than 0.04 after a morphological closing) form gap candidates of at least 0.001 of the map's area,
   bordered by at least two regions that each hold 15% of the land within 0.015 of the gap. A gap is kept only
   when it recurs (a gap there whose rim papers have Jaccard >= 0.25 with its own) in at least three of the four
   other seeds and three of the five parameter variants. A gap means "sparse in this map": it is not evidence that
   the topic between its neighbours is unexplored.

Byte layout (version 1, little-endian; runtime/kg/MAP-FORMAT.md has the field meanings). A unit is a u16 / 65535.

    header   40 B: magic 89 4B 47 4D 41 50 0D 0A; u16 version; u16 grid G; u32 papers N; u16 patterns P; u16 regions R;
             u16 gaps K; u16 layout runs; f32 density scale; f32 median paper density; u32 string bytes S;
             u32 CRC-32 of bytes 40..end
    papers   N x (unit x, unit y), y down
    patterns P x (unit x, unit y, unit spread, u16 members)
    regions  R x (unit x, unit y, u32 papers, u32 label offset, u16 label length, u32 keywords offset,
             u16 keywords length, u16 domain, 3 x u16 pattern; 0xFFFF = none)
    gaps     K x (unit x, unit y, u16 area cells, u16 depth x 10000, u16 rim papers, u8 recurrence, u8 borders,
             3 x u8 border region, 3 x u8 border share %, 3 x u16 rim pattern)
    cdf      256 x u16 share of papers at or below each density level
    levels   G x G u8 density level q, density = (q / 255)^2 x scale, rows from the top
    regions  G x G u8 region index, 0xFF = none
    gaps     G x G u8 gap index, 0xFF = none
    strings  S B UTF-8

Reproduce: Python 3.13 with numpy 2.5.3, scipy 1.18.1, scikit-learn 1.9.1, umap-learn 0.5.12 (numba 0.68.0,
llvmlite 0.50.0, pynndescent 0.6.0) in a throwaway virtual environment, then run the command above from
packages/research/workbench. BLAS runs single-threaded so that floating-point sums do not depend on the thread
count; the same environment rebuilds the asset byte for byte. Another CPU or library build may move points by
rounding (numba compiles UMAP's optimiser with fastmath), giving an equivalent but not identical map. A run
takes a few minutes; matplotlib is needed only for --preview.

Dev-only tooling: none of these packages is a runtime dependency, and the asset is not shipped with any model.
"""
from __future__ import annotations

import os

for _name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMBA_NUM_THREADS"):
    os.environ[_name] = "1"

import argparse
import gzip
import json
import re
import struct
import sys
import unicodedata
import zlib
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import scipy.sparse as sp
from scipy import ndimage

FORMAT_VERSION = 1
MAGIC = b"\x89KGMAP\r\n"
HEADER_BYTES = 40
NONE16 = 0xFFFF
NONE8 = 0xFF

DIMENSIONS = 128
NEIGHBOURS = 30
RECORDED_WEIGHT = 0.5
MIN_DIST = 0.0
EPOCHS = 200
SEEDS = (11, 12, 13, 14, 15)
# (neighbours, recorded weight, min_dist) of the layouts that test whether a gap survives a change of parameters.
VARIANTS = ((15, 0.5, 0.0), (50, 0.5, 0.0), (30, 0.3, 0.0), (30, 1.0, 0.0), (30, 0.5, 0.05))
PAD = 0.02

GRID = 256
BANDWIDTH = 0.006
FLOOR = 0.06
PERSISTENCE = 0.35
MAX_REGIONS = 40
MIN_REGION_PAPERS = 150
MERGE_CAP = 1600
REACH = 0.06

LAND = 0.10
CLOSE_RADIUS = 0.02
MIN_GAP_AREA = 0.001
RIM = 0.015
MIN_BORDER_SHARE = 0.15
RECUR_JACCARD = 0.25
MIN_SEED_RECURRENCE = 3
MIN_VARIANT_RECURRENCE = 3

CHAR_WIDTH = 0.0072
BOX_PAD = 0.008
BOX_HEIGHT = 0.022
MAX_LABEL_CHARS = 32

STOP = set(
    "a an the of for and or in on with to from by via as at is are be can that this these those it its into over under using use "
    "based towards toward through new novel approach method methods model models learning paper we our their than more most not "
    "which such also while between across both each how what when where why you your one two three".split()
)
# Words that name no topic on their own; a bigram may still end in one of HEADS ("federated learning").
GENERIC = STOP | set(
    "beyond without understanding improving improved improve efficient effective robust large scale scalable simple general "
    "generalized framework frameworks neural network networks deep data training task tasks study analysis better learn learned "
    "learns rethinking revisiting provable provably fast faster theory theoretical problem problems do does make makes making all "
    "any only vs versus up out within against".split()
)
HEADS = {"learning", "models", "model", "networks", "network", "neural", "data", "training"}


def words_of(text: str) -> list[str]:
    """Lowercase ASCII words (accents folded) of two or more characters."""
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii").lower()
    return [w.strip("-") for w in re.findall(r"[a-z][a-z0-9\-]+", folded)]


def lsa_tokens(text: str) -> list[str]:
    words = [w for w in words_of(text) if w and w not in STOP]
    return words + [f"{a}_{b}" for a, b in zip(words, words[1:])]


def title_terms(title: str) -> set[str]:
    words = [w for w in words_of(title) if len(w) > 1]
    def head(w: str) -> bool:
        return w not in GENERIC or w in HEADS

    uni = {w for w in words if w not in GENERIC and len(w) > 2}
    bi = {f"{a} {b}" for a, b in zip(words, words[1:]) if a not in GENERIC and len(a) > 2 and head(b)}
    tri = {f"{a} {b} {c}" for a, b, c in zip(words, words[1:], words[2:]) if a not in GENERIC and len(a) > 2 and head(b) and head(c)}
    return uni | bi | tri


def text_space(papers: list[dict]) -> np.ndarray:
    """Unit-length 128-d LSA vectors of the papers' texts."""
    from sklearn.utils.extmath import randomized_svd

    docs = [lsa_tokens(f"{p['title']} {p['title']} {p['idea']} {p['problem']} {p['solution']} {p['story']}") for p in papers]
    n = len(docs)
    df: Counter = Counter()
    for d in docs:
        df.update(set(d))
    kept = sorted(((w, c) for w, c in df.items() if 5 <= c <= n * 0.2), key=lambda x: (-x[1], x[0]))[:80000]
    vocab = {w: i for i, (w, _) in enumerate(kept)}
    rows, cols, vals = [], [], []
    for i, d in enumerate(docs):
        for w, c in sorted(Counter(w for w in d if w in vocab).items()):
            rows.append(i); cols.append(vocab[w]); vals.append((1 + np.log(c)) * np.log(n / df[w]))
    X = sp.csr_matrix((vals, (rows, cols)), shape=(n, len(vocab)), dtype=np.float64)
    norms = np.sqrt(np.asarray(X.multiply(X).sum(1)).ravel())
    X = (sp.diags(1 / np.maximum(norms, 1e-12)) @ X).tocsr()
    U, S, _ = randomized_svd(X, DIMENSIONS, n_iter=10, random_state=0)
    V = U * S
    return (V / np.maximum(np.linalg.norm(V, axis=1, keepdims=True), 1e-12)).astype(np.float32)


def nearest(V: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    """Exact cosine k nearest neighbours of unit rows, each row's own index first."""
    n = len(V)
    idx = np.empty((n, k), np.int32)
    dist = np.empty((n, k), np.float32)
    for s in range(0, n, 2048):
        S = V[s:s + 2048] @ V.T
        r = np.arange(S.shape[0])
        S[r, s + r] = 9.0
        part = np.argpartition(-S, k, axis=1)[:, :k]
        ps = np.take_along_axis(S, part, 1)
        order = np.argsort(-ps, axis=1, kind="stable")
        idx[s:s + 2048] = np.take_along_axis(part, order, 1)
        d = 1 - np.take_along_axis(ps, order, 1)
        d[:, 0] = 0
        dist[s:s + 2048] = np.maximum(d, 0)
    return idx, dist


def recorded_graph(papers: list[dict]) -> sp.csr_matrix:
    n = len(papers)
    rows, cols, vals = [], [], []
    for i, p in enumerate(papers):
        for r, j in enumerate(p["similar"]):
            rows.append(i); cols.append(j); vals.append(1.0 - 0.1 * r)
    W = sp.coo_matrix((vals, (rows, cols)), shape=(n, n)).tocsr()
    return (W + W.T - W.multiply(W.T)).tocsr()


def layout(args: tuple) -> np.ndarray:
    """One UMAP run over the fused graph; a process-pool task. `run` is (seed, neighbours, recorded weight, min_dist)."""
    V, idx, dist, R, run = args
    seed, neighbours, recorded, min_dist = run
    from umap.umap_ import find_ab_params, fuzzy_simplicial_set, simplicial_set_embedding

    rs = np.random.RandomState(seed)
    G, _, _ = fuzzy_simplicial_set(V, neighbours, rs, "cosine", knn_indices=idx[:, :neighbours], knn_dists=dist[:, :neighbours])
    W = R * recorded
    G = (G + W - G.multiply(W)).tocoo()
    G.sum_duplicates()
    a, b = find_ab_params(1.0, min_dist)
    Y, _ = simplicial_set_embedding(V, G, 2, 1.0, a, b, 1.0, 5, EPOCHS, "spectral", rs, "cosine", {}, False, {}, False)
    return Y


def frame(Y: np.ndarray) -> np.ndarray:
    """Uniform scale into [PAD, 1 - PAD]^2 with y pointing down."""
    lo, hi = Y.min(0), Y.max(0)
    span = float((hi - lo).max())
    Z = (Y - (lo + hi) / 2) / span * (1 - 2 * PAD) + 0.5
    Z[:, 1] = 1 - Z[:, 1]
    return np.clip(Z, 0, 1)


def cells(Z: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    c = np.minimum((Z * GRID).astype(int), GRID - 1)
    return c[:, 1], c[:, 0]


def density(Z: np.ndarray) -> np.ndarray:
    """Kernel density on the grid (rows = y), in papers per unit area."""
    H, _, _ = np.histogram2d(Z[:, 1], Z[:, 0], bins=GRID, range=[[0, 1], [0, 1]])
    return ndimage.gaussian_filter(H, BANDWIDTH * GRID, mode="constant") * GRID * GRID


def relabel(L: np.ndarray) -> np.ndarray:
    out = np.full(L.shape, -1, np.int64)
    for k, v in enumerate(np.unique(L[L >= 0])):
        out[L == v] = k
    return out


def basins(D: np.ndarray, floor: float, tau: float) -> np.ndarray:
    """Cells above floor in decreasing density; a component merges into a higher one when its peak minus the saddle is below tau."""
    flat = D.ravel()
    parent = -np.ones(flat.size, np.int64)
    peak = np.zeros(flat.size)

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != root:
            parent[x], x = root, parent[x]
        return root

    for c in np.argsort(-flat, kind="stable"):
        v = flat[c]
        if v < floor:
            break
        r, k = divmod(int(c), GRID)
        roots, best, bestv = set(), -1, -1.0
        for dr in (-1, 0, 1):
            for dk in (-1, 0, 1):
                rr, kk = r + dr, k + dk
                if (dr or dk) and 0 <= rr < GRID and 0 <= kk < GRID and parent[rr * GRID + kk] >= 0:
                    root = find(rr * GRID + kk)
                    roots.add(root)
                    if flat[rr * GRID + kk] > bestv:
                        best, bestv = root, flat[rr * GRID + kk]
        if not roots:
            parent[c] = c
            peak[c] = v
            continue
        top = max(roots, key=lambda x: (peak[x], -x))
        parent[c] = best
        for root in sorted(roots):
            if root != top and peak[root] - v < tau:
                parent[root] = top
    labels = np.full(flat.size, -1, np.int64)
    for c in np.nonzero(parent >= 0)[0]:
        labels[c] = find(int(c))
    return relabel(labels.reshape(D.shape))


def saddles(D: np.ndarray, L: np.ndarray) -> dict:
    """The highest boundary density between each pair of adjacent basins."""
    out: dict = {}
    Lp = np.pad(L, 1, constant_values=-1)
    Dp = np.pad(D, 1)
    for dr, dk in ((0, 1), (1, 0), (1, 1), (1, -1)):
        b = Lp[1 + dr:GRID + 1 + dr, 1 + dk:GRID + 1 + dk]
        db = Dp[1 + dr:GRID + 1 + dr, 1 + dk:GRID + 1 + dk]
        m = (L >= 0) & (b >= 0) & (L != b)
        s = np.minimum(D[m], db[m])
        for x, y, v in zip(np.minimum(L[m], b[m]).tolist(), np.maximum(L[m], b[m]).tolist(), s.tolist()):
            if v > out.get((x, y), -1.0):
                out[(x, y)] = v
    return out


def merge_basins(D: np.ndarray, L: np.ndarray, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    """Small basins join their shallowest-valley neighbour; then the shallowest valleys merge down to MAX_REGIONS."""
    k = int(L.max()) + 1
    lab = L[rows, cols]
    count = np.bincount(lab[lab >= 0], minlength=k).astype(int)
    peak = np.array([D[L == r].max() for r in range(k)])
    nbr: dict = {r: {} for r in range(k)}
    for (i, j), v in saddles(D, L).items():
        nbr[i][j] = v
        nbr[j][i] = v
    parent = list(range(k))
    alive = set(range(k))

    def merge(i: int, j: int) -> None:
        if count[j] > count[i] or (count[j] == count[i] and j < i):
            i, j = j, i
        parent[j] = i
        count[i] += count[j]
        peak[i] = max(peak[i], peak[j])
        alive.discard(j)
        for m, v in nbr[j].items():
            if m != i:
                nbr[m].pop(j, None)
                w = max(v, nbr[i].get(m, -1.0))
                nbr[i][m] = w
                nbr[m][i] = w
        nbr[i].pop(j, None)
        nbr[j] = {}

    def shallowest(allowed) -> tuple | None:
        best, score = None, -1.0
        for i in sorted(alive):
            for j in sorted(nbr[i]):
                if j > i and allowed(i, j):
                    p = nbr[i][j] / min(peak[i], peak[j])
                    if p > score:
                        best, score = (i, j), p
        return best

    while (pair := shallowest(lambda i, j: count[i] < MIN_REGION_PAPERS or count[j] < MIN_REGION_PAPERS)) is not None:
        merge(*pair)
    cap = MERGE_CAP
    while sum(1 for r in alive if count[r] >= MIN_REGION_PAPERS) > MAX_REGIONS:
        pair = shallowest(lambda i, j: count[i] + count[j] <= cap)
        if pair is None:
            cap = int(cap * 1.25)
            continue
        merge(*pair)

    def root(r: int) -> int:
        while parent[r] != r:
            r = parent[r]
        return r

    mapping = np.array([root(r) for r in range(k)])
    merged = np.where(L >= 0, mapping[np.maximum(L, 0)], -1)
    lab = merged[rows, cols]
    counts = Counter(lab[lab >= 0].tolist())
    small = [r for r in np.unique(merged[merged >= 0]) if counts.get(int(r), 0) < MIN_REGION_PAPERS]
    merged[np.isin(merged, small)] = -1
    return relabel(merged)


def territory(L: np.ndarray, reach_cells: int) -> np.ndarray:
    dist, (ri, ci) = ndimage.distance_transform_edt(L < 0, return_indices=True)
    T = L[ri, ci].copy()
    T[dist > reach_cells] = -1
    return T


def regions(Z: np.ndarray, D: np.ndarray, median: float) -> tuple[np.ndarray, np.ndarray]:
    """The core region grid (dense cells) and the lookup grid (cores plus nearby empty cells)."""
    rows, cols = cells(Z)
    L = merge_basins(D, basins(D, FLOOR * median, PERSISTENCE * median), rows, cols)
    return L, territory(L, int(REACH * GRID))


def disk(r: int) -> np.ndarray:
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r


def gap_candidates(Z: np.ndarray, D: np.ndarray, T: np.ndarray, median: float) -> list[dict]:
    land = D >= LAND * median
    r = max(1, int(round(CLOSE_RADIUS * GRID)))
    closed = ndimage.binary_closing(np.pad(land, r + 2), structure=disk(r))[r + 2:-(r + 2), r + 2:-(r + 2)]
    candidate = ndimage.binary_fill_holes(closed | land) & ~land
    comps, k = ndimage.label(candidate, structure=np.ones((3, 3)))
    rows, cols = cells(Z)
    ring = max(1, int(round(RIM * GRID)))
    out = []
    for g in range(1, k + 1):
        mask = comps == g
        area = int(mask.sum())
        if area < MIN_GAP_AREA * GRID * GRID:
            continue
        rim_cells = ndimage.binary_dilation(mask, structure=np.ones((3, 3)), iterations=ring) & ~mask & land
        ids = T[rim_cells]
        ids = ids[ids >= 0]
        if ids.size == 0:
            continue
        counts = Counter(ids.tolist())
        total = sum(counts.values())
        border = [(reg, c / total) for reg, c in sorted(counts.items(), key=lambda x: (-x[1], x[0])) if c / total >= MIN_BORDER_SHARE][:3]
        if len(border) < 2:
            continue
        inside = ndimage.distance_transform_edt(np.pad(mask, 1))[1:-1, 1:-1]
        ar, ac = np.unravel_index(np.argmax(inside), mask.shape)
        out.append({"mask": mask, "cells": area, "x": (ac + 0.5) / GRID, "y": (ar + 0.5) / GRID, "border": border,
                    "rim": np.nonzero(rim_cells[rows, cols])[0], "depth": float(D[mask].mean() / median)})
    return out


def recurrence(gaps: list[dict], others: list[list[dict]]) -> None:
    """Count, for each gap, the other runs with a gap whose rim papers overlap its own by RECUR_JACCARD or more."""
    for g in gaps:
        a = set(g["rim"].tolist())
        best = []
        for run in others:
            js = [len(a & set(h["rim"].tolist())) / max(1, len(a | set(h["rim"].tolist()))) for h in run]
            best.append(max(js, default=0.0))
        g["best"] = best
        g["recurs"] = sum(1 for b in best if b >= RECUR_JACCARD)


def overlap(a: str, b: str) -> bool:
    """Whether two terms share a word, counting plurals and words of six letters or more that begin the other as one word."""
    def stems(term: str) -> list[str]:
        return [re.sub(r"ies$", "y", w).rstrip("s") for w in re.split(r"[ \-]", term) if w]

    return any(x == y or (min(len(x), len(y)) >= 6 and (x.startswith(y) or y.startswith(x))) for x in stems(a) for y in stems(b))


def keywords(titles: list[str], region_of: np.ndarray, count: int) -> list[list[list[str]]]:
    """Up to five keywords per region, each as its forms from longest to shortest ("treatment effect estimation", ..., "treatment")."""
    terms = [title_terms(t) for t in titles]
    total: Counter = Counter()
    for s in terms:
        total.update(s)
    n = len(titles)
    out = []
    for k in range(count):
        ids = np.nonzero(region_of == k)[0]
        m = len(ids)
        local: Counter = Counter()
        for i in ids:
            local.update(terms[i])
        scored = []
        for t, c in local.items():
            if c >= max(4, 0.025 * m):
                f = c / m
                scored.append((f * np.log(f / (total[t] / n)) * (1.15 if " " in t else 1.0), t))
        scored.sort(key=lambda x: (-x[0], x[1]))
        chosen: list[list[str]] = []
        for _, t in scored:
            # A term whose papers use one longer term 45% of the time or more is shown as that term
            # ("conformal" as "conformal prediction", "offline reinforcement" as "offline reinforcement learning").
            forms = [t]
            while longer := [b for _, b in scored if len(b.split()) == len(t.split()) + 1 and f" {t} " in f" {b} " and local[b] >= 0.45 * local[t]]:
                t = longer[0]
                forms.insert(0, t)
            # A word that 80% of the time completes a chosen one-word keyword into a bigram, which 30% of that
            # keyword's papers use, joins the keyword instead ("machine" turns "unlearning" into "machine unlearning").
            word = forms[-1]
            joined = next(((o, b) for o in chosen if len(o) == 1 for b in (f"{word} {o[0]}", f"{o[0]} {word}")
                           if " " not in word + o[0] and local[b] >= 0.8 * local[word] and local[b] >= 0.3 * local[o[0]]), None)
            if joined:
                joined[0].insert(0, joined[1])
                continue
            # Forms that repeat a word of a chosen keyword are dropped; a keyword with no form left is skipped.
            forms = [form for form in forms if not any(overlap(form, kept) for o in chosen for kept in o)]
            if not forms:
                continue
            chosen.append(forms)
            if len(chosen) == 5:
                break
        out.append(chosen)
    return out


def label_text(terms: list[list[str]], count: int) -> str:
    """The first keyword in its longest form within MAX_LABEL_CHARS, followed by the second keyword's longest form that still fits."""
    first = next((form for form in terms[0] if len(form) <= MAX_LABEL_CHARS), terms[0][-1])
    if count == 2 and len(terms) > 1:
        for second in terms[1]:
            if len(text := f"{first} / {second}") <= MAX_LABEL_CHARS:
                return text
    return first


def place_labels(Z: np.ndarray, region_of: np.ndarray, L: np.ndarray, D: np.ndarray, names: list[list[list[str]]]) -> list[dict]:
    """Greedy, largest region first: the first position near the region's centre whose label box overlaps none placed."""
    placed: list[tuple[float, float, float, float]] = []
    labels: list[dict] = [{} for _ in names]
    order = sorted(range(len(names)), key=lambda k: (-int((region_of == k).sum()), k))
    taken: set[str] = set()
    for k in order:
        ids = np.nonzero(region_of == k)[0]
        centre = Z[ids].mean(0)
        r, c = cells(centre[None, :])
        if L[r[0], c[0]] != k:
            mask = L == k
            rr, cc = np.unravel_index(np.argmax(np.where(mask, D, -1)), mask.shape)
            centre = np.array([(cc + 0.5) / GRID, (rr + 0.5) / GRID])
        candidates = [centre] + list(Z[ids[np.argsort(np.linalg.norm(Z[ids] - centre, axis=1), kind="stable")]][::3])
        texts = [label_text(names[k], 2), label_text(names[k], 1)]
        # A label a larger region already shows gets the third keyword.
        if texts[0] in taken and len(names[k]) > 2:
            texts.insert(0, " / ".join(forms[-1] for forms in names[k][:3]))
        done = None
        for text in (t for t in texts if t not in taken):
            w = CHAR_WIDTH * len(text) + BOX_PAD
            # Each candidate also tries the box beside, above and below it, kept inside the map.
            shifts = [(0.0, 0.0), (-w / 2, 0.0), (w / 2, 0.0), (0.0, -BOX_HEIGHT), (0.0, BOX_HEIGHT)]
            for cx, cy in candidates:
                for dx, dy in shifts:
                    x = min(max(cx + dx, w / 2), 1 - w / 2)
                    y = min(max(cy + dy, BOX_HEIGHT / 2), 1 - BOX_HEIGHT / 2)
                    box = (x - w / 2, y - BOX_HEIGHT / 2, x + w / 2, y + BOX_HEIGHT / 2)
                    if not any(box[0] < q[2] and q[0] < box[2] and box[1] < q[3] and q[1] < box[3] for q in placed):
                        done = (text, float(x), float(y), box)
                        break
                if done:
                    break
            if done:
                break
        if done is None:
            raise SystemExit(f"no free label position for region {k} ({texts[0]})")
        text, x, y, box = done
        placed.append(box)
        taken.add(text)
        labels[k] = {"label": text, "x": x, "y": y}
    return labels


def pattern_centres(Z: np.ndarray, papers: list[dict], count: int) -> list[tuple[float, float, float, int]]:
    """Weiszfeld geometric median of each pattern's papers and their median distance from it."""
    pat = np.array([p["pattern"] for p in papers])
    out = []
    for q in range(count):
        P = Z[pat == q].astype(np.float64)
        if len(P) == 0:
            out.append((0.0, 0.0, 0.0, 0))
            continue
        c = np.median(P, axis=0)
        for _ in range(50):
            d = np.maximum(np.linalg.norm(P - c, axis=1), 1e-9)
            c = (P / d[:, None]).sum(0) / (1 / d).sum()
        out.append((float(c[0]), float(c[1]), float(np.median(np.linalg.norm(P - c, axis=1))), len(P)))
    return out


def top(values: np.ndarray, k: int) -> list[int]:
    counts = Counter(int(v) for v in values if v >= 0)
    return [v for v, _ in sorted(counts.items(), key=lambda x: (-x[1], x[0]))[:k]]


def q16(value: float) -> int:
    return int(round(min(max(value, 0.0), 1.0) * 65535))


def encode(Z, patterns, regions_out, gaps, D, regions_grid, gap_grid, median, runs) -> bytes:
    scale = float(D.max())
    level = np.rint(255 * np.sqrt(np.clip(D / scale, 0, 1))).astype(np.uint8)
    rows, cols = cells(Z)
    paper_levels = level[rows, cols]
    cdf = np.cumsum(np.bincount(paper_levels, minlength=256)) / len(Z)
    strings = bytearray()

    def string(text: str) -> tuple[int, int]:
        raw = text.encode("utf-8")
        offset = len(strings)
        strings.extend(raw)
        return offset, len(raw)

    body = bytearray()
    for x, y in Z:
        body += struct.pack("<HH", q16(x), q16(y))
    for x, y, spread, members in patterns:
        body += struct.pack("<HHHH", q16(x), q16(y), q16(spread), members)
    for r in regions_out:
        lo, ll = string(r["label"])
        ko, kl = string(", ".join(r["keywords"]))
        pats = (r["patterns"] + [NONE16] * 3)[:3]
        body += struct.pack("<HHIIHIHH3H", q16(r["x"]), q16(r["y"]), r["papers"], lo, ll, ko, kl, r["domain"], *pats)
    for g in gaps:
        regs = ([b[0] for b in g["border"]] + [NONE8] * 3)[:3]
        shares = ([int(round(b[1] * 100)) for b in g["border"]] + [0] * 3)[:3]
        pats = (g["patterns"] + [NONE16] * 3)[:3]
        body += struct.pack("<HHHHHBB3B3B3H", q16(g["x"]), q16(g["y"]), g["cells"], min(int(round(g["depth"] * 10000)), 65535),
                            min(len(g["rim"]), 65535), g["recurs"], len(g["border"]), *regs, *shares, *pats)
    body += struct.pack("<256H", *[int(round(v * 65535)) for v in cdf])
    body += level.tobytes()
    body += np.where(regions_grid >= 0, regions_grid, NONE8).astype(np.uint8).tobytes()
    body += np.where(gap_grid >= 0, gap_grid, NONE8).astype(np.uint8).tobytes()
    body += bytes(strings)
    header = MAGIC + struct.pack("<HHIHHHHffI", FORMAT_VERSION, GRID, len(Z), len(patterns), len(regions_out), len(gaps), runs,
                                 scale, median, len(strings))
    header += struct.pack("<I", zlib.crc32(body))
    assert len(header) == HEADER_BYTES
    return header + bytes(body)


def preview(path: str, Z, regions_out, gaps, D) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    # 1000 x 1000 px with 12 px type: the geometry the label boxes were laid out for.
    fig = plt.figure(figsize=(10, 10), dpi=100)
    ax = fig.add_axes((0, 0, 1, 1))
    ax.imshow(np.sqrt(D / D.max()), extent=(0, 1, 1, 0), cmap="Greys", alpha=0.4)
    ax.scatter(Z[:, 0], Z[:, 1], s=0.2, c="#333333", linewidths=0, alpha=0.5)
    for g in gaps:
        ax.plot(g["x"], g["y"], "x", color="#cc5500", ms=10, mew=2)
    for r in regions_out:
        ax.text(r["x"], r["y"], r["label"], fontsize=12 * 72 / 100, ha="center", va="center", bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="none", alpha=0.85))
    ax.set_xlim(0, 1); ax.set_ylim(1, 0); ax.set_aspect("equal"); ax.set_axis_off()
    fig.savefig(path)
    plt.close(fig)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("graph")
    parser.add_argument("output")
    parser.add_argument("--preview")
    args = parser.parse_args(argv)
    graph = json.loads(gzip.decompress(Path(args.graph).read_bytes()).decode("utf-8"))
    papers, patterns = graph["papers"], graph["patterns"]
    n = len(papers)
    V = text_space(papers)
    idx, dist = nearest(V, max(NEIGHBOURS, *(v[0] for v in VARIANTS)))
    R = recorded_graph(papers)
    plan = [(seed, NEIGHBOURS, RECORDED_WEIGHT, MIN_DIST) for seed in SEEDS] + [(SEEDS[0], *v) for v in VARIANTS]
    with ProcessPoolExecutor(len(plan)) as pool:
        runs = [frame(Y) for Y in pool.map(layout, [(V, idx, dist, R, run) for run in plan])]

    per_run = []
    for Z in runs:
        D = density(Z)
        rows, cols = cells(Z)
        median = float(np.median(D[rows, cols]))
        L, T = regions(Z, D, median)
        per_run.append({"Z": Z, "D": D, "median": median, "L": L, "T": T, "gaps": gap_candidates(Z, D, T, median)})
    ref = per_run[0]
    seeds = len(SEEDS)
    recurrence(ref["gaps"], [run["gaps"] for run in per_run[1:]])
    for g in ref["gaps"]:
        g["seeds"] = sum(1 for b in g["best"][:seeds - 1] if b >= RECUR_JACCARD)
        g["variants"] = sum(1 for b in g["best"][seeds - 1:] if b >= RECUR_JACCARD)
    Z, D, median, L, T = ref["Z"], ref["D"], ref["median"], ref["L"], ref["T"]
    rows, cols = cells(Z)
    region_of = np.where(L[rows, cols] >= 0, L[rows, cols], T[rows, cols])
    count = int(L.max()) + 1
    names = keywords([p["title"] for p in papers], region_of, count)
    placed = place_labels(Z, region_of, L, D, names)
    pat = np.array([p["pattern"] for p in papers])
    dom = np.array([p["domain"] for p in papers])
    regions_out = []
    for k in range(count):
        ids = region_of == k
        regions_out.append({**placed[k], "keywords": [forms[0] for forms in names[k]], "papers": int(ids.sum()), "domain": top(dom[ids], 1)[0],
                            "patterns": top(pat[ids], 3)})
    kept = [g for g in ref["gaps"] if g["seeds"] >= MIN_SEED_RECURRENCE and g["variants"] >= MIN_VARIANT_RECURRENCE]
    gap_grid = np.full(L.shape, -1, np.int64)
    for k, g in enumerate(kept):
        g["patterns"] = top(pat[g["rim"]], 3)
        gap_grid[g["mask"]] = k
    asset = encode(Z, pattern_centres(Z, papers, len(patterns)), regions_out, kept, D, T, gap_grid, median, len(plan))
    Path(args.output).write_bytes(asset)
    if args.preview:
        preview(args.preview, Z, regions_out, kept, D)
    print(json.dumps({
        "papers": n, "regions": count, "unlabelled": round(float(np.mean(region_of < 0)), 4),
        "gapCandidates": len(ref["gaps"]), "gapSeedRecurrence": [g["seeds"] for g in ref["gaps"]],
        "gapVariantRecurrence": [g["variants"] for g in ref["gaps"]],
        "gapBestJaccard": [[round(b, 2) for b in g["best"]] for g in ref["gaps"]], "gapsKept": len(kept),
        "gapCandidatesPerRun": [len(run["gaps"]) for run in per_run], "bytes": len(asset),
        "labels": [r["label"] for r in regions_out],
        "gaps": [{"x": round(g["x"], 3), "y": round(g["y"], 3), "between": [regions_out[b[0]]["label"] for b in g["border"]],
                  "seeds": g["seeds"], "variants": g["variants"]} for g in kept],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
