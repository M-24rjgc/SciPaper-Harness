---
description: "Host 与 Client 的 job 控制：把一个会话看得到的名册与一个 job 的保留输出镜像到浏览器，不触碰模型的消耗型游标，并代人类停止一个 job。"
kind: "package-reference"
---
# Job Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-job-controller` 让桌面列出会话可见的任务、读取保留输出、停止单个任务，或停止会话的全部工作并核实结算。`job.list` 镜像任务名册；`job.follow` 从绝对字节偏移读取输出。两条流都不改变模型的消耗型游标或完成通知。`job.kill` 与 `job.stopAll` 代表人类执行操作。Client 的 `ctx.jobs` 服务让多个查看器共享名册与输出流，并为会话头部任务列表及停止控件提供数据和操作。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Host 控制器要求活体 Agent 注册表与 job 注册表（已发布组合里是 `dsh-jobs-local`），缺少任一则不加载。`job.list({ sessionId })` 产出该会话可见的集合——运行时归属树的 job 加上所有无主 job——打开时一次，之后每一轮聚合过的生命周期提交（注册、进度、停止中、结算、移除）后再一次；输出追加从不刷新名册，因为结算后的投影已经带着最终字节数。`job.follow({ sessionId?, jobId, from? })` 经 `getTree` 核对可见性，并在每次非消耗读取中保留实际调用方会话——无主 job 不需要 session——先产出一个携带 job 投影的 `opened` 锚帧，再是聚合的 `output` 帧，job 结算且环排干后产出一个终态 `status`，随后流正常关闭；流中若通告了移除（拥有者 teardown），则以被移除 job 的终态投影收尾。两种读取都是非消耗的：模型侧 `job_output` 游标与完成播报状态永远观察不到它们。

`job.kill({ sessionId, jobId })` 以 `cancelled by the user` 为原因取消一个该会话看得到的 job，注册表把该原因合并进被杀 job 的 detail。它不是模型请求的杀停——`dsh-tool-jobs` 只对存活等待收走的结算不发通知——因此拥有者 agent 的完成通知照常送达，并带上原因；仍在等待该 job 的 shell 工具则在自己的结果里以 `[stopped: cancelled by the user]` 读到原因。它回答 `{ outcome: 'requested' }` 或 `{ outcome: 'already-finished' }`，对该会话看不到的 id 以 `job/not-found` 拒绝；运行时归属允许根会话控制后代的 job，无关根会话仍保持隔离。

Client 入口安装 `ctx.jobs`（`IJobs`），由包内部的 `ClientJobsModel` 支撑。`kill(sessionId, jobId)` 转发到 `job.kill` 并把 Remote 结果交给调用方判定准入。`watchRows(sessionId)` 不论多少查看器持有都只为每个被关注的会话开一条名册流，最后一个释放后丢弃行；重连后的首帧已经是完整事实。`observe(sessionId, jobId)` 不论多少查看器展开同一 job 都只开一条 Gateway 流，按 job 保留有界的渲染尾部并用 `gapBefore` 标记淘汰或续读缺口，在终态帧上关闭视图或把流失败记到视图上，最后一个查看器释放后丢弃视图。插件在自己的上下文仍是当前上下文时解析 Gateway 流工厂与 `job` namespace，因为流的（重）开启跑在未声明 `remote.job` 的调用栈上。

`job.stopAll({ sessionId })` 显式取消会话当前轮次及其运行时归属的活体后代，清空它们的排队工作，并请求取消它们的 job 和该会话可见的无主 job。Agent 静止与 job 结算同时观察，受 `stopWaitTimeoutMs` 限制（默认 30 秒，最多 60 秒）。结果携带 `agents`、`jobs` 与独立工作 `sources` 的实际状态和错误；超时、取消失败、仍有活跃工作或可能残留进程时，`confirmed` 为 false。独立工作适配器只在这个显式命令中执行；Agent 静止后会再次扫描，捕获停止过程中才提交的工作，各阶段共用同一个绝对截止时间。普通 `session.cancel` 仍保留已交接到后台的工作。Client 的 `ctx.jobs.stopAll(sessionId)` 转发该报告。

### 配置

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `stopWaitTimeoutMs` | `30,000` | 同时观察 Agent 与 job 停止的时限，最多 60,000 毫秒 |
| `observeFlushMs` | `100` | 注册表提交到下一次名册或输出读取之间的聚合窗口，毫秒 |
| `observeMaxFrameBytes` | `65,536` | 每个观测输出帧的软字节预算；更大的单块整块发送 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-job-controller)是所有受支持字段及其 JSDoc 的完整来源。

-----

<a id="model-experience"></a>
## 模型体验

无。job 观测是浏览器与 Host 的控制状态；它不注册任何提示词、工具或会话事件。模型对同一工作的视图仍在 [`dsh-tool-jobs`](../../jobs/tool-jobs/README.zh.md)。

#### KV 缓存影响

无直接影响；观测读取从不触碰模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 环是尽力而为的实时预览，不是终端转录：生产者的拉取源按轮询轮次复制，同一轮询窗口内两条流的写入先 stdout 落地，客户端拼接 chunk 时也不区分 `channel`。
- 两条流都是进程本地的：Host 重启丢失全部环与名册，续读的观测随后锚定在空注册表上，重开的名册从空开始。
- 按 session 的访问限制由注册表每次读取时的调用方参数强制；Remote 层本身服务任何已连接浏览器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。控制器是 `ctx.jobs` 读取的无状态投影；这些流转发的事件协议与事件对读取的关系由注册表自己的 `@deepseek-ai/dsh-jobs/invariant` 拥有。
