# Agent Note: A grounded relation graph of methods, tasks, datasets, metrics and papers

Status: proposed

English | [中文](2026-10-01-knowledge-graph-relations.zh.md)

## Problem

The knowledge graph links a paper to its pattern and a pattern to its domain, and records which papers are similar. It has no typed relations, so neither the person nor the agent can ask how two methods relate, which method was evaluated on which dataset, or what the project's literature leaves untested. A relation graph that a language model fills in freely would answer those questions with relations nobody can check. The graph has to hold only relations that rest on something in the project's own record, has to lapse when that record changes, and has to honor the person's corrections.

## Proposal

Three new modules of the research workbench hold the graph as pure code that the research service, the knowledge tool and the 关系 (Relations) view call: [knowledge-relations.ts](../../../../packages/research/workbench/src/knowledge-relations.ts) (the model, the store, entity resolution, corrections, staleness and citations), [knowledge-relations-grounding.ts](../../../../packages/research/workbench/src/knowledge-relations-grounding.ts) (the grounding rule and the text matching it uses) and [knowledge-relations-queries.ts](../../../../packages/research/workbench/src/knowledge-relations-queries.ts) (neighbourhood, paths and the gap matrix).

- **Entities** are methods, tasks, datasets, metrics and papers. A paper is always one of the project's literature records (`paper:<evidence id>`); the others have a canonical name and up to 16 aliases, and the id `<kind>:<name in lower case with dashes>`.
- **Relations** are directed: `cites` (paper to paper), `introduces` (paper to what it introduces), `is-a`, `extends`, `improves-on`, `compares-with`, `applied-to` (method to task), `evaluated-on` (method to dataset, optionally with a setting such as 32K) and `measured-by` (to a metric). A kind and an ordered pair hold one relation, which carries up to 12 grounds.
- **A ground** is a quotation of one revision of an evidence record (record, revision, locator and the source's own words), completed project runs (the run, its collected metrics record, the words of the run's name naming each end, and a baseline run for a comparison), or an OpenAlex or Crossref citation record. A proposal without a ground does not exist in the API.
- **The store** is `.research/kg/relations.json`, `{version: 1, entities, relations, citations}` ordered by id, at most 2,000 entities, 5,000 relations and 8 MiB. It follows the marks file of [the annotations note](2026-10-01-knowledge-graph-annotations.md): zod-validated records, a writer lock and atomic rename, a damaged file read for what it holds and copied aside before it is rewritten, a newer format never rewritten. Every edit is a pure function from the stored graph to a new one, so a repeated proposal changes nothing.
- **Staleness is derived on every read** (`relationGraph`). A quote or run ground is outdated when its record is gone, recorded stale or at another revision than the one checked, the test claims get from `isOutdated`; a ground that relied on "we" lapses when the introduction it relied on stops being active; a citation lapses when a paper's record is gone. A relation is `active` while a ground is current, `stale` when all remaining grounds are outdated, and `rejected` when it or all its grounds are rejected. `regroundRelations` re-checks quotations against a new revision and moves those that still hold.
- **Corrections** reject a relation or one ground, with a reason, or restore it. The person's rejection stands against the agent until the person restores it; the agent may undo only its own. A person's proposal of a rejected relation restores it. Rejected relations stay stored so that they keep being honored.

## The grounding rule

A quotation must occur in a quotable chunk of the cited revision, or across two neighbouring chunks, after folding: compatibility decomposition (ligatures, full-width forms), lower case, no combining marks, and no whitespace, dashes, soft hyphens, zero-width characters or Markdown emphasis. PDF line-break hyphenation and lost or inserted spaces therefore do not stop a match, and the stored quotation is the source's own words. It must be 4 words (8 CJK characters) to 500 characters. A literature record with full text must hold it in its pages: the demo project's Longformer record carries a provider abstract that belongs to another work, and a quotation found only there is refused. The BibTeX chunk is never quotable, and a run's metrics are cited as a run.

The source's words, not the proposer's, must name both ends on separate words: by name, alias, or an acronym the same record defines in the form `long form (SF)` or `SF (long form)` (Schwartz and Hearst's matching). In a quotation of the paper that introduces one end by an active `introduces` relation, "we", "our" or "this paper" may name that end, and the ground records the introduction. `introduces` is quoted from the paper itself. Names match by token key, which folds case, accents, hyphenation, spacing and a conservative plural, and splits words at case changes (`withFlashAttention`, `QAFACT EVAL`); a short all-capital name such as `TRUE` or `LED` matches only capitals.

| kind | ends | needs |
|---|---|---|
| introduces | paper → method, task, dataset, metric | the paper's own record; propose, introduce, present, call, refer to this model as |
| is-a | same kind | is a, a kind of, such as, including, exemplified by, `X, a Y` |
| extends | method → method | extends, builds on, based on, principles of, variant |
| improves-on | method → method | outperforms, surpasses, better … than, improves on; not negated within three words; the improving method before the word, or after it in the passive (`outperformed by`, `被`) |
| compares-with | method → method | compared, baseline, versus, against, or an improvement word; or two runs sharing a metric |
| applied-to | method → task | both ends named |
| evaluated-on | method → dataset | evaluate, benchmark, results, achieves, accuracy, demonstrates, or an improvement word; a setting must occur in the quotation |
| measured-by | method, task, dataset → metric | both ends named; for a run, a metric it recorded |

A run ground needs a completed run with collected, current results, and for each end a word of the run's name or command that is one of its name keys or a content word of one of its names (`dynamic` in `ruler-32k-dynamic`). A person's quotation must exist and hold four words; the other rules become warnings stored with the ground, because the person is the authority on what a passage says.

## Citations

`createCitationFetcher(get, {pauseMs, sleep, now})` asks OpenAlex fifty papers a request, by DOI and then by work id, for `id`, `doi` and `referenced_works` only, and asks Crossref by DOI for the papers OpenAlex lists without references. Requests are sequential with a pause (OpenAlex allows ten a second without a key); no e-mail address is sent, as the literature client sends none. `citationQueries` lists the papers whose cached list is missing or older than a caller-given age. `applyCitationWorks` caches each list per paper and provider and records every citation among the project's papers; it matches all cached lists again, so a newly imported paper gains the citations older papers make of it without a request. Citations are weak evidence of how two methods relate, so a citation ground weighs 0.5.

## Queries

- **Neighbourhood** to depth 1 or 2: ring 1 by relation confidence, ring 2 by the sum over ring-1 nodes of the product of the two confidences, cut to at most 80 nodes and four relations per node. The layout hint is each node's ring, its place around the ring (by kind, strength and name; ring 2 under its strongest ring-1 parent) and `core`, the nodes of the largest k-core of at least 2 with the centre.
- **Paths**: Yen's k shortest loopless paths (k ≤ 5, at most 6 hops) over the undirected graph of active and, unless excluded, stale relations, each pair joined by its most confident relation; a hop costs 0.25 − ln(confidence), with a hop-limited Bellman–Ford search for each spur. Confidence is 1 − Π(1 − w) over a relation's sources (0.9 for a quotation of full text or a run, 0.8 for a provider abstract, 0.7 for a project file, 0.5 for a citation), halved while stale. Every hop returns its direction and its two weightiest grounds.
- **Gap matrix** of methods against tasks (`applied-to`), datasets (`evaluated-on`) or settings: a cell counts the distinct literature records, runs and project files whose grounds support the pair, the row's and the column's `is-a` subtypes included. Without a ground it reads the project's passages (pages of full-text records, abstracts otherwise, project files): `mentioned` when one passage names both, `absent` when both are named but never in one passage, `uncovered` when one of them is never named. Rejected grounds never count, and a cell reports how many were rejected.

## Wording of the gap matrix

The matrix describes the project's sources, never the field. The view's heading says 本项目文献中的空白 (gaps in this project's literature) with the coverage it rests on, such as 6 篇全文、2 篇仅元数据 (6 full texts, 2 metadata only). The states read: `reported` 本项目文献中有 N 篇报告 (reported by N papers in this project's literature); `project-only` 仅见于本项目的实验或笔记 (only in this project's runs or notes); `stale` 依据已更新，需重新核对 (its sources changed; check again); `mentioned` 有 N 处同时提到，尚未核实 (named together in N passages, not yet checked); `absent` 本项目文献中没有报告 (no paper in this project's literature reports it); `uncovered` 本项目文献未涉及，结论前请先检索 (this project's literature does not cover it; search before concluding). The view never says 没人测过 (nobody has tested it) or 领域空白 (a gap in the field).

## Evaluation on the demo projects

[knowledge-relations-eval.spec.ts](../../../../packages/research/workbench/tests/knowledge-relations-eval.spec.ts) runs the relations an agent would propose from the two demo projects against excerpts of their records as the PDF extraction left them, and labels each by whether its passage really states it. The same proposals against the complete records give the same outcomes.

| project | proposals | accepted | of them not stated | refused | of them stated |
|---|---|---|---|---|---|
| Sparse attention scaling study | 61 | 43 | 2 | 18 | 2 |
| 长文摘要一致性评测 | 21 | 15 | 0 | 6 | 3 |

Of the 58 accepted relations 56 are stated by their passage (97%), and 56 of the 61 stated relations are accepted (92%). The 24 refusals name what to change: quotation not found, with where the source departs from it (3: a paraphrase, another paper's record, and a footnote mark the agent dropped, `QAGS,1 an`), no word of the kind (4), one end not named (6), provider abstract only (1), reversed improvement (1), setting not in the quotation (1), introduction quoted from another paper (1), run of another method (1), run not collected (1), kinds that do not fit (2), a revision the record lacks (1), a citation offered as a quotation (1) and three words (1). The two false acceptances are what a lexical rule cannot see: "Longformer's attention mechanism is a drop-in replacement for the standard self-attention" passes as `is-a`, and "both Longformer and BigBird outperform models with smaller contexts" as a comparison of the two. The five false refusals are a speed-up and an is-a stated without a word of the kind, an anaphor ("on this dataset"), an unnamed reference ("the entailment-based metrics of Laban et al.") and the footnote mark.

OpenAlex lists references for 2 of the 8 sparse-attention papers (Longformer 53, BigBird 111; none for the 2024–2025 papers, and Crossref holds none for the two ACL DOIs), which gives the two papers' mutual citation. For the 31 summarization papers it lists all, giving 168 citations among them.

The best path from the project's own method `dynamic block selection` to `question answering` has 5 hops and confidence 0.59: its run comparison with full attention, NSA improving on full attention and being a sparse attention (NSA page 1), BigBird being a sparse attention applied to question answering (BigBird page 1); the third best path runs through one of the false acceptances. From QAFactEval to FactCC the paths are AlignScore comparing with both (0.81, the first through "our baselines"), both evaluated on the SummaC benchmark (0.729), the same through SummaCConv (0.583), and the citation from the QAFactEval paper to the FactCC paper (0.405). The project's own framing, `block-sparse attention`, has no relation: its only proposal lacked an is-a word.

Methods against context lengths over the complete sparse-attention records (6 full texts, 2 metadata only, 5 project files):

| method | 32K | 64K | 128K |
|---|---|---|---|
| dynamic block selection | project-only (2 runs) | absent | mentioned (1 passage) |
| fixed block sparse attention | project-only (1 run) | uncovered | uncovered |
| full attention | project-only (1 run) | mentioned (4) | mentioned (3) |
| MoBA | mentioned (9) | mentioned (1) | reported (1 paper) |

For dynamic block selection at 64K the matrix says that no paper in this project's literature reports it, where the prototype's banner claimed that almost nobody has tested it.

On a full-text project of 157 passages and 84,615 tokens, 61 proposals take 226 ms, the passage index 61–136 ms, two gap matrices 24–57 ms and five paths 2–3 ms; five paths are 11.6 KB of JSON, a neighbourhood of 16 nodes and 18 relations 13.6 KB, and a quoted relation about a kilobyte of the file.

## Alternatives considered

**A model judges whether a passage supports the relation.** It would accept paraphrase and catch the two false acceptances above, but its verdict is not reproducible, cannot be explained in the person's view, costs a model call per proposal, and is itself an ungrounded judgement; the lexical rule can be stated in one paragraph and fails in ways the evaluation lists.

**Fuzzy matching of the quotation (edit distance).** It would accept the dropped footnote mark, but it also accepts a changed number or a dropped "not"; folding removes only the differences PDF extraction introduces, and the refusal shows where the source departs.

**A context window around the quotation** in which the second end may be named. With page-sized chunks a window lets an unrelated sentence next to a naming one pass; requiring both names in the quotation forces the proposer to quote the sentence that states the relation, and 500 characters leave room for two sentences.

**Merging an acronym with its expansion automatically.** Acronyms collide (NSA, SA, QA); an acronym counts as the same entity only where the quoted record defines it, and `mergeSuggestions` lists acronym and one-letter pairs for an explicit merge.

**Embeddings for entity resolution.** They would join `dynamic block selection` and `dynamic sparse attention`, which the project treats as different; resolution stays exact on a folded key, and similarity is left to suggestions.

**Personalised PageRank or spreading weights for "how is A connected to B".** They rank nodes, not explanations; Yen's paths give each answer as hops with their grounds, and the logarithmic cost makes a path's confidence the chance that every hop holds.

**Storing staleness.** A stored flag needs every writer of the record to update the relation file; deriving it from revisions, as the evidence graph derives claim status, keeps one source of truth.

**Settings as entities.** A context length belongs to an evaluation, not to a method or a dataset; a setting on an `evaluated-on` ground keeps the binary model and is still checked against the quotation or the run.

**A record of literature searches for "never searched".** The record keeps no searches, and a query says little about which papers were read; whether the project's sources name a method or a column at all is observable and tells `absent` from `uncovered`.

**SQLite instead of a JSON file.** The graph is at most a few megabytes and is read whole for every query; a JSON file follows the marks file and needs no schema migration.

## Open questions

- Whether a person's quotation should meet the same rule as the agent's, instead of being kept with warnings.
- Whether the agent may merge entities, or only suggest merges, since no operation undoes a merge.
- How long a cached reference list is kept before it is fetched again, and whether fetching references needs the person's approval each time.
- Whether built-in graph papers may be nodes; their story fields are model-written summaries and cannot ground a relation.
- Whether the gap matrix's roll-up over `is-a` subtypes is on by default.
- Whether re-grounding runs automatically after a source's refresh, or only on request.
- Whether the agent's `measured-by` from a run covers every metric the run recorded or only those named.

## Acceptance criteria

- The research service exposes commands for the graph (read, propose, reject, restore, merge, entity aliases, citations, re-ground, neighbourhood, paths, gap matrix), validates their input with the exported zod schemas, refuses changes in example projects, and passes projects with their evidence text loaded.
- The knowledge tool gives the agent `relations-propose`, `relations-reject`, `relations-neighbourhood`, `relations-paths` and `relations-gaps`, with `RELATION_GROUNDING_RULE` in the tool's description and the describe functions' text in its results; a recorded-session snapshot pins one proposal round with an accepted and a refused proposal.
- The 关系 view draws a neighbourhood with the layout hint, shows the grounds of a selected relation with 打开原文 (open source), rejects one with 这条不对 (this one is wrong) and adds one with a quotation, finds paths between two nodes, and shows the gap matrix with the wording above.
- The three modules keep per-file 100% coverage, and the evaluation spec's counts hold.

## Risks

- The lexical rule accepts sentences that name both ends with a word of the kind without stating the relation (2 of 58 in the evaluation), and refuses relations stated by anaphor or without such a word (5 of 61); the person's rejection and addition are the remedy, and the cue lists are English and Chinese only.
- A quotation proves what a record says, not that the record is the paper: the abstract-only rule catches one known provider error, not a wrong record.
- Citation coverage for recent papers is poor (2 of 8 in the sparse-attention project), so citation paths are missing exactly where the literature is newest.
- `absent` and `mentioned` depend on the names and aliases the graph holds: a method named only in Chinese is `uncovered` against English literature until it gains an English alias.
- Merges cannot be undone, and an agent merge applies at once.
- The weights 0.9, 0.8, 0.7 and 0.5 order evidence kinds and are not calibrated against labelled relations; path order is sensitive to them only where hop counts and kinds differ.
- The timings come from a machine running other jobs.
