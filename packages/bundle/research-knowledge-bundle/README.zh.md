---
description: "共享研究模式检索和可视化知识图谱。"
kind: "package-bundle"
---

# 科研知识图谱

[English](README.md) | 中文

## 概述

SciPaper Harness 的可选插件，提供研究模式检索、主张比对、项目图谱构建和可视化浏览。入口位于插件页的“科研扩展”。

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

启用后，普通、CCF 和 Spark to Paper 模式共享 `research_knowledge` 工具与 `research-knowledge` Skill。关闭插件会取消图谱任务并撤下工具和 Skill，保留项目 `.research/kg` 目录中的数据。

图谱来源包括内置 AI 文献语料和项目自建图谱。未配置 embedding 时使用关键词检索；配置后可增加语义排序。主张比对支持直接提交主张与参考文献文本，并兼容 Spark to Paper 的 `story.json`。

插件页面支持搜索、来源与领域筛选、节点详情、原文链接。自建图谱使用提取后的 `papers.jsonl` 和 Agent 编写的聚类名称；提取及命名方法由共享 Skill 提供。Embedding 设置与科研配图检索共享，API key 保存在主机凭据库中。

本包只负责选择图谱提供者，不单独发布运行时不变量检查组件；生命周期、缓存、工具与项目数据的一致性由科研服务负责。

<a id="model-experience"></a>
## 模型体验

### 共享知识检索

#### 模型看到什么

启用后，普通、CCF 和 Spark to Paper 模式都提供 `research_knowledge` 工具和 `research-knowledge` Skill。工具返回研究模式、论文、图谱及主张比对的结构化结果。关闭插件后，后续请求会撤下这些能力。

#### Token 影响

工具 schema、按需读取的 Skill 内容和检索结果会占用模型上下文。内置语料在本地读取，不会整库插入模型请求。

#### KV Cache 影响

启用或关闭插件会改变后续请求的工具目录和能力指引。配置不变时，这些内容保持稳定；检索结果仍随请求变化。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 内置语料覆盖 AI 研究；其他领域需要从提取后的论文构建项目图谱。
- 语义排序需要 embedding 服务；没有该服务时仍可使用关键词检索。
- 主张比对只辅助检索，不能据此确认科学创新性或验证论文结论。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
