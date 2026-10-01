# Research

[English](research.md) | 中文

科研子系统是科研版背后的台账。[`@deepseek-ai/dsh-research-workbench`](../../packages/research/workbench/README.zh.md) 拥有 `ctx.research`：每个科研项目一条持久记录、读写这条记录的模型工具，以及告诉 agent（智能体）工作是否完成的检查。工作由 agent 通过普通对话、目标（goal）和技能推进；服务只记录有什么、从哪来、什么已过期、做过哪些决定。它从不向会话注入提示词，也从不因为检查未通过而拒绝某个操作。

源码：[`packages/research/workbench/src/types.ts`](../../packages/research/workbench/src/types.ts)

[`research-app` 组合包](../../packages/bundle/research-app/README.zh.md) 装配科研服务、可独立配置的工具模块、科研技能与浏览器界面。服务本身不注册工具；[包配置](../../packages/research/workbench/README.zh.md#use-this-package) 定义各自独立的插件入口。新项目和视觉复核对话显式选择 `research` 智能体预设，不受普通会话默认预设影响。从已有对话创建项目时保留该对话。

## 项目记录

一个 `ResearchProject` 绑定一个规范的 Workspace 目录。它记录证据（导入的资料、文献、收集到的运行输出）、论点及其证据关联、带修订号与输入的已登记文件、环境、实验运行、编译、页面渲染与视觉复核、决策（每条可带一个 `key`，即说明它定下了什么的短标识，例如 `experiments-deferred`），以及检查确立的进展（[见下文](#progress-and-standing)）。三个设置决定 agent 如何工作：

| 字段 | 取值 | 含义 |
|---|---|---|
| `mode` | 已安装的模式包 id；默认 `general` | 项目所在的模式包（见下文）。 |
| `route` | 该模式包的某条路线 | 在模式包内走的路径，例如从想法、提案或实测结果开始。 |
| `autonomy` | `checkpoints`、`automatic` | agent 在关键决策处提问（`ask_user_question`，会暂停正在运行的目标），还是自行决定并记录理由。它同时决定每段对话的权限预设（[见下文](#autonomy-and-permission)）。 |

<a id="autonomy-and-permission"></a>

自主程度以权限预设的形式生效（`src/schema.ts` 中的 `AUTONOMY_PRESETS`）：`checkpoints` 对应 `workspace-write`，越权请求会询问用户；`automatic` 对应 `research-auto`，越权请求直接拒绝。服务用 `ctx.permissionPresets.set` 把这个预设设到项目的每个在线会话上：绑定到项目的会话，以及工作目录位于项目之内、且不在其中嵌套的其他研究里的每个顶层会话。每次 `set-autonomy`（即使取值不变）、项目创建时、服务启动时都会这样做；每个会话上线时，也由服务自己的 `session/created` 监听器设置，这个监听器在权限服务为该会话固定默认值之后运行。委派出的子会话保持委派时确定的权限，示例的会话从不改动。在某段对话里用 `/permission` 手动输入的预设，在这段对话里一直有效，直到再次设置自主程度或这段对话被重新加载。权限配置行缺少这两个预设中的任何一个时，服务不会加载。

模式由谁选定记在 `modeSetBy` 中。创建时指定了模式的项目记为 `user`；创建时没有指定模式的项目处于 `general`，`modeSetBy` 不设置，表示模式尚未选定。`set-mode` 按它的 `decidedBy`（缺省时为调用方）设置 `modeSetBy`，并追加一条 key 为 `mode` 的决策：问题是「模式与路线」，回答是以 id 写成的 `<mode>` 或 `<mode> · <route>`，理由即其 rationale。只有给出了理由，它才替换 `modeReason`；模式或路线改变时，`progress` 从头开始。`rename` 设置标题，清除 `untitled`（产品起的占位标题），并把同一标题给文件夹对应的 Workspace，除非已有别的 Workspace 用了这个标题。每次实验运行都把提交它的对话记为 `sessionId`；从桌面端提交的运行，以及在这个字段出现之前记录的运行，都没有它。

`activeGoals(project)` 通过目标服务读取项目中已加载的顶层对话里尚未完成的目标（`ResearchGoal`：会话、目标描述、阶段、轮次与最近一次改动），正在推进轮次的排在前面。未加载的对话看不到。agent 的项目简报把读者自己的目标（没有时取第一个）报告为 `activeGoal`；每份快照都以 `goals` 带上项目的这些目标（推导得出、从不存储，没有目标时不出现）。

根目录位于 `<数据目录>/demo` 中的项目是示例研究，随应用提供，用于新手教学（`src/files.ts` 中的 `isExampleRoot`）。快照和 agent 的项目简报会把它标为 `example: true`；这个标记是推导出来的，从不存储。示例对用户和 agent 都是只读的：可以读取和检查，但检查报告不会保存，任何会记录内容的命令都会被拒绝，并提示 `这是示例研究，只能查看 / This is an example research and is read-only`。看板显示最近一次读取的结果，其中的运行不再被观测，示例目录中也不会新建任何研究或文件夹。

以草稿方式创建的研究（见下文）在创建时一并新建了文件夹的情况下记录 `createdRoot`，因此丢弃它时，文件夹一旦为空就可以删除。

记录存放在 `research_workbench` 存储域中（单文档布局，版本 1）。旧形态的记录会在读取时迁移：阶段机字段被移除，已确认的阶段转为用户决策；原先内置的 `paper-first` 与 `from-results` 模式转为 spark-to-paper 模式包的 `proposal` 与 `data` 路线，`free` 或未设置的模式转为 `general`。模式、路线、阶段与检查的 id 都以字符串存储，因此即使记录所指的模式包已被移除，记录照样能打开，项目按 `general` 运行。抽取出的证据文本存放在快照旁的 `.research/chunks/<evidence>/<revision>.json`，而不在记录里，因此一次变更只重写台账，不会重写每份资料的全文。

<a id="new-research-draft"></a>
## 新研究草稿

「新研究」通过桌面端的 `start-new` 命令打开唯一一份未动过的草稿研究。新研究放在研究存放位置：用户在 设置 › 科研 › 研究存放位置 中设置的 `researchHome` 偏好；没有时用服务配置的 `researchHome`；再没有时用 `<用户目录>/SciPaper`（Windows 上是 `%USERPROFILE%\SciPaper`：不在常被 OneDrive 同步的「文档」里，路径也是纯 ASCII，方便 TeX）。`snapshot().researchHome` 报告当前生效的位置；`configure` 拒绝相对路径和位于示例之中的路径。

一项研究在以下条件全部成立时就是未动过的草稿，快照以及这几个命令的答复里标为 `draft: true`（推导得出，从不存储）：

- 记录里除了占位标题（`untitled`，标题为「新研究」）和自主程度之外什么都没有：处于 general 模式且模式尚未选定，简介为空，没有资料、论点、文件、决策、环境、运行、编译、复核或检查（`src/drafts.ts` 中的 `blankRecord`），因此在入口页选择自主程度不会让它失去草稿身份；
- 它的每段对话在会话列表中都是空白的（没有开始过任何轮次）：绑定到它的那段，以及每段在它文件夹里工作的对话，通过 `ctx.sessionController.list` 查到；
- 它的文件夹里只有研究创建时建立的空文件夹（`paper`、`figures`、`code`、`data`、`.research`、`exports`），或者什么都没有；
- 它不是示例，也没有被移出列表（[见下文](#remove-from-list)）。

这三个命令只属于桌面端：`execute` 拒绝 agent 调用它们，模型可见的 `research_project` 也没有这样的操作。

| 命令 | 作用 |
|---|---|
| `start-new {}` | 答复 `{project, sessionId}`：草稿（最新的那项未动过的研究；较早的未动过的研究算作普通研究，可以用 `archive-project` 移出列表），或者在 `<研究存放位置>/<yyyy-mm-dd>-<n>` 新建一项研究，`n` 取当天（本地日期）最小的空闲序号，包括记录、以文件夹名命名的 Workspace 和一段空白对话。被手动删除的草稿文件夹会重新建立；对话被归档的草稿会得到一段新的空白对话。研究存放位置位于示例之中、位于另一项研究之内或位于系统文件夹时，命令被拒绝。 |
| `relocate {projectId, root, confirmNonEmpty?}` | 只作用于草稿；`outcome` 说明所选文件夹是什么。`example`：位于示例之中。`existing`：它已经是 `project` 中的那项研究（附带其绑定的 `sessionId`）。`nested`：它位于 `project` 中那项研究之内，这项研究也可能就是草稿本身。这两种答复所指的研究都可能已被移出列表，此时它带有 `archived: true`。`needs-confirm`：它里面已有文件，且未设置 `confirmNonEmpty`。其余情况为 `moved`：在该处新建研究，沿用草稿的自主程度并带一段空白对话，然后丢弃草稿；`project` 与 `sessionId` 是新研究的。选草稿自己的文件夹时答复 `moved`，草稿保持不变。 |
| `discard-draft {projectId}` | 只作用于草稿：归档它的对话，删除它文件夹的 Workspace 注册和它的记录，然后删除仍为空的各个初始文件夹，在根目录由草稿创建（`createdRoot`）时也删除根目录。里面有任何内容的文件夹都会保留；无法删除的文件夹会记入日志。 |

已经开始的研究既不能更改位置，也不能丢弃：`这项研究已经开始，不能再更改位置或丢弃 / This research has started, so it can no longer be moved or discarded`。对话一旦不再空白就不会重新变回空白，因此发现含有已开始对话的研究之后不会再为它列出会话。读不到会话列表时，快照不标记任何草稿，`start-new` 直接失败，而不会再建一份草稿。

<a id="remove-from-list"></a>
## 把研究移出列表

「移出列表」与「恢复」是桌面端的 `archive-project` 与 `unarchive-project` 命令。和草稿命令一样，`execute` 拒绝 agent 调用它们。

| 命令 | 作用 |
|---|---|
| `archive-project {projectId}` | 归档这项研究中尚未归档的每段顶层对话：绑定到它的那段，以及每段在它文件夹里工作、且不在其中嵌套的其他研究里的对话。归档通过 Workspace 注册表完成，与 shell 自己的归档操作及其「已归档会话」设置页用的是同一套归档。在归档第一段对话之前，记录先存下 `archivedAt` 和这次要归档的对话 id（`archivedConversations`）。委派出的子会话不受影响，磁盘上的任何内容都不改变。再次执行时保留 `archivedAt`，并归档此后新增的对话。对示例拒绝执行；对未动过的草稿也拒绝，并提示 `还没开始的新研究不能移出列表 / The untouched new research cannot be removed from the list`。 |
| `unarchive-project {projectId}` | 取消归档 `archivedConversations` 中的对话，然后清除这两个字段。用户在移出之前自己归档的对话保持归档。仍在列表中的研究原样答复；对示例拒绝执行。 |

归档在修改记录之前通过 `workspace/session-activity` 检查所选对话；任何活跃对话都会使操作被拒绝。后续某次归档失败时，撤销已经完成的归档并恢复先前记录。如果撤销也失败，则保留恢复记录并报告错误；`unarchive-project` 可重新尝试恢复。归档和恢复都不会停止独立实验进程。

快照和命令答复把已移出的研究标为 `archived: true`，它由 `archivedAt` 推导得出，从不存储。它的运行照常进行，但后台观测会跳过它们，直到研究恢复；`experiment-wait` 与 `experiment-refresh` 在被调用时仍会观测运行。已移出的研究永远不会是草稿。

`showExamples` 偏好（设置 › 科研 › 显示示例研究）决定侧边栏是否列出示例。没有设置时视为 true。`memoryCarry` 偏好保存记忆视图的开关，每类记忆一个；未出现的类别视为开启。

## 模式包

模式包是 `packages/research/workbench/runtime/modes/<id>/` 下的一个目录：一份 `mode.yml` 清单、只在项目处于该模式时才对 agent 可见的技能，以及其门禁要运行的脚本。`ModeRegistry`（`src/modes.ts`）在启动时加载并校验各模式包，损坏的模式包会被跳过并给出警告；`general` 模式包必须能加载。

| 清单字段 | 含义 |
|---|---|
| `id`、`order`、`name`、`summary` | 标识与显示，名称含英文与中文 |
| `source` | 该模式包所依据的上游仓库、版本与许可证 |
| `entry`、`preload` | 运行该模式的技能，以及在它之前加载的技能 |
| `paperRoot` | 该模式的论文源文件所在的项目文件夹：`paper`，或表示项目根目录的 `.` |
| `reviewAgainst` | 可选的项目内相对通配：设置后，只有匹配的文件在最新评审之后改动过，评审才算过期 |
| `routes`、`defaultRoute` | 模式内可选的路径 |
| `phases` | 每个阶段的名称、所属路线、技能、是否为检查点、决定它的检查、它要求的事实（每条带一个 `hint`，用中英文各一句话说明缺什么），以及可选的 `deferrable` 决策键 |
| `gates`、`scripts` | 模式包的检查要运行的 Python 脚本（每个门禁带中英文的 `label`），以及 agent 可以运行的脚本 |

通用模式也是一个模式包，只是没有阶段、没有技能：使用已启用的科研工具，不走流水线。模式包的技能通过独立的 `@deepseek-ai/dsh-research-workbench/mode-skills` 插件送达 agent：它按会话工作目录所在项目的模式列出技能，因此切换模式会在进行中的会话里替换技能目录。`research/mode` 事件在项目模式变化时通知这个提供者。停用工具模块不会影响模式技能提供者或共用台账。

阶段要求使用一组固定的事实：文件通配（`file`，可带 `min`）、`manuscript`、`bibEntries`、`sections`、`figures`、`diagram`、`pagesInspected`、`reviewCurrent`、`runsCollected`、`noActiveRuns`、`dataEvidence` 与 `resultsOrData`。以列表给出的要求，其中任意一项成立即视为满足。一条要求在所属阶段内以它的条件命名（`requirementKey`：`file:story.json`、`sections>=4`，多个备选之间用 ` | ` 连接），同一阶段内不能重复；检查按这些键报告未满足的要求。`hint`、门禁的 `label` 和 `paperRoot` 都是必填项，缺少它们的模式包会被跳过并给出警告。

门禁是模式包里的 Python 脚本。它用平台 Python 在项目根目录运行（`python -I -X utf8`，不经过 shell，按参数向量传参），输出的最后一行是 `{"findings": [{severity, message, file?, line?}]}`；除此之外的任何输出都记为一条错误发现。检查从不安装 Python：没有它时，每个门禁都报告自己无法运行。`research_artifact` 的 run-script 以同样方式运行模式包为项目当前路线声明的脚本，并返回脚本的输出。spark-to-paper 模式包通过这样一个适配器原样运行上游的检查脚本；它的 `NOTICE.md` 列出了取用、修补和替换了哪些内容。

CCFA 模式包沿用 CCFA-Skills：十六个专职技能，每个都在两个前置技能（先 `ccf-humanization`，再 `ccf-common`）之后运行，项目状态记在 `ccfa.yaml`。它的路线是上游总控建议的路线（`full-paper`、`manuscript-improvement`、`post-review-response`），外加一条不设阶段、可做任意单项任务的 `open`。它的门禁检查这些技能写出的文件：`ccfa.yaml` 是否具备 v0.4.0 的字段；每份评审报告用上游的 `validate_version_comparison.py --report` 校验，并列出其中未解决的 critical 与 major 问题；修订台账；投稿就绪记录；以及源文件和发布文件夹里的本机用户目录路径。上游的交接模式跟随项目的自主度：`checkpoints` 在上游 partial 交接的触发点提问，`automatic` 不提问。

## 会议模板

`research_artifact` 的 list-venues 与 apply-template 使用一个模板库：139 个 CCF 会议、16 套官方样式（`runtime/venues`，由 `scripts/build_venues.py` 从 CCFA-Skills 构建）。应用一个会议会把样式套件、该会议自己的示例和指南放进 `template/<venue>/`；项目的每个顶层文件夹都在 TeX 搜索路径上，所以项目里任何位置手写的论文都能找到该文档类。同时它把 `template.json`、`main.tex.tmpl` 和样式文件写进项目根目录，供 spark-to-paper 的拼装使用。review 阶段在会议要求匿名时匿名（通过文档类选项或匿名作者块）；final 使用终稿选项。编译时会把会议文档类需要的东西装进托管的 TeX Live：缺失的样式、文档类与参考文献样式文件按提供它们的包安装，字体和图片只在发行版能指出所属包时才安装。

## SVG 图

`research_media` 的 audit-svg 用平台 Python 原样运行 spark-to-paper 自带的 SVG 审计（`runtime/figures/audit_svg.py`）：越界、文字重叠、图形压住标签、随线宽缩放或被裁掉的箭头、悬空的连线、低于像素下限的字号、Times 覆盖不到的字符，以及描摹出来的大量路径。带 `save` 时，报告保存在 spark-to-paper 的图门禁读取的位置。export-figure 通过 svglib 和 reportlab 导出保留可编辑文字的矢量 PDF：svglib 不画 `<marker>`，所以先把箭头等标记展开成普通图形；系统有 Times New Roman 时嵌入该字体；并渲染 1440 与 480 像素宽的预览图。

## 配图库

`research_media` 的 find-reference-figures 检索一个配图库：约 3,500 张经人工复核的 ICLR、ICML、NeurIPS、CVPR、ACL 与 AAAI 论文（2023 至 2026 年）的 Figure 1 与概览图，来自 Top-Conf Figure Gallery。随包发布的只有它的索引（`runtime/figure-gallery/index.json.gz`，由 `scripts/build_figure_gallery.py` 构建）：每张图的论文、作者、会议、年份、视觉类型、Oral、Spotlight 与获奖标记、尺寸和设计分。筛选条件按会议、年份、类型和等级（`award` 包括最佳论文与荣誉提名）缩小范围；查询词用 BM25 在标题、作者、会议和类型上为剩下的图排序；没有查询词时，最受认可的图排在前面。配置了嵌入接口后，第一次查询会在后台把所有标题的嵌入写进产品主目录的缓存，之后的查询把标题嵌入与关键词排序融合。每页都会注明排序依据：`browse`、`keyword` 或 `semantic`。

图片留在配图库那边。fetch-reference-figures `{galleryIds, label}` 从配图库的仓库、CDN 镜像或它的网站取回选中的图，缓存在产品主目录（`research/cache/figure-gallery`），并保存为 `figures/refs/<label>.gallery_<id>.<ext>`，旁边附一份写明论文及其版权的 `.source.json`；配图库已下架的图会报告它已不存在。同一个动作带 `arxivIds` 时，从 ar5iv 取其他论文的总览图。对话旁右侧栏的「配图灵感」标签页浏览同一份索引，图片通过宿主路由 `/api/research/gallery/image?id=` 加载。这些图是各模式画图技能的排版参考，绝不作为论文素材。

## 实验看板

「实验看板」是对话旁右侧栏里的一个标签页，页面打开期间每十五秒读取一次；看着它不花一次模型调用。它的固定部分每个项目都一样：按状态统计的运行、每个在跑的运行及其进度和曲线、每台实验机器，以及所有运行（含命令、指标和曲线）。其余部分是 agent 的布局，由 `research_board` board-update 保存在 `.research/board/board.json`：由八种积木（`stats`、`table`、`chart`、`list`、`runs`、`text`、`kv`、`log`）组成的分区。积木里的值要么固定，要么按 id 或按名称和种子跟随运行。页面对着实时的项目记录解析它，所以运行一结束对应的格子就填上；同一名称有多个已完成的种子时，显示它们的均值和样本标准差。

一次读取会运行三类脚本：带 `refresh` 的 `board-view` 最多每十秒启动一次，`board-refresh` 立即运行一次。机器探针（`runtime/board_probe.py`，只用标准库）对活跃运行、采集脚本和默认环境所在的每台主机各运行一次，本地或经 SSH。它通过 `nvidia-smi` 报告 GPU，报告处理器和内存占用（有 cgroup 配额和上限时按配额和上限计算）以及实验目录所在的磁盘；每次读取都往六小时的历史里加一个采样点。运行把进度记录逐行追加到 `$RESEARCH_PROGRESS_PATH`：监督进程的状态把最后一行带进运行记录的 `progress`，探针读取远程在跑运行的进度记录，远程运行结束后，它的进度记录随日志一起取回本地。采集脚本是 agent 自己写的只读脚本，每 `every` 秒（默认 30）用某个环境的解释器从标准输入运行。每个脚本打印 `{stats?, sections?, alerts?}`；解析不了的部分会被丢弃并指明，其余部分照常保留。每次读取的结果保存在 `.research/board/snapshot.json`，重新打开看板时立刻就能显示。

## 知识图谱

`research_knowledge` 读取科研模式图谱：从论文中提炼出的可复用「问题 → 解法 → 故事」模式，做法沿用 spark-to-paper 的图谱构建。内置图谱从上游的 AI 语料精简而来，以 `runtime/kg/ai-kg.json.gz` 随包发布：包含模式、带故事字段与五个最近邻的论文，不含向量。`scripts/build_kg.py` 离线转换上游压缩包，读取其中的 networkx pickle 时使用不执行文件中任何代码的反序列化器。项目也可以用 agent 抽取好的语料自建图谱（先 `build-graph`，再 `name-patterns`），存放在 `.research/kg/`。

排序使用对模式与论文文本的 BM25，再加上图谱里的论文近邻。配置了嵌入接口（`preferences.embedding`，密钥 `RESEARCH_EMBEDDING_API_KEY`）后，对模式文本的余弦相似度通过倒数排名融合加入排序；新颖性检查在嵌入空间里把故事与最接近的工作比较，沿用上游 0.88 / 0.82 的分档；项目图谱改用平均链接聚类而不是 k-means。每个结果都会注明依据。图谱在首次使用时加载，闲置十分钟后释放。

图谱是可选的，由知识图谱 bundle 的五个插件分担，各有独立开关：`research_knowledge` 背后的引擎、领域地图、证据图、研究记忆和关系图。领域地图注入引擎；证据图、研究记忆和关系图只读取项目记录。已关闭插件的命令会报错并写明插件名，`graph-status` 和快照里的 `knowledge.modules` 报告哪些已开启，关闭插件不会删除 `.research` 下的任何文件。

证据图（`evidence-graph`）是项目记录的纯投影，由 `src/knowledge-evidence.ts` 计算，不存放在任何地方。它返回研究问题（简介，简介为空时用标题）、每条结论及其状态、写有该结论的文件和它的引用，以及这些结论引用的运行、文献和文件；一次运行不论有多少输出被引用，都只是一个节点。结论的状态只由记录中的字段推出。记录为 `contradicted` 的结论就是 `contradicted`。没有引用任何来源的结论，是假设时为 `proposed`，否则为 `missing`。引用的来源已不存在、被记录为过期、或版本与引用时不同，或者结论本身被记录为 `stale`，则为 `stale`。记录为 `proposed` 的结论保持 `proposed`，其余结论为 `supported`。没有引用任何来源、而又能由运行检验的结论（实证结论或假设），会连上进行中、或已结束但没有收集结果的运行，最多三个，因为记录并不把计划中的运行与某条结论关联起来；没有这样的运行时，它带一个“没有引用，也没有进行中的运行”的标记。领域地图的 `map-view` 返回内置图谱中论文的位置及其区域和稀疏区域，`map-papers` 按下标返回论文详情，`map-overlay` 把研究的想法、导入的文献、最近召回的论文和标记放到地图上。读不到随附的布局时命令失败，下一次地图命令会重新读取。`mark`、`unmark` 和 `marks` 修改并列出召回所遵从的标记。

研究记忆（`memory`、`memory-carry`）是这台电脑上各项研究的纯投影，由 `src/knowledge-memory.ts` 计算，除了用户的开关外不存放在任何地方。示例、已移出列表的研究和未动过的草稿不留下记忆。文献按规范化后的标题在各项研究之间合并（`src/title-key.ts`）。已完成的实验按研究、按名称列出，附上最新一次运行的命令和指标；记录里没有基线标记，所以不把任何一个叫作基线。可用的环境会合并（本机 `uv` 环境合为一个，SSH 环境按主机和解释器合并），会议模板按会议计数，经验则是记录了原因或退出码的失败运行，以及选择模式之外的决定，每条截断为 240 个字符。每一类在总数之外最多列出 100 项。`memory-carry` 把 `memoryCarry` 存入研究偏好，未出现的类别视为开启；它是用户自己的命令，agent 会被拒绝。agent 的 `research_project memory` 在 `content` 中只返回已开启的类别，来自它所在研究之外的研究，每类最多 40 项，用研究标题代替 id，不含经验。

关系图在 `.research/kg/relations.json` 中保存一项研究的方法、任务、数据集、指标和论文之间有类型、有方向的关系；`src/knowledge-relations.ts` 是存储及其修改，`src/knowledge-relations-grounding.ts` 是依据规则，`src/knowledge-relations-queries.ts` 是各项查询，[Agent Note](../../.agents/notes/proposed/feature/2026-10-01-knowledge-graph-relations.zh.md) 记录规则及其评测。每条关系都有依据：某条资料记录某个版本中的一段原文、已完成的运行，或来自 OpenAlex 或 Crossref 的引用记录。agent 的引文适用工具描述中写明的严格规则，用户的引文只需存在并含四个词。`relations-graph` 返回一个节点的邻域及布局提示，`relations-paths` 返回解释得最好的几条路径，`relations-gaps` 返回方法与任务、数据集或设置的矩阵，只谈项目自己的来源。`relations-propose`、`relations-reject` 和 `relations-restore` 既供桌面端也供 agent 使用，作者由调用方设定，绝不取自输入；用户的否定对 agent 一直有效。`relations-entity`、`relations-merge`、`relations-reground` 和 `relations-citations` 是用户的命令，最后一个作为后台任务运行，向 OpenAlex 和 Crossref 发出的只读请求按插件的 `pauseMs` 间隔发出，结果保留 `citationMaxAgeDays` 天。`relations-suggestions` 列出可能是同一个对象的实体。示例研究回答读取，拒绝其余命令。

## 检查

`research_check` 对磁盘上的文件和台账做确定性检查并给出报告；它定义的是“完成”，而不是许可。下列基础检查在每种模式下都会运行；模式包再加上自己的阶段与门禁。阶段的要求成立、且决定它的检查没有错误时即为完成。整篇论文（scope 为 `all`）只有在没有任何检查报告错误、并且当前模式在当前路线上的每个阶段都已完成时，才算通过。

scope 与某个基础检查或门禁同名时指的是阶段，阶段 scope 会运行决定该阶段的门禁。每份报告记下 `gatesRun`（它运行过的门禁），并在给 agent 看的英文 `missing` 之外，为每个阶段给出 `unmet` 键（先是未满足的要求，再是每个有错误的决定性检查对应的 `errors:<check>`）。发现所指的文件在磁盘上不存在时，这条发现不再带文件和行号。模式包设置了 `reviewAgainst` 时，`review` 只拿最新评审与匹配该通配的文件比较：spark-to-paper 评审的是 `sections/*.tex`，所以 latex 阶段拼装 `main.tex` 不会让评审过期。

| 检查 | 报告内容 |
|---|---|
| `cite` | 没有对应参考文献条目的引用键、不完整的条目、缺少发表信息或未经提供方核实的条目 |
| `numbers` | 结果、摘要、结论与表格中无法追溯到数据证据、运行指标或代码数值的小数与百分比 |
| `placeholders` | 论文中残留的 `\tbd{}`、`--` 结果单元格、TODO 等标记 |
| `figures` | 缺失的插图文件、没有记录数据与脚本或为位图的结果图、未被引用的示意图 |
| `compile` | 尚未编译、编译失败，或编译早于当前源文件；未定义的引用与溢出的盒子 |
| `visual` | 自上次编译以来尚未渲染并查看过的页面 |
| `review` | 没有评审（`reviews/` 或 `*-review-reports/` 文件夹里的 Markdown，或名为 `review*.md` 的文件；修订台账不算评审）、评审早于稿件，或仍有未关闭的 blocker/major 问题 |
| `stale` / `claims` | 过期的文件与资料、被证据推翻的论点、已无法解析的证据关联 |
| `structure` | 缺失的输入文件；在有阶段的模式下，还包括应有却缺失的章节与通用文档类 |
| `prose` | 只给警告：像机器写的套话、防御性表述、叠加的模糊限定、公式化的对比结构、过多的破折号和宣传性词语，覆盖中英文（spark-to-paper 的 AI 腔词表与 CCFA 的行文规范合并而来） |

<a id="progress-and-standing"></a>
## 进展与现状

`research_check` 是 `project.progress`（`ResearchProgress`）唯一的写入方：它记下所描述的模式与路线、每个阶段的 `done`、`unmet` 键与 `checkedAt`、每项检查的发现与 `checkedAt`，以及 `full`，即最近一次 scope 为 `all` 的检查的汇总。每份报告按同一条规则并入：

- 只有当报告运行了决定某个阶段的全部门禁时，这个阶段才会变化，因此针对某个阶段的检查不会凭不完整的证据把别的阶段标为完成；
- 报告运行过的每项检查，其发现整体替换；
- 只有 scope 为 `all` 时 `full` 才会变化；
- 模式或路线不同的报告会让进展重新开始。

`lastCheck` 仍会写入，供早期版本读取。`export` 为投稿包自己运行一次检查，但不记录任何内容。在有进展记录之前存储的项目，会把它最近一次 scope 为 `all` 的 `lastCheck` 读作进展，并把那份报告的英文文字对应到模式包的要求上，因此随应用提供的示例无需任何改动就能显示各阶段。

`standing(project)` 为每次快照和 agent 的项目简报推导出项目的现状（`ResearchStanding`），从不存储。为其他模式或路线存储的进展视为没有。它包括：

- 当前模式在当前路线上的各阶段：`done`、`current`（第一个既未完成也未推迟的阶段）、`pending` 或 `deferred`，每个带检查点标记，以及最近一次检查发现未满足之处对应的模式包提示；
- 下一阶段及其第一条提示；
- `checkedAt`，最近一次检查的时间；
- `changedSinceCheck`：`.research`、`exports`、`.git` 与 `node_modules` 之外是否有项目文件或目录比那次检查新，目录时间包含删除与重命名；每个项目最多每 30 秒列一次时间，超过 5,000 个文件或无法完成遍历时为 `unknown`；
- `finished`：全文检查通过、每个阶段都已完成，而且全文检查之后没有改动；
- 待处理的问题：每项有发现的检查一组，有错误的组排在前面，组名取门禁的 `label` 或基础检查的内置名称，并附上组内第一个仍存在的文件。

声明了 `deferrable: <key>` 的阶段，在它未完成且项目有一条带该键的决策（`record-decision` 带 `key`）时处于推迟状态。spark-to-paper 的实验阶段声明的是 `experiments-deferred`。推迟的阶段永远不算完成，所以有推迟阶段的项目永远不算已完成；等这个阶段自己的检查通过，它就是已完成。

## 会被拒绝的操作

服务只拒绝不安全或不真实的操作，从不拒绝进行中的工作：

- 项目之外的路径，以及无论怎样拼写都指向 `.research` 的写入（按规范化、不区分大小写的路径判断）；
- 从凭据与密钥目录导入，产品数据目录也在其中；例外是附件存储的 `<数据目录>/attachments/v1/files`，其中是用户附加到对话里的文件（其中指向外部的链接仍会被拒绝）；
- agent 从项目之外其他任何位置导入时需等待用户批准，`automatic` 下会直接拒绝；
- 对已记录的实验标识再次提交，以及猜测运行状态（无法确认的运行记为 `unknown`）；
- 引文在其定位处并不存在的证据关联；
- 除两个科研凭据（生图密钥与嵌入密钥）之外的提供方凭据；
- 位于磁盘根目录、用户主目录或系统目录的项目根目录。

## 并发

每个项目的记录变更逐一进行。项目创建、这几个草稿命令以及 `archive-project` 与 `unarchive-project` 也逐一进行，因此同一文件夹的两次创建只记录一个项目，连点两次「新研究」也只打开一份草稿。耗时工作（编译、渲染页面、导入并抽取资料、构建环境、提交与观测实验）在队列之外的记录副本上运行，只把结果放回队列内应用，因此编译不会阻塞保存，无法连通的 SSH 主机也不会阻塞整个项目。正在提交的运行在提交结果记录之前不会被观测，观测结果也不会覆盖期间已经结束的运行。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxresearch--researchworkbench"></a>

### `ctx.research` — `ResearchWorkbench`

One durable owner for each project's evidence, files, decisions and execution records.

```ts cordis-catalog
/**
 * Read detached project snapshots and non-secret component settings.
 * @returns every project without source bodies, with where it stands, the unfinished goals of its live
 * conversations, and whether it is the untouched draft or removed from the list; the preferences, the
 * research home in effect and the component status.
 */
@Remote async snapshot(): Promise<ResearchSnapshot>

/**
 * Where new researches are created now: the person's `researchHome`
 * preference, else the configured `researchHome`, else `<profile home>/SciPaper`.
 * @returns the absolute research home.
 */
researchHome(): string

/**
 * Where a project stands, derived from its stored progress, its mode and its
 * files; never stored. File times are listed at most every thirty seconds.
 * @param project - the project record.
 * @returns its phases, the next one and what it lacks, the open issues, and whether files changed since the last check.
 */
standing(project: ResearchProject): Promise<ResearchStanding>

/**
 * Read durable operation handles, including interrupted calls from prior launches.
 * @returns every recorded task, with project bodies stripped from results.
 */
@Remote tasks(): ResearchTask[]

/**
 * Create (or reopen) a research project around one canonical DSH Workspace. Nothing starts.
 * @param request - title, absolute root, brief, and optional mode and autonomy.
 * @returns the project record.
 */
@Remote async create(request: CreateProjectRequest): Promise<ResearchProject>

/**
 * Create or reopen a project. A caller that already runs in a session (the
 * agent creating its own project) binds that session instead of a new one.
 * @param request - title, absolute root, brief, and optional mode and autonomy.
 * @param sessionId - the calling session to bind, when there is one.
 * @returns the project record.
 */
async createProject(request: CreateProjectRequest, sessionId?: string): Promise<ResearchProject>

/**
 * Save model roles, explicitly bound tool locations, the research home,
 * whether examples are listed and which kinds of memory new researches
 * carry, never model secrets. A research home among the examples is refused.
 * @param preferences - the complete preference record.
 * @returns the preferences as stored.
 */
@Remote async configure(preferences: ResearchPreferences): Promise<ResearchPreferences>

/**
 * Store a provider's API key under its fixed research credential name.
 * @param kind - the image provider or the embedding endpoint; it must be configured first.
 * @param value - the API key.
 */
@Remote async setCredential(kind: 'image' | 'embedding', value: string): Promise<void>

/**
 * Provision a tool component as a queryable background operation.
 * @param component - which managed tool to install.
 * @returns the job handle to follow through tasks().
 */
@Remote installComponent(component: 'python' | 'uv' | 'latex' | 'drawio'): Promise<ResearchResponse>

/**
 * Admit a desktop action; long operations return a job the desktop follows.
 * @param request - one research command.
 * @param signal - cancellation of the call.
 * @returns the outcome, or a job handle for a long operation.
 */
@Remote async command(request: ResearchCommand, signal: AbortSignal): Promise<ResearchResponse>

/**
 * Every project record, detached, without evidence text (see getProject).
 * @returns copies of all project records.
 */
projects(): ResearchProject[]

/**
 * One project's record with its evidence text, for tools and checks that read sources.
 * @param id - the project.
 * @returns a detached copy of its record.
 */
getProject(id: ProjectId): ResearchProject

/**
 * The project whose root contains a directory, preferring the innermost one.
 * @param directory - a session's working directory.
 * @returns that project, or undefined outside every project.
 */
async projectAt(directory: string): Promise<ResearchProject | undefined>

/**
 * The unfinished goals of a project's live conversations, read through the
 * goal service: every live top-level session whose working directory lies in
 * the project (and in no project nested inside it) and whose goal is not
 * complete. A conversation that is not loaded is not seen.
 * @param project - the project record.
 * @param projects - every project, which decides the research a working directory belongs to; read afresh when absent.
 * @returns the goals, those that drive rounds first, then the most recently changed.
 */
activeGoals(project: ResearchProject, projects?: readonly ResearchProject[]): ResearchGoal[]

/**
 * Dispatch a validated tool or desktop command. The desktop receives a job
 * for long operations; the agent waits for the result inside its tool call.
 * `start-new`, `relocate`, `discard-draft`, `archive-project` and
 * `unarchive-project` are the desktop's alone.
 * @param raw - the command as received.
 * @param signal - cancellation of the call.
 * @param actor - who acts: the desktop user or the agent.
 * @param sessionId - the agent's conversation, recorded on the runs it submits; absent for the desktop.
 * @returns the outcome.
 */
async execute(raw: ResearchCommand, signal: AbortSignal, actor: 'user' | 'agent', sessionId?: string): Promise<ResearchResponse>
```

Source: [`packages/research/workbench/src/index.ts`](../../packages/research/workbench/src/index.ts)

<a id="ctxresearchknowledge--researchknowledge"></a>

### `ctx.researchKnowledge` — `ResearchKnowledge`

Shared graph engine for all research modes in one profile.

```ts cordis-catalog
/**
 * Execute graph work within both caller and plugin lifetimes.
 * @param signal - caller cancellation.
 * @param work - operation over the shared graph engine.
 * @returns the operation's result.
 */
run<T>(signal: AbortSignal, work: (engine: KnowledgeBase, signal: AbortSignal) => Promise<T>): Promise<T>
```

Source: [`packages/research/workbench/src/knowledge-plugin.ts`](../../packages/research/workbench/src/knowledge-plugin.ts)

<a id="ctxresearchknowledgeevidence--researchknowledgeevidence"></a>

### `ctx.researchKnowledgeEvidence` — `ResearchKnowledgeEvidence`

The research question, conclusions and evidence of a project, shared by all research modes in one profile.

```ts cordis-catalog
/**
 * Project a research record into its evidence graph. Nothing is stored or written.
 * @param project - the research record.
 * @returns the question, the conclusions, the evidence behind them and the counts per status.
 */
graph(project: ResearchProject): EvidenceGraphPage
```

Source: [`packages/research/workbench/src/knowledge-evidence-plugin.ts`](../../packages/research/workbench/src/knowledge-evidence-plugin.ts)

<a id="ctxresearchknowledgemap--researchknowledgemap"></a>

### `ctx.researchKnowledgeMap` — `ResearchKnowledgeMap`

The domain map of the research field, shared by all research modes in one profile.

```ts cordis-catalog
/**
 * Execute map work within both caller and plugin lifetimes, with the graph engine.
 * @param signal - caller cancellation.
 * @param work - the operation; it receives the engine and a signal that fires on either cancellation.
 * @returns the operation's result.
 */
run<T>(signal: AbortSignal, work: (engine: KnowledgeBase, signal: AbortSignal) => Promise<T>): Promise<T>

/**
 * The domain map of the field, encoded once per loaded map.
 * @param signal - caller cancellation.
 * @returns the map page.
 */
view(signal: AbortSignal): Promise<MapViewPage>

/**
 * Details of papers of the map, for a hover card.
 * @param indices - paper indices in the built-in graph.
 * @param signal - caller cancellation.
 * @returns their details, unknown indices left out.
 */
papers(indices: readonly number[], signal: AbortSignal): Promise<MapPaperView[]>

/**
 * Where a search text lands on the map, with the papers and patterns it matched. Nothing is recorded: a search is
 * the person's, not a recall of the agent's.
 * @param root - the project root, whose marks recall honours.
 * @param query - the search text.
 * @param embedder - semantic pattern ranking, when configured.
 * @param signal - caller cancellation.
 * @returns the search's placement and matches.
 */
search(root: string, query: string, embedder: Embedder | undefined, signal: AbortSignal): Promise<MapSearchView>

/**
 * What a research places over the map: its idea (the agent's latest recall query, else the brief), its
 * imported literature, the papers its recent recalls returned, and its marks.
 * @param project - the research record.
 * @param embedder - semantic ranking for placing the brief, when configured.
 * @param signal - caller cancellation.
 * @returns the overlay.
 */
overlay(project: Pick<ResearchProject, 'root' | 'brief' | 'evidence'>, embedder: Embedder | undefined, signal: AbortSignal): Promise<MapOverlayPage>
```

Source: [`packages/research/workbench/src/knowledge-map-plugin.ts`](../../packages/research/workbench/src/knowledge-map-plugin.ts)

<a id="ctxresearchknowledgememory--researchknowledgememory"></a>

### `ctx.researchKnowledgeMemory` — `ResearchKnowledgeMemory`

What the researches on this computer leave for the next one, shared by all research modes in one profile.

```ts cordis-catalog
/**
 * Project the researches into the memory a new research can carry. Nothing is stored or written.
 * @param projects - every research record the host holds.
 * @param options - the examples to leave out, the finished researches, the person's switches and the venue names.
 * @returns the researches that left memory, and their literature, finished experiments, environments, venue templates and lessons.
 */
page(projects: readonly ResearchProject[], options: MemoryOptions): ResearchMemoryPage

/**
 * Reduce a page to what the agent reads.
 * @param page - the memory of the researches other than the one the agent works in.
 * @returns only the kinds the person switched on, each cut to the agent's limit, with research titles in place of ids.
 */
carried(page: ResearchMemoryPage): CarriedMemory
```

Source: [`packages/research/workbench/src/knowledge-memory-plugin.ts`](../../packages/research/workbench/src/knowledge-memory-plugin.ts)

<a id="ctxresearchknowledgerelations--researchknowledgerelations"></a>

### `ctx.researchKnowledgeRelations` — `ResearchKnowledgeRelations`

The relation graph of a research: typed relations between its methods, tasks, datasets, metrics and papers, each grounded in a quotation of one of its sources.

```ts cordis-catalog
/**
 * Read the graph around an entity: its neighbourhood, the most connected entities and the rejected relations.
 * @param project - the record; its evidence text is not read.
 * @param query - the entity (id, name or alias) and the neighbourhood's limits.
 * @param signal - caller cancellation.
 * @returns the page, and the neighbourhood described for the agent.
 */
graph(project: RecordedProject, query: GraphQuery, signal: AbortSignal): Promise<Answered<RelationsPage>>

/**
 * Find the best explained paths between two entities.
 * @param project - the record; its evidence text is not read.
 * @param query - the two ends (ids, names or aliases) and the search limits.
 * @param signal - caller cancellation.
 * @returns the paths with the grounds of every hop, and the paths described for the agent.
 */
paths(project: RecordedProject, query: PathQuery, signal: AbortSignal): Promise<Answered<RelationPathsPage>>

/**
 * Build the gap matrix of methods against tasks, datasets or settings over the project's own sources.
 * @param project - the record with evidence text loaded; the matrix reads its passages.
 * @param query - the axis, optionally the rows and columns (ids or names), and whether subtypes count; they do not by default.
 * @param signal - caller cancellation.
 * @returns the matrix with the wording keys, and the matrix described for the agent.
 */
gaps(project: RecordedProject, query: GapQuery, signal: AbortSignal): Promise<Answered<RelationGapPage>>

/**
 * Check and record proposed relations, each on its own.
 * @param project - the record with evidence text loaded; quotations are searched in it.
 * @param proposals - at most 50 relations with their grounds.
 * @param by - who proposes; the agent's quotations face the strict grounding rule, the person's the lighter one.
 * @param signal - caller cancellation.
 * @returns one outcome per proposal in order, and the repair done to a damaged stored file.
 */
propose( project: RecordedProject, proposals: readonly RelationProposalInput[], by: Actor, signal: AbortSignal, ): Promise<Answered<RelationProposalOutcomeView[]> & { repaired: string[] }>

/**
 * Reject or restore a relation, or one of its grounds.
 * @param project - the record (only its root is used).
 * @param change - `reject` or `restore`, the relation, the ground when only one is meant, and a reason for a rejection.
 * @param by - who decides; the person's rejection stands against the agent until the person restores it.
 * @param signal - caller cancellation.
 * @returns the outcome.
 */
decide( project: ProjectRoot, change: { verb: 'reject' | 'restore'; relation: string; ground?: string | undefined; reason?: string | undefined }, by: Actor, signal: AbortSignal, ): Promise<RelationDecisionOutcomeView>

/**
 * Create an entity, or add aliases to the one a name already names.
 * @param project - the record (only its root is used).
 * @param input - the kind, name and aliases.
 * @param by - who acts.
 * @param signal - caller cancellation.
 * @returns the outcome.
 */
entity( project: ProjectRoot, input: { kind: 'method' | 'task' | 'dataset' | 'metric'; name: string; aliases?: string[] | undefined }, by: Actor, signal: AbortSignal, ): Promise<RelationEntityOutcomeView>

/**
 * Merge one entity into another of its kind; no operation undoes it.
 * @param project - the record (only its root is used).
 * @param input - the merged entity and the survivor, by id.
 * @param by - who merges.
 * @param signal - caller cancellation.
 * @returns the outcome.
 */
merge( project: ProjectRoot, input: { from: string; into: string }, by: Actor, signal: AbortSignal, ): Promise<RelationMergeOutcomeView>

/**
 * Pairs of entities that may be one.
 * @param project - the record (only its root is used).
 * @param signal - caller cancellation.
 * @returns the suggestions and the same described for the agent.
 */
suggestions(project: ProjectRoot, signal: AbortSignal): Promise<Answered<RelationMergeSuggestionView[]>>

/**
 * Check the quotations whose source moved to a new revision against it, and move those that still hold.
 * @param project - the record with evidence text loaded.
 * @param signal - caller cancellation.
 * @returns how many quotations moved and how many no longer hold.
 */
reground(project: RecordedProject, signal: AbortSignal): Promise<RelationRegroundView>

/**
 * Fetch the reference lists of the papers whose list is missing or older than the configured age from OpenAlex and
 * Crossref, and record every citation among the project's papers. Cancelling stops the requests; nothing is written then.
 * @param project - the record.
 * @param signal - caller cancellation.
 * @returns the papers asked for, the lists now cached, the citations added, and the failed requests.
 */
citations(project: RecordedProject, signal: AbortSignal): Promise<RelationCitationsView>
```

Source: [`packages/research/workbench/src/knowledge-relations-plugin.ts`](../../packages/research/workbench/src/knowledge-relations-plugin.ts)

<a id="research-events"></a>

### `research/*` events

<a id="researchmode--emit"></a>

#### `research/mode` — emit

A project was created or its mode changed, after the change was stored. The mode's skills follow it into the project's sessions.

```ts cordis-catalog
/**
 * A project was created or its mode changed, after the change was stored.
 * The mode's skills follow it into the project's sessions.
 * @param event - the project, its root and the mode now recorded.
 * @mode emit
 */
'research/mode'(event: ResearchModeEvent): void
```

Source: [`packages/research/workbench/src/index.ts`](../../packages/research/workbench/src/index.ts)
<!-- END GENERATED cordis-surface -->
