# Agent Note: A figure gallery of top-venue Figure 1s for every research mode

Status: implemented

English | [中文](2026-09-24-research-figure-gallery.zh.md)

## Problem

Every drawing skill of the research workbench starts from how strong papers draw the same kind of figure: spark-to-paper's figure stage requires grounding a schematic figure on an on-topic top-venue main figure, CCFA's visual composer has a reference-layout mode, and the general mode's method-diagram skill studies close papers before drawing. The only tool for it was fetch-reference-figures, which takes arXiv ids the agent must first find and then guesses the overview figure from captions on ar5iv, so grounding often failed or picked a results plot.

## Decision

The platform ships the index of Top-Conf Figure Gallery, about 3,500 Figure 1 and teaser figures of ICLR, ICML, NeurIPS, CVPR, ACL and AAAI papers from 2023 to 2026 that its maintainers reviewed by hand, as a capability of every mode.

- **Index only.** `scripts/build_figure_gallery.py` reads the gallery's `data/figures.json` at a fixed commit and writes `runtime/figure-gallery/index.json.gz` with the gallery's MIT licence and a notice. The images keep their papers' copyright, so none is bundled.
- **Search.** `research_media` find-reference-figures filters by venue, year, visual pattern and tier, ranks a query with BM25 over titles, authors, venues and patterns, and lists the most recognised figures first without one. With an embedding endpoint, the title embeddings are computed once in the background and cached per model and index commit; later queries fuse them with the keyword ranking. Each page states its basis.
- **Fetch on demand.** fetch-reference-figures `{galleryIds, label}` takes each chosen image from the gallery's repository, then a CDN mirror, then its site; caches it under the product home; and saves it into `figures/refs/` with a `.source.json` naming the paper and its copyright. Images are fetched from the live gallery, so one it takes down stops being available. The ar5iv path stays for papers outside those venues.
- **Both people and the agent use it.** The workbench's figure gallery tab, opened from the conversation header, browses the same index through the host route `/api/research/gallery/image` and saves a figure with the same action. The three drawing skills search the gallery first and fall back to arXiv papers.

## Consequences

- The installer grows by about 440 KB of index; each figure costs one download of about 100 KB the first time anyone views or saves it.
- Browsing and saving need the network until a figure is cached; the index and search work offline.
- Coverage is machine learning and AI venues from 2023 to 2026; other fields fall back to arXiv papers the agent finds.
- Refreshing the gallery means rebuilding the index at a newer commit with `scripts/build_figure_gallery.py`.

## Alternatives considered

**Bundle the images.** It would add about 400 MB to the installer and redistribute figures the gallery itself only indexes for educational reference, including AAAI figures whose authors and publisher keep the copyright.

**Embed the gallery's own web page.** It cannot hand a chosen figure to the project, and its copy is not in the product's locale dictionaries. The native tab uses the product's search and save actions.
