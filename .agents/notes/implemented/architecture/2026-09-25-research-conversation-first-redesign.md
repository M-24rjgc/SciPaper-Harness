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

## Alternatives considered

**Remove the rows instead of disabling them.** The telemetry and `/feedback` rows belong to the base bundle, which the headless, ACP and SDK profiles share, so removing them there would change those profiles too. The Web rows could be dropped from the insert list, but a disabled row keeps the choice visible in place and is one line for a deployment to turn back on, the same reason the Web patch disables the agent-plane rows instead of dropping them.

**Disable telemetry in the base bundle.** It would change the CLI profiles this product does not ship, and the base bundle's own test pins the upstream default. The Web bundle is exactly what the `web` profile and the desktop compose.

**Hide the controls from `ui-research` by registering over their slots.** An empty occupant hides a button but leaves the plugin and its Host Remote mounted, so a rating could still authorise an upload through another path. A disabled row mounts neither half.

**Set the variable in the Desktop child and nothing else.** The Desktop Host did not read `DSH_TELEMETRY_DISABLED`; only the CLI launcher applied it. The variable alone would have reached the agent's processes but not the Host's own composition.

**Update every inherited golden to the shipped rows.** About 75 inherited goldens record the Chat and Trajectory tab strip and 54 the rating buttons, and the scenarios of the disabled plugins need those rows to run at all. Rewriting the goldens would remove what they test from about 80 upstream scenarios, and a refresh on Windows would also record that platform's failures into goldens CI compares on Linux. The inherited scenarios keep composing the rows instead, and the research scenarios run and assert the shipped composition.

**Replace the copy from `ui-research` (step 2).** The locale service refuses a second dictionary for a namespace, and re-registering each slot only to draw the same component with other words would copy shell components into the research package.

**Rename the keys with the words (step 2).** `chat.deepDiving`, `hero.chooseWorkspace` and `placeholder.workspace` are identifiers the shell components read. New names would edit component code for no visible difference.

**Refresh the goldens for the copy (step 2).** For the same reason as in step 1, the goldens change in place, on the lines that quote the old values; those lines are exactly what a refresh would rewrite.

## Consequences

- The Web and Desktop compositions reach a DeepSeek service only when the person configures a DeepSeek model or stores a DeepSeek key, which also enables the DeepSeek web-search provider behind `web_search`; nothing they run creates `.anonymous-user-id`. With the plugin settings page disabled, the GUI has no switch for web search.
- The product has no way to send feedback or download a Session log. [SciPaper Harness as an independent product](2026-09-24-scipaper-independent-identity.md) records the rest of the product's request identity.
- The GUI cannot pick a preset or edit the roster. A default preset stored earlier through the removed settings section (`agent-presets.default`) stays in effect, and nothing in the GUI shows it, until the settings document is edited.
- The Host rows that served only removed browser halves, `plugin-inventory` and `terminal-controller`, stay mounted and unused.
- The entry screen, the composer, the files entry and the first-run dialog no longer say 工作区 (workspace) or name DeepSeek as the product. Other shell copy still says 工作区, such as the workspace list, the directory picker's title 选择工作区目录 and the permission preset 工作区内修改, until the steps that replace those controls.
- Until the entry policy of step 9 lands, 新研究 creates no research while no folder is chosen, which is when the fallback placeholder shows, so its 新建 (start new) points at a button that does not do that yet; opening a listed research, or choosing a folder with the chip, works.
- Every shell locale string that names DeepSeek, Harness or DSH and still renders in the shipped composition names a model the person selects (the model picker's DeepSeek descriptions, the DeepSeek endpoint placeholders in the Models settings). The inherited welcome notice about DeepSeek Harness 0.1 is in `ui-settings-models`, but `ui-research` occupies that onboarding step with a component that renders nothing, and the web-search description sits on the disabled plugin settings page. The model-visible system prompt still introduces the agent as powered by DeepSeek Harness (`includeHarnessIdentity`), and the web-search provider's missing-key error still points to Settings > Plugins; neither is UI copy.
- The inherited user guide (`docs/user/guide`) and upstream Agent Notes still quote the shell's old labels, such as **Choose workspace** and `Deep diving...`.
