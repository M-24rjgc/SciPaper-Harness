---
description: "Session V4 到 V5 的 header 迁移，以及本机与 SSH 执行身份的原生 V5 准入。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

[English](README.md) | 中文

## 概述

为受支持的 V4 Session header 增加明确的本机执行身份，从而恢复为 V5。原生 V5 header 也可指定 SSH 主机和 POSIX 工作目录。迁移保留事件顺序与继承切点；已发布 V4 codec 继续负责物理事件行。

## 目录

- [使用本包](#use-this-package)
- [Header 与事件契约](#header-and-event-contract)
- [原生 V5 准入](#native-v5-admission)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[格式 catalog](../session-format-catalog/README.zh.md)为持久化恢复组装此相邻迁移边。直接导入只用于 catalog 组装和格式测试；本库没有 Cordis 挂载配置。[公开导出](src/index.ts)包括 `sessionFormatV4ToV5`、已发布 V4 与 V5 codec、V5 校验器及 V5 工件恢复器。

迁移先校验已发布 V4 header，再把 `version` 改为 5，并设置 `execution: { kind: 'local' }`。Stage 按顺序复制事件、保留序号和继承前缀长度。持久化层负责来源读取及经验证的后继代际发布。

<a id="header-and-event-contract"></a>
## Header 与事件契约

| 输入 | V5 结果 |
|---|---|
| V4 逻辑 header | 保留既有字段；增加 `version: 5` 和本机 `execution`。 |
| V4 事件或紧凑 run | 展开并输出，不改变所表示的事件。 |
| V5 物理 header | 沿用 V4 物理分帧并增加 `execution`；即使 Host 为 Windows，SSH `cwd` 仍是 POSIX 路径。 |
| V5 事件行 | 使用已发布 V4 事件编码与解码器，不转换事件形状。 |

源 codec 在转换前校验 V4。已继承的来源保留其继承事件数量，包括由带标签的 `session/end-seed` 事件确定的切点。错误的来源或目标会拒绝恢复；stage 的部分输出不代表成功。

<a id="native-v5-admission"></a>
## 原生 V5 准入

`assertReleasedV5Header` 要求版本为 5，执行身份为 `{ kind: 'local' }` 或 `{ kind: 'ssh', host }`；SSH 主机名不可为空，`cwd` 若存在则必须是 POSIX 绝对路径。为兼容旧调用点，缺省 `execution` 按本机处理，而 V5 编码会写入规范化身份。SSH `cwd` 不交给 V4 的路径校验，另按 POSIX 规则校验。

`restoreReleasedV5Artifact` 应用已发布 V4 的事件关系规则，并校验 V5 delivery 标记所属的 Session 及之前的序号。`assertReleasedV5Relationships` 执行相同的关系校验，但不替换工件。这两个入口都不检查 SSH 连接，也不读取文件系统。

<a id="further-exploration"></a>
## 进一步阅读

[格式协议](../session-format/README.zh.md)定义迁移 stage 与拒绝规则。[V4 迁移边](../session-format-v3-to-v4/README.zh.md)拥有来源事件语义；[JSONL 持久化](../session-persistence-jsonl/README.zh.md)负责代际发布。[历史 V4 schema](../../../docs/persistence-changes/historical-formats/v4.zh.md)记录选定的前驱类型目录。

<a id="model-experience"></a>
## 模型体验

间接地，通过在当前请求组装前恢复 V4 历史的 Session catalog 产生影响。

#### KV Cache 影响

仅涉及 header 的迁移不改变恢复后事件的内容或顺序。请求组装层依据生成的会话决定缓存复用。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- V4 Session 没有 SSH 执行身份；迁移赋予本机执行身份，无法根据 `cwd` 推断远端主机。
- 原生 V5 校验检查 header 与事件关系，不检查远端主机可用性或工作区访问权限。
- 本迁移边只支持相邻的 V4 到 V5 恢复；更早版本先经过 catalog 中各自的迁移边。

<a id="dev-note"></a>
### 开发备注

本包不发布 invariant companion。迁移 stage 和 codec 没有可独立偏离的运行时注册状态。
