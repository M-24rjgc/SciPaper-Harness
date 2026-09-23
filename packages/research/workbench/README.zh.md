---
description: "科研项目台账与模型工具：带页码级引文的资料、附开放获取全文的文献、LaTeX 编译与页面渲染、Python 环境、脱离应用运行的实验、只报告不拦截的论文检查，以及投稿导出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research-workbench

[English](README.md) | 中文

## 概述

为 agent（智能体）提供科研项目台账以及在其中工作的工具：导入并检索带页码级引文的资料，核实文献并获取开放获取全文，撰写并编译 LaTeX，渲染页面以便查看，构建 Python 环境，运行不受应用与 SSH 断开影响的实验，并导出投稿压缩包。`research_check` 报告论文各阶段是否完成；检查不通过也不会拒绝任何操作。科研版应选用它；它需要存储域以及桌面端或 Web 宿主。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

与 `ui-research` 客户端插件和科研 agent 预设一起挂载；web-app bundle 已经这样配置。服务本身不注册任何工具：预设挂载 `@deepseek-ai/dsh-research-workbench/tools`，因此只有由该预设组成的 agent 能看到科研工具。

### 何时选用

当 agent 需要把一篇论文从想法或已有结果一路推进到投稿，并为每份资料、每个文件、每个数字保留来源时，选用它。它负责记录与检查；工作由 agent、目标（goal）与科研技能推进，因此普通的编码会话用不上它。

### 最小配置

```yaml
- id: research-workbench
  name: '@deepseek-ai/dsh-research-workbench'
  config:
    maxSourceBytes: 67108864
    pollIntervalMs: 5000
    maxReviewPages: 12
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxSourceBytes` | 必填 | 单份资料、文件或工具响应的字节上限 |
| `pollIntervalMs` | 必填 | 观测运行中实验的间隔 |
| `maxReviewPages` | 必填 | 一次查看最多渲染的 PDF 页数 |
| `componentRoot` | 产品主目录下的 `research/components` | 托管的 Python、uv、TeX 与 draw.io 所在目录 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-research-workbench)是全部受支持字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

一个服务拥有 `research_workbench` 存储域中的全部项目记录；每个项目的变更逐一应用。耗时工作（编译、页面渲染、导入、环境构建、实验提交与观测）在队列之外的副本上运行，只记录其结果，因此保存从不等待编译。证据文本存放在 `.research/chunks` 下按修订号划分的文件里，使每次写记录都很小。文件本身留在项目中，不可变快照存放于 `.research` 之下。[科研子系统页面](../../../docs/subsystems/research.zh.md)介绍记录、模式、检查与拒绝项。

| 源码 | 内容 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务本体：项目生命周期、命令分派、项目队列、运行观测 |
| [`src/checks.ts`](src/checks.ts) | `research_check`：各模式的阶段列表与每一项检查 |
| [`src/latex.ts`](src/latex.ts) | 主稿发现、输入展开、参考文献与插图解析 |
| [`src/artifacts.ts`](src/artifacts.ts) | 导入、文件修订、编译、页面渲染、导出 |
| [`src/experiments.ts`](src/experiments.ts) | 运行登记、输入快照、提交、观测、输出收集 |
| [`src/literature.ts`](src/literature.ts) | Crossref、OpenAlex 与 arXiv 元数据；开放获取 PDF 查找 |
| [`src/tools.ts`](src/tools.ts) | 模型工具与审批钩子 |
| [`runtime/experiment_runner.py`](runtime/experiment_runner.py) | 每个运行都在其下执行的标准库监督进程 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [科研子系统](../../../docs/subsystems/research.zh.md)——记录、模式、检查、拒绝项与 Cordis API。
- [目标](../../../docs/subsystems/goal.zh.md)——流水线如何一轮接一轮运行，直到检查通过。
- [权限预设](../../../docs/subsystems/permission-presets.zh.md)——检查点与全自动两种自主度背后的预设。
- [存储](../../../docs/subsystems/storage.zh.md)——项目记录所在的存储域。

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas

#### What the model sees

生成的[科研工具 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-research-workbench)：共八个工具，`research_project`（current、create、list、set-mode、set-autonomy、record-decision）、`research_check`（scope），以及按类别划分、各带 `action` 与类型化字段的工具：`research_evidence`、`research_artifact`、`research_environment`、`research_experiment`、`research_media`，外加 `research_task`。描述用一行列出每个 action 的字段；`projectId` 可省略，因为项目由会话的工作目录确定。

#### Token effect

工具可见时，每次请求都有固定的 schema 开销；同一构建中的定义是静态的。

#### KV Cache effect

定义及其可见性不变时，前缀保持稳定。

### Tool-call history and result

#### What the model sees

结果是精简的 JSON：只包含本次调用产生的内容（消息、路径、运行视图、检查报告、文献条目、按 `maxSourceBytes` 截断的资料摘录），从不返回整个项目。`research_project current` 返回项目简报：模式及其理由、自主度、上次检查得出的阶段进度、最近 20 条决策、全部已登记文件、最近 60 份资料、环境、最近 20 次运行与最近一次编译，并附上指出下一个未完成阶段以及何时应当提问的指引。失败以抛出的错误呈现，并指明如何修正，例如 `Revision conflict: the file is at revision 2, not 1. Read it again and merge your changes`。

#### Token effect

随每次调用的结果增长，直到压缩。资料检索与文件读取最大，按 `maxSourceBytes` 截断；检查报告列出带文件与行号的发现。

#### KV Cache effect

只追加；结果位于可复用的请求前缀之后，不会使任何缓存失效。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

以下是这个包当前的约束，不是任务清单。

未发布运行时不变量配套插件，因为台账维护的每一种关系（修订号、证据关联、运行标识）都在写入处、在每个项目逐一进行的变更队列中强制保证。

- **优先面向 Windows 的装配**——Python、uv、TeX 与 draw.io 的自动安装面向 Windows x64；其他平台在设置中绑定已有工具。
- **SSH 不做任何装配**——远程运行使用显式配置的 OpenSSH 认证和专用远程目录；从不创建账户、不接入集群调度器、不改动服务器的全局 Python。
- **agent 一侧无法导出 draw.io**——图可以在内置编辑器中编辑，但矢量导出需要桌面应用的主进程，而这个包不扩展主进程；agent 默认用 TikZ 绘图。
- **单用户项目**——一个人在一台机器上的项目；协作账户不在范围内。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
