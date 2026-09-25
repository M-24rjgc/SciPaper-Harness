---
description: "科研版的浏览器界面：空会话项目入口、标题栏状态、只报告的右侧栏科研标签页（自主度、阶段、检查发现、决策与工具）、论点原文面板、实验运行与实验看板、项目文件面板与科研设置。"
kind: "package-plugin"
---

# @deepseek-ai/dsh-client-ui-research

[English](README.md) | 中文

## 摘要

在对话旁展示科研项目，只报告，不掌舵：用户查看阶段、发现与决策，打开论点的原文，在实验看板上跟进实验运行，并可在确认后停止一次运行。这里唯一可改的设置是自主度，选择它时会同时选用 `research-auto` 权限预设。模式由助手设定，检查由助手运行；这里没有任何东西会自行开始工作或打开面板。每个控件显示自己的进度与失败原因。请与 `@deepseek-ai/dsh-research-workbench` 一起挂载。

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

`hideDeveloperCells`（默认 `false`）遮蔽外壳中在本产品里属于开发者界面的单元格：输入框下方的轮次、步数、token 速率与缓存命中小胶囊，通用设置里的默认权限，以及「打开配置文件」操作。Host 半边校验它，并作为 `__DSH_RESEARCH__` 全局变量放进每个服务出去的页面，浏览器半边在应用时读取；除此之外，客户端行的 `config` 到不了任何浏览器插件。

该插件注入 `remote`、`remote.research`、`remote.directoryPicker`、`slots`、`locale`、`layout`、`sessions`、`sidebarRight` 与 `uiWorkspace`。缺少宿主行时 Remote 不存在，任何注册都不会发生。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

所有界面读取同一份轮询得到的项目、偏好与组件快照，并按会话绑定确定会话所属的项目，否则取包含会话工作目录的最内层项目根目录，因此项目文件夹中的每个对话都会显示它。命令发往宿主 Remote；启动宿主后台任务的命令在任务结束时才算完成。自主度控件的 `/permission` 行通过会话自身的命令通道提交，与原生选择器的做法相同。每个向宿主请求操作的控件各自保留进行中状态与失败提示（`Action.tsx`）；不存在插件级的忙碌标志或错误横幅。

| 模块 | 画出什么 |
| --- | --- |
| `Hero.tsx` | 空会话入口与科研标签页上的烧瓶标志 |
| `Header.tsx` | 对话标题栏里的项目状态标签；点击后打开科研标签页 |
| `Rail.tsx` | 科研标签页：自主度、宿主 `standing` 给出的阶段与待处理问题及检查时间、决策、计数，以及工具行（实验看板、配图灵感、研究文件） |
| `NewProject.tsx`、`ProjectEntry.tsx` | 带模式与自主度的项目创建，以及侧栏项目列表 |
| `ClaimSheet.tsx` | 一条论点，以及它脚下的每一份原文，覆盖整个界面，只在它所属的项目里查找 |
| `RunPanel.tsx`、`MetricsGrid.tsx`、`StopRun.tsx` | 输入框上方已提交的实验及其指标，以及确认后停止一次运行 |
| `Workbench.tsx` | 项目自身的文件：资料、稿件与示意图编辑器、运行、导出；保存从不覆盖二进制文件 |
| `examples.ts` | 让示例研究里每段对话的输入框保持不可输入；标题栏状态标签、科研标签页和项目列表会标出示例 |
| `Action.tsx`、`EmptyCell.tsx` | 单个控件自己的进度与失败提示；用来遮蔽输入框统计信息、默认权限设置与“打开配置文件”操作的空单元 |
| `Board.tsx`、`BoardBlocks.tsx`、`LineChart.tsx`、`boardValues.ts` | 实验看板标签页：在跑的运行、机器、按实时记录解析的 agent 分区、所有运行，以及折线图 |
| `Gallery.tsx` | 「配图灵感」标签页：筛选条件、顶会 Figure 1 网格，以及把一张图存为 `figures/refs/` 下的参考图 |
| `ResearchSettings.tsx`、`EnvironmentForm.tsx` | 模型分工、托管组件、已绑定的环境 |
| `Onboarding.tsx` | 跳过 harness 首次运行时的内测声明 |
| `contract.ts`、`format.ts`、`locales.ts` | 注入面、会话到项目的解析、格式化，以及 `en` 与 `zh` 两份全部文案 |

所有文案由词典拥有，遵循[客户端 UI 文案归属词典](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)决策。

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the commands and records its controls write: the autonomy control submits `/permission research-auto` or `/permission workspace-write` through the session's command path, and autonomy lands in the host ledger that the agent reads with `research_project current`. Suggested sentences (a plot request from a finished run) are appended to the composer draft and reach the model only when the person sends them.

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
