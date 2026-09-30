---
description: "为无界面配置选择 SSH 远端执行后端。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-ssh-remote-bundle

[English](README.md) | 中文

## 概述

这个可选组合包把已配置的非桌面环境的文件系统、进程和沙箱服务接到一台 POSIX SSH 主机。它不控制桌面工作区的选择。桌面用户可从侧栏的「添加 SSH 工作区」入口使用远端文件、终端和 TypeScript/JavaScript LSP。

## 目录

- [使用](#use-this-package)
- [实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用

把该组合包加入无界面或自定义配置，并在启动前设置 `DSH_SSH_ENABLE_REMOTE=1` 及五个参数：`DSH_SSH_HOST`（OpenSSH 主机别名）、`DSH_SSH_NODE`（远端 Node 绝对路径）、`DSH_SSH_HELPER`（远端辅助程序绝对路径）、`DSH_SSH_HELPER_HASH`（辅助程序入口的 SHA-256）、`DSH_SSH_WORKSPACE`（远端工作区绝对路径）。POSIX 主机上需预先安装辅助程序；SSH 别名需配置凭据和受信任的主机密钥。缺少开关或任何参数时，配置继续使用本地服务。

桌面插件页可以显示这个已安装的组合包，但它的开关只作用于已配置的非桌面环境。在桌面版中，从侧栏选择「添加 SSH 工作区」，输入 OpenSSH 主机别名和 POSIX 绝对目录，即可使用远端工作区。[远端工作区预设服务](../../ssh/remote-workspace-presets/README.zh.md)会校验该目录，并为桌面会话装配远端能力。

-----

<a id="understand-the-implementation"></a>
## 实现

补丁把 `dsh-ssh`、`dsh-fs-ssh`、`dsh-subprocess-ssh` 和 `dsh-sandbox-ssh` 作为一组后端装配；仅在非桌面进程且远端参数完整时关闭三项本地提供方。Windows 上的 SSH 数据流使用独立通道及 TLS-PSK 认证。本包只负责选择 SSH 后端，因此不单独发布运行时不变量入口；运行状态由 SSH、文件系统、子进程和沙箱提供方负责。

-----

<a id="further-exploration"></a>
## 延伸阅读

[SSH 连接](../../ssh/ssh/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 远端执行

#### 模型看到什么

已有的 `dsh-tool-fs` 和命令工具在配置的远端工作区运行。组合包不新增工具名或系统提示词。

#### Token 影响

远端文件内容和命令结果通过已有工具占用模型上下文。组合包自身不增加 token。

#### KV Cache 影响

选择该后端不改变工具目录；工具 schema 不变时，请求前缀保持稳定。

## 已知限制

<a id="known-limitations-and-deferred-work"></a>

- 实际连接需要可达的 POSIX SSH 主机、兼容的 Node、已安装的辅助程序及匹配的摘要。
- 本组合包的环境开关不会创建或选择桌面 SSH 工作区；每个远端工作区从侧栏入口添加。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
