# 后台任务运行时

[English](jobs.md) | 中文

长时间运行的生产方、`ctx.jobs` 与任务控制命令共用的类型。[seam 收敛 Agent Note](../../.agents/notes/implemented/architecture/2026-09-03-jobs-seam-consolidation.zh.md) 负责当前设计，[运行时 Agent Note](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md) 记录其起源；本页记录 [`packages/jobs/jobs/src/types.ts`](../../packages/jobs/jobs/src/types.ts) 与客户端安全叶子 [`view.ts`](../../packages/jobs/jobs/src/view.ts) 中的确切字段与变体。

## ID 与状态

`JobId` 是按 `<kind>-N` 生成的[品牌化 id](core.zh.md#branded-ids)。访问控制依赖拥有者授权，而非 id 的保密性。`JobKind` 派生自可合并扩展的 map；注册表将各个 kind 视为不透明的 id 命名空间。

```ts type-equiv
/**
 * Producer-defined job kinds. Plugins extend this map by declaration merging;
 * the registry treats every value as an opaque id namespace.
 */
interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
}
```

`JobStatus` 为 `'running' | 'stopping' | 'completed' | 'killed' | 'failed'`；生产方特有的事实在运行期间归入 `JobView.progress`，结算后归入 `JobView.detail`。

## 生产方约定

`JobSpec` 声明身份、拥有者会话、可选的拉取式 `output` 源与启动器。运行时会在完成预检后携带该 job 的 `JobHandle` 调用 `run()`，随后提交注册，不再执行可能失败的步骤。生产方拥有执行资源；运行时拥有身份、访问、生命周期状态与输出环。

```ts type-equiv
/**
 * Producer declaration passed to {@link JobRegistry.start}. The runtime
 * preflights access and cleanup before invoking {@link run}; the producer owns
 * execution resources while the runtime owns identity, lifecycle state, and
 * the output ring.
 */
interface JobSpec {
  /** Producer kind — also the id prefix (`bash`, `subagent`, …). */
  kind: JobKind
  /** One-line model-facing label (the command; the delegation description). */
  label: string
  /**
   * Owning session. Access is fenced by it, and the owner's live Agent must be
   * the one currently registered under that id: its disposal cancels and
   * awaits the job. Omitting the owner creates an unowned job, open to any
   * caller until service disposal.
   */
  owner?: SessionId
  /**
   * Optional UTF-8 byte cap for each complete model-facing completion notice or
   * output read, including controller status metadata. Independent of ring
   * retention: it bounds the consuming model surface, never observers.
   */
  outputLimitBytes?: number
  /**
   * Pull sources the registry pumps into the ring at its own cadence.
   * Producers that narrate their own progress use {@link JobHandle.append}
   * instead; a job may use both.
   */
  output?: readonly JobOutputSource[]
  /**
   * Start the work after preflight and synchronously return its hooks. Called
   * once with the job's producer face; a throw leaves nothing registered (the
   * spent ordinal is skipped), and the producer must clean up any partially
   * started resources.
   * @param job - the issued id plus the ring append and progress writers.
   */
  run(job: JobHandle): JobHooks
}
```

```ts type-equiv
/**
 * Producer face of one registered job, handed to {@link JobSpec.run} and
 * valid for the job's whole life. All methods are synchronous. Writes staged
 * inside the starter call are retained and become visible with the
 * registration commit; after settlement — the producer's own outcome, a kill,
 * or a registry-forced teardown end — writes log and drop instead of
 * throwing, so a producer's trailing flush cannot break its own teardown path.
 */
interface JobHandle {
  /** The registry-issued id (`<kind>-N`). */
  readonly id: JobId
  /**
   * Append one chunk to the output ring. Offsets advance by the chunk's UTF-8
   * byte length; an empty chunk is dropped without waking observers.
   * @param text - the chunk text, exactly as produced.
   * @param options - stream label and gap marker.
   */
  append(text: string, options?: JobAppendOptions): void
  /**
   * Replace the live progress line (`3/10`, the current phase). Settlement
   * clears it; the terminal reason travels in {@link JobOutcome.detail}.
   * @param line - the new progress line.
   */
  updateProgress(line: string): void
}
```

`JobHooks.done` 会在生产方释放其资源后 resolve，而不是仅在工作完成时 resolve。结果是一个值而非流的 job——subagent 的报告、workflow 渲染出的结果——把它作为 `JobOutcome.result` 返回；模型在结算后的第一次读取携带它一次。

```ts type-equiv
/** Hooks through which the runtime controls and observes producer work. */
interface JobHooks {
  /**
   * Request termination. Must be synchronous, idempotent, and eventually settle
   * {@link done}; throws propagate. The optional reason is forwarded verbatim.
   */
  cancel(reason?: string): void
  /**
   * Resolves after the producer releases its resources, not merely when work
   * finishes. Must not reject; the runtime converts a rejection to `failed`.
   * If teardown cancellation throws, the runtime may force-fail only the
   * registry record without claiming that the work stopped.
   */
  done: Promise<JobOutcome>
}
```

```ts type-equiv
/** Terminal result supplied by a producer through {@link JobHooks.done}. */
interface JobOutcome {
  /** How the job ended: finished (`completed`), cancelled (`killed`), or broke (`failed`). */
  status: 'completed' | 'killed' | 'failed'
  /**
   * Terminal reason rendered into status lines (`exit code: 3`, `max-tokens`).
   * When the job settles `killed` after a {@link JobRegistry.kill} with a
   * reason, the registry appends that reason.
   */
  detail?: string
  /**
   * Return value for jobs whose result is a value rather than a stream (a
   * workflow's rendered result, a subagent's report). The output ring carries
   * the stream; this is handed out once by the model's next {@link JobRegistry.read}.
   */
  result?: string
}
```

拉取源把一个非消耗的偏移读取器——子进程的 `readFrom` 家族——交给注册表。注册表按自己的节奏（`dsh-jobs-local` 的 `pumpPollMs`）泵送每个源，并在结算封环之前再排干一次，因此生产方不需要把任何东西折进 `done`。

```ts type-equiv
/**
 * A pull source the registry pumps into the job's output ring — the subprocess
 * `readFrom` family. The registry owns the cadence and drains every source one
 * last time before settlement closes the ring, so a producer folds nothing
 * into its `done`.
 */
interface JobOutputSource {
  /** Stream label attached to every chunk this source yields. */
  channel?: JobChannel
  /**
   * Read everything captured since `fromByte` without consuming it.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 first).
   * @returns the delta text, the next offset, the lossy flag, and the spill path the source currently keeps.
   */
  read(fromByte: number): JobSourceRead
}
```

```ts type-equiv
/** One incremental read from a {@link JobOutputSource}. */
interface JobSourceRead {
  /** Text captured since the requested offset (the whole retained tail when lossy). */
  text: string
  /** Whole-stream offset to resume from on the next read. */
  nextOffset: number
  /** True when the requested offset slid out of the source's retained window. */
  lossy: boolean
  /**
   * Host path of a file holding the complete stream, when the source
   * currently keeps an intact one. Reported on every read, so the registry
   * tracks it as source metadata: a later read without it withdraws the file.
   */
  spillPath?: string
}
```

## 输出环

每个 job 拥有一个有界的环。拉取源被泵入其中，`JobHandle.append` 的推送整块落地；模型通过注册表保管的游标（`JobRegistry.read`）消耗该环，任意数量的观察者按绝对字节偏移读取它（`JobRegistry.readAt`），二者互不干扰。`JobChannel` 标记 `stdout`、`stderr` 与 `log`；`log` 是只到达观察者、从不进入模型消耗式读取的生产方叙述。结算即封流并把保留量裁剪到结算上限——环没有独立的生命周期。拉取源保留的 spill 文件是 job 元数据（`JobView.output.spillPaths`，每次泵读取都会刷新），不是逐块元数据，所以环淘汰了字节之后、甚至缺口 chunk 本身也被淘汰之后，模型的丢失输出提示仍能点名该文件。浏览器通过 [`dsh-api-job-controller`](../../packages/api/job-controller/README.zh.md) 的 Remote 流 `job.list` 与 `job.follow` 触达名册与环，其帧列于下文的 Cordis API 一节。

```ts type-equiv
/** One chunk of a job's output ring: absolute offset, text, channel, and loss marker. */
interface JobChunk {
  /** Absolute offset of the chunk's first byte; offsets never move once assigned. */
  readonly at: number
  /** Chunk text exactly as appended (possibly tail-trimmed by retention). */
  readonly text: string
  /** Stream label, when the producer supplied one. */
  readonly channel?: JobChannel
  /** Bytes immediately before this chunk were lost, at the producer or to retention. */
  readonly gapBefore?: true
}
```

```ts type-equiv
/** Result of one non-consuming {@link JobRegistry.readAt}. */
interface JobOutputRead {
  /** Retained chunks overlapping `[from, total)`, in offset order. */
  chunks: readonly JobChunk[]
  /**
   * Offset to resume from — the ring's current `total`. Always a chunk
   * boundary: appends land whole and trimming only advances chunk starts, and
   * consumers concatenate `chunks` under that assumption, so a provider
   * serving partial chunks would silently duplicate text.
   */
  next: number
  /** True when `from` fell below the oldest retained byte, so bytes are missing before `chunks`. */
  lossy: boolean
}
```

## 消费方视图

`JobView` 是每个读者都消费的唯一投影：模型工具、浏览器名册与观测流。`owner` 携带划定访问边界的会话 id；注册表为生命周期清理解析其背后的活体 `Agent`，从不把该对象交出去。`progress` 是生产方的实时行，结算时清除；`detail` 是终态原因，合并了记录下来的 kill 原因。

```ts type-equiv
/**
 * Read-only projection of one job — a fresh object per call, never live
 * registry state. The model tools, the browser roster, and the observation
 * stream all consume this one shape.
 */
interface JobView {
  /** The registry-issued id (`<kind>-N`). */
  readonly id: JobId
  /**
   * The producer kind the job was registered with: a Host-registered
   * `JobKind`, carried as an open string because a browser bundle or a Remote
   * codec sees only the `JobKindMap` merges its own program compiles.
   */
  readonly kind: string
  /** The producer-supplied one-line label. */
  readonly label: string
  /** Owning session; absent for an unowned job, which every caller can see. */
  readonly owner?: SessionId
  /** Producer-owned cap for complete model-facing notices and reads, in UTF-8 bytes. */
  readonly outputLimitBytes?: number
  /** Current lifecycle state. */
  readonly status: JobStatus
  /** The producer's live progress line (`3/10`, the current phase); cleared at settlement. */
  readonly progress?: string
  /** Terminal reason (`exit code: 3`); a recorded kill reason is merged in. */
  readonly detail?: string
  /** Epoch ms when the job was registered. */
  readonly startedAt: number
  /** Epoch ms when the job settled; absent while live. */
  readonly finishedAt?: number
  /**
   * The output ring's absolute coordinates and the complete-stream files
   * behind it. `total` is the offset the next chunk starts at (0 while
   * nothing was written); `earliest` is the oldest retained byte, greater
   * than zero exactly when retention dropped the head. `spillPaths` lists the
   * spill files the job's pull sources currently keep, in source order and
   * deduplicated, and is absent while no source keeps one: it outlives any
   * chunk, so a reader below `earliest` can still name where the bytes went.
   */
  readonly output: { readonly total: number; readonly earliest: number; readonly spillPaths?: readonly string[] }
}
```

`JobRegistry` 的 `list`、`get`、`read`、`readAt`、`kill` 和 `wait` 各自接收调用方的 `SessionId`；省略调用方时仅可访问无主 job，传入会话时还可访问该会话拥有的 job。

```ts type-equiv
/** Output and post-read state returned by the consuming {@link JobRegistry.read}. */
interface JobRead {
  /** Ring chunks appended since the model cursor, in offset order; every channel included. */
  chunks: readonly JobChunk[]
  /** True when the cursor fell below the oldest retained byte, so bytes are missing before `chunks`. */
  lossy: boolean
  /** The producer's {@link JobOutcome.result}, handed out by the first read after settlement only. */
  result?: string
  /** The job's state at read time. */
  job: JobView
}
```

<a id="session-tree-stop"></a>

## 会话树停止

`JobStopReport` 记录显式会话树停止所选中的普通任务和独立工作适配器。`SessionStopRequest` 携带当前运行时的 Agent 树和统一截止时间；适配器报告保留各目标的停止确认和错误。`job.stopAll` 接收 `JobStopAllRequest` 并返回 `JobStopAllValue`，其中包含观测到的 Agent 状态。

```ts type-equiv
/** Trusted caller and shared deadline for an explicit session-tree stop. */
interface SessionStopRequest {
  /** Requested root session; absent only for an unowned Host control. */
  readonly sessionId?: SessionId
  /** Exact currently registered caller; durable session lineage grants no authority. */
  readonly caller?: Agent
  /** Verified live runtime ownership tree, including the caller. */
  readonly agents: readonly Agent[]
  /** Absolute epoch-millisecond deadline shared by every stop participant. */
  readonly deadline: number
  /** Cancellation reason forwarded to the selected resources. */
  readonly reason?: string
  /** Cancels observation; requested resource stops remain in force. */
  readonly signal?: AbortSignal
}
```

```ts type-equiv
/** Adapter invoked only by explicit stop-all, never by turn cancellation or service disposal. */
type SessionStopSource = (request: SessionStopRequest) => Promise<StopSourceReport>
```

```ts type-equiv
/** Cancellation and observed settlement for one job, including a failed stop. */
interface JobStopResult {
  readonly job: JobView
  /** Cancellation or observation failure; a terminal record alone does not prove termination after this failure. */
  readonly error?: string
}
```

```ts type-equiv
/** One independently managed target observed by an explicit stop source. */
interface StopSourceTarget {
  /** Source-specific stable resource identifier. */
  readonly id: string
  /** Fresh observed lifecycle state, including unknown when observation failed. */
  readonly status: string
  /** True only after the adapter verified this resource is no longer active. */
  readonly confirmed: boolean
  /** Cancellation or observation failure for this target. */
  readonly error?: string
}
```

```ts type-equiv
/** Bounded cancellation report supplied by a detached-work adapter. */
interface StopSourceReport {
  /** True only when every selected independent target was confirmed stopped. */
  readonly confirmed: boolean
  /** Individual resource observations; an empty list alone does not confirm an adapter failure. */
  readonly targets: readonly StopSourceTarget[]
  /** Adapter-wide cancellation or observation failure. */
  readonly error?: string
}
```

```ts type-equiv
/** Source identity and its observed independent work. */
interface NamedStopSourceReport extends StopSourceReport {
  /** Effect-scoped adapter's public registration label. */
  readonly source: string
}
```

```ts type-equiv
/** Bounded stop of the live jobs owned by a session and its live runtime descendants. */
interface JobStopReport {
  /** True only when all selected jobs and independent work were verified stopped. */
  readonly confirmed: boolean
  /** Actual ordinary-job projections and any cancellation or observation failures. */
  readonly jobs: readonly JobStopResult[]
  /** Explicit-stop adapters; these do not participate in ordinary cancellation or disposal. */
  readonly sources: readonly NamedStopSourceReport[]
}
```

```ts type-equiv
/** Explicit human stop of a session's active turn and its live descendant work. */
interface JobStopAllRequest {
  readonly sessionId: SessionId
}
```

```ts type-equiv
/** Observed quiescence of one runtime Agent after the stop request. */
interface SessionStopResult {
  readonly sessionId: SessionId
  readonly status: 'idle' | 'running'
  /** Cancellation, observation, or timeout failure. */
  readonly error?: string
}
```

```ts type-equiv
/** Observed Agent quiescence and job settlement after an explicit session-tree stop. */
interface JobStopAllValue extends JobStopReport {
  readonly agents: readonly SessionStopResult[]
}
```

## 事件

注册表通过一条带过滤的流宣布每次提交。生命周期事件携带其所宣布的提交之后的投影；`settled` 标出原因，完成播报方据此跳过 teardown；`output` 只携带 id 与新的 total，观察者从自己的游标读取，注册表从不推送负载。

```ts type-equiv
/**
 * One lifecycle or output event. Lifecycle events carry the job's projection
 * after the commit they announce; `output` carries only the id and the new
 * total, so an observer schedules a {@link JobRegistry.readAt} from its own
 * cursor and the registry never pushes payloads.
 */
type JobEvent =
  | {
    /** Registration commit, progress line change, stopping transition, or removal from the visible set. */
    readonly type: 'registered' | 'progress' | 'stopping' | 'removed'
    readonly job: JobView
  }
  | {
    readonly type: 'settled'
    readonly job: JobView
    readonly cause: JobSettleCause
    /**
     * Whether this settlement released a live {@link JobRegistry.wait}. That
     * waiter's caller receives the terminal projection as its own result, so
     * a completion reporter treats an awaited settlement as already delivered
     * and reports only the unawaited ones. A wait that timed out or was
     * aborted before the settlement does not count.
     */
    readonly awaited: boolean
  }
  | {
    readonly type: 'output'
    readonly id: JobId
    /** Owning session, absent for an unowned job. */
    readonly owner?: SessionId
    /** The ring's total after the append (or at settlement, which ends the stream). */
    readonly total: number
  }
```

```ts type-equiv
/**
 * Who a subscription hears about. `{ owner }` delivers that session's jobs
 * plus every unowned job (the set that session can see). `{ owners: 'scope' }`
 * delivers the owners composed under the subscribing context — one registry
 * serves every composition in the process, and a mount under one preset must
 * not hear another preset's agents. `{ owners: 'all' }` delivers everything.
 */
type JobEventFilter =
  | { readonly owner: SessionId }
  | { readonly owners: 'all' | 'scope' }
```

## 服务行为

抽象的 [`JobRegistry`](../../packages/jobs/jobs/src/index.ts) Service Definition 规定了原子化的 `start`、各自接收调用方的 `list`、`get`、消耗式 `read`、非消耗的 `readAt`、`kill` 与有界的 `wait`、带过滤的 `events` 流，以及 `attachController`；[`LocalJobRegistry`](../../packages/jobs/jobs-local/src/index.ts) 是进程本地的 Service Provider。授权将调用方会话解析为登记时的精确所有者或可信运行时祖先；同 id 的替换实例不会继承权限。拥有者清理与准入使用 job 启动时登记在该拥有者会话下的活体 `Agent`。本地提供方的正安全整数配置 `maxConcurrentJobsPerOwner` 默认为 `10`，按精确拥有者统计 `running` 加 `stopping` 记录，无主任务共享一个桶；生产方的终态结算释放容量；`retainBytes`（默认 262144）与 `settledRetainBytes`（默认 16384）约束每个环的运行期与结算后保留量，`pumpPollMs`（默认 150）是拉取节奏。工作可能孤立的记录会在所有者释放后保留，拒绝显式移除，并使停止全部操作保持未确认状态，直到服务释放时移除。参见 [`dsh-jobs`](../../packages/jobs/jobs/README.zh.md) 了解 Service Definition 约定，[`dsh-jobs-local`](../../packages/jobs/jobs-local/README.zh.md) 了解注册表生命周期与准入策略，[`dsh-tool-jobs`](../../packages/jobs/tool-jobs/README.zh.md) 了解面向模型的 Consumer。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxjobcontroller--jobcontroller"></a>

### `ctx.jobController` — `JobController`

Host service backing the generated `ctx.remote.job` namespace.

```ts cordis-catalog
/**
 * Stream jobs in the session's captured runtime ownership tree plus unowned jobs
 * as whole-set frames: one on open, then one after each coalesced burst of
 * lifecycle commits. The stream has no natural end; the carrier closes it.
 * @param request - the session whose visible set to mirror.
 * @param signal - cancellation owned by the Remote stream carrier.
 * @returns the roster frames.
 */
@Remote({ mode: 'stream' }) list(request: JobListRequest, signal: AbortSignal): AsyncIterable<JobListFrame>

/**
 * Stream one job's retained output from an absolute byte offset, then its
 * terminal projection once settled and drained. Non-consuming: the
 * model-facing cursor and notice state never observe these reads. The
 * request's session is the fenced read's caller; the registry rejects a
 * job the session cannot see and an unknown job.
 * @param request - target job, owner or trusted ancestor session, and optional resume offset.
 * @param signal - cancellation owned by the Remote stream carrier.
 * @returns anchor, coalesced output frames, and the terminal status.
 */
@Remote({ mode: 'stream' }) follow(request: JobFollowRequest, signal: AbortSignal): AsyncIterable<JobFollowFrame>

/**
 * Kill one background job on a human's behalf. The request's session is
 * the fenced read's caller, so the job must be one that session can see:
 * the registry requires its captured owner or a trusted runtime ancestor.
 * A replacement using the same session id has no access. The kill records
 * `cancelled by the user` as its reason; it is not one the model requested,
 * so the owning agent still receives the completion notice, and a shell
 * tool waiting on that job reads the reason in its own result.
 * @param request - Session whose job list carries the job, and the job id.
 * @returns the registry's admission of the kill request.
 */
@Remote('kill') kill(request: JobKillRequest): JobKillValue

/**
 * Stop the session's active turn, live runtime descendants, and their jobs.
 * Ordinary session cancellation retains detached jobs; this command explicitly
 * cancels them and reports observed settlement, including stops that timed out.
 * @param request - root session whose live ownership tree is stopped.
 * @param signal - cancellation of the bounded observation, not of requested stops.
 * @returns per-job states and whether no selected work remains live.
 */
@Remote('stopAll') async stopAll(request: JobStopAllRequest, signal: AbortSignal): Promise<JobStopAllValue>
```

Types: [JobStopAllRequest](jobs.zh.md#session-tree-stop) · [JobStopAllValue](jobs.zh.md#session-tree-stop)

Source: [`packages/api/job-controller/src/index.ts`](../../packages/api/job-controller/src/index.ts)

<a id="ctxjobs--jobregistry-abstract-seam"></a>

### `ctx.jobs` — `JobRegistry` (abstract seam)

Abstract background job registry. Subclass, implement the abstract members, and load the subclass as a plugin — it registers as `ctx.jobs` (one implementation per context; loading a second throws, which is cordis' standard duplicate-service behavior).

Implementations must honor these semantics:

- Registrations outlive producer and controller fibers. Owner and service disposal cancel live work and await compliant producers; a throwing teardown cancel force-fails only the record. Such settlements announce `cause: 'teardown'`, because a job whose owner is being destroyed has no reader left.
- Caller session ids resolve to exact registered runtimes. Owned-job access requires the captured owner or a trusted runtime ancestor; a replacement using the same session id inherits no access.
- Settlement is first-wins: one terminal record, released waiters, then one round of contained event delivery, even against a late producer outcome. The `settled` event follows every released waiter and reports whether it released one (`awaited`), so a completion reporter can skip settlements a waiting caller already collected.
- A settled record stays listed until its owner's disposal, service disposal, or an explicit remove by a caller that collected the terminal state itself and never handed the id out. Records reporting possibly orphaned work survive owner disposal, refuse explicit removal, and keep stopAll unconfirmed until service disposal removes them.
- start refuses work while no attached job controller serves the spec's owner, so a producer cannot start work that owner cannot collect or stop. One registry serves every composition in the process, so this question — and event delivery under `{ owners: 'scope' }` — is owner-relative rather than process-wide: registrations made from an unscoped context serve every owner, and registrations made under an agent composition's scope serve exactly the agents composed under it.
- Every job owns one output ring. Pull sources named by the spec are pumped by the registry and drained once more before settlement; pushed appends land whole. The model's consuming cursor and observers' absolute offsets read the same bytes and never disturb each other.
- Ring retention is bounded. Appends past the live cap drop the oldest retained bytes; a reader below the retained window gets a lossy read, never an error. Settlement trims retention to the settled cap and ends the stream; the ring has no separate lifecycle.

```ts cordis-catalog
/**
 * Attach an explicit-stop adapter without adopting its independent resources.
 * Scope visibility and plugin teardown follow the registering Cordis context;
 * the source validates target authority from exact runtime ownership itself.
 * Ordinary cancellation and registry/owner disposal never invoke this hook.
 * @param name - stable adapter label included in the stop report.
 * @param source - bounded cancellation and real-state observation.
 * @returns disposer removing only the hook, without stopping its work.
 */
registerStopSource(name: string, source: SessionStopSource): () => void

/**
 * Preflight access, validation, owner cleanup, and implementation-owned
 * admission before starting and atomically registering work. Any preflight
 * rejection leaves no job id or execution resource. A throwing starter
 * leaves nothing registered; after it returns, registration cannot fail.
 * @param spec - job identity, owner, output sources, and synchronous starter.
 * @returns the registry-issued `<kind>-N` id.
 */
abstract start(spec: JobSpec): JobId

/**
 * List caller-owned and unowned jobs in registration order.
 * @param caller - reading session; omission sees only unowned jobs.
 * @returns fresh projections.
 */
abstract list(caller?: SessionId): JobView[]

/**
 * List accessible jobs across the caller's runtime ownership tree. A provider
 * may retain trusted admission-time ancestry until an owner's jobs drain.
 * Durable fork lineage never grants access to another root Agent.
 * @param caller - root session; omission sees only unowned jobs.
 * @returns deduplicated projections including unowned jobs.
 */
listTree(caller?: SessionId): JobView[]

/**
 * Project one job visible to the caller's live runtime ownership tree.
 * @param id - job to look up.
 * @param caller - root session; omission sees only unowned jobs.
 * @returns a fresh projection, rejecting unknown or unrelated jobs.
 */
getTree(id: JobId, caller?: SessionId): JobView

/**
 * Cancel all live accessible jobs, then await their settlement concurrently.
 * A timeout or aborted wait never claims termination. Cancellation failures
 * are isolated per job, and newly admitted live jobs remain unconfirmed.
 * @param caller - session whose live ownership tree is stopped.
 * @param timeoutMs - non-negative finite bound; zero requests stops without waiting.
 * @param reason - cancellation reason forwarded to every selected producer.
 * @param signal - cancels observation; already requested stops remain in force.
 * @param deadlineAt - optional enclosing absolute deadline; can only shorten this wait.
 * @returns actual job states and whether all selected work stopped.
 */
async stopAll( caller: SessionId | undefined, timeoutMs: number, reason?: string, signal?: AbortSignal, deadlineAt?: number, ): Promise<JobStopReport>

/**
 * Project one job without changing its cursor. Throws for an unknown or
 * foreign job.
 * @param id - job to look up.
 * @param caller - session resolving to the captured owner or a trusted runtime ancestor; absent sees unowned jobs.
 * @returns a fresh projection.
 */
abstract get(id: JobId, caller?: SessionId): JobView

/**
 * Consume the ring from the model cursor and advance it to the current
 * total. After settlement the first read also carries the producer's
 * result. Throws for an unknown or foreign job.
 * @param id - job to read.
 * @param caller - session resolving to the captured owner or a trusted runtime ancestor; absent sees unowned jobs.
 * @returns the chunks since the cursor, the lossy flag, the result once, and the post-read projection.
 */
abstract read(id: JobId, caller?: SessionId): JobRead

/**
 * Read retained ring output without moving the model cursor. Resume with
 * a previous read's `next`; an offset inside a retained chunk returns the
 * whole chunk (its `at` may precede `from`). Throws for a negative or
 * non-integer offset, or an unknown or foreign job.
 * @param id - job to read.
 * @param from - absolute byte offset to read from (0 for the retained head).
 * @param caller - session resolving to the captured owner or a trusted runtime ancestor; absent sees unowned jobs.
 * @returns retained chunks overlapping `[from, total)`, the resume offset, and the lossy flag.
 */
abstract readAt(id: JobId, from: number, caller?: SessionId): JobOutputRead

/**
 * Request cancellation, then mark the job stopping. A producer throw
 * propagates without changing job state. A supplied reason is merged into
 * terminal `detail` when the job settles `killed`. Throws for an unknown
 * or foreign job.
 * @param id - job to cancel.
 * @param caller - session resolving to the captured owner or a trusted runtime ancestor; absent sees unowned jobs.
 * @param reason - cancellation reason forwarded verbatim to the producer.
 * @returns `requested` for live work, otherwise `already-finished`.
 */
abstract kill(id: JobId, caller?: SessionId, reason?: string): 'requested' | 'already-finished'

/**
 * Wait for settlement or timeout without cancelling the job. Caller abort
 * rejects only while the job is live; after settlement the terminal
 * projection wins. Rejects for an invalid timeout or an unknown or foreign
 * job.
 * @param id - job to wait for.
 * @param timeoutMs - positive finite wait bound in milliseconds.
 * @param caller - session resolving to the captured owner or a trusted runtime ancestor; absent sees unowned jobs.
 * @param signal - optional cancellation of the wait itself.
 * @returns projection at settlement or timeout.
 */
abstract wait(id: JobId, timeoutMs: number, caller?: SessionId, signal?: AbortSignal): Promise<JobView>

/**
 * Drop one settled job's record from the visible set and announce
 * `removed`. For a caller that collected the terminal state through its own
 * {@link wait} and never handed the id to the model, such as a shell tool's
 * foreground call. Throws for a job that is still live, may have orphaned work,
 * is unknown, or is foreign.
 * @param id - settled job to drop.
 * @param caller - session resolving to the captured owner or a trusted runtime ancestor; absent sees unowned jobs.
 */
abstract remove(id: JobId, caller?: SessionId): void

/**
 * Attach an effect-scoped controller that can read and stop jobs. It serves the
 * owners its registering context's scope covers, and {@link start} refuses an
 * owner no attached controller serves.
 * @param name - diagnostic label; duplicate names remain independent.
 * @returns disposer that detaches this controller.
 */
abstract attachController(name: string): () => void
```

Types: [JobStopReport](jobs.zh.md#session-tree-stop) · [SessionId](core.zh.md) · [SessionStopSource](jobs.zh.md#session-tree-stop)

Source: [`packages/jobs/jobs/src/index.ts`](../../packages/jobs/jobs/src/index.ts)
<!-- END GENERATED cordis-surface -->
