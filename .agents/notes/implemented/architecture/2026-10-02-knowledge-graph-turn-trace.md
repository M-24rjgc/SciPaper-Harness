# Agent Note: What a knowledge call touched, and the Conversation view

Status: implemented

English | [中文](2026-10-02-knowledge-graph-turn-trace.zh.md)

## Problem

The Knowledge tab could show the whole graph, but not what the agent used in the turn the person was reading. A tool card named the call (a recall, a listing of marks, a path search) and nothing more, so the person could not tell which patterns or papers a recall returned, which of their marks shaped it, or which relations a path search walked. Three views of the same turn had to agree on node identity (the card, the picture beside the conversation, and the marks list), and the picture had to stay true after the person changed a mark. The brief also asked for the used nodes to appear as chips inside the reply text.

## Decision

**The trace is a projection stored with the tool result, not with the research.** Each `research_knowledge` call computes a `KnowledgeTrace` (version 1) from the structured value it computed anyway: the recall result and the rows `KnowledgeBase.recall` returned, the marks list, the relation neighbourhood, or the paths page. The tool declares it as `output.presentationMeta`, which the tool runtime persists on the `tool/result` record as `meta` and the chat surfaces as `ToolResultNode.meta`. The model never sees it: the render function strips `knowledgeTrace` from the text it returns, and `meta` is not part of what is sent to the model. Nothing is written outside the session log, so a trace lives and dies with the call it describes, an old call without `meta` still renders as before, and replay needs no side file.

**Only the agent's calls leave a trace.** The person's own commands (the same actions run from the desktop) return no `knowledgeTrace`, so the picture shows what the agent touched and never what the person did.

**The shape.** A trace has an `action`, an optional `query`, `nodes` (`id`, `source` of `ai`, `project` or `relations`, `kind`, a label cut to 80 characters, a `use` of `pinned`, `recalled`, `skipped`, `centre` or `end`, and an `index` for the built-in graph's papers), `edges` (the relation id and kind, its two ends, who recorded it, and `walked` for a hop of a found path), the `marks` count with the honour switch when a listing read it, the number of `paths`, and `omitted`. It holds at most 40 nodes and 80 edges; the rest are counted in `omitted`, and an edge stays only while both its ends do. A node listed twice counts once at its first place.

**Ids are the ones the views already use.** A pattern or paper has the id of its mark, `<graph>:<kind>:<id>` (the same string the graph view uses as the node id), and a relation entity or relation has the id of the relation graph. The idea node is the only id the client makes up, and it is never stored. A trace therefore joins to the person's marks and to the relations view by string equality, and the client resolves each node's current verdict from the marks as they stand now. A trace records what the call used (`pinned`, `skipped`) and the client draws what is true now: a chip is struck through from the current marks, so it stays right after an undo or a later mark, and a chip is plain while the person has paused the agent's following.

**One registry symbol, because the host loads the engine twice.** `recall` returns the items it listed (graph, index, id, label, and the mark that moved them) beside the result, not inside it, so the model's JSON keeps its fields. This first used a module-level `WeakMap`, which worked in every unit test and returned nothing in the product: the bundled entry and the unbundled graph plugin each load their own copy of `knowledge.ts`, so the entry's map never held the plugin's results. The items now sit on a non-enumerable property under `Symbol.for('@deepseek-ai/dsh-research-workbench/recall-returned')`, which both copies read; JSON and object spread skip it. `builtinIndices`, which feeds the map's recall history, still uses a `WeakMap` and is open to the same fault; this note records it and does not change it.

**The Conversation view reads the chat, not the research.** The Knowledge tab gets the session's chat through the standard `useChat(selector, equal)` hook, looks at the last 12 turns, and takes the `research_knowledge` calls of the latest turn that has any (or the turn of the call a card opened it from). It folds their traces into one picture: the idea (the recall queries), the nodes, and the lines, where a line is walked (the idea to each pinned item of a recall, or a hop of a found path), plain (read), dashed blue (a relation the person recorded), or dashed grey (left out by a mark). The picture draws at most 14 nodes and says how many were left out. Its layout is a pure function of the nodes (the most connected node or the idea in the middle, rings, and fixed turns to avoid overlaps), so the same turn draws the same way every time. The person's marks, the switch that tells the agent to follow them and each undo are the commands the Domain map uses; the client keeps the marks in a small live store that the commands update, and an example research shows them and refuses every change.

**The 在图谱里看 link opens that call's turn.** A card of a traced call carries a link that opens the Knowledge tab on the Conversation view with `{ call, node }`, ringing the nodes that call touched; a card of a call without a trace keeps the 查看图谱 button it had. When the call belongs to an earlier turn the view says so and offers the way back to the latest.

**The chips are drawn in the tool card, and in the reply text from the same traces.** The knowledge tool card draws the nodes of its call as chips under the tool line (outlined for a pinned node, struck through for one marked not relevant, at most eight with a count of the rest), and each focuses its node in the Conversation view. The agent's own reply names items as `kg:` links that the renderer hands to the research feature, which resolves each id against these traces; [that decision](2026-10-02-knowledge-links-in-assistant-text.md) records the link scheme, the renderer extension and what the model is told.

**The tool lines say what was touched.** The line of a traced call reads the count from the trace (`读取你的 3 条标注`, `从你的想法出发，沿 2 条路径找基线`), and a call without a trace reads as it always did.

## Alternatives considered

**Store the trace in the research record or in a file.** It would outlive the call, need pruning, and give a second place for the same fact to go stale; with `meta` the session log is the only store.

**Rebuild the trace in the client by parsing the result text.** The text is the model's view and changes with the tool's wording; the structured value is already in hand on the host.

**Put what a call used in the model's result.** It would spend tokens on every call for a field the model cannot use.

**Record the person's verdict in the trace.** The chip would then disagree with the marks after the next change; the trace records what the call used and the client reads the verdict now.

**Draw the picture with a force simulation.** It differs between runs and cannot be tested to a fixed result; a deterministic placement can.

**A `WeakMap` keyed by the result object.** See above: it fails when the module is loaded twice.

**Parse chips out of the reply text.** The reply is the model's wording; matching names in it would guess, and a wrong guess would draw a chip for a node the agent did not use. A link the agent writes with an id it read is not a guess.

## Consequences

A knowledge call now carries up to a few kilobytes of `meta` in the session log. Sessions written before this change draw nothing in the Conversation view and keep their old card; the view's empty state says that nothing has been used yet.

The Conversation view is offered when the map or the relations plugin is on. The marks card needs the graph engine and the added relations need the relation graph, so each appears only with its plugin; a disabled plugin hides its part and nothing throws.

The client reads the session's chat inside the Knowledge tab, so the view follows each turn as it settles without a command. The cost is a selector over the last 12 turns on every chat change; it returns the same list when nothing changed, so it does not render again.

A reply's chips are only as old as the traces they resolve against: a session written before the traces were kept has none, and a link to an id no call of the conversation touched is plain text.

Pinned by `knowledge-trace.spec.ts` (the builders and their limits), the recall, tools and loader specs (the trace beside the real tools, stripped from the model's text), the client specs for reading, folding and laying out a trace, the Conversation view and the card, and by running the product against recorded conversations in both languages.
