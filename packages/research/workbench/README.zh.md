---
description: "科研项目台账与模型工具：带页码级引文的资料、附开放获取全文的文献、LaTeX 编译与页面渲染、Python 环境、脱离应用运行的实验、只报告不拦截的论文检查，以及投稿导出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-research-workbench

[English](README.md) | 中文

## 概述

为 agent（智能体）提供科研项目台账以及在其中工作的工具：导入并检索带页码级引文的资料，核实文献并获取开放获取全文，撰写并编译 LaTeX，渲染页面以便查看，构建 Python 环境，运行不受应用与 SSH 断开影响的实验，排布由脚本保持最新的实验看板，并导出投稿压缩包。`research_check` 报告并记下论文各阶段是否完成；检查不通过也不会拒绝任何操作。科研版应选用它；它需要存储域以及桌面端或 Web 宿主。

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

通过 `research-app` bundle 与 `ui-research` 客户端插件和科研 agent 预设一起挂载。服务本身不注册工具。预设中的配置行挂载 `@deepseek-ai/dsh-research-workbench/tools`，通过 `config.modules` 选择 `project`、`evidence`、`artifact`、`environment`、`experiment`、`board`、`media`、`knowledge`、`checks` 或 `tasks`；省略时全部启用，空列表不启用任何工具。每行独立拥有选定的工具及审批钩子，停用一行不会影响其他工具族或共用台账。项目模式技能由独立的 `@deepseek-ai/dsh-research-workbench/mode-skills` 提供，通用科研技能通过指向本包 `runtime/skills` 的 `skill-filesystem` 提供。新研究和视觉审查对话显式选择固定的 `research` 预设，不受普通会话默认预设影响。

项目的自主程度就是它每段对话的权限预设：服务注入 `ctx.permissionPresets`，在每次设置自主程度时、以及每个会话上线时，为项目的每个在线会话设置预设，`checkpoints` 对应 `workspace-write`，`automatic` 对应 `research-auto`；示例和委派出的子会话不受影响（[详情](../../../docs/subsystems/research.zh.md#autonomy-and-permission)）。权限配置行必须同时配置这两个预设（research-app bundle 已经如此），否则服务不会加载。

可选的知识图谱 bundle 从本包挂载三个插件，各占一行、各有独立开关。`knowledge-plugin` 提供图谱引擎（`ctx.researchKnowledge`），`knowledge-map-plugin` 提供领域地图（`ctx.researchKnowledgeMap`），`knowledge-evidence-plugin` 提供证据图（`ctx.researchKnowledgeEvidence`）。地图注入图谱引擎，因此引擎关闭时地图也关闭；证据图只读取项目记录，不需要引擎。桌面端命令 `evidence-graph`、`map-view` 和 `map-overlay` 在对应插件关闭时报错，错误中写明插件名；`graph-status` 报告哪些子插件已开启，快照也在 `knowledge.modules` 中带有同样的标志。关闭任何一个插件都不会改动项目文件。每一行的名称和说明来自 `locale/<plugin>/en.json` 与 `zh.json`，以 `<plugin>/locale/*.json` 导出。

首次读取科研快照时，在 `<data home>/research/examples/v1` 初始化两套离线示例，包含合成数据、中英文正文、PDF 札记、可编辑 SVG 图，以及通过 Session Controller 创建的持久对话。初始化保留已有文件和记录，恢复缺失材料，以稳定标识续接中断的登记。`showExamples` 只控制显示，不创建或删除示例。发布示例的对话采用 `read-only` 权限预设，科研写操作均拒绝示例目录，数据 home 的别名也受保护。旧 `<data home>/demo` 和默认 home 的 demo 保持只读，不会被改写。

服务还通过 Session Controller 的命令准入 waterfall，在激活 Agent 或写入前拒绝示例对话的分支、重命名、发消息、队列修改和新增对话。已登记的示例对话仍可幂等收养；创建和缺失对话恢复仅允许初始化器的原始进程内请求。保护依据实际目录和已登记的项目身份，涵盖 home 别名，不依赖 Session 名称前缀。普通研究对话仍可正常分支和编辑。

「新研究」是桌面端的 `start-new` 命令：它打开唯一一份未动过的草稿研究，没有时在 `<研究存放位置>/<yyyy-mm-dd>-<n>` 新建一份，连同文件夹的 Workspace 和一段空白对话。`relocate` 把草稿移到用户选择的文件夹，`discard-draft` 删除草稿以及它建立的空文件夹。研究存放位置取用户的 `researchHome` 偏好，没有时取配置的 `researchHome`，再没有时取 `<用户目录>/SciPaper`。agent 不能发送这几个命令（[详情](../../../docs/subsystems/research.zh.md#new-research-draft)）。

「移出列表」是桌面端的 `archive-project`：它归档这项研究的对话，并在记录上标记 `archivedAt`，磁盘上的内容都不改变；它的运行不再被观测，直到 `unarchive-project` 恢复它，并恰好取消归档它当初归档的那些对话。存在活跃对话时，操作在任何写入之前拒绝归档；随后发生归档失败时，撤销本次已经完成的归档，如果撤销也失败则保留恢复所需的对话记录。归档不会停止独立实验进程。agent 同样不能发送这两个命令（[详情](../../../docs/subsystems/research.zh.md#remove-from-list)）。

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
| `researchHome` | `<用户目录>/SciPaper` | 用户在设置中选定位置之前，新研究所在的绝对路径文件夹；测试组合把它指向临时文件夹 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-research-workbench)是全部受支持字段的完整来源。

平台 Python 优先使用显式配置的解释器，其次是内嵌解释器，最后使用 `componentRoot` 下的环境。Windows 下以扩展长度路径执行绝对路径命令。内嵌解释器和新建的本地 Windows 环境在启动时规范原生模块导入路径，同时保留已有的 `sitecustomize` 文件。若新环境的基础解释器路径超过 Windows 重定向启动器的限制，环境会使用该基础解释器及其相邻 DLL 的副本；包隔离方式保持不变。接入已有环境只做检查，不修改其中的文件。保存的偏好设置、环境记录和组件状态保留普通路径；相对命令保留通常的查找方式。

TeX 优先使用显式绑定的 `texBin`，其次是已完成安装的托管发行版，最后检测 `PATH` 中可用的引擎。组件状态报告所选工具的来源、实际版本和可用引擎；编译使用同一选择。无效绑定会报错，不退回其他工具；所选发行版缺少请求的引擎时也会报错，不另行下载第二套发行版。没有绑定或可用安装时，Windows 可按需安装私有 TinyTeX。缺少的宏包只会在托管发行版中自动安装；调用外部 MiKTeX 的编译引擎与 BibTeX 时会禁用其隐式装包功能。

### 新增一个模式

模式是一个目录，不是代码。要新增一个模式（比如学习模式），就创建 `runtime/modes/<id>/`：一份 `mode.yml`（标识、路线、各阶段要求的事实与决定它的检查、门禁和脚本），`skills/<name>/SKILL.md` 下的技能，以及它用平台 Python 运行的门禁或脚本；改编自上游方法的模式还要带上它的 `LICENSE` 和一份 `NOTICE.md`。清单还要写明给人看的内容：

- `paperRoot`：论文源文件所在的文件夹（`paper`，或表示项目根目录的 `.`）；
- 每条要求的 `hint`：中英文各一句短话，说明缺了什么，研究记录会把它显示在当前阶段下面；
- 每个门禁的 `label`：它的发现归组时使用的名称；
- 可选：阶段上的 `deferrable: <决策键>`，表示记下对应决策后可以推迟该阶段；评审只覆盖论文一部分时，用 `reviewAgainst: <通配>` 指明。

注册表在启动时加载并校验它，损坏时给出警告并跳过；技能提供者只在处于该模式的项目里显示它的技能；`research_check` 运行它的阶段与门禁。再在预设的 `research-modes` 技能里为它加一行，并仿照 `tests/spark-pack.spec.ts` 写一个测试。只有当某个阶段需要要求词汇里还没有的事实种类时，才需要改代码。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

一个服务拥有 `research_workbench` 存储域中的全部项目记录；每个项目的变更逐一应用。耗时工作（编译、页面渲染、导入、环境构建、实验提交与观测）在队列之外的副本上运行，只记录其结果，因此保存从不等待编译。证据文本存放在 `.research/chunks` 下按修订号划分的文件里，使每次写记录都很小。文件本身留在项目中，不可变快照存放于 `.research` 之下。[科研子系统页面](../../../docs/subsystems/research.zh.md)介绍记录、模式、检查与拒绝项。

编辑器保存旧版本时，服务先持久化磁盘上的外部编辑修订，再报告冲突；重新读取会得到该修订，中断留下的历史文件也会保留。实验即使在提交返回时已经完成，也会收集证据；等待和后台观测还会补收此前已完成但尚未收集证据的运行。

| 源码 | 内容 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务本体：项目生命周期、新研究草稿、移出列表、命令分派、项目队列、运行观测，以及每段对话的权限预设 |
| [`src/drafts.ts`](src/drafts.ts) | 新研究：研究存放位置、草稿文件夹的命名、未动过的草稿包含什么，以及删除它的空文件夹 |
| [`src/checks.ts`](src/checks.ts) | `research_check`：每一项基础检查、通过服务提供的执行器运行的模式门禁，以及按模式要求得出的阶段进度 |
| [`src/progress.ts`](src/progress.ts) | 项目的进展（由 `research_check` 的报告逐份并入），以及 `standing`：给人、项目简报和对话标题栏看的项目现状 |
| [`src/modes.ts`](src/modes.ts) | 模式包：清单校验、注册表、路线，以及项目最终落到的模式 |
| [`src/mode-skills.ts`](src/mode-skills.ts) | 按项目所在模式列出技能的技能提供者 |
| [`src/gates.ts`](src/gates.ts) | 模式包的门禁与脚本：用平台 Python 运行它们并读取其发现 |
| [`runtime/modes/`](runtime/modes) | 随包发布的模式包：`general`、`spark-to-paper` 与 `ccfa`（上游技能、门禁与脚本，见各包的 `NOTICE.md`） |
| [`src/figures.ts`](src/figures.ts) | SVG 图：上游审计，以及导出为矢量 PDF 与预览图（[`runtime/figures/`](runtime/figures)） |
| [`src/prose.ts`](src/prose.ts) | 行文检查：套话、防御性表述、模糊限定、公式化对比、破折号和宣传性词语 |
| [`src/venues.ts`](src/venues.ts) | 会议模板库：列出会议，并把某个会议的模板应用到项目 |
| [`runtime/venues/`](runtime/venues) | 139 个会议、16 套官方样式，附指南与示例，由 [`scripts/build_venues.py`](scripts/build_venues.py) 构建 |
| [`src/examples.ts`](src/examples.ts)、[`runtime/examples/v1/`](runtime/examples/v1) | 两套合成研究示例的保留式安装、稳定登记及成稿对话 |
| [`src/knowledge.ts`](src/knowledge.ts) | `research_knowledge`：加载图谱、召回、新颖性、构建并命名项目图谱 |
| [`src/knowledge-plugin.ts`](src/knowledge-plugin.ts)、[`src/knowledge-map-plugin.ts`](src/knowledge-map-plugin.ts)、[`src/knowledge-evidence-plugin.ts`](src/knowledge-evidence-plugin.ts) | 三个可选的知识图谱服务；前两个在 [`src/operation-scope.ts`](src/operation-scope.ts) 下运行任务，插件关闭时由它中止任务 |
| [`src/knowledge-evidence.ts`](src/knowledge-evidence.ts) | 证据图：研究问题、结论及其背后的运行与文献，由纯函数从记录投影得到 |
| [`src/knowledge-map-shell.ts`](src/knowledge-map-shell.ts) | 领域地图唯一的读取入口，在地图数据接入之前报告地图尚未建好 |
| [`src/clustering.ts`](src/clustering.ts) | 分词、BM25、词项向量、余弦、排名融合、平均链接与 k-means 聚类 |
| [`runtime/kg/`](runtime/kg) | 内置科研模式图谱，由 [`scripts/build_kg.py`](scripts/build_kg.py) 精简而来 |
| [`src/latex.ts`](src/latex.ts) | 主稿发现、输入展开、参考文献与插图解析 |
| [`src/artifacts.ts`](src/artifacts.ts) | 导入、文件修订、编译、页面渲染、导出 |
| [`src/experiments.ts`](src/experiments.ts) | 运行登记、输入快照、提交、观测、输出收集 |
| [`src/literature.ts`](src/literature.ts) | Crossref、OpenAlex 与 arXiv 元数据；开放获取 PDF 查找 |
| [`src/images.ts`](src/images.ts) | 生图（OpenAI 图像接口，默认 gpt-image-2，带参考图时走 edits；也支持返回图片的对话接口）与来自 ar5iv 的参考图 |
| [`src/board.ts`](src/board.ts) | 实验看板：保存的布局、机器探针、进度记录和采集脚本，在后台读取 |
| [`runtime/board_probe.py`](runtime/board_probe.py) | 只用标准库的探针，报告一台机器的 GPU、处理器、内存、磁盘以及各运行的进度记录 |
| [`src/gallery.ts`](src/gallery.ts) | 配图库：按筛选条件、关键词和可选的标题嵌入检索；图片按需取回并缓存 |
| [`runtime/figure-gallery/`](runtime/figure-gallery) | 来自 Top-Conf Figure Gallery 的约 3,500 张顶会 Figure 1 的索引，由 [`scripts/build_figure_gallery.py`](scripts/build_figure_gallery.py) 构建；不含图片 |
| [`src/tools.ts`](src/tools.ts) | 模型工具与审批钩子：从项目之外导入时先询问，用户附加的文件除外 |
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

生成的[科研工具 schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-research-workbench)：共十个工具，`research_project`（current、create、rename、list、modes、set-mode、set-autonomy、record-decision）、`research_check`（scope），以及按类别划分、各带 `action` 与类型化字段的工具：`research_evidence`、`research_artifact`、`research_environment`、`research_experiment`、`research_board`、`research_media`、`research_knowledge`，外加 `research_task`。描述用一行列出每个 action 的字段；`projectId` 可省略，因为项目由会话的工作目录确定。

#### Token effect

工具可见时，每次请求都有固定的 schema 开销；同一构建中的定义是静态的。

#### KV Cache effect

定义及其可见性不变时，前缀保持稳定。

### Tool-call history and result

#### What the model sees

结果是精简的 JSON：只包含本次调用产生的内容（消息、路径、运行视图、检查报告、文献条目、按 `maxSourceBytes` 截断的资料摘录），从不返回整个项目。`research_project current` 返回项目简报：模式、路线及其理由、模式是否已选定以及由谁选定（`modeChosen`、`modeSetBy`）、路线是否已定（`routingSettled`）、该模式的 `paperRoot`、自主度、这项研究某段已加载对话所持有的目标（`activeGoal`，读者自己的优先）、每个阶段的状态（已完成、当前、未开始或已推迟）及其上次检查发现缺少的内容、最近一次检查的时间以及之后文件是否有改动、各阶段使用的技能、最近 20 条决策、全部已登记文件、最近 60 份资料、环境、最近 20 次运行与最近一次编译，并附上指引：下一阶段及其提示、已推迟的阶段、开始某阶段工作时要加载的该模式技能、不应重复创建的在运行目标，以及何时应当提问。这些阶段与研究记录给人看的是同一份 `standing`。不在任何研究中时，current 返回 `{project: null, hint}` 而不报错；`create` 只把本对话自己的文件夹设为研究，拒绝其他任何 root，并在消息中请 agent 让用户使用「新研究」和「更改位置」。失败以抛出的错误呈现，并指明如何修正，例如 `Revision conflict: the file is at revision 2, not 1. Read it again and merge your changes`。导入用户附加到对话里的文件不会发起审批请求；从项目之外其他任何位置导入会先询问用户，而在 `automatic` 自主程度下请求会被直接拒绝，因为它的预设在这项研究的每段对话里都关闭了审批提示（审批策略的运行时上下文语句会告诉模型当前适用哪一种）。

#### Token effect

随每次调用的结果增长，直到压缩。资料检索与文件读取最大，按 `maxSourceBytes` 截断；检查报告列出带文件与行号的发现。

#### KV Cache effect

只追加；结果位于可复用的请求前缀之后，不会使任何缓存失效。

### Skill catalog

#### What the model sees

项目所在模式包的技能，与预设自带的通用技能一起列在会话的技能目录里；处于通用模式的项目不会列出其中任何一个。模式变化后，下一步会发布一份替换目录。

#### Token effect

每个模式包技能占目录中的一行（spark-to-paper 增加十三行，ccfa 增加十六行）。技能正文只在模型加载它时才消耗 token，其 `references/` 只在模型读取时才消耗。

#### KV Cache effect

模式变化会追加一条替换目录消息；此前的前缀仍可复用。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

以下是这个包当前的约束，不是任务清单。

未发布运行时不变量配套插件，因为台账维护的每一种关系（修订号、证据关联、运行标识）都在写入处、在每个项目逐一进行的变更队列中强制保证。

- **优先面向 Windows 的装配**——Python、uv、TeX 与 draw.io 的自动安装面向 Windows x64。所有平台都会检测 `PATH` 中已有的 TeX；Windows 之外的其他工具需要在设置中绑定。
- **SSH 不做任何装配**——远程运行使用显式配置的 OpenSSH 认证（或在 SSH 工作区添加时已保存的、该环境 `用户@主机[:端口]` 对应的密码）和专用远程目录；密码只通过 `SSH_ASKPASS` 交给 `ssh`，绝不出现在命令行、运行记录或工具结果中。从不创建账户、不接入集群调度器、不改动服务器的全局 Python。
- **agent 一侧无法导出 draw.io**——图可以在内置编辑器中编辑，但矢量导出需要桌面应用的主进程，而这个包不扩展主进程；agent 默认用 TikZ 绘图。
- **GPU 读数只支持 NVIDIA**——看板的机器探针通过 `nvidia-smi` 读取 GPU；在 macOS 上不读取处理器和内存占用。
- **单用户项目**——一个人在一台机器上的项目；协作账户不在范围内。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
