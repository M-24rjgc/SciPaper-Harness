---
description: "科研版的 Web 与桌面界面：侧栏的研究树、启动与「新研究」落在哪里、入口页的说明行、「试试」示例说法与文件夹菜单、标题栏状态、输入框里的自主程度按钮、只报告的右侧栏研究记录（模式、自主程度、「现在」一行、阶段、检查发现、决策与工具）、右侧栏的实验看板、资料与论点、配图灵感和 draw.io 编辑器标签页、对话里的研究工具卡片、论点原文面板、实验运行与科研设置。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-research

[English](README.md) | 中文

## 概述

在对话旁展示研究，只报告，不掌舵。侧栏列出用户的研究及其对话、示例和其他文件夹。启动时打开用户最近在做的研究，或打开「新研究」也会打开的那一份未动过的草稿。用户查看阶段、发现与决策，打开论点的原文，在实验看板上跟进实验运行，并可在确认后停止一次运行。输入框里的按钮设定研究的自主程度，用于每段对话。模式由助手设定，检查由助手运行；这里没有任何东西会自行开始工作或打开面板。请与 `@deepseek-ai/dsh-research-workbench` 一起挂载。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

把这一行与宿主侧服务一起挂进客户端名单：

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

`hideDeveloperCells`（默认 `false`）遮蔽外壳中在本产品里属于开发者界面的单元格：输入框下方的轮次、步数、token 速率与缓存命中小胶囊，通用设置里的默认权限，以及「打开配置文件」操作不再绘制，输入框的访问模式按钮由研究的自主程度按钮取代，入口页的 Workspace 选择器由研究的文件夹菜单取代，侧栏的 Workspace 浏览器由研究树取代。Host 半边校验它，并作为 `__DSH_RESEARCH__` 全局变量放进 Web 或桌面宿主渲染的每个页面，浏览器半边在应用时读取；除此之外，客户端行的 `config` 到不了任何浏览器插件。

该插件注入 `remote`、`remote.research`、`remote.directoryPicker`、`remote.session`、`slots`、`locale`、`layout`、`sessions`、`workspaces`、`sidebarRight`、`uiWorkspace` 与 `settingsScope`，并通过后者读取 `agent-presets` 设置命名空间。它向 ui-workspace 注册入口策略，只在 ui-workspace 行设置 `entry: policy` 时生效。缺少宿主行时 Remote 不存在，任何注册都不会发生。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

所有界面读取同一份轮询得到的项目、偏好与组件快照，并按会话绑定确定会话所属的项目，否则取包含会话工作目录的最内层项目根目录，因此项目文件夹中的每个对话都会显示它。命令发往宿主 Remote；启动宿主后台任务的命令在任务结束时才算完成。自主程度按钮发送 `set-autonomy`，由宿主应用预设；按钮读取对话的 `permissions` 投影，用来标出用 `/permission` 手动输入的预设。遮蔽别人的单元格无法把位置交还，所以在研究之外这个按钮什么也不画，`/permission` 仍能打开外壳自己的选择器。每个向宿主请求操作的控件各自保留进行中状态与失败提示（`Action.tsx`）；不存在插件级的忙碌标志或错误横幅。它不占主面板：次要工具是各自独立的右侧栏标签页（`research-board`、`research-sources`、`research-gallery`），只从科研标签页、运行卡片或入口行打开；项目文件通过当前显示的对话打开（`dsh-resource://file/session/<id>/<path>`），因为侧栏的文件查看器要经由会话读取文件。

入口策略（`entry.ts`）在没有选中项时，落到用户自己最近用过的研究（不是示例，不是草稿，没有被移出列表，文件夹仍在列表中）上已开始的最新对话；没有这样的对话时落到它文件夹的空白对话；用户没有自己的研究时，调用宿主的 `start-new`。启动时，若恢复的选中项在示例里，也按同样的方式让开。每次打开都等会话列表收录该会话，一旦更新的导航（`layout.beginNavigation`）或选中项取代了它就放弃。移动草稿（`relocate`）时宿主会在答复前归档草稿的对话，所以移动进行中失去的选中项归这次移动处理，`land()` 什么也不做；移动随后通过文件夹位置自己的 `onPick`（在选择「更改位置…」时捕获）把输入框里的草稿和附件带过去，结束后若没有选中项再落地。

研究树（`ResearchTree.tsx`，各行由 `treeValues.ts` 推导）以优先级 -1 占据侧栏的浏览位置。外壳的 Workspace 浏览器仍注册在下面，所以它的 `sidebar.workspaces.directoryFlow` 子插槽一直为文件夹选择器保持声明。一段对话属于它绑定的研究，或文件夹包含它工作目录的研究；否则属于列出它的 Workspace 所在的研究；否则作为没有研究的文件夹（其他文件夹）里的对话；再否则不属于任何文件夹。已归档的对话、子会话和视觉检查的审阅对话从不成行。移出列表（`archived`）的研究连同它的对话一起隐藏，它的文件夹也不算没有研究的文件夹。某项研究的对话在等待批准、计划审阅或问题回答时，或它的某个目标受阻时，这一行显示提醒色圆点；它的对话、目标或实验有在推进的时候，显示进行中的蓝色圆点；标题栏状态标签的圆点读的是同一套（`activity.ts`）。点击研究会打开它已开始的最新对话，没有时打开它文件夹的空白对话（示例里从不这样做）。「＋ 新对话」复用或新建空白对话。菜单发送 `rename` 和 `archive-project`，通过会话与 Workspace 控制器重命名、归档对话，并通过 `create` 把文件夹设为研究。搜索即时匹配名称和标题，并在 250 毫秒后通过 `sessions.search` 搜索对话内容。哪些行已展开保存在研究树自己的 store 里，所以收起到窄栏后也不会丢。

含文字或附件的未发送对话会作为草稿保留在研究树中，显示文字首行或附件数量。已保存的文字在输入框挂载前即可显示；非当前且没有内容的空白对话仍然隐藏。未动过的研究草稿仍是单独一行「新研究」。

| 模块 | 画出什么 |
| --- | --- |
| `Hero.tsx` | 空会话入口与科研标签页上的烧瓶标志 |
| `Header.tsx` | 对话标题栏里的研究状态标签：「模式待定」、只有模式（通用）、`{模式} · {阶段} n/m`、`{模式} · 已完成 ✓` 或 `{阶段}已推迟`，示例前面加「示例 ·」，并带上这项研究的圆点；点击打开科研标签页，面板正显示这个标签页时点击则收起面板 |
| `AutonomyChip.tsx` | 输入框访问模式位置上的研究自主度：`检查点 ▾` 或 `全自动 ▾` 及两项选择的菜单；对话在另一个预设下运行时显示 `本对话：<预设>`，示例中显示 `示例 · 只读` |
| `Rail.tsx` | 科研标签页（研究记录）：研究及其文件夹，带「在资源管理器中打开」；记下的模式、由谁选定，以及只往草稿里加一句话的「想换模式？」；自主程度（只读）；「现在」一行，先说等你处理或正在推进的事，再说下一步，并提供「跳过去」或一句可在对话中提出的话；宿主 `standing` 给出的阶段与待处理问题及检查时间；最新的三条决策；「资料 · 论点 · 文件 · 实验」计数和工具行，每个都在旁边打开一个标签页；以及对话没有使用科研助手、或设置里把另一个 Agent 预设存成默认时的提示，带「改回科研助手」 |
| `activity.ts` | 为「现在」一行和圆点推导一项研究此刻的动态：它第一段等你处理的对话、快照带来的目标（`goals`）、在运行的对话和实验 |
| `presets.ts` | 科研助手的 Agent 预设（`agent-presets` 命名空间的组合默认值），以及为新对话取代它、保存在设置里的 `default` |
| `entry.ts` | 入口策略：启动、失去选中项与「新研究」落在哪里，以及把草稿移到某个文件夹或另一项研究 |
| `EntryScreen.tsx` | 入口页标题下的一行（`新对话 · {模式} · {阶段} n/m · 研究记录`、`示例研究 · 只能查看`，以及入口页的提示），和未动过的草稿输入框为空时上方的两句「试试」示例说法，点击只会加进草稿 |
| `FolderMenu.tsx` | 文件夹按钮的菜单：保存在 <路径>；未动过的草稿可「更改位置…」（宿主的文件夹选择窗口，宿主没有时输入路径）；宿主支持时「在资源管理器中打开」；「换到另一项研究」；以及所选文件夹的情况（已经是研究、在某项研究里面、已有文件、在示例之中） |
| `ResearchTree.tsx`、`treeValues.ts`、`treeStore.ts` | 侧栏的研究树：按最近使用排列的自己的研究及其进度与圆点，它们的对话和「＋ 新对话」，「示例」与「其他文件夹」两组，行菜单（重命名、在资源管理器中打开、移出列表、设为研究…），搜索，以及收起的窄栏里的搜索按钮 |
| `ClaimSheet.tsx` | 一条论点，以及它脚下的每一份原文，覆盖整个界面，只在它所属的项目里查找 |
| `RunPanel.tsx`、`MetricsGrid.tsx`、`StopRun.tsx` | 输入框上方这段对话提交的实验（按它们的 `sessionId`）及其指标，以及确认后停止一次运行；空白对话里没有未结束的运行时什么都不画，示例里只有「日志」和「看板」 |
| `Tabs.tsx` | 对话旁的实验看板与配图灵感标签页，各自显示这段对话所属的研究，示例只能查看；以及这些标签页的标题 |
| `Sources.tsx` | 「资料」标签页：每份资料的作者与年份（从它的文献记录读取）、DOI 和研究手里有它的什么，可在侧栏的查看器里打开资料或它的全文；带状态的论点，每条打开论点面板；为论点打开时滚动到论点 |
| `Diagram.tsx` | `.drawio` 文件地址的 draw.io 编辑器（优先于文本查看器）：通过 `read-artifact` 载入研究的文件，研究记录还不认识的文件先登记；按载入时的版本通过 `save-artifact` 保存；提供组件安装，装好后重新载入框架；示例的图打开后不保存 |
| `Brand.tsx` | 原生侧栏品牌行里的产品标志与名称 |
| `examples.ts` | 让示例研究里每段对话的输入框保持不可输入；标题栏状态标签、科研标签页和研究树会标出示例 |
| `ResearchToolView.tsx`、`toolCallValues.ts` | `research_*` 工具在 `tool.call.toolview` 按键注册的卡片，由每次记录下的调用与结果推导：一行写明工具和这次调用做了什么（`研究资料 · 导入 3 个文件`），原始调用收在行后，失败原因就地显示；`research_check` 则是一张卡片，写明范围、通过或未通过及计数、前三组发现，报告表明文件在磁盘上时文件可点开，检查的原话收在「详细信息」后。研究记录只负责命名（阶段、检查名称、路线）并给出研究文件夹 |
| `Action.tsx`、`EmptyCell.tsx` | 单个控件自己的进度与失败提示；用来遮蔽输入框统计信息、默认权限设置与“打开配置文件”操作的空单元 |
| `Board.tsx`、`BoardBlocks.tsx`、`LineChart.tsx`、`boardValues.ts` | 实验看板：在跑的运行、机器、按实时记录解析的 agent 分区、所有运行，以及折线图；状态待确认的运行在它的卡片上重新连上或标为知道了，不论是哪段对话提交的；示例的看板是上次读取的结果，只读一次，不提供读取控件，也不提供运行操作 |
| `Gallery.tsx` | 配图灵感：筛选条件、顶会 Figure 1 网格，以及把一张图存为 `figures/refs/` 下的参考图（示例里不行）。请求期间暂停加载更多；分页延续最近一次成功的查询 |
| `ResearchSettings.tsx`、`EnvironmentForm.tsx` | 研究存放位置、研究树是否列出示例（显示示例研究）、移出列表的研究及「恢复」（已移出的研究）、模型分工、托管组件、已绑定的环境 |
| `Onboarding.tsx` | 跳过 harness 首次运行时的内测声明 |
| `contract.ts`、`format.ts`、`locales.ts` | 注入面、会话到项目的解析、格式化，以及 `en` 与 `zh` 两份全部文案 |

所有文案由词典拥有，遵循[客户端 UI 文案归属词典](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)决策。

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the commands and records its controls write: the autonomy chip sends `set-autonomy`, the host applies `research-auto` or `workspace-write` to every conversation of the research, and autonomy lands in the host ledger that the agent reads with `research_project current`. Suggested sentences (the entry screen's Try sentences, a plot request from a finished run, the research record's 想换模式？ and 在对话中提出 sentences) are appended to the composer draft and reach the model only when the person sends them. 改回科研助手 (Use the research assistant again) removes a saved `agent-presets.default`, so conversations created afterwards compose from the research preset.

#### KV Cache effect

不直接使任何缓存失效；权限与科研工具的使用方各自负责请求前缀的变化。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

以下是这个包当前的约束，不是任务清单。

未发布运行时不变量配套插件，因为这个包不持有任何可独立观察的关系：它渲染宿主拥有的快照，而每一次注册都是插槽注册表已负责释放的 effect。

- **浏览器中没有原文正文**——宿主从每份快照中去掉证据文本；论点面板展示宿主在写入时校验过的引文。
- **指标在结束时到达**——运行中的实验显示它的进度记录（没写进度记录时显示已用时长），指标在运行结束后出现。
- **没有设置深链**——设置面板没有面向插件的打开接口，因此科研标签页只说明去哪里管理环境。
- **不提供示意图导出**——draw.io 编辑器保存 `.drawio` 文件，不提供把示意图导出为 PDF 的功能。
- **看板的宽度只是首次打开的建议**——实验看板和配图灵感建议 560 px，科研标签页和「资料」建议 320 px，`layout.setInitialRightbarWidth` 只在面板还没有宽度时采用；此后标签页按面板现有的宽度打开，停靠栏的全屏会让它占满整个界面。
- **文件标签页里没有文件操作**——外壳的文件标签页没有放单个文件操作的位置，所以单个文件没有「在资源管理器中打开」或「用默认程序打开」；文件夹菜单和研究树可以在资源管理器中打开研究文件夹。
- **draw.io 保存可能遇到过期的版本**——已登记的图若在上次记录之后被研究工具以外的方式改过，保存时会显示为更新的版本，保存会被拒绝，直到这个文件再次被记录（编译时，或助手登记它时）。
- **宿主没有文件夹选择窗口时输入路径**——在 browse 目录选择器下（远程浏览器、经 SSH 启动），「更改位置…」和「研究存放位置」要输入绝对路径；外壳的应用内文件夹浏览器属于被文件夹菜单取代的 Workspace 选择器。
- **入口提示只显示在它自己的界面上**——在已开始的对话界面上点「新研究」失败时，没有入口行显示这个失败；ui-workspace 会把它记入日志。
- **研究树不能拖动排序**——研究和对话按最近使用排列；被遮蔽的 Workspace 浏览器里的手动顺序不再适用。
- **单独恢复的对话仍然隐藏**——移出列表的研究里的某段对话，若从外壳的已归档对话列表里单独恢复，它仍属于那项隐藏的研究，在研究恢复之前哪里都不显示。
- **只有已加载的对话会报告目标**——圆点和「现在」一行通过宿主的目标服务读取目标，而它只看得到已加载的对话；没人加载过的对话里的目标什么也不显示。
- **没记下对话的运行只在看板上**——桌面端提交的运行，或运行开始记录对话之前记下的运行，在任何对话里都没有卡片；看板会列出它，状态待确认时在看板上重新连上或标为知道了。
- **科研助手就是部署的默认预设**——对话用 `agent-presets` 行的 `default` 组合时才算使用科研助手；换了 id 的同一份预设副本会被当作别的预设。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

从仓库根目录运行的局部检查：

```sh
pnpm exec tsc -p packages/client/ui-research/tsconfig.json --noEmit --composite false --incremental false
pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-research
pnpm exec vitest run --config vitest.config.ts packages/client/ui-research
```

</details>
