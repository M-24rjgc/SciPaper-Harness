---
description: "SSH 工作区验证与隔离的远端 Agent 能力组合。"
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-workspace-presets

[English](README.md) | 中文

## 概述

本服务通过已有 OpenSSH 别名验证 POSIX 工作区，将随包提供的辅助程序安装到远端登录用户的私有主目录，并按主机和规范化路径注册独立的 Agent 预设。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本服务与 `agentPresets` 及 SSH、文件系统、子进程、沙箱、Bash、搜索和 LSP 插件包一起挂载。调用 `inspect({ host, path })` 可获得 `{ presetId, canonicalPath }`；只需要预设 ID 时调用 `ensure({ host, path })`。SSH 登录、远端 Node.js、目录访问、辅助程序或 LSP 安装、预设激活失败时，两个方法都会报错。Host 同时挂载共享科研工作台服务时，可显式设置 `researchTools: true` 添加十类科研工具。

主机参数是已有的 OpenSSH 别名，或带可选 `:端口` 的 `用户@主机`。SSH 使用非交互模式，严格检查主机密钥，不转发 SSH Agent。远端主机需要 Node.js 22 或更新版本。本服务不配置 SSH 凭据，也不放宽主机密钥策略。

添加工作区时，`inspect` 还接受 `auth` 登录选择。`{ kind: 'password', password }` 会先拿这个密码向主机验证，主机接受之后才把它保存到凭据库中该主机的记录下（见[密码登录](../ssh/README.zh.md#password-login)）；密码错误不会改变任何内容，下一次请求会重新验证。`{ kind: 'key' }` 用 OpenSSH 密钥、认证代理和配置验证，并清除此前为该主机保存的密码。不带 `auth` 的请求，例如每次恢复会话，使用主机已保存的认证方式。`forget(host)` 删除已保存的密码。主机拒绝时会以 `SshFailure` 报错，其 `kind` 为 `auth`、`unreachable`、`host-key`、`host-key-changed` 或 `unsupported`；错误信息中绝不含密码。

-----

<a id="understand-the-implementation"></a>
## 理解实现

本地包提供单文件辅助程序。SSH 将它流式上传至远端 `~/.scipaper-harness/ssh-helper` 下的 `0700` 目录，在安装前后验证 SHA-256，并以 `0500` 权限保存。注册 Agent 预设前，远端目录会经过 `realpath` 解析，以及读取和进入权限检查。此后 Bash、文件与搜索操作共用同一远端 SSH 连接和文件系统作用域。

本包还会将压缩的 TypeScript 语言服务器与编译器运行时传送至远端私有、按内容寻址的目录。通过 SHA-256 验证后才启用 LSP；远端不需要包管理器或联网下载。远端有 `rg` 时，预设使用它的绝对路径提供 `glob` 与 `grep`。

-----

<a id="model-experience"></a>
## 模型体验

### 远端工作区工具

#### 模型会看到什么

所选预设提供面向远端目录的 Bash、文件和 TypeScript/JavaScript LSP 工具。SSH 主机有 `rg` 时才显示搜索工具。工具结果保留远端 POSIX 路径。启用 `researchTools: true` 且 Host 挂载共享工作台服务时，还会提供十类科研工具；其记录仍存于本地 Host 台账，并要求唯一匹配一项已就绪的 SSH 环境。

#### Token 影响

所选工具定义会增加请求前缀的 token。Agent 使用工具时，工具调用和结果会增加会话 token；目录检查和辅助程序安装不会增加 token。

#### KV Cache 影响

工具集合不变时，所选预设在各次请求中保持稳定的工具定义前缀。启用科研工具或远端搜索可用性变化会改变该前缀；工具结果追加在后续会话内容中。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 科研工具需要已就绪的 SSH 环境，将远端执行根目录映射到一个本地研究项目；它们不会在远端另建科研记录。
- 仅支持 POSIX SSH 主机。SSH 别名认证、主机密钥录入及 Node.js 安装由本服务之外管理。
- 保存密码需要已组合的 `ctx.credentials`；没有它时，选择密码会在运行任何 SSH 命令之前被拒绝。密码会一直留在凭据库中，直到 `forget` 或密钥登录将其替换。
- 搜索依赖远端的 `rg` 可执行文件。TypeScript/JavaScript LSP 在工作区初始化时从随包运行时安装。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>实现细节</summary>

本包不发布 invariant companion。SSH 辅助程序摘要、工作区解析和预设激活均在 `inspect`、`ensure` 时验证；本服务没有独立维护的持久化观测值。

</details>
