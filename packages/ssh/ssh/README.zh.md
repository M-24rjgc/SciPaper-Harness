---
description: "面向组合 POSIX 文件、进程与沙箱提供方的部署者，说明 OpenSSH 连接配置及远端辅助进程生命周期。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh

[English](README.md) | 中文

## 概述

`dsh-ssh` 将 Windows、Linux 或 macOS 上的 Harness 主机连接到 POSIX SSH 主机上已安装的辅助程序。部署方持有的 OpenSSH 主机别名，或带有已保存密码的 `用户@主机[:端口]` 目标，提供认证与主机身份；配套的文件系统、子进程和沙箱提供方共享该连接。连接在就绪前验证已安装产物的摘要；辅助程序在连接关闭或租期到期时负责远端清理。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在自定义 `dsh` 配置组合中，将本服务与 [`fs-ssh`](../fs-ssh/README.zh.md)、[`subprocess-ssh`](../subprocess-ssh/README.zh.md) 和 [`sandbox-ssh`](../sandbox-ssh/README.zh.md) 组合。主机运行 Harness、模型传输和 Session 存储；远端机器提供文件与进程。headless 配置组合支持这种安排。

### 部署前提

远端需要运行 Linux 或 macOS。Linux 和 macOS 客户端通过连接复用与 Unix 套接字转发建立程序流；Windows 客户端为程序流使用独立的 SSH exec 通道。启动前配置主机别名或目标、凭据与已知主机记录：本服务要求严格检查主机密钥并禁用认证代理转发。密钥、认证代理和 ssh 配置的认证在 `BatchMode` 下运行，没有交互流程；已保存的密码是唯一的另一种登录方式（见[密码登录](#password-login)）。

将已构建的辅助程序安装在远端，或使用 [`remote-workspace-presets`](../remote-workspace-presets/README.zh.md) 把单文件辅助程序安装到远端主目录下的私有位置。Node、辅助程序和可选引导程序必须位于工作区和可写临时目录之外，也必须位于后端会替换的临时目录树之外，例如 bwrap 的私有 `/tmp`；工作区仍可位于 `/tmp` 下。摘要校验在辅助程序启动后发现非预期的已安装产物；它不能保证可写部署文件的执行安全，也不能认证恶意 SSH 主机。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `host` | 必填 | 已有的 OpenSSH 主机别名，或带可选 `:端口` 的 `用户@主机` |
| `node`、`helper`、`workspace` | 必填 | 远端 Node 可执行文件、辅助程序打包入口和默认工作区的绝对路径 |
| `helperHash` | 必填 | 已安装辅助程序入口的小写 SHA-256 |
| `bootstrapPath`、`bootstrapHash` | 省略 | 成对提供的远端 PTC 入口及其小写 SHA-256 |
| `requestTimeoutMs` | `30000` | 连接与管理请求的截止时限，范围为 1 至 2,147,483,647 毫秒 |
| `maxFrameBytes` | `67108864` | 每条 JSON 消息的负载上限，最大为 64 MiB |
| `maxPending` | `128` | 普通未完成请求的数量上限；心跳与有界清理请求使用预留容量 |
| `leaseMs` | `30000` | 辅助进程心跳租期，范围为 3000 至 600000 毫秒 |

使用 PTC 时，配置两个引导字段，并将验证后的 `ctx.ssh.nodeExecutable` 与 `ctx.ssh.bootstrapPath` 传给 [`NodePtcRuntime`](../../ptc-runtime/ptc-runtime-node/README.zh.md)。仅使用文件系统和 Bash 时可以省略这对字段。未配置 PTC 部署时，`bootstrapPath` getter 会拒绝访问。

<a id="password-login"></a>
### 密码登录

已保存密码的主机用密码登录，不再使用密钥。密码是 [`credentials`](../../credentials/credentials/README.zh.md) 在 `ssh/host-<主机的哈希>` 下保存的凭据记录；必须组合 `ctx.credentials` 才能读取密码。已保存的密码由 [`remote-workspace-presets`](../remote-workspace-presets/README.zh.md) 在主机接受之后写入。

这类主机的每个 ssh 子进程都会收到 `SSH_ASKPASS` 和 `SSH_ASKPASS_REQUIRE=force`。askpass 程序是私有临时目录中的一个脚本，它从该子进程的环境变量 `DSH_SSH_ASKPASS_SECRET` 打印密码，因此密码不会出现在任何参数、文件、日志或错误文本中，诊断信息也会去掉它的每一处出现。子进程不启用 `BatchMode`，只尝试一次密码，关闭公钥，只用密码与 keyboard-interactive 两种方式，所以密码错误会立即失败。两种登录方式都保持严格的主机密钥检查：未知或已变更的主机密钥会失败，不会弹出确认提示。[信任新主机](#trusting-a-new-host)是单独的、显式的一步。

这需要 OpenSSH 8.4 或更新版本（`SSH_ASKPASS_REQUIRE` 自该版本引入）；更旧或无法识别的客户端会在建立任何连接之前以 `unsupported` 类别失败。在 Windows 上，该程序是 `askpass.cmd`，由它运行 Windows PowerShell 中的 `askpass.ps1`，以 UTF-8 写出密码，密码不经过 `cmd.exe`。Windows OpenSSH 客户端无法启动路径含非 ASCII 字符的程序，所以目录按顺序建在临时目录、`ProgramData` 或 `Users\Public` 之下，取第一个纯 ASCII 的位置。Windows 为每条流各建立一个已认证连接，所以每条流都会重新登录。

包入口 `@deepseek-ai/dsh-ssh/auth` 导出所有 ssh 调用方共用的部分：解析 `用户@主机:端口` 的 `parseSshHost` 和 `sshDestinationArguments`，`planSshAuth`，`SshPasswordStore`，以及 `SshFailure` 与 `classifySshFailure`，后者把 ssh 诊断归为 `auth`、`unreachable`、`host-key`、`host-key-changed` 或 `unsupported`。

<a id="trusting-a-new-host"></a>
### 信任新主机

主机密钥不在 `known_hosts` 中的主机会以 `host-key` 失败。`@deepseek-ai/dsh-ssh/host-key` 让人可以确认该密钥，而不必手动运行 `ssh`。`scanHostKey(host)` 先用 `ssh -G` 查出连接实际使用的名称、端口和 `known_hosts` 文件，再用 `ssh-keyscan` 读取密钥（优先 ed25519，其次 ECDSA，最后 RSA），返回密钥类型和 SHA-256 指纹，指纹在本地计算。它不做任何认证，也不写入任何内容；对位于 `ProxyJump` 或 `ProxyCommand` 之后的主机，由于无法直接扫描其密钥，它什么也不返回。

`trustHostKey(host, fingerprint)` 是唯一的写入方，调用方只有拿到人确认过的指纹才能到达它。它会再扫描一次，密钥不再匹配时以 `host-key-changed` 拒绝。它还会运行一次无需登录的严格探测，所以已经记录了不同密钥的主机会被以 `host-key-changed` 拒绝，绝不会被信任；密钥变更永远是硬性拒绝。否则，它把 `[主机]:端口 类型 密钥`（端口 22 则只写主机名）追加到 ssh 读取的第一个 `known_hosts` 文件。此后每个真实连接仍以 `StrictHostKeyChecking=yes` 运行，因此验证的就是所记录的密钥。这两个函数对密钥主机和密码主机的行为相同。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

OpenSSH 主连接承载私有管理 RPC。每条程序流使用独立转发的 Unix 套接字和独立 SSH 通道。程序 stdout 无法伪造管理回复，也不会占用控制流的通道窗口；SSH 传输拥塞仍会影响共享连接。

每个流预留项都有一个随机 256 位 TLS 预共享密钥，仅由管理 RPC 传递。TLS 认证两端并保护流中的每个字节；密钥绝不作为流前缀发送。套接字目录为私有目录（`0700`），套接字使用 `0600` 权限。替换可写套接字路径无法冒充端点或获知流密钥；攻击者仍可中断服务或转发不透明的 TLS 记录。

连接释放会先等待转发与取消子进程，以及尚在建立的流结束，再删除本地资源。传输丢失会拒绝待处理操作并使连接失效。辅助进程在 SSH EOF、终止信号或心跳到期时启动托管清理。断连客户端无法确认远端结果；操作不会自动重连或重放。

启动或进程结果失败后，预留项在原生进程范围清空后释放；有界完成缓存保留原始拒绝结果，供后续读取。辅助程序关闭也会等待已在进行的端点与目录清理。

终端启用 shell 活动观察时，根进程退出会保留 reservation 及其剩余工作。活动 RPC 继续访问 provider；明确终止时先等待进程范围完全停稳，再释放端点并记录完成结果。helper 连接卸载和租约到期仍保留原有的终止权限。

辅助程序以 `--disable-sigusr1` 启动，因此同用户进程发送的信号无法开启其 Node 调试器。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SSH 子系统](../../../docs/subsystems/ssh.zh.md) — 执行坐标、传输语义及生命周期归属。
- [POSIX SSH 决策](../../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md) — 理由、替代方案及必要验证。
- [SSH 密码登录决策](../../../.agents/notes/implemented/architecture/2026-10-01-ssh-password-login.zh.md) — askpass 传输、存储、主机密钥策略及被否决的替代方案。

-----

<a id="model-experience"></a>
## 模型体验

无，因为主机别名、认证与流能力令牌属于私有部署细节，每项面向模型的操作均由消费方负责。

#### KV Cache 影响

本提供方不贡献请求前缀内容。面向模型的工具与结果由消费方负责。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 底层连接不负责安装辅助程序、重连或重放操作；`remote-workspace-presets` 负责安装辅助程序和注册预设。
- Web 工作区界面的路径仍假定可访问主机文件系统；请使用 headless 或所有消费方都遵守提供方路径语义的自定义组合。
- TLS 流密钥不防御远端操作系统级进程内存检查或调试。文件效果策略保留所选沙箱后端的限制。
- 已保存的密码与凭据文件受同样的保护：只有操作系统用户自己的文件权限，在 Windows 上就是用户配置目录的访问控制列表。该用户的进程，包括 Agent 的工具进程，都能读取该文件以及正在运行的 ssh 子进程的环境。不使用操作系统钥匙串。
- 主机密钥确认通过 `ssh-keyscan` 读取密钥，所以在代理之后不可用；此时连接以不带密钥的 `host-key` 失败，人必须手动运行一次 `ssh`。指纹只有与可信渠道比对才有意义；人必须拿它与服务器管理员提供的指纹对照。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随入口。消息校验及所属文件系统、子进程和沙箱提供方执行可观察的约束；此适配器没有增加可独立观察的状态关系。

</details>
