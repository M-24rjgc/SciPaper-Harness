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
