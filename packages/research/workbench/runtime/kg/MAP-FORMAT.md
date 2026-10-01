# ai-map.bin format

`ai-map.bin` is the domain map of the built-in graph `ai-kg.json.gz`. [`scripts/build_kg_map.py`](../../scripts/build_kg_map.py) writes it offline, and [`src/knowledge-map.ts`](../../src/knowledge-map.ts) parses and validates it at runtime. [MAP-QUALITY.md](MAP-QUALITY.md) explains how the layout was chosen and how accurate it is.

## Conventions

All integers are little-endian and unsigned. A *unit* value is a `u16` that stands for `value / 65535` in [0, 1]. Map coordinates are units: x grows rightward and y grows downward, as on a screen. Paper and pattern indices refer to the `papers` and `patterns` arrays of `ai-kg.json.gz`. `0xFFFF` in a `u16` index slot and `0xFF` in a `u8` index slot mean "none". Grids have `G × G` cells stored row by row from the top-left; cell (row r, column c) covers x in [c/G, (c+1)/G) and y in [r/G, (r+1)/G).

## Header (40 bytes)

| Offset | Type | Field |
| --- | --- | --- |
| 0 | 8 bytes | Signature `89 4B 47 4D 41 50 0D 0A` (`\x89KGMAP\r\n`) |
| 8 | u16 | Format version, 1 |
| 10 | u16 | Grid size G |
| 12 | u32 | Paper count N; equals the graph's paper count |
| 16 | u16 | Pattern count P |
| 18 | u16 | Region count R (below 255) |
| 20 | u16 | Gap count K (below 255) |
| 22 | u16 | Layout runs the gaps were tested on, the shipped run included |
| 24 | f32 | Density scale: the density, in papers per unit area, that level 255 stands for |
| 28 | f32 | Median paper density: the density at the median paper's own cell |
| 32 | u32 | String table length S in bytes |
| 36 | u32 | CRC-32 (IEEE, as zlib computes it) of every byte from offset 40 to the end |

The file length is exactly `40 + 4N + 8P + 28R + 24K + 512 + 3G² + S`.

## Sections, in file order

| Section | Record | Fields |
| --- | --- | --- |
| Papers | 4 bytes × N | unit x, unit y |
| Patterns | 8 bytes × P | unit x, unit y (geometric median of the pattern's papers), unit spread (their median distance from it), u16 member count; 0 members means no position |
| Regions | 28 bytes × R | unit x, unit y (label anchor), u32 papers, u32 label offset, u16 label length, u32 keywords offset, u16 keywords length, u16 domain index, 3 × u16 pattern index |
| Gaps | 24 bytes × K | unit x, unit y (the point farthest from the gap's edge), u16 area in cells, u16 depth × 10000, u16 rim papers, u8 recurrence, u8 border count (2 or 3), 3 × u8 border region, 3 × u8 border share in percent, 3 × u16 rim pattern index |
| Density CDF | 512 bytes | 256 × u16: entry q is the share (/65535) of papers whose own cell has density level q or lower |
| Density levels | G² bytes | level q per cell; the density is `(q / 255)² × density scale` papers per unit area |
| Region cells | G² bytes | region index per cell, `0xFF` where no region reaches |
| Gap cells | G² bytes | gap index per cell, `0xFF` outside every gap |
| Strings | S bytes | UTF-8 labels and keyword lists, addressed by offset and length from the table's start |

A region's label is the text the map shows at its anchor: one to three keywords joined by ` / `, unique within the file. Its keyword list holds up to five keywords joined by `, `. A region's domain is the most common domain among its papers, and its three pattern slots hold its most common patterns. A gap's border slots name the regions around it with their share of its rim, largest first. Its recurrence counts the other layout runs (out of runs − 1) that have a gap whose rim papers overlap its own by a Jaccard index of 0.25 or more. The shipped file was tested on ten runs: the shipped one, four other seeds and five parameter variants. Its depth is the mean density inside it relative to the median paper density.

## Meaning and limits

Distances are meaningful within a neighbourhood (a few hundredths of the map). The relative placement of far-apart regions carries little meaning. A gap is a sparse area of this map, enclosed by denser regions, that recurred across layout runs. It is not evidence that the topic between its neighbours is unexplored.

## Validation

`parseKnowledgeMap` rejects a file that is shorter than the header, has another signature or version, has a length that differs from the one the header implies, or fails the checksum. It also rejects a file whose paper count differs from the caller's graph, whose header values are out of range, or whose index or string reference points outside its table.
