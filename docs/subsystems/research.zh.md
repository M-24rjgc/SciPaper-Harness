# Research

[English](research.md) | 中文

科研子系统是科研版背后的台账。[`@deepseek-ai/dsh-research-workbench`](../../packages/research/workbench/README.zh.md) 拥有 `ctx.research`：每个科研项目一条持久记录、读写这条记录的模型工具，以及告诉 agent（智能体）工作是否完成的检查。工作由 agent 通过普通对话、目标（goal）和技能推进；服务只记录有什么、从哪来、什么已过期、做过哪些决定。它从不向会话注入提示词，也从不因为检查未通过而拒绝某个操作。

源码：[`packages/research/workbench/src/types.ts`](../../packages/research/workbench/src/types.ts)

## 项目记录

一个 `ResearchProject` 绑定一个规范的 Workspace 目录。它记录证据（导入的资料、文献、收集到的运行输出）、论点及其证据关联、带修订号与输入的已登记文件、环境、实验运行、编译、页面渲染与视觉复核、决策，以及最近一次检查报告。两个设置决定 agent 如何工作：

| 字段 | 取值 | 含义 |
|---|---|---|
| `mode` | `paper-first`、`from-results`、`free` 或未设置 | 路线。`paper-first` 先写完除实验占位外完整的方法论文，再跑实验；`from-results` 直接根据已有数据写作；`free` 不走流水线。未设置表示由 agent 选择路线并记录理由。 |
| `autonomy` | `checkpoints`、`automatic` | agent 在关键决策处提问（`ask_user_question`，会暂停正在运行的目标），还是自行决定并记录理由。`automatic` 搭配 `research-auto` 权限预设：沙箱越权请求直接拒绝，而不是等待审批。 |

记录存放在 `research_workbench` 存储域中（单文档布局，版本 1）。早期按阶段推进的工作台写下的记录会在读取时迁移：阶段、预算与暂停标记被移除，已确认的阶段转为用户决策。抽取出的证据文本存放在快照旁的 `.research/chunks/<evidence>/<revision>.json`，而不在记录里，因此一次变更只重写台账，不会重写每份资料的全文。

## 模式与检查

`research_check` 对磁盘上的文件和台账做确定性检查并给出报告；它定义的是“完成”，而不是许可。每种模式列出若干阶段，阶段的检查全部通过即为完成。整篇论文（scope 为 `all`）只有在没有任何检查报告错误、并且当前模式的每个阶段都已完成时，才算通过：

| 模式 | 阶段 |
|---|---|
| `paper-first` | idea → literature → plan → draft → experiments → results → polish → submission |
| `from-results` | ingest → plan → literature → write → figures → polish → submission |
| `free` | 无；按需运行指定检查 |

| 检查 | 报告内容 |
|---|---|
| `cite` | 没有对应参考文献条目的引用键、不完整的条目、缺少发表信息或未经提供方核实的条目 |
| `numbers` | 结果、摘要、结论与表格中无法追溯到数据证据、运行指标或代码数值的小数与百分比 |
| `placeholders` | 论文中残留的 `\tbd{}`、`--` 结果单元格、TODO 等标记 |
| `figures` | 缺失的插图文件、没有记录数据与脚本或为位图的结果图、未被引用的示意图 |
| `compile` | 尚未编译、编译失败，或编译早于当前源文件；未定义的引用与溢出的盒子 |
| `visual` | 自上次编译以来尚未渲染并查看过的页面 |
| `review` | 没有评审、评审早于稿件，或仍有未关闭的 blocker/major 问题 |
| `stale` / `claims` | 过期的文件与资料、被证据推翻的论点、已无法解析的证据关联 |
| `structure` | 缺失的输入文件、该模式应有却缺失的章节、通用文档类 |

## 会被拒绝的操作

服务只拒绝不安全或不真实的操作，从不拒绝进行中的工作：

- 项目之外的路径，以及无论怎样拼写都指向 `.research` 的写入（按规范化、不区分大小写的路径判断）；
- 从凭据与密钥目录导入；agent 从项目之外导入时需等待用户批准；
- 对已记录的实验标识再次提交，以及猜测运行状态（无法确认的运行记为 `unknown`）；
- 引文在其定位处并不存在的证据关联；
- 除科研凭据之外的生图提供方凭据；
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
 * Store the image-provider API key under its fixed research credential name.
 * @param value - the API key.
 */
@Remote async setImageCredential(value: string): Promise<void>

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
<!-- END GENERATED cordis-surface -->
