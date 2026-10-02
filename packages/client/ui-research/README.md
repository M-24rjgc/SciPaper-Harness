---
description: "Research edition Web and desktop interface: the sidebar's research tree, where startup and 新研究 (New research) land, the entry screen's line, Try sentences and folder menu, header status, the composer's autonomy chip, the read-only right-sidebar research record with the mode, autonomy, the Now line, phases, check findings, decisions and tools, the right-sidebar tabs of the experiment board, the sources and claims, the figure gallery and the draw.io editor, the research tool cards in the conversation, the claim evidence sheet, experiment runs and research settings."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-research

English | [中文](README.zh.md)

## Summary

Shows research beside the conversation, and reports rather than steers. The sidebar lists the person's researches with their conversations, the examples and other folders. Startup opens the last research, or the one untouched draft 新研究 also opens. The person reads phases, findings and decisions, opens a claim's sources, follows runs on the experiment board, and stops a run after confirming. A composer chip sets the research's autonomy for every conversation. The assistant sets the mode and runs checks; nothing here starts work or opens a panel by itself. Mount it with `@deepseek-ai/dsh-research-workbench`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row in a client roster alongside the host-side service:

```yaml
- id: research-workbench
  name: '@deepseek-ai/dsh-research-workbench'
  config:
    maxSourceBytes: 67108864
    pollIntervalMs: 5000
    maxReviewPages: 12
- id: ui-research
  name: '@deepseek-ai/dsh-client-ui-research'
  config:
    hideDeveloperCells: true
```

`hideDeveloperCells` (default `false`) shadows the shell cells that are developer surfaces in this product: the composer's turn, step, token-rate and cache-hit pills, General settings' default permission, and the open-configuration-file action draw nothing, the research's autonomy chip takes the composer's access chip, the research's folder menu takes the entry screen's Workspace picker, and the research tree takes the sidebar's workspace browser. The Host half validates it and puts it into every page rendered by the Web or Desktop Host as the `__DSH_RESEARCH__` global, which the browser half reads when it applies; a client row's `config` reaches no browser plugin otherwise.

The plugin injects `remote`, `remote.research`, `remote.directoryPicker`, `remote.session`, `slots`, `locale`, `layout`, `sessions`, `workspaces`, `sidebarRight`, `uiWorkspace` and `uiSession` and `configForms`, through which it reads the `agent-preset-registry` settings namespace. It registers ui-workspace's entry policy, which acts only where the ui-workspace row sets `entry: policy`. Without the host row the Remote is absent and nothing registers.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Every surface reads one polled snapshot of projects, preferences and components, and finds the project of a session by its binding, else by the innermost project root containing the session's working directory, so every conversation in a project folder shows it. Commands go to the host Remote; a command that starts a host job settles when the job does. The autonomy chip sends `set-autonomy`, and the host applies the preset; the chip reads the conversation's `permissions` projection to name a preset typed by hand with `/permission`. A shadowing cell cannot give its seat back, so outside a research the chip draws nothing and `/permission` remains the way to the shell's picker. Every control that asks the host for something keeps its own pending state and failure line (`Action.tsx`); there is no plugin-wide busy flag or error banner. Nothing takes the main panel: the secondary tools are right-sidebar tabs of their own (`research-board`, `research-sources`, `research-gallery`), opened only from the research tab, a run card or the entry line, and a project file opens through the conversation on screen (`dsh-resource://file/session/<id>/<path>`), because the sidebar's file viewers read a file through a session.

The entry policy (`entry.ts`) lands, whenever nothing is selected, on the own research used last (not an example, not the draft, not removed from the list, its folder still listed) and its newest conversation that has started, or on its folder's blank conversation; with no research of the person's own it calls the host's `start-new`. At startup, a selection restored inside an example gives way the same way. Every open waits for the session list to carry the session and is dropped once a newer navigation (`layout.beginNavigation`) or selection superseded it. A move of the draft (`relocate`) archives its conversation before the host answers, so while a move runs a lost selection is the move's and `land()` does nothing; the move then carries the composer's draft and attachments through the folder seat's own `onPick`, captured when 更改位置… was chosen, and lands afterwards if nothing is selected.

The research tree (`ResearchTree.tsx`, rows derived in `treeValues.ts`) takes the sidebar's browsing seat at priority -1. The shell's workspace browser stays registered underneath, so its `sidebar.workspaces.directoryFlow` child stays declared for the folder pickers. A conversation belongs to the research it is bound to or whose folder holds its working directory, else to the research of the Workspace that lists it, else to that Workspace as a folder without a research (其他文件夹), else to no folder. Archived conversations, child sessions and visual-review reviewers are never rows. A research removed from the list (`archived`) is hidden with its conversations, and its folder does not count as a folder without a research. A row's dot is warn while a conversation of it waits on an approval, a plan review or a question, or a goal of it is blocked, and ongoing blue while one of its conversations, goals or runs moves; the header chip's dot reads the same (`activity.ts`). Clicking a research opens it on its newest started conversation, else its folder's blank conversation (never in an example). ＋ 新对话 reuses or creates the blank one. The menus send `rename` and `archive-project`, rename and archive conversations through the session and Workspace controllers, and make a folder a research through `create`. The search matches names and titles at once and conversation text through `sessions.search` after 250 ms. Which rows are open lives in the tree's own store, so it survives the collapsed rail.

Unsent conversations with text or attachments remain in the tree as drafts, with the first line of text or the attachment count. Saved text appears before its composer mounts; empty non-current conversations stay hidden. The untouched research draft remains a single New research row.

| Module | What it draws |
| --- | --- |
| `Hero.tsx` | The flask mark on the blank-session entry and the research tab |
| `Header.tsx` | The research chip in the conversation header: 模式待定 (mode not chosen), the mode alone (通用), `{mode} · {phase} n/m`, `{mode} · 已完成 ✓` or `{phase}已推迟`, after 示例 · in an example, with the research's dot; a click opens the research tab, or closes the panel while it shows that tab |
| `AutonomyChip.tsx` | The research's autonomy in the composer's access seat: `检查点 ▾` or `全自动 ▾` with a two-choice menu, `本对话：<preset>` while the conversation runs under another preset, `示例 · 只读` in an example |
| `Rail.tsx` | The research tab (研究记录): the research and its folder with 在资源管理器中打开; the mode as recorded, with who chose it and 想换模式？, which only adds a sentence to the draft; the autonomy (read-only); the 现在 (Now) line, which names what waits on the person or moves before the next step, with 跳过去 (Go there) or a sentence to suggest in the conversation; the phases and open issues of the host's `standing` with when it was checked; the three newest decisions; the 资料 · 论点 · 文件 · 实验 counts and the tools row, each opening a tab beside it; and a note when the conversation does not use the research assistant, or the settings keep another agent preset as the default, with 改回科研助手 |
| `activity.ts` | What is live in a research, for the 现在 line and the dots: its first conversation waiting on the person, the goals the snapshot carries (`goals`), its running conversations and runs |
| `presets.ts` | The research assistant's agent preset (the `agent-preset-registry` namespace's composition default) and a saved `selectedDefault` that replaces it for new conversations |
| `entry.ts` | The entry policy: where startup, a lost selection and 新研究 land, and the draft's moves to a folder or into another research |
| `EntryScreen.tsx` | The line under the entry screen's headline (`新对话 · {mode} · {phase} n/m · 研究记录`, `示例研究 · 只能查看`, and the entry screen's notices), and the two 试试 (Try) sentences above the untouched draft's empty composer, which only add to the draft |
| `FolderMenu.tsx` | The folder chip's menu: 保存在 <path>, 更改位置… for the untouched draft (the host's chooser, or a typed path where it has none), 在资源管理器中打开 where the host can, 换到另一项研究; and what a chosen folder turned out to be (already a research, inside one, holding files, among the examples) |
| `ResearchTree.tsx`, `treeValues.ts`, `treeStore.ts` | The sidebar's research tree: own researches by recent use with standing and dot, their conversations and ＋ 新对话, the 示例 and 其他文件夹 groups, row menus (重命名, 在资源管理器中打开, 移出列表, 设为研究…), the search, the collapsed rail's search button, and the 添加 SSH 工作区 (Add SSH workspace) dialog: host as an alias or user@host, an optional port, the remote path, and a login of key or ssh config (default) or a password that is held in the form until the host verifies it; a refusal is worded from the host's classification in the reader's language, and a host this computer has not seen asks "Trust this host?" with the key type and SHA-256 fingerprint before anything is recorded |
| `ClaimSheet.tsx` | One claim and every source under it, over the whole frame, looked up in its own project |
| `RunPanel.tsx`, `MetricsGrid.tsx`, `StopRun.tsx` | The runs this conversation submitted (their `sessionId`) above the composer, with their metrics, and stopping one after a confirmation; nothing on a blank conversation without an open run, and only 日志 and 看板 in an example |
| `Tabs.tsx` | The experiment board (实验看板) and figure gallery (配图灵感) tabs beside the conversation, each showing the research of that conversation, an example as view only; the tabs' chip titles |
| `Sources.tsx` | The 资料 (Sources) tab: each source with its authors and year (read from its reference record), DOI and what the research holds of it, opening the source or its full text in the sidebar's viewers; the claims with their state, each opening the claim sheet; opened for the claims, it scrolls to them |
| `Diagram.tsx` | The draw.io editor for a `.drawio` file address (ahead of the text viewer): it loads the research's artifact through `read-artifact`, registering a file the record does not know yet, saves through `save-artifact` against the revision it loaded, offers the component's install and loads the frame afresh after it; an example's diagram opens without saving |
| `Brand.tsx` | The product's mark and name in the native sidebar's brand row |
| `examples.ts` | Keeps every example conversation's composer inert and marks its block read-only, so Chat hides branching; supplies the exact v1 example file paths from its ledger and bundled companion files for in-app previews of plain-text references; the header chip, the research tab and the research tree mark examples |
| `ResearchToolView.tsx`, `toolCallValues.ts`, `traceValues.ts` | The keyed `tool.call.toolview` cards of the `research_*` tools, derived from each logged call and result: a row naming the tool and what the call did (`研究资料 · 导入 3 个文件`), with the raw call behind it and a failure in place; for `research_check`, a card with the scope, 通过 or 未通过 with counts, the first three groups of findings, each file a link when the report shows it on disk, and the check's words behind 详细信息. The record only names things (phases, check labels, routes) and gives the folder. A `research_knowledge` call is described from the trace the host stored beside its result (`traceValues.ts`: `读取你的 3 条标注`, `从你的想法出发，沿 2 条路径找基线`), shows the nodes it touched as chips (outlined when pinned, struck through when the person's marks as they stand now call them not relevant) and carries a 在图谱里看 link that opens the 对话 view on that call's turn; a call from before the trace was kept reads as it did, with 查看图谱 |
| `KnowledgeLink.tsx`, `linkValues.ts` | The research's cell of the keyed `conversation.message.link` slot for the scheme `kg`: a link such as `[MoBA](kg:ai:paper:42)` in a settled assistant reply is a chip only when a `research_knowledge` call of this conversation touched that exact id, a node or a relation, found in the traces of the loaded turns, newest call first. A pinned node's chip is outlined and a chip is struck through while the person's marks as they stand now call its node not relevant (plain while they are paused); a relation's chip is blue. A click opens the 对话 view on that call's turn with the node in focus. A made-up id, an id of another conversation and a malformed destination stay the link's plain text, with no link and no styling, and the destination is looked up by exact id and never followed |
| `Action.tsx`, `EmptyCell.tsx` | One control's own progress and failure line; the empty cell that shadows the composer statistics, the default-permission setting and the open-config-file action |
| `Board.tsx`, `BoardBlocks.tsx`, `LineChart.tsx`, `boardValues.ts` | The experiment board: runs in flight, machines, the agent's sections resolved against the live record, every run, and the line charts; an unconfirmed run is reconnected or dismissed from its card, whichever conversation submitted it; an example's board is its last read, read once, with no read controls and no run actions |
| `Gallery.tsx` | The figure gallery: filters, a grid of top-venue Figure 1s, and saving one as a reference under `figures/refs/`, except in an example. Loading more waits for the current request and continues the last successful query |
| `Knowledge.tsx`, `KnowledgeMap.tsx`, `EvidenceGraph.tsx`, `evidenceValues.ts`, `MemoryView.tsx`, `memoryValues.ts` | The Knowledge tab and the knowledge bundle's plugin page: a segmented control over the views of the knowledge plugins that are on (对话 beside the map or the relations, the domain map, 关系, 我的研究, 记忆 and the catalog explorer over the graph engine), opening on 对话 once the agent has used the graph in this conversation and otherwise on 我的研究 when the evidence graph is on. The 对话 view (`FollowView.tsx`, `FollowGraph.tsx`, `followValues.ts`, `Follow.module.css`) reads the knowledge calls of the conversation's latest turn (or of the turn of the call a card opened it from) through `useChat`, folds their traces into one small picture of the nodes the agent touched, lights the path it walked behind a switch, and lists the person's marks (pinned, not relevant, an added relation) with the switch that makes the agent follow them and an undo for each, through the same commands as the map; an example research can be looked at and never marked. The evidence view draws the question, the conclusions and their runs and literature in three columns with computed lines, lights the lines of the selected conclusion, and words its panel (where it is written, what supports it, what would invalidate it, the next step) from the dictionary; in a panel narrower than 440 px the columns stack. The memory view draws the researches on this computer, what each left and the next research in the same kind of computed three-column layout, with a switch per kind for what the next research carries, the failures and decisions the records hold, and 用这些开始新研究, which takes the entry the sidebar's 新研究 button takes. The map view (`KnowledgeMap.tsx`, `MapStage.tsx`, `MarksCard.tsx`, `mapValues.ts`) draws the 29,240 papers of the built-in graph on a canvas coloured by region, with the research's idea, imported literature, the agent's recalls and the person's marks over it. It hovers and selects papers, pans and zooms, searches the map, shows how crowded the map is around the idea, lets the person mark the closest work relevant or not and pause the agent's following of the marks, and hands a question about the idea or a region to the conversation's draft. Sparse areas are an optional layer, off at first |
| `RelationsView.tsx`, `RelationsGraph.tsx`, `RelationsPanels.tsx`, `RelationsEdit.tsx`, `RelationsGaps.tsx`, `relationsValues.ts` | The 关系 view of the Knowledge tab: the research's entities (methods, tasks, datasets, metrics, papers) and the relations between them, each resting on the source's own words. The graph draws one entity's neighbourhood within two hops at a fixed size from the host's layout hints (centre, core group, rings, slots) with no force simulation: a relation is a line with a button at its midpoint, a relation whose sources changed is dashed and marked 待核, and the path being shown is thick. Choosing a node, a starting point or a searched name or alias centres the graph there; the picture scrolls inside its frame. Beside it, or below it in a panel narrower than 440 px: 两件事之间怎么连起来 (the best path as a chain with each hop's quotation, the other paths folded away, the reasons there is none in words), 选中的关系 (who recorded it, every ground with the source's words, place and kind, opening the source, rejecting the relation or one ground with an optional reason, checking outdated grounds again), 补一条关系 (the person's relation, grounded in a quotation of an imported source at its current revision; a refusal shows the host's message), the rejected relations with 恢复, entities that may be one with a 合并 that first says a merge cannot be undone, 补充引用关系 (a host job that reports what it recorded and what failed), and 本项目文献中的空白, the methods against tasks, datasets or settings as the project's own sources cover them, which says what those sources hold and never that nobody tested a pair or that the field has a gap. A research without relations is told how they appear. An example research can be looked at, and every control that writes is disabled in it |
| `ResearchSettings.tsx`, `EnvironmentForm.tsx` | Where new researches are kept (研究存放位置), whether the tree lists the examples (显示示例研究), the researches removed from the list with 恢复 (已移出的研究), model roles, local component status with expandable LaTeX source, engines and path, bound environments |
| `Onboarding.tsx` | Skips the harness's first-run internal-testing notice |
| `contract.ts`, `format.ts`, `locales.ts` | The injected face, session-to-project resolution, formatting, and every string in `en` and `zh` |

All copy is locale-owned per the [locale-owned client UI copy](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.md) decision.

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the commands and records its controls write: the autonomy chip sends `set-autonomy`, the host applies `research-auto` or `workspace-write` to every conversation of the research, and autonomy lands in the host ledger that the agent reads with `research_project current`. Suggested sentences (the entry screen's Try sentences, a plot request from a finished run, the research record's 想换模式？ and 在对话中提出 sentences) are appended to the composer draft and reach the model only when the person sends them. 改回科研助手 (Use the research assistant again) removes a saved `agent-preset-registry.selectedDefault`, so conversations created afterwards compose from the research preset.

#### KV Cache effect

No direct invalidation; the permission and research-tool consumers own any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current constraints of the package, not a task backlog.

No runtime invariant companion is published because this package holds no independently observable relationship: it renders a snapshot the host owns, and every registration is an effect the slot registry already disposes.

- **No source text in the browser** — the host strips evidence text from every snapshot; the claim sheet shows the quote the host validated at write time.
- **Metrics arrive at exit** — a running experiment shows its progress line (or elapsed time when it writes none); its metrics appear once the run finishes.
- **No settings deep link** — the settings panel has no plugin-facing open API, so the research tab names where environments are managed.
- **No diagram export** — the draw.io editor saves `.drawio` files; exporting a diagram to PDF is not offered.
- **The board's width is a first-open suggestion** — the board, the gallery and the Knowledge tab suggest 560 px and the research and Sources tabs 320 px, which `layout.setInitialRightbarWidth` applies only while the panel has no width yet; after that a tab opens at the panel's width, and the dock's fullscreen gives it the whole frame.
- **No file actions in the files tab** — the shell's files tab has no seat for per-file actions, so no single file offers 在资源管理器中打开 (show in the file manager) or 用默认程序打开 (open with the default application); the folder menu and the tree show the research folder in the file manager.
- **A draw.io save can meet a stale revision** — a registered diagram edited outside the research tools since it was last recorded reads as a later revision on save, so the save is refused until the file is recorded again (by a compile, or when the agent registers it).
- **A typed folder where the host has no chooser** — under the browse directory picker (a remote browser, an SSH launch) 更改位置… and 研究存放位置 take a typed absolute path; the shell's in-app folder browser belongs to the Workspace picker the folder menu replaces.
- **Entry notices show on their own screen** — a 新研究 failure raised while a conversation that has started is on screen shows on no entry line; ui-workspace logs it.
- **No drag reorder in the tree** — researches and conversations are ordered by recent use; the shadowed workspace browser's manual order does not apply.
- **A conversation restored alone stays hidden** — a conversation of a removed research, unarchived by itself from the shell's archived-conversation list, belongs to that hidden research and shows nowhere until the research is restored.
- **Only loaded conversations report goals** — the dots and the 现在 line read goals through the host's goal service, which sees only loaded conversations; a goal in a conversation nobody has loaded shows nothing.
- **Runs recorded without their conversation are on the board only** — a run the desktop submitted, or one recorded before runs kept their conversation, has a card in no conversation; the board lists it and reconnects or dismisses it when its state is unconfirmed.
- **The research assistant is the deployment's default preset** — a conversation counts as using it when it composes from the `agent-preset-registry` row's `default`; a copy of that preset under another id reads as another preset.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Scoped checks from the repository root:

```sh
pnpm exec tsc -p packages/client/ui-research/tsconfig.json --noEmit --composite false --incremental false
pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-research
pnpm exec vitest run --config vitest.config.ts packages/client/ui-research
```

</details>
