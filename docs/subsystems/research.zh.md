# Research

[English](research.md) | 中文

科研子系统是科研版背后的台账。[`@deepseek-ai/dsh-research-workbench`](../../packages/research/workbench/README.zh.md) 拥有 `ctx.research`：每个科研项目一条持久记录、读写这条记录的模型工具，以及告诉 agent（智能体）工作是否完成的检查。工作由 agent 通过普通对话、目标（goal）和技能推进；服务只记录有什么、从哪来、什么已过期、做过哪些决定。它从不向会话注入提示词，也从不因为检查未通过而拒绝某个操作。

源码：[`packages/research/workbench/src/types.ts`](../../packages/research/workbench/src/types.ts)

## 项目记录

一个 `ResearchProject` 绑定一个规范的 Workspace 目录。它记录证据（导入的资料、文献、收集到的运行输出）、论点及其证据关联、带修订号与输入的已登记文件、环境、实验运行、编译、页面渲染与视觉复核、决策，以及最近一次检查报告。三个设置决定 agent 如何工作：

| 字段 | 取值 | 含义 |
|---|---|---|
| `mode` | 已安装的模式包 id；默认 `general` | 项目所在的模式包（见下文）。 |
| `route` | 该模式包的某条路线 | 在模式包内走的路径，例如从想法、提案或实测结果开始。 |
| `autonomy` | `checkpoints`、`automatic` | agent 在关键决策处提问（`ask_user_question`，会暂停正在运行的目标），还是自行决定并记录理由。`automatic` 搭配 `research-auto` 权限预设：沙箱越权请求直接拒绝，而不是等待审批。 |

记录存放在 `research_workbench` 存储域中（单文档布局，版本 1）。旧形态的记录会在读取时迁移：阶段机字段被移除，已确认的阶段转为用户决策；原先内置的 `paper-first` 与 `from-results` 模式转为 spark-to-paper 模式包的 `proposal` 与 `data` 路线，`free` 或未设置的模式转为 `general`。模式、路线、阶段与检查的 id 都以字符串存储，因此即使记录所指的模式包已被移除，记录照样能打开，项目按 `general` 运行。抽取出的证据文本存放在快照旁的 `.research/chunks/<evidence>/<revision>.json`，而不在记录里，因此一次变更只重写台账，不会重写每份资料的全文。

## 模式包

模式包是 `packages/research/workbench/runtime/modes/<id>/` 下的一个目录：一份 `mode.yml` 清单、只在项目处于该模式时才对 agent 可见的技能，以及其门禁要运行的脚本。`ModeRegistry`（`src/modes.ts`）在启动时加载并校验各模式包，损坏的模式包会被跳过并给出警告；`general` 模式包必须能加载。

| 清单字段 | 含义 |
|---|---|
| `id`、`order`、`name`、`summary` | 标识与显示，名称含英文与中文 |
| `source` | 该模式包所依据的上游仓库、版本与许可证 |
| `entry`、`preload` | 运行该模式的技能，以及在它之前加载的技能 |
| `routes`、`defaultRoute` | 模式内可选的路径 |
| `phases` | 每个阶段的名称、所属路线、技能、是否为检查点、决定它的检查，以及它要求的事实 |
| `gates`、`scripts` | 模式包的检查要运行的 Python 脚本，以及 agent 可以运行的脚本 |

通用模式也是一个模式包，只是没有阶段、没有技能：全部科研工具，不走流水线。模式包的技能通过与科研工具一起挂载的技能提供者送达 agent：它按会话工作目录所在项目的模式列出技能，因此切换模式会在进行中的会话里替换技能目录。`research/mode` 事件在项目模式变化时通知这个提供者。

阶段要求使用一组固定的事实：文件通配（`file`，可带 `min`）、`manuscript`、`bibEntries`、`sections`、`figures`、`diagram`、`pagesInspected`、`reviewCurrent`、`runsCollected`、`noActiveRuns`、`dataEvidence` 与 `resultsOrData`。以列表给出的要求，其中任意一项成立即视为满足。

门禁是模式包里的 Python 脚本。它用平台 Python 在项目根目录运行（`python -I -X utf8`，不经过 shell，按参数向量传参），输出的最后一行是 `{"findings": [{severity, message, file?, line?}]}`；除此之外的任何输出都记为一条错误发现。检查从不安装 Python：没有它时，每个门禁都报告自己无法运行。`research_artifact` 的 run-script 以同样方式运行模式包为项目当前路线声明的脚本，并返回脚本的输出。spark-to-paper 模式包通过这样一个适配器原样运行上游的检查脚本；它的 `NOTICE.md` 列出了取用、修补和替换了哪些内容。

CCFA 模式包沿用 CCFA-Skills：十六个专职技能，每个都在两个前置技能（先 `ccf-humanization`，再 `ccf-common`）之后运行，项目状态记在 `ccfa.yaml`。它的路线是上游总控建议的路线（`full-paper`、`manuscript-improvement`、`post-review-response`），外加一条不设阶段、可做任意单项任务的 `open`。它的门禁检查这些技能写出的文件：`ccfa.yaml` 是否具备 v0.4.0 的字段；每份评审报告用上游的 `validate_version_comparison.py --report` 校验，并列出其中未解决的 critical 与 major 问题；修订台账；投稿就绪记录；以及源文件和发布文件夹里的本机用户目录路径。上游的交接模式跟随项目的自主度：`checkpoints` 在上游 partial 交接的触发点提问，`automatic` 不提问。

## 会议模板

`research_artifact` 的 list-venues 与 apply-template 使用一个模板库：139 个 CCF 会议、16 套官方样式（`runtime/venues`，由 `scripts/build_venues.py` 从 CCFA-Skills 构建）。应用一个会议会把样式套件、该会议自己的示例和指南放进 `template/<venue>/`；项目的每个顶层文件夹都在 TeX 搜索路径上，所以项目里任何位置手写的论文都能找到该文档类。同时它把 `template.json`、`main.tex.tmpl` 和样式文件写进项目根目录，供 spark-to-paper 的拼装使用。review 阶段在会议要求匿名时匿名（通过文档类选项或匿名作者块）；final 使用终稿选项。编译时会把会议文档类需要的东西装进托管的 TeX Live：缺失的样式、文档类与参考文献样式文件按提供它们的包安装，字体和图片只在发行版能指出所属包时才安装。

## SVG 图

`research_media` 的 audit-svg 用平台 Python 原样运行 spark-to-paper 自带的 SVG 审计（`runtime/figures/audit_svg.py`）：越界、文字重叠、图形压住标签、随线宽缩放或被裁掉的箭头、悬空的连线、低于像素下限的字号、Times 覆盖不到的字符，以及描摹出来的大量路径。带 `save` 时，报告保存在 spark-to-paper 的图门禁读取的位置。export-figure 通过 svglib 和 reportlab 导出保留可编辑文字的矢量 PDF：svglib 不画 `<marker>`，所以先把箭头等标记展开成普通图形；系统有 Times New Roman 时嵌入该字体；并渲染 1440 与 480 像素宽的预览图。

## 配图库

`research_media` 的 find-reference-figures 检索一个配图库：约 3,500 张经人工复核的 ICLR、ICML、NeurIPS、CVPR、ACL 与 AAAI 论文（2023 至 2026 年）的 Figure 1 与概览图，来自 Top-Conf Figure Gallery。随包发布的只有它的索引（`runtime/figure-gallery/index.json.gz`，由 `scripts/build_figure_gallery.py` 构建）：每张图的论文、作者、会议、年份、视觉类型、Oral、Spotlight 与获奖标记、尺寸和设计分。筛选条件按会议、年份、类型和等级（`award` 包括最佳论文与荣誉提名）缩小范围；查询词用 BM25 在标题、作者、会议和类型上为剩下的图排序；没有查询词时，最受认可的图排在前面。配置了嵌入接口后，第一次查询会在后台把所有标题的嵌入写进产品主目录的缓存，之后的查询把标题嵌入与关键词排序融合。每页都会注明排序依据：`browse`、`keyword` 或 `semantic`。

图片留在配图库那边。fetch-reference-figures `{galleryIds, label}` 从配图库的仓库、CDN 镜像或它的网站取回选中的图，缓存在产品主目录（`research/cache/figure-gallery`），并保存为 `figures/refs/<label>.gallery_<id>.<ext>`，旁边附一份写明论文及其版权的 `.source.json`；配图库已下架的图会报告它已不存在。同一个动作带 `arxivIds` 时，从 ar5iv 取其他论文的总览图。工作台的「配图灵感」标签页浏览同一份索引，图片通过宿主路由 `/api/research/gallery/image?id=` 加载。这些图是各模式画图技能的排版参考，绝不作为论文素材。

## 知识图谱

`research_knowledge` 读取科研模式图谱：从论文中提炼出的可复用「问题 → 解法 → 故事」模式，做法沿用 spark-to-paper 的图谱构建。内置图谱从上游的 AI 语料精简而来，以 `runtime/kg/ai-kg.json.gz` 随包发布：包含模式、带故事字段与五个最近邻的论文，不含向量。`scripts/build_kg.py` 离线转换上游压缩包，读取其中的 networkx pickle 时使用不执行文件中任何代码的反序列化器。项目也可以用 agent 抽取好的语料自建图谱（先 `build-graph`，再 `name-patterns`），存放在 `.research/kg/`。

排序使用对模式与论文文本的 BM25，再加上图谱里的论文近邻。配置了嵌入接口（`preferences.embedding`，密钥 `RESEARCH_EMBEDDING_API_KEY`）后，对模式文本的余弦相似度通过倒数排名融合加入排序；新颖性检查在嵌入空间里把故事与最接近的工作比较，沿用上游 0.88 / 0.82 的分档；项目图谱改用平均链接聚类而不是 k-means。每个结果都会注明依据。图谱在首次使用时加载，闲置十分钟后释放。

## 检查

`research_check` 对磁盘上的文件和台账做确定性检查并给出报告；它定义的是“完成”，而不是许可。下列基础检查在每种模式下都会运行；模式包再加上自己的阶段与门禁。阶段的要求成立、且决定它的检查没有错误时即为完成。整篇论文（scope 为 `all`）只有在没有任何检查报告错误、并且当前模式在当前路线上的每个阶段都已完成时，才算通过。

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

## 会被拒绝的操作

服务只拒绝不安全或不真实的操作，从不拒绝进行中的工作：

- 项目之外的路径，以及无论怎样拼写都指向 `.research` 的写入（按规范化、不区分大小写的路径判断）；
- 从凭据与密钥目录导入；agent 从项目之外导入时需等待用户批准；
- 对已记录的实验标识再次提交，以及猜测运行状态（无法确认的运行记为 `unknown`）；
- 引文在其定位处并不存在的证据关联；
- 除两个科研凭据（生图密钥与嵌入密钥）之外的提供方凭据；
- 位于磁盘根目录、用户主目录或系统目录的项目根目录。

## 并发

每个项目的记录变更逐一进行。耗时工作（编译、渲染页面、导入并抽取资料、构建环境、提交与观测实验）在队列之外的记录副本上运行，只把结果放回队列内应用，因此编译不会阻塞保存，无法连通的 SSH 主机也不会阻塞整个项目。正在提交的运行在提交结果记录之前不会被观测，观测结果也不会覆盖期间已经结束的运行。

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
 * @returns every project without source bodies, the preferences and the component status.
 */
@Remote async snapshot(): Promise<ResearchSnapshot>

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
 * Save model roles and explicitly bound tool locations, never model secrets.
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
 * Dispatch a validated tool or desktop command. The desktop receives a job
 * for long operations; the agent waits for the result inside its tool call.
 * @param raw - the command as received.
 * @param signal - cancellation of the call.
 * @param actor - who acts: the desktop user or the agent.
 * @returns the outcome.
 */
async execute(raw: ResearchCommand, signal: AbortSignal, actor: 'user' | 'agent'): Promise<ResearchResponse>
```

Source: [`packages/research/workbench/src/index.ts`](../../packages/research/workbench/src/index.ts)

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
