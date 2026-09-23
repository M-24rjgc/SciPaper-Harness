---
description: "research 组地图：科研版背后的科研台账服务及其模型工具，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/research

[English](README.md) | 中文

## 概述

research 组把 harness 变成科研协作者：它能从一个想法或已有的实验结果出发，完成一篇可编译、可投稿的论文。本组只有一个服务包：项目台账（`ctx.research`）及其模型工具，涵盖证据、文献、文件与 LaTeX、Python 环境、实验、页面渲染，以及只报告不拦截的论文检查。工作由 agent（智能体）推进；科研 agent 预设、其技能与 `ui-research` 客户端插件不在本组内。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`workbench`](workbench/README.zh.md) | 记录每个科研项目并检查论文：证据、文件、决策、环境、实验、编译与导出 | `ctx.research`；注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [科研子系统](../../docs/subsystems/research.zh.md)——项目记录、模式与检查、会被拒绝的操作，以及 Cordis API。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-research-workbench)——每个受支持配置字段。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
