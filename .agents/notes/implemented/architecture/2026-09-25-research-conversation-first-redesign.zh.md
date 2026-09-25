# Agent Note：以研究与对话为中心重新设计 SciPaper Harness

Status: implemented

[English](2026-09-25-research-conversation-first-redesign.md) | 中文

## 问题

SciPaper Harness 是构建在 DeepSeek Harness Web 外壳上的科研应用，但它在科研产品旁边仍带着外壳自己的开发者产品。每条回复都提供「好的回答 / 有问题的回答」，而在基础组合包的 `FEEDBACK_ONLY` 遥测模式下，一次评分或 `/feedback` 就会把这段对话的 Session 日志交给 `harness-telemetry.deepseeksvc.com`；桌面应用从未设置 `DSH_TELEMETRY_DISABLED`。每个 DeepSeek 官方模型请求还会在 `dsh_session_log` 字段里附带整份 Session 日志。界面上还有与科研无关的开发者控件：Cordis 插件徽标、一个 agent preset 选择标签（选其他选项就会失去科研工具）、轨迹标签页、终端标签页、Session 日志下载、「在…中打开」按钮，以及插件和 preset 设置页。文案也在替外壳说话：运行中的一轮显示「深度求索中...」（DeepSeek 的中文名），入口页让用户选择「工作区」，首次启动对话框提出「配置 DeepSeek 官方模型」，仿佛那是产品自己的模型，窗口标题则是产品的旧名 Research Workbench。除此之外，入口页、新建路径、右侧栏和 agent 的流程已经长成了两个功能重叠的应用，其中好几个控件什么也不做。

负责人批准了一次重新设计：「研究」是用户唯一创建的对象，对话是主界面，右侧面板只报告。它按顺序分步交付，每一步都保持应用可用；本 note 在每一步交付时记录这一步。

## 决策

### 第 1 步：不发遥测、不收反馈、不提供开发者控件

由 Web 组合包的 patch（`packages/bundle/web-app/cordis.patch.yml`）关闭这些行，不改外壳代码，只有一个外壳包清单去掉了一条依赖边（见下文）。`web` profile 与 Desktop Host 都在 base 之上组合这个组合包，因此两者都不再包含它们。

- **遥测与反馈。** 按 id 禁用 `session-telemetry-otel` 和 `command-feedback`（base 的行）；`message-feedback` 与 `ui-message-feedback` 以禁用状态插入。组合结果因此没有导出器、没有 `/feedback`、没有评分按钮，也没有 `messageFeedback` 和 `sessionFeedback` 两个 Remote。
- **模型请求不再附带 Session 日志。** `session-log-deepseek` 保持挂载，但设为 `enabled: false`。DeepSeek 模型仍是普通的服务商，只是其请求不再带 `dsh_session_log` 字段。
- **桌面端开关。** 无论继承的环境是什么，Electron 壳都以 `DSH_TELEMETRY_DISABLED=1` 启动 Host。Host 像 `dsh` 启动器那样应用这个开关：值非空且组合中有遥测行时，在所有插件组合包、profile 自己的 patch 和桌面叠加层之后，再用最后一个 patch 禁用它（`apps/desktop-host/src/layers.ts` 中的 `desktopPatchLayers`）。agent 启动的进程会继承该变量。
- **开发者控件。** 以禁用状态插入：`session-log-download`（Session 日志下载与 `/export`）、`open-in-app` 与 `ui-open-in-app`（桌面端原本就已关闭）、`ui-cordis`（Cordis 插件徽标）、`ui-agent-preset`（空白对话上的 preset 标签、会话头部的 preset 名称和 preset 设置分区）、`ui-settings-plugins` 与 `ui-settings-plugin-inventory`（插件设置页）、`ui-sidebar-terminal`（终端标签页）和 `ui-trajectory`（轨迹视图，因此会话头部不再画视图标签）。
- **Preset 与自主程度。** 每段对话都从名录默认的 `research` 组合。`research-auto` 在权限列表中的显示名为 `全自动 · Automatic`。
- **产品标题。** 科研版客户端构建 profile（`scripts/client-build-environment.ts`）把 `DSH_CLIENT_TITLE` 设为 `SciPaper Harness`，页面标题以及随之而来的桌面窗口标题都使用它。
- **一条清单依赖边。** `ui-attachment` 的 `dsh.client.inject` 不再列出 `ui-trajectory`。它向轨迹图片 slot 的贡献通过 `ctx.slots.inject` 等待该 slot，本身是可选的；而 Web 名录不保留指向未组合的包的依赖边（`assembly-bundle-roster.client.spec.ts`）。

`packages/bundle/web-app/tests/research-edition-rows.ts` 把每个被禁用的行只列一次。旁边的 `independence.spec.ts` 固定了组合后的各行，包括没有任何启用的行写着遥测端点；`apps/desktop/tests/desktop-telemetry.spec.ts` 通过 `desktopPatchLayers` 固定桌面组合，开关也在其中。科研场景按交付时的状态运行这些行：`apps/web/tests/research-workbench.e2e.ts`（它也从 `research` preset 组合）、示例生成器 `research-demo.e2e.ts`，以及 `shipped-composition.e2e.ts` 中检查交付默认值的测试。继承来的 Web 场景继续组合这些被禁用的行，因为 Playwright 脚手架的 `enableInheritedRows` 默认为 true，所以它们及其金标准仍按录制时的样子测试上游插件。组装后的 jsdom 通道挂载交付时的名录，只有其中的轨迹图片场景重新组合轨迹视图这一行（`mountAssembledApp({ enableRows: ['ui-trajectory'] })`）。批准的方案原本要求更新回放金标准，这里没有这样做（见其他方案）。

### 第 2 步：外壳文案说的是「研究」，不是工作区，也不是某家公司

文案改在五个外壳包的词典里，不改任何键，也不改任何组件。一个 locale 命名空间每种语言只接受一份词典（`ctx.locale.register` 会拒绝第二份），所以别的插件无法替换这些值。先写中文，英文随之对应。

| 包 | 键 | 中文 | English |
|---|---|---|---|
| `ui-chat` | `chat.deepDiving`，运行中那一轮下方的状态行 | 思考中… | Thinking… |
| `ui-conversation` | `hero.headline` | 今天想推进什么？ | What shall we work on today? |
| `ui-conversation` | `placeholder.hero`，空白对话的输入框 | 说说你的研究问题，或把论文、数据拖进来（/ 调用指令，@ 引用文件或对话） | Describe your research question, or drop in papers and data; / for commands, @ for files or conversations |
| `ui-conversation` | `placeholder.default` | 接着说，或把论文、数据拖进来（/ 调用指令，@ 引用文件或对话） | Keep going, or drop in papers and data; / for commands, @ for files or conversations |
| `ui-conversation` | `placeholder.workspace`，尚未选定文件夹时的输入框 | 先在左侧新建或打开一项研究 | Start new research or open one on the left first |
| `ui-conversation` | `hero.chooseWorkspace`，尚未选定文件夹时的文件夹标签和输入框名称 | 选择研究 | Choose research |
| `ui-settings-models` | `onboardingTitle`，首次启动的密钥对话框 | 添加一个模型服务的 API Key 即可开始使用 | Add an API key for a model service to get started |
| `ui-settings-models` | `onboardingDescription` | 这里可直接填写 DeepSeek 的密钥；其他提供方可在 设置 › 模型 中添加。 | You can enter a DeepSeek key here; add other providers in Settings › Models. |
| `ui-sidebar-files` | `guide.title`，右侧面板起始页上的文件入口 | 研究文件 | Research files |
| `ui-sidebar-files` | `guide.description` | 浏览这项研究的文件夹 | Browse this research's folder |
| `ui-sidebar-files` | `noWorkspace` | 这段对话没有研究文件夹。 | This conversation has no research folder. |
| `ui-sidebar-files` | `error.outsideWorkspace` | 这个目录在研究文件夹之外，侧栏不会读取它。 | That directory is outside the research folder, so the sidebar will not read it. |
| `ui-reference` | `crumb.root`，`@` 逐级进入文件夹时的第一段路径 | 研究文件夹 | Research folder |
| `ui-reference` | `section.sessions`，`@` 菜单里的对话分区 | 对话（不变） | Conversations |

- **状态行**不再带有外壳背后那家公司的名字。
- **首次启动对话框**仍然只提供 DeepSeek 凭据，所以文案写明它要的是什么：一个模型服务的密钥，这里填 DeepSeek 的，其他提供方在「模型」设置里添加。它不再把 DeepSeek 说成产品自己的模型。
- **两句输入框提示**各是一句话；中文里的指令提示放在全角括号内。英文的 `@` 菜单把这个分区叫作 Conversations，与提示里的用词一致。
- **文件夹只用一个词。** 这一步改到的每个字符串都把研究的文件夹叫作「研究文件夹 / research folder」，文件入口叫作「研究文件 / Research files」。批准方案的步骤原文写的是「项目文件」和「项目文件夹」，但方案的对象模型规定「项目」和「工作区」不出现在界面上；之后为文件标签页命名的步骤沿用这一步的用词。
- **文件标签页**的标签名仍是「文件 / Files」。

五个包的单元 spec 以字面文本固定新值，使用各 spec 渲染的语言。引用旧值的浏览器金标准和定位器只改了那几行。另有三个继承来的金标准（`subagent-conversation` 与 `subagent-interrupt`）把子会话的访问模式标签读作 `全自动 · Automatic`，即第 1 步给 `research-auto` 的显示名，此前它们记录的是 `Custom`。两个 `lifecycle-chrome` 入口页金标准也换成了 ui-research 当前的入口页段落，这些段落在金标准录制之后改过。`onboarding-deepseek-config` 中密钥对话框的金标准也按同样方式修改，但没有任何运行会比较它：该场景先要等待上游的欢迎声明，而 ui-research 覆盖了它。`deepseek-messages-settings` 与 `onboarding-usable-provider` 会在浏览器里打开新的对话框。`apps/web/tests/research-workbench.e2e.ts` 用英文读取尚无研究时的入口页（标题、Choose research 标签和兜底提示）、一项研究的空白对话、已完成回复下方的输入框，并用中文读取新研究的入口页。

## 考虑过的其他方案

**直接移除这些行，而不是禁用。** 遥测和 `/feedback` 行属于 base 组合包，headless、ACP 和 SDK profile 都共用它，在那里移除会一并改变这些 profile。Web 的行本可以从 insert 列表中删掉，但禁用的行把这个选择原地写明，部署方也只需一行就能重新打开；这与 Web patch 禁用而不是删掉 agent 层各行的理由相同。

**在 base 组合包中关闭遥测。** 这会改变本产品并不交付的 CLI profile，而且 base 组合包自己的测试固定着上游的默认值。`web` profile 与桌面端组合的正是 Web 组合包。

**由 `ui-research` 覆盖这些控件的 slot 来隐藏它们。** 空的占位只能藏起按钮，插件和它的 Host Remote 仍然挂载，评分仍可能通过别的路径授权上传。禁用的行则两半都不挂载。

**只在桌面子进程里设置这个变量。** Desktop Host 原本不读取 `DSH_TELEMETRY_DISABLED`，只有 CLI 启动器会应用它。只设变量能传到 agent 的进程，却影响不到 Host 自己的组合。

**把所有继承来的金标准改成交付时的行。** 约 75 个继承来的金标准记录了「对话 / 轨迹」标签条，54 个记录了评分按钮，而那些被禁用插件的场景没有这些行就根本无法运行。改写这些金标准会让约 80 个上游场景失去它们要测试的内容；在 Windows 上刷新还会把该平台的失败写进 CI 在 Linux 上比较的金标准。于是继承来的场景继续组合这些行，而科研场景运行并断言交付时的组合。

**由 `ui-research` 替换这些文案（第 2 步）。** locale 服务会拒绝同一命名空间的第二份词典；而为了换几个字去重新注册每个 slot、画出同样的组件，等于把外壳组件复制进科研包。

**连同文字一起改键名（第 2 步）。** `chat.deepDiving`、`hero.chooseWorkspace` 和 `placeholder.workspace` 是外壳组件读取的标识符。换新名字要改组件代码，而界面上看不出任何区别。

**为文案刷新金标准（第 2 步）。** 理由与第 1 步相同，金标准原地修改，只改引用旧值的那几行；刷新改写的也正是这几行。

## 影响

- 只有当用户配置了 DeepSeek 模型，或存入 DeepSeek 密钥时，Web 与 Desktop 组合才会连接 DeepSeek 服务；存入密钥也会启用 `web_search` 背后的 DeepSeek 网页搜索服务。它们运行的任何部分都不会创建 `.anonymous-user-id`。插件设置页已禁用，GUI 中没有网页搜索的开关。
- 产品不再有发送反馈或下载 Session 日志的途径。[SciPaper Harness as an independent product](2026-09-24-scipaper-independent-identity.zh.md) 记录了产品其余的请求身份。
- GUI 不能选择 preset，也不能编辑名录。此前通过已移除的设置分区保存的默认 preset（`agent-presets.default`）会继续生效，GUI 中也看不到它，直到有人修改设置文件。
- 只为已移除的浏览器半边服务的 Host 行 `plugin-inventory` 与 `terminal-controller` 仍然挂载，但不再有使用者。
- 入口页、输入框、文件入口和首次启动对话框不再出现「工作区」，也不再把 DeepSeek 说成产品本身。其他外壳文案仍写着「工作区」，例如工作区列表、目录选择器的标题「选择工作区目录」和权限预设「工作区内修改」，直到替换这些控件的步骤为止。
- 在第 9 步的入口策略落地之前，尚未选定文件夹时「新研究」不会创建研究，而兜底提示正是在这时显示，所以提示里的「新建」指向一个暂时还做不到这件事的按钮；打开列表中已有的研究，或用文件夹标签选择文件夹，都可以用。
- 在交付的组合中仍会显示、并且提到 DeepSeek、Harness 或 DSH 的外壳 locale 字符串，指的都是用户自己选择的模型（模型选择器里 DeepSeek 模型的说明、「模型」设置中 DeepSeek 端点的占位地址）。关于 DeepSeek Harness 0.1 的继承欢迎声明位于 `ui-settings-models`，但 `ui-research` 用一个什么也不渲染的组件占据了这一引导步骤；网页搜索的说明则在已禁用的插件设置页上。模型可见的系统提示词仍把 agent 介绍为由 DeepSeek Harness 驱动（`includeHarnessIdentity`），网页搜索服务缺少密钥时的错误仍指向 Settings > Plugins；两者都不是界面文案。
- 继承来的用户指南（`docs/user/guide`）和上游 Agent Note 仍引用外壳的旧标签，例如 **Choose workspace** 和 `Deep diving...`。
