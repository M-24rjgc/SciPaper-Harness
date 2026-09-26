# Agent Note: SciPaper Harness, redesigned around research and conversation

Status: implemented

English | [中文](2026-09-25-research-conversation-first-redesign.zh.md)

## Problem

SciPaper Harness is a research application built on the DeepSeek Harness Web shell, and it still carried the shell's developer product beside the research one. A reply offered Like and Dislike, and in the base bundle's `FEEDBACK_ONLY` telemetry mode a rating or `/feedback` released the conversation's Session log to `harness-telemetry.deepseeksvc.com`; the desktop application never set `DSH_TELEMETRY_DISABLED`. Every official DeepSeek model request also carried the whole Session log in its `dsh_session_log` field. The screens showed developer controls with no research meaning: a Cordis plugin badge, an agent-preset chip whose other choices strip the research tools, a trajectory tab, a terminal tab, a Session-log download, an Open In button, and the plugin and preset settings pages. The copy spoke for the shell as well: a running turn read 深度求索中... (DeepSeek's Chinese name), the entry screen asked for a 工作区 (workspace), the first-run dialog offered to configure the official DeepSeek model as if it were the product's own, and the window was titled Research Workbench, the product's earlier name. Beyond these, the entry screen, the creation paths, the right-hand rail and the agent's flow had grown into two applications with overlapping controls, several of which do nothing.

The owner approved a redesign in which the research is the only object the user creates, the conversation is the main screen, and the right panel only reports. It ships in ordered steps, each leaving the application working; this note records each step as it ships.

## Decision

### Step 1: no telemetry, feedback or developer controls

The Web bundle's patch (`packages/bundle/web-app/cordis.patch.yml`) turns the rows off; no shell code changes, and one shell manifest loses a dependency edge (below). The `web` profile and the Desktop Host compose this bundle over the base, so both run without them.

- **Telemetry and feedback.** `session-telemetry-otel` and `command-feedback` (base rows) are disabled by id; `message-feedback` and `ui-message-feedback` are inserted disabled. The composition therefore has no exporter, no `/feedback`, no rating buttons and neither the `messageFeedback` nor the `sessionFeedback` Remote.
- **No Session-log copy in model requests.** `session-log-deepseek` stays mounted with `enabled: false`. DeepSeek models remain an ordinary provider, but their requests carry no `dsh_session_log` field.
- **The Desktop switch.** The Electron shell starts the Host with `DSH_TELEMETRY_DISABLED=1` whatever the inherited environment says. The Host applies the switch as the `dsh` launcher does: when the value is non-empty and the telemetry row is composed, a last patch disables it, after every plugin bundle, the profile's own patch and the Desktop overlay (`desktopPatchLayers` in `apps/desktop-host/src/layers.ts`). Processes the agent starts inherit the variable.
- **Developer controls.** Inserted disabled: `session-log-download` (the Session-log download and `/export`), `open-in-app` and `ui-open-in-app` (already off on the desktop), `ui-cordis` (the Cordis plugin badge), `ui-agent-preset` (the preset chip on a blank conversation, the preset label in the header and the preset settings section), `ui-settings-plugins` and `ui-settings-plugin-inventory` (the plugin settings pages), `ui-sidebar-terminal` (the terminal tab) and `ui-trajectory` (the trajectory view, so the session header draws no view tabs).
- **Presets and autonomy.** Every conversation composes from `research`, the roster default. `research-auto` carries the display name `全自动 · Automatic` for the permission list.
- **The product title.** The research client build profile (`scripts/client-build-environment.ts`) sets `DSH_CLIENT_TITLE` to `SciPaper Harness`, which the page title and so the Desktop window title carry.
- **One manifest edge.** `ui-attachment` no longer lists `ui-trajectory` in `dsh.client.inject`. Its trajectory-image contribution waits on that slot through `ctx.slots.inject` and is optional, and the Web roster keeps no dependency edge to a package it does not compose (`assembly-bundle-roster.client.spec.ts`).

`packages/bundle/web-app/tests/research-edition-rows.ts` lists each disabled row once. `independence.spec.ts` beside it pins the composed rows, including that no enabled row names the telemetry endpoint, and `apps/desktop/tests/desktop-telemetry.spec.ts` pins the Desktop composition through `desktopPatchLayers`, the switch included. The research scenarios run the rows as shipped: `apps/web/tests/research-workbench.e2e.ts` (which also composes from the `research` preset), the example generator `research-demo.e2e.ts`, and the shipped-defaults test of `shipped-composition.e2e.ts`. The inherited Web scenarios keep composing the disabled rows, because the Playwright scaffold's `enableInheritedRows` defaults to true, so they and their goldens keep testing the upstream plugins as recorded. The assembled jsdom lane mounts the shipped roster, and only its trajectory image scenario composes the trajectory row again (`mountAssembledApp({ enableRows: ['ui-trajectory'] })`). The approved plan asked for the replay goldens to be updated instead; they are not (see the alternatives).

### Step 2: the shell's copy names the research, not a workspace or a company

The copy changes in the dictionaries of five shell packages; no key and no component changes. A locale namespace takes one dictionary per locale (`ctx.locale.register` refuses a second one), so no other plugin can replace these values. Chinese is written first and English follows it.

| Package | Key | 中文 | English |
|---|---|---|---|
| `ui-chat` | `chat.deepDiving`, the status line under a running turn | 思考中… | Thinking… |
| `ui-conversation` | `hero.headline` | 今天想推进什么？ | What shall we work on today? |
| `ui-conversation` | `placeholder.hero`, the composer of a blank conversation | 说说你的研究问题，或把论文、数据拖进来（/ 调用指令，@ 引用文件或对话） | Describe your research question, or drop in papers and data; / for commands, @ for files or conversations |
| `ui-conversation` | `placeholder.default` | 接着说，或把论文、数据拖进来（/ 调用指令，@ 引用文件或对话） | Keep going, or drop in papers and data; / for commands, @ for files or conversations |
| `ui-conversation` | `placeholder.workspace`, the composer while no folder is chosen | 先在左侧新建或打开一项研究 | Start new research or open one on the left first |
| `ui-conversation` | `hero.chooseWorkspace`, the folder chip and the composer's name while no folder is chosen | 选择研究 | Choose research |
| `ui-settings-models` | `onboardingTitle`, the first-run key dialog | 添加一个模型服务的 API Key 即可开始使用 | Add an API key for a model service to get started |
| `ui-settings-models` | `onboardingDescription` | 这里可直接填写 DeepSeek 的密钥；其他提供方可在 设置 › 模型 中添加。 | You can enter a DeepSeek key here; add other providers in Settings › Models. |
| `ui-sidebar-files` | `guide.title`, the files entry on the right panel's start page | 研究文件 | Research files |
| `ui-sidebar-files` | `guide.description` | 浏览这项研究的文件夹 | Browse this research's folder |
| `ui-sidebar-files` | `noWorkspace` | 这段对话没有研究文件夹。 | This conversation has no research folder. |
| `ui-sidebar-files` | `error.outsideWorkspace` | 这个目录在研究文件夹之外，侧栏不会读取它。 | That directory is outside the research folder, so the sidebar will not read it. |
| `ui-reference` | `crumb.root`, the first crumb of an `@` folder descent | 研究文件夹 | Research folder |
| `ui-reference` | `section.sessions`, the conversations section of the `@` menu | 对话 (unchanged) | Conversations |

- **The status line** no longer carries the name of the company behind the shell.
- **The first-run dialog** still offers only the DeepSeek credential, so its copy says what it asks for: a key for a model service, DeepSeek's here, other providers in the Models settings. It no longer presents DeepSeek as the product's own model.
- **The two composer invitations** are one sentence each; in Chinese the command hint sits in a full-width parenthesis. The English `@` menu calls its section Conversations, the word the invitations use.
- **One word for the folder.** Every string this step touches calls the research's folder 研究文件夹 / research folder and its files entry 研究文件 / Research files. The approved plan's step text named them 项目文件 and 项目文件夹, but its object model keeps 项目 (project) and 工作区 (workspace) out of the UI; the later steps that name the files tab use the same words as this one.
- **The files tab** keeps its chip name 文件 / Files.

The unit specs of the five packages pin the new values as literal text, in the language each spec renders. The browser goldens and locators that quoted the old values change on those lines only. Three inherited goldens (`subagent-conversation` and `subagent-interrupt`) also read a child session's access chip as `全自动 · Automatic`, the display name step 1 gives `research-auto`, where they had recorded `Custom`. The two `lifecycle-chrome` entry-screen goldens also take ui-research's current entry-screen paragraphs, which had changed after those goldens were recorded. The `onboarding-deepseek-config` golden of the key dialog changes the same way, but no run compares it: that scenario first waits for the upstream welcome notice, which ui-research shadows. `deepseek-messages-settings` and `onboarding-usable-provider` open the new dialog in the browser. `apps/web/tests/research-workbench.e2e.ts` reads the entry screen before any research exists (the headline, the Choose research chip and the fallback placeholder), the blank conversation of a research, and the composer under a settled reply in English, and the entry screen of a new research in Chinese.

### Step 3: the research surfaces stop destroying files and stop acting on their own

`ui-research` and the research host change; no shell code changes.

- **Saving never empties a binary file.** `writeArtifact` refuses `save-artifact` on a binary file before it reads or writes anything, whoever asks. A file is binary by its extension (images, PDF, archives, office documents, fonts, arrays) or, under any other name, when its first 8 KiB hold a NUL byte (`isBinaryFile`, `files.ts`). `read-artifact` answers such a file with `binary: true` and no text, and the file panel then shows no editor and holds 保存 off. 保存 is also held off until something was typed, so the default new-file path is never written empty.
- **Nothing opens or starts by itself.** The dock that opened the research tab whenever a research conversation mounted is gone, and so are the entry cards that did nothing, the promise row, and the claim and figure cards above the composer. The research tab opens only from the header chip. The header's 项目文件夹, 实验看板 and 配图灵感 buttons move into the tab's tools row, beside the research files.
- **The rail reports.** It loses the mode select, 运行检查, 推进流程 and the environment block, whose 已就绪 was never probed. The assistant sets the mode, runs checks and drives goals. The rail keeps the autonomy select until step 8 moves it to the composer. The 实验 row shows only when the route has an experiments phase or runs exist.
- **Every control keeps its own progress and failure.** The plugin-wide `busy` and `error` are gone: `useAction` (`Action.tsx`) gives each control its own pending state and a failure line beside it. `run` follows a host job until it settles, so a control stays pending as long as the work does and a failed job shows its message.
- **Runs.** 停止 asks 确认取消这次实验？停止后无法继续。 once (`StopRun.tsx`). A queued run reads 排队中 in neutral grey, not 运行中. 用它画图 appends its sentence to the draft instead of replacing what was typed.
- **Smaller fixes.**
  - The claim sheet looks the claim up in its own project, since claim ids are unique only within a project.
  - Opening a conversation waits up to five seconds for the session list to carry it, then opens the research folder's blank conversation; before, a card could throw `unknown session`.
  - Settings drop 主模型, which was saved but never read.
  - An environment earns no tag for a status that was never probed.
- **Developer cells shadowed.** Empty occupants take the composer's turn, step, token-rate and cache pills (`conversation.composer.dock#stats`), General settings' default permission (`settings.general.item#permission`, which the research's autonomy decides) and the open-configuration-file action (`settings.action#open-document`). They register only when `ui-research`'s `hideDeveloperCells` is true, which the Web bundle sets on its row. A client row's `config` reaches only the package's Host half, so that half validates it and puts it into every served page as the `__DSH_RESEARCH__` global, the way `client-connection` hands the browser its recovery timing; the browser half reads it when it applies. The Web e2e scaffold turns it off for the inherited scenarios together with the rows of step 1, so their goldens keep the pills.

### Step 4: one colour per meaning

Brand, button, business accent, success and link were one teal, so done, running, suggested and "act here" looked the same. The research theme (`ui-theme/src/styles/research.css`) now gives each meaning its own token, and the research surfaces use them by meaning.

| Meaning | Token | Light | Dark |
|---|---|---|---|
| Brand, and where to act: the flask marks, send, focus rings, selection | `brand-primary`, `state-business-*` (the shell's accent), `button-info-*` | teal `#15635f` | teal `#7bc4bb`, send `#3f8f86` |
| Verified by a check or the evidence | `state-success-*` | green `#3b7a1f` on `#e9f2e1` | `#98c46a` on `#26331d` |
| Work in progress | `state-ongoing-*`, a new alias (base `deepseek-450` / `-100`, dark `-400` / `-800`) | blue `#3366cc` on `#e8eefa` | `#8fb0e6` on `#26324a` |
| Needs the person | `state-warn-*` | clay, unchanged | unchanged |
| Done, pending, neutral | `label-secondary`, `label-tertiary`, `border-l4` | — | — |

- **Where each goes.** Running marks, progress bars, the rail's running tag and the board's live indicator use the ongoing blue. Done phases and finished runs are neutral; a running run's tag is neutral beside its blue mark. Focus rings and selection use the brand. Decorative marks (the claim sheet's thumbnails and quote rule) are neutral, and the sparkline takes the first chart colour.
- **Shell CSS.** The fork's sidebar override makes 新研究 tinted (the accent's tint with brand text) instead of filled, so the composer holds the one filled button. The sidebar and entry-screen flask marks move from `state-success` to `brand-primary` (`SidebarRoot.module.css`, `HeroShell.module.css`).
- **Contrast.** Every state colour carries text at 4.6:1 or more on its own tint and 5:1 or more on the page in light, and 5.8:1 or more in dark. The dark send button carries its white icon at 3.8:1.
- **Colour is never the only signal.** The OKLab check (`validate_palette.js`) passes for blue against teal (ΔE 18). Green against teal is 12.8, the most a green gets next to this teal. Green and clay are close under protanopia, and nearly equal under deuteranopia in the dark theme. Every verified mark therefore carries ✓ or words, every needs-you mark its words, and a running mark its label.

### Step 5: examples say they are examples, and nothing writes into them

The example researches (`<data home>/demo`, made by `research-demo.e2e.ts`) looked like the person's own work: they opened at start, their decisions read 你, and a conversation or a check could write into them.

- **The flag.** `isExampleRoot(root)` (`files.ts`) is the generator's own rule, a root inside `<data home>/demo`. `publicProject` and `projectBrief` add `example: true`; nothing stores it, so no example file or record changes. The generator runs its host under an isolated data home and writes the examples under another one, so the rule never matches while it builds them.
- **Host guard (defence in depth).** `execute` refuses every recording command on an example, from either actor, with `这是示例研究，只能查看 / This is an example research and is read-only`. The refusal comes before any slow work, so a refused compile never runs TeX in the example's folder. Reads work. A check runs and answers but is not stored. `board-update` and `board-refresh` are refused, and `board-view` never refreshes, so no board cache is written. `mutate` refuses an example's record whatever path reaches it, background observation skips examples' runs, and `create` returns an existing example unbound but makes no research or folder among the examples.
- **In the browser.**
  - The header chip starts with 示例 · in a dashed outline.
  - The research tab opens with a banner, 示例研究：随应用提供的演示，只能查看。 Answers stored as the user's read 示例作者, because they were never the reader's. The autonomy select is inert.
  - The sidebar lists examples after the person's own researches, each tagged 示例.
  - `guardExampleComposers` (`examples.ts`) keeps the composer of every conversation inside an example inert through `conversation.blocks`, with 这是示例研究，只能查看。点「新研究」开始你自己的研究。. A session holds one block, which `ui-model-selection` also sets and clears, so the guard raises its block again whenever another plugin clears it.

### Step 6: one record of progress

The rail's phases, the header chip and the agent's brief each read `lastCheck`, the last report whatever its scope, so a phase check replaced a full one and 检查通过 sat beside unfinished phases. Now `research_check` keeps one record of progress, and one host function says where the research stands.

- **Reports say what ran.** Each `CheckReport` carries `gatesRun`, and each phase its `unmet` keys: the keys of its unmet requirements (`requirementKey`, built from the conditions and unique within a phase), then `errors:<check>` for each deciding check with errors. The English `missing` lines stay for the model. A scope that names both a phase and a base check, such as spark-to-paper's `cite`, means the phase and runs its gates, which the report's filtering already assumed. A finding whose file is not on disk loses its file and line, so the CCFA link to a missing `submission/checks.md` is gone.
- **The merge rule.** `mergeProgress` (`progress.ts`) folds each report into `project.progress`: a phase moves only when the report ran every gate that decides it; each check the report ran replaces its findings; `full` comes only from scope `all`; a report for another mode or route starts afresh. `research_check` is the only writer: `export` still puts its own report in the package and records nothing. `lastCheck` is still written.
- **Read-time seeding.** A record without `progress` reads its scope-`all` `lastCheck` as its progress (`storedProgress`). The old English lines are matched to requirements by their message or by the reason text a check gives, and `N error(s) in …` to error keys, so the shipped examples show their phases and hints with no example file or record changed. The stored-report schema reads a missing `gatesRun` or `unmet` as empty.
- **Standing.** `standing(project)` derives the phases (done, current, pending or deferred, with the checkpoint flag and the pack's hints), the next phase and its first hint, `finished`, `checkedAt`, `changedSinceCheck` and the open issues grouped by check. The file time is the newest mtime outside `.research`, `exports`, `.git` and `node_modules`, cached for 30 s per root (`FileTimes`) and `unknown` past 5,000 files; unknown never counts as finished. `snapshot()` adds it to every project, as `publicProject` adds `example`, and nothing stores it. `projectBrief` takes its phases (`state`, `checkpoint`, and `missing` from the hints), next phase, hint and deferred phases from it, and adds `checkedAt`, `changedSinceCheck`, `finished` and `paperRoot`. `scripts/gen-cordis-catalog.ts` lists `ResearchStanding` with the other research record types that `types.ts` documents.
- **Mode packs.** Every requirement carries `hint: {en, zh}`, every gate `label: {en, zh}`, and every pack `paperRoot` (`paper` for general and CCFA, whose skills write `paper/main.tex`; `.` for spark-to-paper); all three are required. spark-to-paper's experiments phase declares `deferrable: experiments-deferred`, and the pack declares `reviewAgainst: "sections/*.tex"`, so assembling `main.tex` leaves the review current. Base checks carry built-in names (`CHECK_LABELS`).
- **Decision keys.** `record-decision` takes an optional `key` slug and stores it on the decision. A deferrable phase is deferred while it is not done and a decision carries its key. A deferred phase never counts as done; a phase whose own check passes is done, deferral or not.
- **In the browser.** `Rail.tsx` draws the standing: a neutral ✓ for done, a ring in `brand-primary` on the current phase, a hollow mark for pending, 已推迟 in the warn colour, 开始前会先问你 on checkpoint phases, the current phase's hint in the pack's words, and 检查于 {relative time} with 检查后有改动. 待处理 lists at most three groups named in the reader's language (引用 · 2 个错误); a group opens its file only when the host found it on disk, and the checks' own words sit behind 详细信息. `standingText` reads `{mode} · {phase} {done}/{total}`, `{mode} · 已完成 ✓` when finished, `{mode} · 实验已推迟` once nothing before the deferred phase is left, and `{mode} · 待复查` when every phase is done but the paper is not finished.

### Step 7: the agent chooses the mode, names the research and keeps one goal (host, persona and skills)

The record said every research's mode was the user's choice, `set-mode` deleted the reason and recorded no decision, `current` failed outside a research, `create` could make a research in any folder, and nothing told a second conversation that a goal already ran. The host, the persona and the skills now carry the flow of section 4 of the approved plan.

- **A mode is chosen, not assumed.** `createProject` passes a mode to the record only when the caller named one, so only then does `newProject` write `modeSetBy: user`. A research created without a mode is `general` with `modeSetBy` unset: the mode is not chosen yet.
- **`set-mode` records the decision.** It takes `decidedBy` (`user` or `agent`, the caller when absent), sets `modeSetBy` from it and appends a decision with key `mode`: the question 模式与路线, the answer `<mode>` or `<mode> · <route>` in ids, and the reason as its rationale. It replaces `modeReason` only when it is given one. A changed mode or route replaces `progress` with an empty record for the new pair, so phases checked under another mode never return through a stored `lastCheck`.
- **`rename {title}`** sets the title, clears `untitled` and gives the folder's Workspace the same title unless another Workspace already has it (Workspace titles are unique, `workspace-controller/commands.ts`); the result then says the folder keeps its earlier name. `untitled` is a new optional record field for a placeholder title the product chose; the draft research of step 9 sets it.
- **Runs name their conversation.** `execute` takes the calling session, and `submitExperiment` records it on the run as `sessionId`. Runs from the desktop and runs recorded earlier carry none.
- **`activeGoals(project)`** reads the goals through the goal service: it walks `ctx.agents.list()`, keeps the top-level sessions whose working directory's innermost research is this one, and asks `ctx.goals.get(agent)` for each. A complete goal, a session without one and a goal log that fails to replay are skipped, and the rest come ordered active, blocked, paused, newest first. The service now injects `agents` and `goals`, both host-plane services of the base bundle. A conversation that is not loaded is not seen, because the goal service reads a loaded session's projection.
- **The tool.** `current` never fails: outside a research, or in a conversation without a folder, it returns `{project: null, hint}`. `create` makes only the conversation's own folder a research; another `root` is refused with a message telling the agent to ask the user to use 新研究 and 更改位置, and a folder inside a research returns that research's brief instead of a nested one. `set-autonomy` is described as for when the user asks in words.
- **The brief** adds `modeChosen`, `modeSetBy`, `routingSettled` (the user chose the mode, or a decision with key `mode` exists), `activeGoal` (the reader's own goal first, else the first the service reports, with `thisConversation` and a count of other conversations holding one) and `untitled`, and its guide says when the mode is not chosen, when routing is settled, where a goal already runs and when the research still needs a title. The pack's skills are named for when a phase's work starts, not for a question. The checkpoint phases were already in the brief (`phases[].checkpoint`, "Checkpoint before: …").
- **The persona** (`presets/research/agent.cordis.yml`) opens with the text of plan section 4.8 and keeps the integrity and hands paragraphs. Its last bullet, on importing attached files directly, waits for step 8, which lets the attachment store be imported.
- **The skills.** `research-modes` holds the one table of modes and routes, the rule for a mode not chosen, and says `set-mode` records the decision and settles the route. `ts-paper` and `ccf-pipeline-orchestrator` route again only while `routingSettled` is false and create a goal only when `activeGoal` shows none. `ts-paper-experiment` and `running-experiments` record `experiments-deferred` when nothing can run and report the paper stays in proposal form. `results-ingest` names `results.facts.json` only, `paper-writing` follows the brief's `paperRoot`, and `ccf-common` calls `ccfa.yaml` the skills' working notes and `research_check` the record of where the research stands. `references/upstream.md` and the NOTICE files are unchanged.
- **The generator and the e2e.** The example generator's scripted `set-mode` calls carry the reason (and `decidedBy: user` where the user chose at a checkpoint) and no longer follow with their own mode decision. The research Web e2e asserts that the creation dialog, which names the mode its select holds, records that mode as the user's, and that `set-mode` recorded the user's decision. Until step 9 removes that dialog, only researches the agent or the example generator creates without a mode start with the mode not chosen.

The model-visible text left from step 1 changes too. The Web bundle's `system-prompt` row sets `includeHarnessIdentity: false`, so the agent is introduced by its persona alone. `harness:source` (`app-boot`), `app:web-surface` and the `DSH_WEB_URL` description (`web-app`) have no configuration field for their text, so their wording changed in place: "the implementation checkout of this application", "this application's Web GUI", "the Web GUI serving this session". The four Web system-prompt goldens, the `fresh-round-trip` Web-context golden and the Web-surface golden change on those lines only, and `replay-round-trip.e2e.ts` expects the persona as the first paragraph. `independence.spec.ts` pins the row.

### Step 7: research tool calls read in the reader's language (ui-research)

The research tools' calls fell back to the generic tool row, which showed the wire name and the first string argument, so a check read as `research_check · cite` and its report as raw JSON. `ui-research` now registers a keyed `tool.call.toolview` card for each research tool; no shell code changes.

- **Where a card's facts come from.** `toolCallValues.ts` derives everything from the logged call and result: the call's state (running, answered, failed, stopped), its arguments, and the tool's JSON value, which every research tool returns as one text block. The research record only names things: a phase by its pack label in the mode the report ran under, a check by the label the project's `standing` gives it, a mode and route by their pack names; anything else goes by its id. The Host `presentCall` titles stay in `tools.ts`; the Web Client never read them.
- **A row per call.** `ResearchToolCard` reads as the tool's name and what the call did (`研究资料 · 导入 3 个文件`, `研究记录 · 设定模式：spark-to-paper · 从实测结果开始`) in the tool rows' 24px measure with the flask mark. Every action of the ten tools has its phrase; an action this build does not know reads `执行 <action>`, and a call whose arguments are still incomplete shows the tool's name alone. The raw arguments and result sit behind the row's disclosure; a failure shows the host's reason under the row (`没能完成：…`), and a stopped call says 已中止.
- **A card per check.** `ResearchCheckCard` reads `研究检查 · {scope} · 通过 | 未通过 · n 个错误 · n 个提醒`. A check that found no error and still did not pass says why: `n 项要求未满足` for a phase scope, `n 个阶段未完成` for scope all. It lists the first three groups of findings by check, errors first, each with the first file it names, and keeps every finding and the unfinished phases' own lines behind 详细信息. A file opens in the right sidebar only when the report carries `gatesRun`, which marks a host that drops missing files; the examples' reports predate it and show their files as text. Only a clean report gets the green ✓ (`state-success`); one that did not pass takes the warn dot and 未通过 in `state-warn`. A result that is not a report falls back to the row.
- **Tests.** `tool-call-values.client.spec.ts` feeds the example generator's calls and reports in the host's old and new formats, and checks against the Host's own tool definitions (`registerResearchTools`) that every registered research tool has a card and every declared action a phrase. `research-tool-view.client.spec.tsx` renders the cards; `plugin.client.spec.ts` checks the ten registrations.

### Step 8: autonomy is every conversation's permission, and attached files are the person's consent (host and persona)

Autonomy was a line in the brief and a rail select that sent `/permission` to the rail's own conversation. Other conversations of the research, including ones a goal drove, kept whatever preset they had. Under 全自动 even a PDF the person had just attached was declined: the attachment store lives inside the product home, and the import refused that whole folder tree.

- **The host applies autonomy.** `AUTONOMY_PRESETS` (`schema.ts`) maps `checkpoints` to `workspace-write` (an escalation asks) and `automatic` to `research-auto` (an escalation is declined). The service injects `permissionPresets` and `sessions` and sets the mapped preset with `ctx.permissionPresets.set` on every live session of a research. That is the session bound to it, else each session whose working directory's innermost research it is, the client's `sessionProject` rule; one `innermost` helper now serves `projectAt`, `activeGoals` and this lookup. It applies on every `set-autonomy` from either actor, even one that keeps the value. It also applies after a project is created, since the bound session went live before the record existed, when the service starts, and in its own `session/created` listener for each session that becomes live.
- **After the default pin.** The permission service registers its `session/created` listener, which pins the settings default, in its constructor. The research service injects it, so it starts later, and Cordis dispatches listeners in registration order. The order matters when the person's default differs: run first, the research preset would find nothing to change and the pin would then write the default.
- **Left alone.** Sessions of an example get no permission event. Delegated children (`origin: subagent`) keep the approval their delegation pinned to `never`. Sessions outside every research are not touched. A failure to set one session's preset is logged, not thrown, because a throw in `session/created` refuses the session. The service does not load unless the permission row configures both presets; the web-app bundle does.
- **What the model sees.** `set` appends `permission/preset` (log-only), `approval/policy`, and `sandbox/mode` only when the sandbox changes. The approval sentence of each request's runtime context is folded from that log. No switch notice is injected, unlike the `/permission` command. No shared replay scenario holds a research, so no golden changes. The example generator already set `research-auto` on its automatic project and now finds it set.
- **Attached files.** `isAttachment` (`files.ts`) accepts a path below `<data home>/attachments/v1/files`, the layout of `@deepseek-ai/dsh-attachment-local`'s `storedFilePath`, that still lies there once links are resolved. `assertImportable` lets such a path through. It still refuses the rest of the product home (credentials, `file-objects`, the files folder itself, a `..` escape, a link out of the store) and the key directories. The approval hook asks for no such path; other paths outside the project still ask under checkpoints and are declined under automatic. The `research_evidence` `paths` description says so.
- **The persona** gains the last bullet of plan section 4.8: files the user attached can be imported directly, and for other paths outside the research folder the agent asks the user to attach them. No golden quotes the research persona; `preset.spec.ts` pins the bullet.
- **Tests.** `loader.spec.ts` covers creation, a nested research, a bound session, sessions that open later, a subagent, sessions outside every research, a failing session, both actors' `set-autonomy`, examples, a restart and the load refusal. `research.spec.ts` imports an attached file and folder and refuses the rest of the home. `tools.spec.ts` covers the approval hook. The research Web e2e shows that a conversation nobody opened becomes `research-auto` as it goes live, and that a change reaches it and the bound conversation.

### Step 8: autonomy is changed in the composer (ui-research)

- **The chip.** `AutonomyChip.tsx` takes the composer's access seat (`conversation.input.permission`, priority −1). In a research conversation it reads `检查点 ▾` or `全自动 ▾`, and its menu (the ui-primitives `Menu`) offers 检查点 — 关键决策先问我 and 全自动 — 不打断我，越权操作直接拒绝 under 自主程度，用于这项研究的每段对话. A choice sends `set-autonomy` through the plugin's `run`, and the host applies the preset to every conversation of the research; the browser sends no `/permission`. While the command runs the chip names the choice and holds itself; a failure shows beside it.
- **A preset typed by hand.** The chip reads the conversation's `permissions` projection. While it differs from the autonomy's preset (checkpoints → `workspace-write`, automatic → `research-auto`), the chip reads `本对话：<preset>` in the warn colour, naming the two autonomy presets by the autonomy and the others 仅可查看, 完全权限, 自动审查 and 自定义; any other preset shows by its key. Choosing an autonomy then sends `set-autonomy` even when it is the one recorded, so the host applies it again; without a difference, choosing the autonomy in force sends nothing.
- **Examples.** The chip is the static text 示例 · 只读.
- **Outside a research the chip draws nothing.** The renderer draws a single cell's lowest-priority entry, and an entry leaves its cell only by crashing, so the shell's chip cannot show through. `/permission` still opens the shell's picker there.
- **Gated with the developer cells.** The chip registers only under `hideDeveloperCells`, so the inherited Web scenarios, which turn the flag off, keep the access chip and their goldens.
- **The rail.** The autonomy select, its `/permission` line and the injected `command` are gone. The rail and the project's file panel show 自主程度 and `检查点（在输入框下方更改）`; an example shows the name alone.
- **Tests.** `autonomy-chip.client.spec.tsx` covers the chip and `plugin.client.spec.ts` its registration under the flag. The research Web e2e changes the autonomy from the chip, waits for the conversation's `research-auto`, types `/permission read-only`, sees `This conversation: Read only`, and brings it back by choosing Automatic.

### Step 9: startup and 新研究 go to the research's entry policy; the brand row is identity (shell)

Two shell packages each gain one configuration field (S1, S2). Both default to the upstream behaviour, and the Web bundle's patch sets the research edition's values.

- **S1, `ui-workspace` `entry`.** `Config.entry` is `recent` (the default, the upstream rule) or `policy`. `UiWorkspace.setEntryPolicy({ land, startNew })` registers one policy and returns its disposer; a second registration throws, and a stale disposer leaves a newer policy registered. Under `policy`:
  - `land()` replaces the recent Workspace's connection once the Session and Workspace lists are ready with nothing selected. It also runs after `clearArchivedCurrent` clears an archived selection, after the current Session leaves the list, and when a policy registers while nothing is selected. It does not start while another policy call runs or while the fallback connects, and does not run again after a call settled with nothing selected, so a policy that selects nothing cannot loop.
  - The unscoped `startSession()` (the sidebar's 新研究) runs `startNew()`; `startSession(workspaceId)` still reuses or creates that Workspace's blank Session.
  - A startup in which no policy registers within 5 s of both lists being ready (`ENTRY_POLICY_WAIT_MS`) uses the `recent` rule. A policy that registers later still takes the unscoped action and every later lost selection.
  - A throw or rejection from either call is logged as `entry policy land failed:` or `entry policy startNew failed:` and never rejects into the caller. A selection restored from the previous visit is kept, as under `recent`. Under `recent` a registered policy is kept and never called, so the inherited scenarios are unaffected by the policy ui-research registers.
  - The policy opens only listed Sessions (`sessions.open` refuses an unlisted id). Neither call carries a cancellation signal.
- **S2, `ui-sidebar` `brandAction`.** `new-session` (the default) keeps the expanded brand row as a second New Session button. `none` renders the same mark and name in a plain `div` (`.brandPlain`, default cursor) that is not `aria-hidden`, so the name reads as text while the mark stays decorative.
- **Delivery to the browser.** A client row's `config` reaches only the Host half, which was an empty `apply` in both packages. Each Host half now validates its `Config` and, for the non-default value only, pushes a `webserver/index-inject` global (`__DSH_WORKSPACE__ = { entry: 'policy' }`, `__DSH_SIDEBAR__ = { brandAction: 'none' }`), as `client-connection` and ui-research's `__DSH_RESEARCH__` do. The browser half reads the global when it applies and treats its absence as the default, so a default row serves a byte-identical page and the jsdom assembled lane runs the defaults.
- **The Web bundle** sets `entry: policy` on `ui-workspace` and `brandAction: none` on `ui-sidebar`; `independence.spec.ts` pins both. The Web e2e scaffold's `enableInheritedRows` puts both back to their defaults for the inherited scenarios, beside `hideDeveloperCells: false`.
- **One inherited JSDoc line.** `ui-layout`'s `setInitialRightbarWidth`, a fork addition, gains its `@param`; `gen-cordis-inspect-catalog` refused to run without it.
- **Tests.** `workspaces-service.client.spec.ts` covers `land()` at startup, after an archive and after the current Session leaves the list; `startNew()` for the unscoped action and the scoped action unchanged; the 5 s fallback and its end; a policy registering during the wait and after a fallback; no `land()` while a call runs; logged failures; one policy at a time and a stale disposer; and `recent` ignoring a registered policy. `apply.client.spec.ts` in both packages covers the Host half's global and the browser half's reading of it, and `sidebar-root.client.spec.tsx` the plain brand row. Every existing spec of both packages, and the startup and sidebar Web e2e files, pass unchanged.

### Step 9: 新研究 opens one untouched draft research (host)

- **The research home.** New researches go to `<research home>/<yyyy-mm-dd>-<n>`: the `researchHome` preference (设置 › 科研 › 研究存放位置), else the service's `researchHome` Config field, else `<profile home>/SciPaper` (`resolveResearchHome`, `src/drafts.ts`), outside Documents, which OneDrive often syncs, and ASCII for TeX. `configure` refuses a relative path and one among the examples, and the snapshot carries the home in effect as `researchHome`. The Web e2e scaffold pins the Config field inside its temporary folder, so no scenario writes the developer's profile.
- **The draft.** `start-new`, the desktop's command through `execute`, answers `{project, sessionId}`: the untouched draft, or a new research at the next free `n` with its record (`untitled`, titled 新研究, general with `modeSetBy` unset), its folder's Workspace named after the folder, and one blank conversation. It runs on the same one-at-a-time chain as project creation, so two clicks make one draft. It never reuses or makes a draft among the examples, inside another research, or in a system folder.
- **Untouched.** A research is the draft (`draft: true`, derived in snapshots and in these commands' answers, never stored) while its record holds nothing but the placeholder title and the autonomy (`blankRecord`), every conversation of it is blank in `ctx.sessionController.list` (no turn started), its folder holds only the empty scaffold folders, and it is not an example. A research found holding a started conversation is remembered, because a conversation never becomes blank again.
- **Relocate.** `relocate {projectId, root, confirmNonEmpty?}` answers `example`, `existing` (that research and its bound conversation), `nested` (the draft's own folder included), `needs-confirm`, or `moved`: the research is created at the folder with the draft's autonomy and a blank conversation, and the draft is discarded.
- **Discard.** `discard-draft` and a move archive the draft's blank conversations, delete its folder's Workspace registration and its record, then remove each scaffold folder that is still empty, and the root when the draft created it, which the record's `createdRoot` says. A folder that holds anything stays; one that cannot be removed is logged.
- **The agent.** `execute` refuses the three commands to the agent. `research_project` gains no action, and its `create` still only adopts the conversation's own folder.

### Step 9: startup, 新研究 and the entry screen go to the research (ui-research)

- **The entry policy.** `entry.ts` registers `land` and `startNew` with `uiWorkspace.setEntryPolicy` for the plugin's life. `land()` reads the record again and opens the person's own research used last (not an example, not the untouched draft, its folder still in the Workspace list) on its newest conversation that has started: listed, top-level, not archived, not blank, not a visual-review reviewer. When no conversation of it has started, it opens the folder's blank one. A research counts as used when a conversation of it or its record last changed. With no research of the person's own it calls `startNew()`; when the record cannot be read it says why and creates nothing. `startNew()` sends `start-new` and opens the draft's conversation. When that conversation is already on screen, the entry line says 这里就是一项新的研究，直接说说你的问题。 for four seconds.
- **Late opens.** Neither call carries a signal, so every open starts a `layout.beginNavigation()`. It opens only while that navigation is current, the selection is still the one it started from (or none), and the plugin runs. It opens only a session the list carries, waiting up to five seconds; otherwise the entry line says why.
- **Startup never keeps an example.** Once both lists are ready and the record has arrived, a selection restored from the last visit that lies in an example gives way to `land()`. This runs once per registration; an example the person opens later stays.
- **The draft's moves.** 更改位置… sends `relocate` with the folder seat's `onPick` captured when the item was chosen. `moved`: the flow waits until both lists carry the new folder's conversation, then calls that `onPick`, which moves the composer's draft and attachments there, and waits for the selection to arrive. The host archives the draft's conversation before it answers, so ui-workspace clears the selection and calls `land()` meanwhile; while a move runs, `land()` does nothing, and a move that ends with nothing selected lands. `existing` offers 打开它 and `nested` offers 打开「X」: the draft is carried into that research's blank conversation, then `discard-draft` removes the draft. `needs-confirm` offers 就用这里, which repeats `relocate` with `confirmNonEmpty`. `nested` inside the draft's own folder and `example` offer another folder. A failure shows on the entry line.
- **The folder menu.** `FolderMenu.tsx` takes `conversation.hero.workspace` at priority −1. The shell's `WorkspaceChip` stays the chip and names the Workspace: the draft's folder, and after `rename` the research's title. The menu reads 保存在 <path>; 更改位置… on the untouched draft only; 在资源管理器中打开 when `session.canOpenWorkspacePath()` answered yes; and 换到另一项研究 › with the person's other researches, newest first, which carries the draft through `onPick` and leaves the draft in place. A chosen folder's outcome appears in a second menu at the chip. Where the host has no chooser (`directory-picker/unavailable`, the browse picker), a dialog takes a typed absolute path. The menu registers under `hideDeveloperCells`, with the developer cells, so the inherited Web scenarios keep the shell's picker.
- **The entry line and 试试.** `EntryScreen.tsx` fills `conversation.hero.welcome`: nothing for the draft or a folder outside every research; `新对话 · {mode} · {phase} n/m · 研究记录` for a blank conversation of a research, where 研究记录 opens the research tab; `示例研究 · 只能查看` for an example; and any notice raised on that screen. Above the composer (`conversation.input.dock`), while the draft's conversation is blank and nothing is typed, 试试：「…」「…」 adds `heroOpeningMaterials` or `heroOpeningIdea` to the draft and sends nothing.
- **Removed.** The 新建项目目录… pill (`research-create`), the composer's folder button (`research-new-project`), `NewProject.tsx`, their dialog styles, and their keys. `ResearchProjects` stays until step 10; the Workbench keeps its own creation form until step 11.
- **Settings.** 设置 › 科研 opens with 研究存放位置: the folder in effect (`snapshot.researchHome`), 默认位置 while the preference is unset, 更改… (the host's chooser, or a typed path) and 恢复默认, each saved through `configure`.
- **Faces.** `pickDirectory` answers a `FolderPick` (`picked`, `cancelled`, `unavailable`), and the entry seats share a `ResearchEntryInjected` face. The plugin also injects `remote.session` and `workspaces`.
- **Tests and goldens.** `entry.client.spec.ts`, `entry-screen.client.spec.tsx` and `folder-menu.client.spec.tsx` cover the flows and seats; `plugin.client.spec.ts` the registration, the startup example rule, the move guard and the late-open guards. The research Web e2e lands on a draft under the scaffold's pinned research home, moves it with its composer text to a typed folder, renames it, reuses the draft for 新研究 and shows its notice, asks about a folder that holds files, and carries a typed question into an existing research, discarding the draft. The composer's folder button is gone from 76 inherited ARIA goldens, and the entry pill from the two `lifecycle-chrome` entry-screen goldens, on those lines only.

### Step 10: 移出列表 archives a research's conversations, and content search opens at the first search (host and bundle)

- **`archive-project {projectId}`**, the desktop's 移出列表 (Remove from list). It archives each top-level conversation of the research that is not archived yet: the one bound to it, and each working in its folder and in no research nested there. It uses `ctx.workspaceRegistry.archiveSession`, the same archive the shell's archive action and the 已归档会话 settings page reach through the `workspaces` Remote; the session controller has no archive of its own. Before the first conversation is archived, the record stores `archivedAt` and the ids it archives (`archivedConversations`, absent when none). Delegated children (`origin: subagent`) are left alone, and nothing on disk changes. Repeating it keeps `archivedAt` and archives any conversation added since. It is refused for an example (`EXAMPLE_READ_ONLY`) and for the untouched draft (`还没开始的新研究不能移出列表 / The untouched new research cannot be removed from the list`).
- **`unarchive-project {projectId}`**, 恢复 (Restore), unarchives `archivedConversations` and then clears both fields, so a restore cut short can be repeated. A conversation the person had archived before the removal stays archived, and a research in the list is answered unchanged.
- **The person's commands.** Both commands run on the creation chain with the draft commands, so a research is never archived while it is the draft. `execute` refuses them to the agent; `PERSON_ONLY` names all five commands (`isPersonCommand`).
- **Derived flag.** `publicProject` adds `archived: true` while `archivedAt` is set; it is never stored.
- **What skips a removed research.** Background observation (`refreshRunning`) skips its runs until it is restored; `experiment-wait` and `experiment-refresh` still observe a run when asked. `blankRecord` requires no `archivedAt`, so a removed research is never the draft that snapshots mark and `start-new` reopens.
- **`showExamples`.** An optional boolean preference, saved through `configure` like `researchHome`; absent reads as true.
- **Content search (D17).** The Web bundle's `session-query-sqlite` row sets `openAt: first-search` and restates `path: ':memory:'`, the base row's other key. `independence.spec.ts` pins the whole config. `lazy-search-startup.compat.spec.ts` expects `first-search` on the web row and `never` on the base row.
- **Tests.** `loader.spec.ts` covers removal and restore across a restart, the person's own earlier archives, a nested research, a delegated child, the draft, examples, `showExamples`, and runs left unobserved until the restore. `drafts.spec.ts` covers `archivedAt` in `blankRecord`.

### Step 10: the sidebar lists researches and their conversations (ui-research)

- **The tree.** `ResearchTree.tsx` takes the sidebar's browsing seat (`sidebar.workspaces`, priority −1) under `hideDeveloperCells`, as the other developer-cell shadows do; the inherited Web scenarios keep the shell's workspace browser. The browser stays registered underneath, so its `sidebar.workspaces.directoryFlow` child stays declared for the folder pickers (`plugin.client.spec.ts` checks it). The 研究项目 cards (`ProjectEntry.tsx`, `sidebar.projects`) are gone from every composition.
- **Where a conversation belongs** (`treeValues.ts`): the research it is bound to or whose folder holds its working directory; else the research of the Workspace that lists it; else that Workspace, shown as a folder without a research; else no folder. Archived conversations, child sessions and visual-review reviewers are never rows, but a running child still lights its research's dot. A research removed from the list (`archived`) is hidden with its conversations, and its folder is not a folder without a research. A conversation restored alone from the archived-conversation list while its research is removed stays hidden until the research is restored.
- **Rows.** Own researches are ordered by recent use (the newest started conversation or the record, whichever changed last). A row shows its title (the placeholder 新研究 in italics while `untitled`), `standingPhrase` on the right (nothing in the general mode), and a dot: warn while a conversation of the research waits on an approval, a plan review or a question (the session's pending interaction), ongoing blue while a conversation of it or one of its runs is running. The untouched draft is a leaf row. An expanded research lists its top-level conversations newest first; the blank one shows only while it is on screen (新对话, italic). The last line is ＋ 新对话 (`startSession(workspaceId)`), hidden on that blank conversation and in examples.
- **Clicks.** A research opens on its newest started conversation, else its folder's blank conversation, never in an example; the research on screen folds and unfolds instead. The draft opens its blank conversation.
- **Groups.** 示例 at the bottom: open while the person has no research of their own or is in an example, hidden when `showExamples` is false. 其他文件夹 appears only when a registered folder holds no research or conversations belong to no folder. A row the person opened or closed keeps that choice in the tree's own store for the page's life.
- **Menus.** A research: 重命名 (`rename`), 在资源管理器中打开 (`session.openWorkspacePath` reveal, only while `canOpenWorkspacePath`), 移出列表 (`archive-project`); the draft gets no 移出列表 and an example only the file manager. A conversation: 重命名 (the session's own `rename`) and 移出列表 (`uiWorkspace.archiveSession`); an example's conversations get none. A folder: 设为研究…, which asks for a name and sends `create` with the folder as root, and 移出列表, which archives every conversation the folder lists and then deletes its Workspace registration. A failure shows under its row.
- **Search and the rail.** The header's search matches research names and conversation titles at once, and conversation text through `sessions.search` 250 ms after the last keystroke, as a flat list of results naming each conversation's place and the matched passage. The collapsed rail keeps the search as its one control: it widens the sidebar and focuses the box after the slide.
- **Keyboard and ARIA.** A flat `role="tree"` whose rows carry `aria-level`, `aria-posinset`, `aria-setsize`, `aria-expanded` and `aria-selected`; one row in the tab order; Up and Down move, Right opens or enters, Left closes or goes to the parent, Home and End go to the ends, Enter and Space activate, and the context-menu key or Shift+F10 opens the row menu; focus returns to the row after the menu closes.
- **Settings › 科研.** 显示示例研究 is a switch saved at once through `configure`; 已移出的研究 lists each removed research with its folder and 恢复 (`unarchive-project`). The model-roles form keeps `showExamples`.
- **Elsewhere in ui-research.** `land()` and 换到另一项研究 skip removed researches, and 打开它 on a removed research restores it before carrying the draft. `standingText` is built on the new `standingPhrase`.
- **Tests and goldens.** `tree-values.client.spec.ts` and `research-tree.client.spec.tsx` cover the derivation, clicks, keyboard, menus, dialogs, search and rail; `plugin.client.spec.ts` the registration, the shadowed browser's declared child and the tree face; the settings, entry and folder-menu specs removed researches. The research Web e2e reads the tree, opens a conversation and ＋ 新对话, finds a conversation by its text, renames, removes and restores a research, and toggles 显示示例研究; its settled-reply scenario opens its conversation through 其他文件夹. The `lifecycle-chrome` `hero` and `plan-active` goldens lose the 研究项目 navigation, on those lines only.

### Step 11: the secondary tools are tabs beside the conversation, and the Workbench goes (ui-research)

- **Tab types.** ui-research registers four more right-sidebar tab types in the builtin band. Each body sits in `sidebar.right.pane.tab` under its own id (`@deepseek-ai/dsh-client-ui-research/board`, `/sources`, `/gallery`, `/drawio`) with the research tab's face. The three pages register live chip titles. The guide page still offers the research tab alone. Each body shows the research of its conversation (`useSessionProject`). A conversation in no research reads the research tab's line, and an example opens with 示例研究：随应用提供的演示，只能查看。
  - **实验看板 (`research-board`).** `Board.tsx` without the manual run form. 停止, behind its confirmation, is not drawn in an example. With no run and no section it reads 这项研究还没有实验。需要时助手会在这里登记运行。
  - **资料 (`research-sources`, `Sources.tsx`).** Each source shows authors · year, `DOI …`, what the research holds of it (全文, 仅摘要, 仅元数据 or 数据) and 需要更新 when stale. 在原文里打开这一页 opens its `path` in the sidebar's viewers, and 全文 opens its `fullTextPath`. Below come the claims with their state tags, in the claim sheet's tones; a claim raises the sheet through `focusClaim`. The authors and year live in the literature source's `reference.json`, which the record does not carry. The face's `reference(projectId, source)` fetches it through `/api/research/file` and keeps the answer per project, path and revision. A refused or failed read, or a record without authors, answers undefined and shows no byline, and a later tab asks again. An open with `{ section: 'claims' }` (a `SidebarRightTabParamsMap` entry) scrolls to the claims, and any other open scrolls to the top, because a new tab starts at the scroll position the pane's previous tab left. The tab imports, searches and verifies nothing.
  - **配图灵感 (`research-gallery`).** `Gallery.tsx`. An example gets no 存为参考图 form. A figure's detail lays out in one column below about 520 px.
  - **draw.io (`research-drawio`).** A resource type with `patterns: ['*.drawio']` and a `canOpen` that accepts any file address `parseFileAddress` reads. It outranks the text viewer's fallback band for every `.drawio` address, including the files tab's.
    - The body resolves the file (an absolute path as written, a relative one against its conversation's working directory) to a path in the research folder. Outside it, the tab says 这个 draw.io 文件不在研究文件夹里，这里无法编辑。
    - The diagram loads through `read-artifact`. A file the record does not list is first registered (`register-artifact`, kind `diagram`, no links). An example cannot register one, so there the tab reads 研究记录里没有这张图。
    - Saving works as it did in the Workbench: `save-artifact` with the revision the editor loaded and the artifact's own links. Autosaves are debounced by 1.5 s and written one at a time, the latest winning. An autosave still waiting when the tab closes is written then.
    - While the snapshot's `components` does not list draw.io as installed, the tab offers 安装组件. An install reads the record again once it settles, and the frame is keyed by the install count, so it loads afresh.
    - An example's diagram loads with `autosave: 0` and `noSaveBtn=1`, and its save messages are ignored.
- **Openers.** `openBoard()`, `openSources(section?)` and `openGallery()` replace `expand(projectId, panel, artifactId)`, beside the existing `openFiles()`. Each calls `layout.setInitialRightbarWidth` and then `sidebarRight.openTab`. The board and the gallery suggest 560 px, the research and Sources tabs 320 px (D16).
  - **Rail counts.** 证据 opens Sources, 论点 opens Sources at its claims, the files count opens the files tab, and 实验 opens the board.
  - **Rail tools row.** It opens the board, the gallery and the files tab.
  - **Run card.** 看板 opens the board.
- **A project file opens through the conversation on screen.** The sidebar's file viewers claim only session-scoped file addresses. `openFile`'s `dsh-resource://file/absolute/…` address was claimed by no type and threw, so issue links, claim-sheet sources and check-card files all failed with 没能完成. `projectFileAddress(sessionId, root, path)` now builds `dsh-resource://file/session/<id>/<absolute path>` with `sessionFileAddress` from `@deepseek-ai/dsh-util-workspace-path`, which replaces the `dsh-util-crypto` development dependency, and `openFile` passes the current session. The host reads a session-scoped absolute path without confining it to the workspace.
- **Removed.**
  - `Workbench.tsx` and its module, and the `main` registration.
  - `ModeSelect.tsx` with `modeChoice`, `parseModeChoice` and `chosenMode`, and `ActionButton`.
  - `expand()`, and the focus store's `projectId`, `panel` and `artifactId`.
  - `ResearchView.response`, which only the Workbench showed.
  - 77 locale keys only the Workbench used, including the four that named the full workbench.
  - Renamed: `galleryAuthorsMore` becomes `authorsMore`, which the sources share.
  - Moved: `ResearchMark` and `ResearchBrand` to `Brand.tsx`.
  - Kept: `openConversation` stays on the face.
- **File actions.** The shell's files tab has no seat for per-file actions, so no single file offers 用默认程序打开 or 在资源管理器中打开, and the shell is unchanged.
- **Tests.**
  - New specs: `tabs`, `sources`, `diagram`, `brand` and `contract`.
  - Extended specs: `board` and `gallery` cover examples. `plugin` covers the registrations, the openers and their widths, session-scoped addresses, `reference` and the read after an install.
  - The research Web e2e opens the claim through the Sources tab and returns to the research tab through the header chip. A new scenario opens Sources and a source's file in the text viewer, the board's empty state, and a `.drawio` file from the files tab, which registers it and offers the install.
  - `gen-client-catalog` lists the new occupants and drops the research `main` key.

### Step 11: the research record reads the research's standing, and run cards stay in their conversation (ui-research)

- **The record (`Rail.tsx`).** The research tab, its guide entry and the header chip's tooltip are now called 研究记录 / Research record, the name the entry line already used. From top to bottom:
  - **The research.** Its title, a dashed 示例 tag for an example, and its folder in muted text. 在资源管理器中打开 shows while `session.canOpenWorkspacePath()` answered yes. An example opens with 示例研究：随应用提供的演示，只能查看。. The face gains the `canReveal` hook and `reveal(path)`, which rejects with the host's reason; the tree's menu uses it too.
  - **Mode · route · who chose it.** `spark-to-paper · 从实测结果开始 · 你选定`, or 助手选定, or 示例作者选定 in an example, with `modeReason` under it. The route falls back to the pack's default route. The line reads 模式待定 while `modeSetBy` is unset. 想换模式？ adds 我想把这项研究换成别的模式，你看哪种合适？ to the draft of the conversation beside the tab (the tab seat's own `useInput` and `inputActions`) and sends nothing; an example has none. The autonomy line is unchanged.
  - **现在 (Now).** `nowLine` (`activity.ts`) takes the first of these:
    - a conversation of the research waiting on an approval, a plan review or a question: 等你回答（对话「X」）, with 跳过去 unless it is this conversation;
    - a goal that drives rounds: 助手正在推进：{current phase}（对话「X」）, without the phase in a mode that has none;
    - running runs (not queued, not unconfirmed): n 个实验运行中, with 打开实验看板;
    - a blocked goal: 助手在等你：见对话「X」, with 跳过去;
    - once checked, the current phase: 下一步：{phase} — {its first hint};
    - a deferred phase with no current phase left: {phase}已推迟：结果格保留「--」，等你补上结果后继续;
    - finished: 全部检查通过, with the ✓ in `state-success`;
    - never checked: 还没有检查过;
    - every phase done but the paper not finished: 各阶段都已完成，还需要再检查一次;
    - the general mode, the mode not chosen included: 通用模式：直接在对话里提需求.
  - **现在 details.** The next-phase, finished, never-checked and recheck lines offer 在对话中提出：{sentence} (继续：{phase}, 导出投稿包, 检查一下现在的进度), which adds the sentence to the draft; an example offers none. A conversation goes by its title, or 新对话 while it is blank or unlisted. The lines that wait on the person use the warn colour; the goal and run lines use the ongoing blue.
  - **阶段 (Phases) and 待处理 (Open issues).** As step 6 built them, under a 阶段 head. Before any check nothing shows under the phases, because the 现在 line says so.
  - **决策 (Decisions).** The three newest, marked 你 / 助手 (示例作者 in an example), question and answer only. A decision with key `mode` reads 模式与路线, with the mode and route by their pack names, or by their ids when the pack or route is gone.
  - **Counts.** 资料 (with its 待更新 tag), 论点, 文件 and 实验, named as the tabs they open. The files count shows its own error in place.
  - **Tools row.** Unchanged.
  - **Removed.** The decisions' rationale lines, the note under the phases before any check, `ProjectStatus`, and the keys `checkNever`, `railSourcesLabel` (证据) and `artifacts` (论文与图表).
- **What is live (`activity.ts`).** `researchActivity` reads:
  - the listed conversations whose research this is (`sessionProject`), and the first of them that waits on the person;
  - the goals, as the snapshot carries them;
  - the running runs.

  From these it derives one dot: warn outranks ongoing. `conversationSignal`, `goalSignal` and `strongestSignal` moved here from `treeValues.ts`. The tree row's dot now also takes the research's goals: a blocked one is warn, one that drives rounds is ongoing, a paused one shows nothing.
- **One draft (host).** Only the newest untouched research is the draft. A research whose files were removed again, or one restored to the list while still blank, is untouched too, and both used to read as drafts, so the tree showed two italic 新研究 rows. `drafts` now tests every blank record and keeps the newest, so the older one is an ordinary research the person can remove from the list. `discard` asks only that its research be untouched, because a relocated draft already has a newer one beside it.
- **Goals in the snapshot (host).** `ResearchProject.goals` carries `activeGoals(project)` for each snapshot: derived, never stored, absent when there is none. `activeGoals` takes an optional `projects` list, so one snapshot resolves every project against one list. The typert validators and the remotes bundle carry the field.
- **The header chip (`Header.tsx`).**
  - Its forms: 模式待定 while the mode is not chosen; the mode alone when it has no phases (通用); `{mode} · {phase} n/m`; `{mode} · 已完成` with a verified ✓; `{phase}已推迟` alone once nothing before the deferred phase is left; `{mode} · 待复查`. In an example they all follow `示例 ·`. `standingPlace` (`format.ts`) gives the place, and `standingPhrase` reads it.
  - The `· 全自动` suffix is gone; the composer's chip names the autonomy.
  - The dot is the research's. It pulses in the ongoing blue unless the person prefers reduced motion.
  - A click calls the face's new `toggleProgress()`. While `sidebarRight.isExpanded()` holds and `sidebarRight.active()` is the research tab, it collapses the panel (`toggleExpanded()`); otherwise it opens the research tab as `showProgress()` does.
- **A saved default preset that is not the research assistant's.**
  - Where it is read: the agent-preset roster composes a session that names no preset from `agent-presets.default`, the person's layer over the row's `default`, while `modeSelectionEnabled` is not false.
  - ui-research binds that namespace with `ctx.settingsScope.bind` (new inject `settingsScope`). The bind adds no wire read, and the settings mirror refreshes it when the document changes.
  - `presetDefaults` (`presets.ts`) gives `research`, the namespace's composition `default`, and `saved`, the person's `default` while it names another preset and selection is on.
  - In any conversation of the person's own research, the record then says 新对话会使用「{preset}」而不是科研助手：设置里把它存成了默认。 with 改回科研助手, which runs `scope.unset('default')`.
  - A refused settings write reloads instead of rejecting, so a default still saved after the unset is reported as 设置里仍保存着原来的默认.
  - A conversation whose `agentPreset` projection names another preset reads 此对话未使用科研助手，研究工具不可用。新开一段对话即可。, or only its first sentence beside the saved-default line.
  - An example says neither. No shell or preset code changes.
- **Run cards (`RunPanel.tsx`).**
  - They show only runs whose `sessionId` is this conversation. Runs of other conversations, and runs recorded without one, are on the board only.
  - A blank conversation draws nothing unless one of its runs is open.
  - In an example there is no 重新连上, 知道了, 停止 or 用它画图. The unconfirmed note there reads 提交回执丢了，无法确认它是否还在跑。. 日志 and 看板 stay.
  - The props are the input dock seat's `PropsRuntime<'conversation.input.dock'>`; `RunPanelOwnerProps` is gone.
- **The board (`Board.tsx`).**
  - An example's board is read once with `refresh: false` and not watched, because the host never reads an example's board again. It draws neither 立即读取 nor 每 15 秒, and its unconfirmed-run banner reads {name}：状态无法确认.
  - Elsewhere the board's run card offers 重新连上 and 知道了 for an unconfirmed run (`experiment-refresh`, `experiment-dismiss`, each with its own error in place). A run from another conversation, or one without a conversation, has a card above no composer. The banner reads {name}：状态无法确认，请在下方「正在运行」里它的卡片上重新连上.
- **Tests.**
  - New specs: `activity` and `presets`. `rail` is rewritten. `header`, `run-panel`, `board`, `tree-values` and `plugin` are extended; `plugin` covers `toggleProgress`, `reveal`, the presets scope and the reset. The host `loader` spec covers the snapshot's goals.
  - The research Web e2e reads the mode line and the 现在 line after a check. It adds the suggested sentence to the draft, closes the panel with the chip while the record shows and opens it again, opens 资料 from its count, and submits a run as the assistant from the conversation on screen, so its card shows there.

### Final sweep: the inherited lanes keep upstream onboarding, and no test writes the real home

- **The first-run notice.** ui-research's shadow of the harness's first-run notice now sits behind `hideDeveloperCells`, beside the other product-only shadows. The shipped edition still skips the notice. The inherited Web lanes show it again, so `onboarding-deepseek-config` passes and compares its key-dialog golden once more, and so do `remote-welcome` and `submission-echo`.
- **Settings order.** The 科研 settings section takes order 24, one before 已归档会话 (25). Both used to share 25, so the order of the settings nav depended on which plugin loaded first.
- **The 全自动 preset.** Its description is one Chinese sentence, like Auto review's, so the `/permission` picker stays narrower than the composer. `access-confirmation` expects it beside the three standard presets.
- **Tests stay out of the real home.** `default-web-process`, `hmr-live` and `smoke-real` boot the shipped Web profile outside the scaffold. They now root `USERPROFILE` and `HOME` in their temp world, because the entry policy's 新研究 is created under `homedir()`. `default-product-isolation` waits for the research tree, which is the shipped sidebar now.
- **The inherited Web e2e on Windows.** A run of every Web e2e file, compared with the same files at the commit before step 1, finds no other failure that the redesign caused. The remaining failures fail the same way before step 1: the `bash` tool and POSIX paths in replayed logs and goldens, the research preset in the preset lists, and the client build record.

## Alternatives considered

**Remove the rows instead of disabling them.** The telemetry and `/feedback` rows belong to the base bundle, which the headless, ACP and SDK profiles share, so removing them there would change those profiles too. The Web rows could be dropped from the insert list, but a disabled row keeps the choice visible in place and is one line for a deployment to turn back on, the same reason the Web patch disables the agent-plane rows instead of dropping them.

**Disable telemetry in the base bundle.** It would change the CLI profiles this product does not ship, and the base bundle's own test pins the upstream default. The Web bundle is exactly what the `web` profile and the desktop compose.

**Hide the controls from `ui-research` by registering over their slots.** An empty occupant hides a button but leaves the plugin and its Host Remote mounted, so a rating could still authorise an upload through another path. A disabled row mounts neither half.

**Set the variable in the Desktop child and nothing else.** The Desktop Host did not read `DSH_TELEMETRY_DISABLED`; only the CLI launcher applied it. The variable alone would have reached the agent's processes but not the Host's own composition.

**Update every inherited golden to the shipped rows.** About 75 inherited goldens record the Chat and Trajectory tab strip and 54 the rating buttons, and the scenarios of the disabled plugins need those rows to run at all. Rewriting the goldens would remove what they test from about 80 upstream scenarios, and a refresh on Windows would also record that platform's failures into goldens CI compares on Linux. The inherited scenarios keep composing the rows instead, and the research scenarios run and assert the shipped composition.

**Replace the copy from `ui-research` (step 2).** The locale service refuses a second dictionary for a namespace, and re-registering each slot only to draw the same component with other words would copy shell components into the research package.

**Rename the keys with the words (step 2).** `chat.deepDiving`, `hero.chooseWorkspace` and `placeholder.workspace` are identifiers the shell components read. New names would edit component code for no visible difference.

**Refresh the goldens for the copy (step 2).** For the same reason as in step 1, the goldens change in place, on the lines that quote the old values; those lines are exactly what a refresh would rewrite.

**Guard binary files by extension only (step 3).** A dataset or checkpoint under an unusual name would still be emptied. The NUL-byte probe reads at most 8 KiB, and a text file never contains a NUL byte.

**Repoint `state-business` to blue for running work (step 4).** The shell uses `state-business` as its accent in about 30 places (caret, pending dot, hover rules, reference chips, focus outlines), so the caret and every accent would have turned the running blue. A new `state-ongoing` alias carries work in progress instead.

**Use the plan's green `#2e7d4f` (step 4).** It sits at ΔE 7 from the brand teal in light and at 5.6 in dark, so verified and brand would read as one colour; the leaf green keeps them apart.

**Store an example flag in the record, or mark examples with `/permission read-only` (step 5).** A stored flag would mean editing every example record, which the generator owns. A permission preset would append events to the examples' session logs, and it would still let the host's own commands write. Deriving the flag from the folder needs neither.

**Keep one error banner and clear it per action (step 3).** A banner above the panel tells nobody which button failed, and two actions in flight overwrite each other's message. A line beside each control needs no clearing rules.

**Keep a report per scope, or let only scope `all` write (step 6).** Reports per scope leave every reader to work out which one is newest for each phase. An `all`-only writer throws away the phase checks the agent runs at the end of each phase. Merging by the gates that ran keeps phase checks useful and never marks a phase done on partial evidence.

**Name requirements by their position (step 6).** An index names a different requirement after a pack edit, so stored progress would show the wrong hint. A key built from the conditions survives reordering, and a changed condition only loses its hint.

**Seed progress in the storage migration (step 6).** `migrateProject` runs without the mode registry, so it cannot map an old report's English lines to requirement keys. Seeding where the mode is resolved can, and it changes no stored record until the next check.

**Let a deferral count as done (step 6).** The paper would then read 已完成 while its result cells still read "--" (D18).

**Move the review after the latex phase (step 6).** It would reorder ts-paper's stage chain. Comparing the review with the sections it read holds through any number of recompiles.

**Read goals from the session projections, or store them in the record (step 7).** The goal projection belongs to the goal service, which also rejects a log that no longer replays; reading it past the service would copy that rule. A goal copied into the ledger would be a second record of a fact the session log owns, and would go stale the moment the goal changed.

**Drop the `root` parameter of `create` (step 7).** A model that still passed a folder would then create the research in its working directory without being told. Keeping the parameter and refusing another folder says where a research in another folder comes from.

**Write the mode decision's answer in the reader's language (step 7).** The record is shared by both interface languages and by the agent. Mode and route ids are exact in all three, and the key `mode` lets the research record name the decision in the reader's language.

**Delete `progress` on a mode change (step 7).** A deleted record reads its stored `lastCheck` again, so returning to an earlier mode would bring its old phases back. An empty record for the new mode and route starts nothing checked.

**Reword the web-search endpoint guidance (step 7).** Its failure text still sends the person to Settings > Plugins > Plugin configuration > Web search, a page this edition does not ship, before its own fallback to `DEEPSEEK_SEARCH_BASE_URL` and the `web-search-deepseek` configuration. The keyless `web-search-endpoint-guidance` session snapshot records a model reply that quotes that text, so changing it needs a live re-recording with a key; it stays until then.

**Put Chinese titles in the Host's `presentCall` (step 7).** The Web Client does not consume Host presenters ([client-derived presentation](2026-08-23-client-derived-tool-presentation.md)), and a Host title has one language.

**Copy the Host's `CHECK_LABELS` into the client (step 7).** A second copy would drift; the standing already carries the label of every check with findings.

**A Config field for the autonomy-to-preset mapping (step 8).** The composer chip shows the same mapping to tell a hand-typed preset apart, and a client row's config never reaches the browser, so a configurable host mapping would be a second copy the chip could disagree with. What each preset allows stays configurable in the permission row.

**Keep applying the preset from the browser (step 8).** The browser reaches only a conversation it has open, so a conversation a goal drives, or one nobody opened, would run under a stale preset.

**Switch through the `/permission` path, `ctx.approval.setPolicy` with its notice (step 8).** It needs a live agent and would add a user-visible notice to every conversation on each change. The runtime-context sentence already states the current policy, and the plan names `permissionPresets.set`.

**Apply only in `session/created` (step 8).** A new research's bound session goes live before the record exists, so it would keep the default until its next load.

**Allow the attachment folder by its lexical path, or the whole `attachments` tree (step 8).** A link inside the store could lead anywhere in the home, and `file-objects` and the image objects are not what the person attached by name. Resolving links and accepting only `files/**` keeps the refusal of the rest.

**Fall back to the shell's chip outside a research (step 8).** The slot model has no entry that declines. Drawing `PermissionSelect` from ui-research would import another plugin's component, and rewriting it would copy its catalog read and risk confirmations.

**Register the chip without the flag (step 8).** Inherited scenarios whose sessions are outside a research would lose the access chip that their goldens record.

**Name presets from the permission catalog (step 8).** It would add the `remote.permissionPresets` read and its invalidation to ui-research. The catalog's names are the host's, which the shell's chip also replaces with its own dictionary for built-in presets.

**Keep sending `/permission` from the browser (step 8).** It reaches only the conversation on screen.

**Always publish the page global, as ui-research does (step 9).** A default row would add a script to every served page, and both packages' inert-Host-entry specs would change. Publishing only a non-default value keeps the default page identical.

**An `initialSession: none` switch plus a research-side startup (step 9).** It closes the race only at startup. `clearArchivedCurrent` and the removal of the current Session would still leave nothing selected, and 新研究 would still inherit the current folder.

**Run `land()` on every notification while nothing is selected (step 9).** A policy that selects nothing (a failed `start-new`, a research home that cannot be written) would call the Host on every list change. Only transitions trigger it: the startup, a lost selection, a registration.

**Replace an earlier policy on a second registration, or keep a stack (step 9).** Two plugins registering policies is a composition error; the throw names it at load.

**A Config field for the 5 s wait (step 9).** The wait guards against a missing plugin; it is not a tuning choice.

**Make the brand row a button that does nothing, or hide it (step 9).** A button without an action is a dead control (D13); hiding the row would take the product's identity out of the sidebar.

**Count `set-autonomy` as a change (`revision === 1`) (step 9).** The autonomy chip sits in the draft's composer, so choosing 全自动 before typing would turn the draft into a research of its own: 更改位置 would disappear and the next 新研究 would make a second folder. The record's content decides instead, and `relocate` carries the autonomy.

**The preference alone for the research home (step 9).** Startup under the entry policy calls `start-new` before a test can configure anything, so every Web e2e would create folders in the developer's `%USERPROFILE%\SciPaper`. A Config field is what a composition can pin.

**Remove the root whenever it is empty (step 9).** A folder the person made before choosing it is not one the draft made; `createdRoot` records which.

**Read blankness from session events or `inspect` (step 9).** Events reach only this process's live sessions, and `inspect` copies a live session's whole log. The list's `blank` bit is what the shell uses to reuse a blank conversation.

**Leave the old conversation unarchived (step 9).** A session log cannot be deleted, and a cold session whose list metadata misses the cache reads as not blank, so it would reappear among folderless conversations. Archiving is the one removal the registry offers.

**Render the chip in ui-research (step 9).** The shell draws `WorkspaceChip` itself and hands the seat only the menu; a second chip would need a new hero slot, which the plan dropped.

**An in-app folder browser for 更改位置 (step 9).** The shell's browse flow fills `conversation.hero.workspace.directoryFlow`, which only the Workspace picker declares; rendering it from the research menu would break slot ownership. A typed path covers the hosts without a chooser.

**Show the folder outcomes on the entry line (step 9).** 打开它 must call the folder seat's own `onPick`, which the entry line does not receive; the menu at the chip has it.

**Discard the draft on 换到另一项研究 (step 9).** The draft is the one reusable 新研究; keeping it costs nothing, and the next 新研究 opens it again.

**Let `land()` create a draft when the record cannot be read (step 9).** A draft beside researches the snapshot missed would duplicate one; saying why leaves the choice to the person.

**Archive conversation by conversation from the browser (step 10).** The browser does not own the innermost-research rule, would keep no record of what it archived, and a closed tab would leave a research half archived with nothing to restore from.

**Delete the record or the Workspace registration, as `discard-draft` does (step 10).** A removal must be reversible; deleting the Workspace would also drop the folder's session accounting.

**Derive "removed" from "every conversation archived" (step 10).** A research without conversations, or one whose conversations the person archived one by one, would read the same, and a restore would unarchive conversations the person archived themselves.

**Archive first, then store the record (step 10).** A failure between the two would leave archived conversations with no record of which. Storing first leaves at worst an id that was never archived, which the registry's unarchive ignores.

**Archive delegated children too (step 10).** The shell never lists them on their own; archived, they would appear as separate rows on the 已归档会话 page.

**Refuse commands on a removed research (step 10).** Its runs are meant to keep going, and the person can reopen an archived conversation from 已归档会话; only background observation stops.

**Restyle the shell's workspace browser (step 10).** It lists folders, not researches, and offers 添加工作区, 视图选项, 未分组, 分叉会话 and 删除工作区; removing them would change the shell. The shadow leaves the shell as it is.

**Nested `role="group"` markup (step 10).** A flat tree with `aria-level`, `aria-posinset` and `aria-setsize` is valid ARIA and lets the keyboard walk one ordered list of rows.

**Persist which rows are open (step 10).** The research on screen opens by itself after a reload, and persisted keys of removed or discarded researches would pile up.

**Port the browser's drag reorder (step 10).** Recent use is the order the plan accepts, and a manual order has no research meaning.

**Only delete a folder's Workspace registration on 移出列表 (step 10).** Its conversations would come back under 未归入文件夹的对话; archiving them first takes them out of every list, restorable from 已归档会话.

**Read the goal projection for the ongoing dot (step 10).** List rows carry no typed goal state in ui-research, and reading it would add the goal package's types; the running bit covers a goal's rounds.

**List a conversation restored alone under 其他文件夹 (step 10).** It would call a conversation of a removed research folderless; restoring the research brings it back where it belongs.

**Keep a stripped Workbench (step 11).** A main panel replaces the conversation, which is the second application the plan removes (sections 3.5 and 10). The right-panel tabs keep one reporting place beside the conversation.

**Show the board as a conversation view tab (step 11).** It would bring back a view tab strip and move reporting into the main surface (D16).

**Force 560 px through a new layout action (step 11).** `ILayout` only suggests a first width. Widening an open panel needs a shell method, which step 11 does not add, and the dock's 全屏 already gives the board the whole frame.

**Render draw.io through the document preview's extension registry (step 11).** `documentPreviews` dispatches renderers inside the text tab with that tab's load modes and toolbar, and it loads bytes through the workspace-files Remote. The editor needs the research's artifact and revision (`read-artifact`, `save-artifact`) and a frame of its own; a tab type claiming `*.drawio` gives it both without a shell change.

**Register the diagram on every open (step 11).** It would record external edits under the artifact's links, which fails once a linked source goes stale, and it writes a revision nobody asked for. Registration happens only for a file the record does not know.

**Carry authors and year in the snapshot (step 11).** The record has no fields for them, and the examples' records are never rewritten. A derived field would read every reference record on each snapshot, whereas the file route already serves the record on demand.

**Offer the file actions in the tab menu (step 11).** `sidebar.right.tab.menu.item` extends a tab's own menu, not a row of the files tree; per-file actions need a seat in the files tab.

**Teach the text viewer the absolute scope (step 11).** It is a shell change, and a session-scoped address reaches the same file through the viewers as shipped.

**Read the default from `agentPresets.list()` (step 11).** Its `isDefault` marks the default in force, but not the deployment's. The client could not tell a saved override from the edition's own default without naming `research` itself. The settings namespace carries both layers, and its mirror follows document changes.

**Ignore a stale saved default in the roster (step 11).** It changes the preset package's selection policy, and it drops a choice the settings still hold without telling anyone. Showing the choice and offering the reset leaves it to the person.

**Recognise a research preset by its composition rows (step 11).** It reads each preset's composition for the research tools row on every snapshot. This edition ships no preset chooser, and its deployment default is the research assistant's preset.

**Derive goals in the browser from the session list's `goal` projection (step 11).** List rows carry projection values only as cached hints for sessions this window has not bound, so a goal driving another conversation would show late or not at all. The host's `activeGoals` reads the live goal service, as the brief does.

**Show runs recorded without a conversation in every conversation (step 11).** Spec section 3.3 keeps them there. They would put one research's runs into each of its conversations again. The board lists them and gives them a card's actions.

**Close the record only with the dock's own collapse (step 11).** The spec makes the chip the door both ways. `ISidebarRight` already offers `isExpanded()`, `active()` and `toggleExpanded()`, so no shell change is needed.

**Keep the autonomy on the chip (step 11).** The composer's chip names it (step 8), and the spec's chip forms do not.

**Keep the tab name 研究进展 (step 11).** The spec and the entry line call the panel 研究记录. One name for one panel.

**Refresh the inherited goldens without the notice (final sweep).** The inherited lanes exist to exercise the upstream plugins as shipped upstream. Shadowing their first step there would hide upstream onboarding from every test that checks it.

**Give the research host an environment override for its home (final sweep).** That is a product setting added only for tests. The launchers already own their temp world, and `homedir()` follows it.

## Consequences

- The Web and Desktop compositions reach a DeepSeek service only when the person configures a DeepSeek model or stores a DeepSeek key, which also enables the DeepSeek web-search provider behind `web_search`; nothing they run creates `.anonymous-user-id`. With the plugin settings page disabled, the GUI has no switch for web search.
- The product has no way to send feedback or download a Session log. [SciPaper Harness as an independent product](2026-09-24-scipaper-independent-identity.md) records the rest of the product's request identity.
- The GUI cannot pick a preset or edit the roster. A default preset stored earlier through the removed settings section (`agent-presets.default`) stays in effect, and nothing in the GUI shows it, until the settings document is edited.
- The Host rows that served only removed browser halves, `plugin-inventory` and `terminal-controller`, stay mounted and unused.
- The entry screen, the composer, the files entry and the first-run dialog no longer say 工作区 (workspace) or name DeepSeek as the product. Other shell copy still says 工作区, such as the workspace list, the directory picker's title 选择工作区目录 and the permission preset 工作区内修改, until the steps that replace those controls.
- Until the entry policy of step 9 lands, 新研究 creates no research while no folder is chosen, which is when the fallback placeholder shows, so its 新建 (start new) points at a button that does not do that yet; opening a listed research, or choosing a folder with the chip, works.
- Every shell locale string that names DeepSeek, Harness or DSH and still renders in the shipped composition names a model the person selects (the model picker's DeepSeek descriptions, the DeepSeek endpoint placeholders in the Models settings). The inherited welcome notice about DeepSeek Harness 0.1 is in `ui-settings-models`, but `ui-research` occupies that onboarding step with a component that renders nothing, and the web-search description sits on the disabled plugin settings page. The model-visible system prompt names neither DeepSeek Harness nor DSH as the product; the web-search provider's endpoint-failure guidance still points to Settings > Plugins (see the alternatives), and its missing-key error points to the Models page, which the product has.
- The inherited user guide (`docs/user/guide`) and upstream Agent Notes still quote the shell's old labels, such as **Choose workspace** and `Deep diving...`.
- A person who wants a check, the pipeline or another mode now asks the assistant in the conversation.
- Until step 9 the 新建项目目录… pill and the composer's folder button stay as the only direct ways to put a research in a chosen folder.
- An example cannot be continued, even by the person who has it open; making a copy of one is left to the tutorial (`复制为我的研究`). Until step 9 startup can still land in an example, which now says it is one.
- The shell's own success marks (a done todo, a diff's added lines, the connection indicator) now read the verified green in the research edition, which is their conventional meaning.
- The rail, the header chip and the brief agree, because all three read one standing. A phase check changes only the phases whose gates it ran, and the whole-paper summary changes only with a full check.
- A project holding more than 5,000 files never reads as finished and never shows 检查后有改动. Each snapshot lists a checked project's files at most every 30 seconds.
- `research_check scope: cite`, and `figures`, in spark-to-paper now run that phase's gates as well.
- A pack without hints, gate labels or `paperRoot` no longer loads.
- `lastCheck` is written but nothing reads it; task results stored by earlier versions keep the report fields they had.
- Until step 8 the rail keeps its autonomy select, and until step 11 it has no 现在 line.
- Records created before step 7 carry `modeSetBy: user` from the earlier creation path and read as chosen. A record whose mode an agent set before `set-mode` recorded decisions reads `routingSettled: false`, so its pack's entry skill may route it once more.
- The shipped examples keep the separate mode decisions their generator recorded then; a regenerated example would carry one decision per `set-mode`.
- A goal in a conversation that is not loaded is not reported in `activeGoal`, so an agent can create a second one beside it.
- Inherited Web scenarios compose the same `system-prompt` row, so their prompt goldens lost the identity opener with the research edition's.
- A clean check scoped to a base check (for example `figures` in the general mode) shows the check's id, because the snapshot carries a check's label only while it has findings.
- A preset typed with `/permission` holds in its conversation until the autonomy is set again or the conversation is loaded again.
- The research service does not load in a composition whose permission row lacks `workspace-write` or `research-auto`.
- The attachment store is shared by all conversations, so a path attached in another conversation is importable too. The agent learns attachment paths only from its own conversation's messages.
- The example generator's own `permissionPresets.set(..., 'research-auto')` is now redundant and stays.
- In the shipped edition a conversation outside every research has no access control in the composer; `/permission` remains.
- A composition that mounts ui-research without `hideDeveloperCells` keeps the shell's access chip and has no autonomy control, although the rail still points to the composer.
- A hand-typed preset lasts until the next autonomy choice in that research.
- When the conversation's projection arrives after the record, the chip briefly reads `本对话：…`.
- Without a registered policy (ui-research not loaded), startup waits 5 s and then connects the recent Workspace, and 新研究 keeps the upstream rule.
- Research Web scenarios that compose the shipped rows run under `entry: policy` and `brandAction: none`: their sidebar has one 新研究 button.
- After a policy call settles with nothing selected, nothing is selected until the person acts or the selection is lost again.
- `docs/config-catalog.md` lists both packages' configuration.
- `existing` and `nested` change nothing; opening that research and discarding the draft with `discard-draft` is the client's.
- A draft whose conversation was archived gets a new blank conversation from `start-new`; the record keeps its bound one.
- When sessions cannot be listed, snapshots and command answers mark no draft, and `start-new` fails rather than make a second draft.
- While a draft exists, each snapshot lists the sessions once.
- Any file in the draft's folder, an OS file such as `.DS_Store` included, makes it a research of its own.
- A research home changed in the settings applies to the next draft; an existing draft stays where it is until it is moved.
- A research home inside a research refuses 新研究 until the settings change.
- Where the host has no folder chooser (a remote browser, an SSH launch), 更改位置… and 研究存放位置 take a typed absolute path.
- If a moved research's conversation does not appear in the lists within five seconds, the typed draft stays with the archived draft conversation, and the entry line says why.
- After 换到另一项研究 the untouched draft stays in the list until the next 新研究 reopens it or a move discards it.
- The chip names the folder's Workspace, so a research whose rename could not retitle its Workspace shows the folder name there.
- A removed research stays in `projects()`: the agent's `research_project list`, `projectAt`, and `relocate`'s `existing` and `nested` answers still find it (`archived: true`), and a conversation opened in its folder belongs to it.
- Both commands bump the record's `revision` and `updatedAt`, so a restored research counts as just used.
- A conversation that begins in a removed research's folder is not archived until `archive-project` runs again.
- A conversation the person unarchives alone from 已归档会话 stays in `archivedConversations`; restoring the research then changes nothing for it.
- A run that finishes while its research is removed is collected at the first observation after the restore.
- Content search keeps an in-memory index built at the first search after each start.
- A composition that mounts ui-research without `hideDeveloperCells` shows the shell's workspace browser and no research list, since the cards are gone.
- The tree has no drag reorder and no view options, and which rows are open resets on reload.
- A goal between two rounds, a queued run and a run whose state is unconfirmed show no dot.
- A folder taken out of the list loses its Workspace registration; its conversations, restored from 已归档会话, come back as conversations in no folder.
- A conversation restored alone while its research is removed shows nowhere until the research is restored.
- The board opens at 560 px only while the right panel has no width yet. Once the research tab set 320 px, the board opens at the panel's width, and 全屏 gives it the frame.
- A tab opened in a pane starts at the scroll position the previous tab left. The Sources tab scrolls to its section; the board and the gallery do not.
- A registered diagram edited outside the research tools since it was recorded is refused on save as a revision conflict, until a compile or the agent records it again. There is no 接纳外部修改.
- Opening a `.drawio` file the record does not list records it as revision 1 of a diagram.
- Each page load costs one request per literature source for its byline. A source whose reference record cannot be read shows none.
- From the files tab a single file can be neither shown in the file manager nor opened with the default application.
- A goal in a conversation nobody has loaded shows no dot and no 现在 line, because the goal service sees loaded conversations only.
- Runs the desktop submitted, and runs recorded before runs kept their conversation, have no card above any composer; the board lists them.
- A waiting question counts while the shell's pending-interaction map carries it; its domains publish it for the conversations this window follows.
- The 现在 line's first rule counts approvals and plan reviews as well as questions, as the tree's dot does, and reads 等你回答 for each.
- While the mode is not chosen, the 现在 line reads 通用模式：直接在对话里提需求 beside 模式待定.
- A copy of the research preset under another id reads as another preset, and its conversations get the note.
- The saved-default note shows only in the research record; the chip and the entry screen say nothing about it. 改回科研助手 clears `default` alone and leaves `modeSelectionEnabled` as it is.
- An example's board with no stored read reads 尚未读取 and offers no way to read it.
- An older untouched research beside the draft is listed as 新研究 in upright type, and is removed from the list like any research.
- The chip closes the panel only while the research tab is the active tab of the active pane. With another tab in front, it opens the record, suggesting 320 px only while the panel has no width yet.
- The Web e2e files that fail on Windows fail as they did before step 1, apart from those this sweep fixed. `preview-boot` failed before step 1 too; it now stops later, waiting for the old entry screen's folder box. The real-key smoke was not compared.
