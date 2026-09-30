---
name: visual-self-review
description: Use after every meaningful compile to look at the paper's actual pages — layout, figures, tables, typography — and fix what a reader would notice.
---

# Looking at your own pages

Compiling is not proof the paper looks right. Look at it.

## Steps

1. `research_artifact` render-pages (optionally `maxPages`). It returns PNG paths of the latest compiled PDF.
2. `read_image` each page. If your model cannot read images, use `research_media` visual-review instead, which sends the pages to the configured vision model; its findings come back through complete-visual-review.
3. Check, page by page:
   - figures: legible text at print size, nothing clipped, consistent fonts and colours, placed near first mention;
   - tables: aligned, not overflowing the margin, consistent decimals, best result marked consistently;
   - text: no overfull lines running into the margin, no widowed headings, equations not overflowing;
   - references: no "??" for citations or cross-references;
   - page limit respected for the venue.
4. Fix what you found, compile again, and look again at the pages you changed.

## Done when

The `visual` check no longer warns (pages were rendered after the latest compile) and nothing you saw needs fixing.
