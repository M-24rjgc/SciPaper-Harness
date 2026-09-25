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

### 第 3 步：科研界面不再毁坏文件，也不再自作主张

改动在 `ui-research` 和科研宿主里，外壳代码不变。

- **保存不会清空二进制文件。** `writeArtifact` 在读写任何内容之前就拒绝对二进制文件执行 `save-artifact`，无论谁发起。判断方式：按扩展名（图片、PDF、压缩包、Office 文档、字体、数组文件），或者在其他文件名下，文件前 8 KiB 含有 NUL 字节（`files.ts` 中的 `isBinaryFile`）。`read-artifact` 对这类文件返回 `binary: true` 且不带文本，文件面板随之不显示编辑器，并禁用「保存」。在输入任何内容之前「保存」也不可用，因此默认的新文件路径不会被写成空文件。
- **不再自己打开或启动任何东西。** 原先只要科研对话一挂载就打开科研标签页的 dock 已移除；什么也不做的入口卡片、承诺行，以及输入框上方的论点与图卡片也一并移除。科研标签页只从标题栏的状态标签打开。标题栏的「项目文件夹」「实验看板」「配图灵感」三个按钮移到标签页的工具行，与研究文件并列。
- **侧栏只报告。** 它去掉了模式选择、「运行检查」「推进流程」，以及从未真正探测、却显示「已就绪」的环境块。模式由助手设定，检查由助手运行，目标由助手推进。自主度选择先保留在侧栏，第 8 步再移到输入框下方。只有当路线含实验阶段或已有运行时，才显示「实验」一行。
- **每个控件各自显示进度与失败。** 插件级的 `busy` 与 `error` 已移除：`useAction`（`Action.tsx`）让每个控件有自己的进行中状态，并在旁边显示失败原因。`run` 会跟随宿主后台任务直到结束，因此控件的进行中状态与实际工作一样长，失败的任务会显示它的消息。
- **运行。** 「停止」会先问一次：确认取消这次实验？停止后无法继续。（`StopRun.tsx`）。排队中的运行显示为灰色的「排队中」，不再显示为「运行中」。「用它画图」把句子追加到输入框里，不再覆盖已输入的内容。
- **较小的修正。**
  - 论点面板只在论点所属的项目里查找它，因为论点 id 只在项目内唯一。
  - 打开对话时，最多等待五秒，直到会话列表里出现它，否则打开该研究文件夹的空白对话；此前卡片可能抛出 `unknown session`。
  - 设置去掉了「主模型」：它能保存，却从未被读取。
  - 从未探测过的环境状态不再显示标签。
- **遮蔽开发者单元格。** 空占位替换了输入框下方的轮次、步数、token 速率与缓存命中小胶囊（`conversation.composer.dock#stats`），通用设置里的默认权限（`settings.general.item#permission`，它由研究的自主度决定），以及「打开配置文件」操作（`settings.action#open-document`）。只有当 `ui-research` 的 `hideDeveloperCells` 为 true 时才注册这些占位，Web 组合包在它的行上设了这个值。客户端行的 `config` 只会到达包的 Host 半边，所以由这一半校验它，并作为 `__DSH_RESEARCH__` 全局变量放进每个服务出去的页面，做法与 `client-connection` 把重连时序交给浏览器相同；浏览器半边在应用时读取它。Web e2e 脚手架为继承来的场景把它关掉（与第 1 步的那些行一起），因此它们的金标准仍保留这些小胶囊。

### 第 4 步：一种含义一种颜色

品牌、按钮、业务强调色、成功色和链接原本是同一种青绿色，所以「已完成」「运行中」「建议」和「在这里操作」看起来一模一样。科研主题（`ui-theme/src/styles/research.css`）现在给每种含义各自的 token，科研界面按含义使用它们。

| 含义 | Token | 浅色 | 深色 |
|---|---|---|---|
| 品牌，以及在哪里操作：烧瓶标志、发送、焦点框、选中 | `brand-primary`、`state-business-*`（外壳的强调色）、`button-info-*` | 青绿 `#15635f` | 青绿 `#7bc4bb`，发送 `#3f8f86` |
| 经检查或证据核实 | `state-success-*` | 绿 `#3b7a1f`，底 `#e9f2e1` | `#98c46a`，底 `#26331d` |
| 进行中 | `state-ongoing-*`，新增的别名（基础主题 `deepseek-450` / `-100`，深色 `-400` / `-800`） | 蓝 `#3366cc`，底 `#e8eefa` | `#8fb0e6`，底 `#26324a` |
| 需要用户处理 | `state-warn-*` | 陶土色，不变 | 不变 |
| 已完成、待进行、中性 | `label-secondary`、`label-tertiary`、`border-l4` | — | — |

- **各自用在哪里。** 运行中的标记、进度条、侧栏的运行中标签和看板的实时指示使用进行中的蓝色。已完成的阶段和已结束的运行是中性色；运行中的运行，其标签为中性，旁边是蓝色标记。焦点框和选中状态使用品牌色。装饰性的标记（论点面板的缩略图与引文竖线）为中性，迷你折线图使用第一个图表颜色。
- **外壳 CSS。** fork 自己的侧栏覆盖样式把「新研究」从实心按钮改成浅色底（强调色的浅底配品牌色文字），让输入框拥有唯一的实心按钮。侧栏和入口页的烧瓶标志从 `state-success` 改为 `brand-primary`（`SidebarRoot.module.css`、`HeroShell.module.css`）。
- **对比度。** 浅色下每种状态色在自己的浅底上文字对比度不低于 4.6:1，在页面上不低于 5:1；深色下不低于 5.8:1。深色的发送按钮，白色图标对比度为 3.8:1。
- **颜色从来不是唯一的信号。** OKLab 检查（`validate_palette.js`）中蓝色与青绿色的差值为 ΔE 18，可以通过。绿色与青绿色为 12.8，这已是贴着这种青绿色的绿色能达到的最大差值。在红色弱下绿色与陶土色很接近，深色主题在绿色弱下几乎一样。因此每个「已核实」标记都带 ✓ 或文字，每个「需要你处理」标记都带文字，运行中的标记都带标签。

### 第 5 步：示例说明自己是示例，也没有任何东西写进它们

示例研究（`<数据目录>/demo`，由 `research-demo.e2e.ts` 生成）看起来和用户自己的研究一样：启动时会打开它们，里面的决策显示为「你」，一段对话或一次检查也能写进去。

- **标记。** `isExampleRoot(root)`（`files.ts`）用的正是生成器自己的规则：根目录位于 `<数据目录>/demo` 之内。`publicProject` 和 `projectBrief` 会加上 `example: true`；这个标记不存储，所以不会改动任何示例文件或记录。生成器让宿主运行在隔离的数据目录下，却把示例写在另一个目录下，因此在它生成示例时，这条规则不会命中。
- **宿主防护（纵深防御）。** 对示例执行任何会记录内容的命令，`execute` 都会拒绝，无论来自用户还是 agent，并提示 `这是示例研究，只能查看 / This is an example research and is read-only`。拒绝发生在任何耗时工作之前，被拒绝的编译不会在示例的文件夹里运行 TeX。读取照常可用。检查会运行并返回结果，但不保存。`board-update` 与 `board-refresh` 被拒绝，`board-view` 从不刷新，因此不会写入看板缓存。无论经由什么路径，`mutate` 都拒绝修改示例的记录；后台观测跳过示例里的运行；`create` 对已有的示例原样返回、不绑定会话，但不会在示例目录中新建研究或文件夹。
- **在浏览器里。**
  - 标题栏状态标签以虚线框的「示例 ·」开头。
  - 科研标签页顶部有一条说明：示例研究：随应用提供的演示，只能查看。以用户名义存储的回答显示为「示例作者」，因为那从来不是读者本人的回答。自主度选择不可操作。
  - 侧栏把示例排在用户自己的研究之后，并各自标上「示例」。
  - `guardExampleComposers`（`examples.ts`）通过 `conversation.blocks` 让示例里每段对话的输入框保持不可输入，并显示：这是示例研究，只能查看。点「新研究」开始你自己的研究。每个会话只有一个阻挡位，`ui-model-selection` 也会设置和清除它，因此只要别的插件清除了阻挡，守卫就会重新放上自己的阻挡。

### 第 6 步：进展只有一份记录

侧栏的阶段、标题栏状态标签和 agent 的项目简报读的都是 `lastCheck`，即最近一次报告，不论它的范围，所以一次阶段检查会顶替全文检查，「检查通过」旁边还摆着没完成的阶段。现在 `research_check` 只维护一份进展记录，由一个宿主函数说明研究的现状。

- **报告写明运行了什么。** 每份 `CheckReport` 带有 `gatesRun`，每个阶段带有 `unmet` 键：先是未满足要求的键（`requirementKey`，由条件构成，在阶段内唯一），再是每个有错误的决定性检查对应的 `errors:<check>`。英文的 `missing` 行留给模型。同时是阶段名和基础检查名的 scope（例如 spark-to-paper 的 `cite`）指阶段，并运行它的门禁，这也正是报告的筛选早已假定的。发现所指的文件不在磁盘上时，这条发现不再带文件和行号，CCFA 指向不存在的 `submission/checks.md` 的链接因此消失。
- **合并规则。** `mergeProgress`（`progress.ts`）把每份报告并入 `project.progress`：只有报告运行了决定某阶段的全部门禁，该阶段才会变化；报告运行过的每项检查整体替换它的发现；`full` 只来自 scope 为 `all` 的检查；模式或路线不同的报告让进展重新开始。`research_check` 是唯一的写入方：`export` 仍把自己的报告放进投稿包，但不记录任何内容。`lastCheck` 仍会写入。
- **读取时补种。** 没有 `progress` 的记录，会把它 scope 为 `all` 的 `lastCheck` 读作进展（`storedProgress`）。旧报告的英文行按要求的 message 或检查给出的原因文字对应到要求上，`N error(s) in …` 对应到错误键，因此随应用提供的示例无需修改任何示例文件或记录，就能显示各阶段和提示。存储报告的 schema 把缺失的 `gatesRun` 或 `unmet` 读作空。
- **现状。** `standing(project)` 推导出各阶段（done、current、pending 或 deferred，带检查点标记和模式包的提示）、下一阶段及其第一条提示、`finished`、`checkedAt`、`changedSinceCheck`，以及按检查分组的待处理问题。文件时间取 `.research`、`exports`、`.git` 与 `node_modules` 之外最新的修改时间，每个根目录缓存 30 秒（`FileTimes`），超过 5,000 个文件时为 `unknown`；unknown 永远不算已完成。`snapshot()` 像 `publicProject` 加上 `example` 那样给每个项目加上它，从不存储。`projectBrief` 的阶段（`state`、`checkpoint`，以及由提示得出的 `missing`）、下一阶段、提示和已推迟的阶段都取自它，另外加上 `checkedAt`、`changedSinceCheck`、`finished` 和 `paperRoot`。`scripts/gen-cordis-catalog.ts` 把 `ResearchStanding` 与其他由 `types.ts` 说明的科研记录类型列在一起。
- **模式包。** 每条要求带 `hint: {en, zh}`，每个门禁带 `label: {en, zh}`，每个模式包带 `paperRoot`（general 和 CCFA 为 `paper`，CCFA 的技能写的是 `paper/main.tex`；spark-to-paper 为 `.`）；三者都是必填项。spark-to-paper 的实验阶段声明 `deferrable: experiments-deferred`，模式包声明 `reviewAgainst: "sections/*.tex"`，因此拼装 `main.tex` 不会让评审过期。基础检查有内置名称（`CHECK_LABELS`）。
- **决策键。** `record-decision` 接受可选的 `key` 短标识，并存进这条决策。可推迟的阶段在未完成、且有决策带上它的键时处于推迟状态。推迟的阶段永远不算完成；阶段自己的检查通过时它就是已完成，不论是否推迟过。
- **在浏览器里。** `Rail.tsx` 按现状绘制：已完成是中性色的 ✓，当前阶段是 `brand-primary` 色的圆环，未开始是空心标记，「已推迟」用警示色，检查点阶段注明「开始前会先问你」，当前阶段下方是模式包自己的提示，下面是「检查于 {相对时间}」以及「检查后有改动」。「待处理」最多列出三组，用读者的语言命名（引用 · 2 个错误）；只有宿主在磁盘上找到了文件，这一组才能打开它，检查自己的原话收在「详细信息」里。`standingText` 显示为 `{mode} · {phase} {done}/{total}`，完成时为 `{mode} · 已完成 ✓`，推迟阶段之前已无待做阶段时为 `{mode} · 实验已推迟`，每个阶段都已完成但论文还没完成时为 `{mode} · 待复查`。

## 考虑过的其他方案

**直接移除这些行，而不是禁用。** 遥测和 `/feedback` 行属于 base 组合包，headless、ACP 和 SDK profile 都共用它，在那里移除会一并改变这些 profile。Web 的行本可以从 insert 列表中删掉，但禁用的行把这个选择原地写明，部署方也只需一行就能重新打开；这与 Web patch 禁用而不是删掉 agent 层各行的理由相同。

**在 base 组合包中关闭遥测。** 这会改变本产品并不交付的 CLI profile，而且 base 组合包自己的测试固定着上游的默认值。`web` profile 与桌面端组合的正是 Web 组合包。

**由 `ui-research` 覆盖这些控件的 slot 来隐藏它们。** 空的占位只能藏起按钮，插件和它的 Host Remote 仍然挂载，评分仍可能通过别的路径授权上传。禁用的行则两半都不挂载。

**只在桌面子进程里设置这个变量。** Desktop Host 原本不读取 `DSH_TELEMETRY_DISABLED`，只有 CLI 启动器会应用它。只设变量能传到 agent 的进程，却影响不到 Host 自己的组合。

**把所有继承来的金标准改成交付时的行。** 约 75 个继承来的金标准记录了「对话 / 轨迹」标签条，54 个记录了评分按钮，而那些被禁用插件的场景没有这些行就根本无法运行。改写这些金标准会让约 80 个上游场景失去它们要测试的内容；在 Windows 上刷新还会把该平台的失败写进 CI 在 Linux 上比较的金标准。于是继承来的场景继续组合这些行，而科研场景运行并断言交付时的组合。

**由 `ui-research` 替换这些文案（第 2 步）。** locale 服务会拒绝同一命名空间的第二份词典；而为了换几个字去重新注册每个 slot、画出同样的组件，等于把外壳组件复制进科研包。

**连同文字一起改键名（第 2 步）。** `chat.deepDiving`、`hero.chooseWorkspace` 和 `placeholder.workspace` 是外壳组件读取的标识符。换新名字要改组件代码，而界面上看不出任何区别。

**为文案刷新金标准（第 2 步）。** 理由与第 1 步相同，金标准原地修改，只改引用旧值的那几行；刷新改写的也正是这几行。

**只按扩展名识别二进制文件（第 3 步）。** 名字不常见的数据集或检查点文件仍会被清空。NUL 字节探测最多读取 8 KiB，而文本文件从不含 NUL 字节。

**把 `state-business` 改指蓝色来表示运行中（第 4 步）。** 外壳在约 30 处把 `state-business` 当作强调色（光标、待处理圆点、悬停规则、引用标签、焦点框），光标和所有强调色都会变成运行中的蓝色。改由新增的 `state-ongoing` 别名表示进行中的工作。

**采用方案里的绿色 `#2e7d4f`（第 4 步）。** 它与品牌青绿色在浅色下只差 ΔE 7，深色下只差 5.6，「已核实」和品牌会被看成同一种颜色；叶绿色能把两者分开。

**在记录里存示例标记，或用 `/permission read-only` 标记示例（第 5 步）。** 存储标记就得修改每一条示例记录，而这些记录归生成器所有。权限预设会往示例的会话日志里追加事件，而且仍挡不住宿主自己的命令写入。由文件夹位置推导标记，两者都不需要。

**保留一个错误横幅，并在每次操作时清除（第 3 步）。** 面板上方的横幅不告诉人是哪个按钮失败了，两个同时进行的操作还会互相覆盖消息。每个控件旁边一行失败提示，就不需要任何清除规则。

**按范围各存一份报告，或只让 scope 为 `all` 的检查写入（第 6 步）。** 按范围存报告，每个读取方都得自己判断每个阶段以哪份为新。只让 `all` 写入，又会丢掉 agent 在每个阶段末尾运行的阶段检查。按运行过的门禁合并，阶段检查仍然有用，也永远不会凭不完整的证据把阶段标为完成。

**按位置给要求编号（第 6 步）。** 模式包一改，序号就会指向另一条要求，存储的进展会显示错误的提示。由条件构成的键不怕调整顺序，条件改了也只是失去提示。

**在存储迁移中补种进展（第 6 步）。** `migrateProject` 运行时拿不到模式注册表，无法把旧报告的英文行对应到要求键上。在解析出模式的地方补种就可以，而且在下一次检查之前不改动任何存储的记录。

**让推迟算作完成（第 6 步）。** 那样论文会在结果格还是「--」的时候显示「已完成」（D18）。

**把评审移到 latex 阶段之后（第 6 步）。** 这会打乱 ts-paper 的阶段顺序。拿评审与它读过的章节比较，不论重新编译多少次都成立。

## 影响

- 只有当用户配置了 DeepSeek 模型，或存入 DeepSeek 密钥时，Web 与 Desktop 组合才会连接 DeepSeek 服务；存入密钥也会启用 `web_search` 背后的 DeepSeek 网页搜索服务。它们运行的任何部分都不会创建 `.anonymous-user-id`。插件设置页已禁用，GUI 中没有网页搜索的开关。
- 产品不再有发送反馈或下载 Session 日志的途径。[SciPaper Harness as an independent product](2026-09-24-scipaper-independent-identity.zh.md) 记录了产品其余的请求身份。
- GUI 不能选择 preset，也不能编辑名录。此前通过已移除的设置分区保存的默认 preset（`agent-presets.default`）会继续生效，GUI 中也看不到它，直到有人修改设置文件。
- 只为已移除的浏览器半边服务的 Host 行 `plugin-inventory` 与 `terminal-controller` 仍然挂载，但不再有使用者。
- 入口页、输入框、文件入口和首次启动对话框不再出现「工作区」，也不再把 DeepSeek 说成产品本身。其他外壳文案仍写着「工作区」，例如工作区列表、目录选择器的标题「选择工作区目录」和权限预设「工作区内修改」，直到替换这些控件的步骤为止。
- 在第 9 步的入口策略落地之前，尚未选定文件夹时「新研究」不会创建研究，而兜底提示正是在这时显示，所以提示里的「新建」指向一个暂时还做不到这件事的按钮；打开列表中已有的研究，或用文件夹标签选择文件夹，都可以用。
- 在交付的组合中仍会显示、并且提到 DeepSeek、Harness 或 DSH 的外壳 locale 字符串，指的都是用户自己选择的模型（模型选择器里 DeepSeek 模型的说明、「模型」设置中 DeepSeek 端点的占位地址）。关于 DeepSeek Harness 0.1 的继承欢迎声明位于 `ui-settings-models`，但 `ui-research` 用一个什么也不渲染的组件占据了这一引导步骤；网页搜索的说明则在已禁用的插件设置页上。模型可见的系统提示词仍把 agent 介绍为由 DeepSeek Harness 驱动（`includeHarnessIdentity`），网页搜索服务缺少密钥时的错误仍指向 Settings > Plugins；两者都不是界面文案。
- 继承来的用户指南（`docs/user/guide`）和上游 Agent Note 仍引用外壳的旧标签，例如 **Choose workspace** 和 `Deep diving...`。
- 想做检查、推进流程或换模式时，用户现在在对话里向助手提出。
- 在第 9 步之前，「新建项目目录…」胶囊按钮和输入框里的文件夹按钮仍是把研究放进指定文件夹的仅有的直接途径。
- 示例不能继续推进，即使是正打开它的用户也不行；复制一份示例留给新手引导来做（`复制为我的研究`）。在第 9 步之前，启动时仍可能进入示例，但现在它会说明自己是示例。
- 外壳自身的成功标记（已完成的待办、diff 的新增行、连接指示）在科研版中现在显示为「已核实」的绿色，这正是它们约定俗成的含义。
- 侧栏、标题栏状态标签和项目简报说法一致，因为三者读的是同一份现状。阶段检查只改变它运行过门禁的那些阶段，全文汇总只随全文检查变化。
- 文件超过 5,000 个的项目永远不会显示为已完成，也永远不显示「检查后有改动」。每次快照对已检查过的项目最多每 30 秒列一次文件。
- 在 spark-to-paper 中，`research_check scope: cite` 和 `figures` 现在也会运行该阶段的门禁。
- 缺少提示、门禁名称或 `paperRoot` 的模式包不再加载。
- `lastCheck` 仍会写入，但不再有读取方；早期版本存下的任务结果保留它们原有的报告字段。
- 在第 7 步之前，人设和技能都不提决策键；agent 只能从工具说明里知道它。在第 8 步之前，侧栏仍保留自主度选择；在第 11 步之前，侧栏还没有「现在」一行。
