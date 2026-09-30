---
description: "在插件页选择 Exa 搜索后端。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-search-exa-bundle

[English](README.md) | 中文

## 概述

这个可选组合包为科研工作区选择 Exa 网络搜索后端。随产品提供，但默认关闭。

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

在**插件**页启用**Exa 搜索**。搜索前需要配置 `EXA_API_KEY` API key。没有密钥时后端虽已登记，仍不可使用。关闭组合包后，科研工作区恢复默认的 DeepSeek 搜索。启用 Exa 会自动关闭另一个可选搜索后端。

-----

<a id="understand-the-implementation"></a>
## 实现

组合包补丁把共享 `web` 服务的搜索提供方设为 `exa`，并挂载 `@deepseek-ai/dsh-web-search-exa`。本包只负责选择搜索提供方，因此不单独发布运行时不变量入口；运行状态由 web 服务和搜索提供方负责。

-----

<a id="further-exploration"></a>
## 延伸阅读

[网络搜索子系统](../../../docs/subsystems/web.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 搜索结果

#### 模型看到什么

启用组合包并配置密钥后，已有的 `web_search` 工具使用 Exa，返回规范化的来源结果；不会增加新工具名。

#### Token 影响

返回的来源摘要占用模型上下文。组合包不增加系统提示词。

#### KV Cache 影响

切换提供方会改变搜索结果，不改变工具 schema。工具目录不变时，重复请求的前缀保持稳定。

## 已知限制

<a id="known-limitations-and-deferred-work"></a>

- Exa 需要自己的 API key 和网络连接。
- 发起搜索前必须配置 API key。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
