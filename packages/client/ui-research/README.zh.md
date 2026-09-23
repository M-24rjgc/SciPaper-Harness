---
description: "科研版的浏览器界面：空会话项目入口、标题栏状态、右侧栏科研标签页（模式、自主度、阶段、检查发现与决策）、论点原文面板、实验运行、项目文件面板与科研设置。"
kind: "package-plugin"
---

# @deepseek-ai/dsh-client-ui-research

[English](README.md) | 中文

## 摘要

在对话旁展示科研项目，并让用户掌舵：选择模式与自主度、运行检查、启动流水线、查看阶段、发现与决策、打开论点的原文、跟进实验运行，以及编辑、编译和导出项目文件。选择全自动自主度时会同时选用 `research-auto` 权限预设，“运行流水线”会通过输入框提交 `/goal`。它从不驱动 agent（智能体）；它渲染宿主台账并发送普通命令。请与 `@deepseek-ai/dsh-research-workbench` 一起挂载。

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
```

该插件注入 `remote`、`remote.research`、`remote.directoryPicker`、`slots`、`locale`、`layout`、`sessions` 与 `sidebarRight`。缺少宿主行时 Remote 不存在，任何注册都不会发生。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

所有界面读取同一份轮询得到的项目、偏好与组件快照，并按会话绑定确定会话所属的项目，否则取包含会话工作目录的最内层项目根目录，因此项目文件夹中的每个对话都会显示它。命令发往宿主 Remote；`/goal` 与 `/permission` 行通过会话自身的命令通道提交，与原生选择器的做法相同。

| 模块 | 画出什么 |
| --- | --- |
| `Hero.tsx` | 空会话入口：标志、继续最近项目的一行提示、开场入口、恒定承诺 |
| `Header.tsx` | 对话标题栏里的项目状态标签与文件操作 |
| `Rail.tsx` | 科研标签页：模式与自主度控件、运行检查、运行流水线、阶段、发现、决策 |
| `NewProject.tsx`、`ProjectEntry.tsx` | 带模式与自主度的项目创建，以及侧栏项目列表 |
| `ClaimSheet.tsx` | 一条论点，以及它脚下的每一份原文，覆盖整个界面 |
| `RunPanel.tsx`、`MetricsGrid.tsx` | 输入框上方已提交的实验及其指标 |
| `Workbench.tsx`、`ContextCards.tsx` | 项目自身的文件：资料、稿件与示意图编辑器、运行、导出 |
| `ResearchSettings.tsx`、`EnvironmentForm.tsx` | 模型分工、托管组件、已绑定的环境 |
| `Onboarding.tsx` | 跳过 harness 首次运行时的内测声明 |
| `contract.ts`、`format.ts`、`locales.ts` | 注入面、会话到项目的解析、格式化，以及 `en` 与 `zh` 两份全部文案 |

所有文案由词典拥有，遵循[客户端 UI 文案归属词典](../../../.agents/notes/implemented/architecture/2026-08-23-locale-owned-client-ui-copy.zh.md)决策。

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the commands and records its controls write: Run pipeline submits `/goal <objective>` and the autonomy control submits `/permission research-auto` or `/permission workspace-write` through the session's command path, while mode, autonomy and decisions land in the host ledger that the agent reads with `research_project current`.

#### KV Cache effect

不直接使任何缓存失效；目标、权限与科研工具的使用方各自负责请求前缀的变化。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

以下是这个包当前的约束，不是任务清单。

未发布运行时不变量配套插件，因为这个包不持有任何可独立观察的关系：它渲染宿主拥有的快照，而每一次注册都是插槽注册表已负责释放的 effect。

- **浏览器中没有原文正文**——宿主从每份快照中去掉证据文本；论点面板展示宿主在写入时校验过的引文。
- **指标在结束时到达**——运行中的实验只显示已用时长，指标在运行结束后出现。
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
