---
description: "SciPaper 科研版：在 DSH Web 应用上组合项目工作区、科研智能体、证据、实验与论文产物。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-research-app

[English](README.md) | 中文

## Summary

本组合包在 `dsh-base` 和 `dsh-web-app` 上装配 SciPaper Harness 科研工作区。运行 `dsh --profile research`，即可在浏览器创建科研项目、管理证据与论断、运行实验及处理论文产物。`web` 与桌面配置也默认包含科研版。

## Use this package

将本包置于基础层和 Web 层之后。两个补丁选择 `research` 智能体预设，并挂载科研 Host 服务与浏览器界面。插件管理和配置页面可用于添加其他能力。

科研预设分别声明十类工具模块：项目、证据、产物、环境、实验、看板、媒体、知识、检查和任务。每一项单独加载 `@deepseek-ai/dsh-research-workbench/tools` 并设置自己的 `modules`。科研模式技能由独立的 `@deepseek-ai/dsh-research-workbench/mode-skills` 插件提供。可以通过配置补丁分别停用或配置各项，同时共用科研数据服务。

## Understand the implementation

浏览器界面属于 `@deepseek-ai/dsh-client-ui-research`；本包负责组合配置与启动迁移。不发布运行时不变量配套组件，因为实时科研状态由科研服务拥有和观测，不属于此组合层。

`migration` 导出提供 `migrateResearchProfile({ home, profileDir })`，在加载已有科研配置前调用。迁移保留原配置字节的独立备份，用日志恢复中断写入，转换支持的旧模型与预设配置，并在替换前拒绝配置冲突。独立的设置导入器会保留未能导入的节，供后续修复。

## Further Exploration

- [科研数据与工具](../../research/workbench/README.zh.md)
- [科研浏览器界面](../../client/ui-research/README.zh.md)
- [通用 Web 应用](../web-app/README.zh.md)

## Model Experience

### Research preset

#### What the model sees

`research` 预设组合标准智能体工具、科研工具和技能。各工具通过科研服务共享项目标识与证据记录。`research_check` 返回建议，不会自动认可科学论断。独立实验进程继续由科研实验运行时管理。

#### Token effect

启用的工具模块会把工具定义加入请求，加载的科研技能会加入其指令。停用的模块不会通过对应预设项添加工具定义。

#### KV Cache effect

更换启用的工具模块或科研模式可能改变后续请求的前缀。预设组合保持稳定时，这些内容在请求之间保持不变。

## Known Limitations and Deferred Work

- 迁移拒绝在目标适配器中没有对应能力的旧设置，包括自定义 Chat Completions Files API 限额和自定义预设发现目录；原文件会被保留。模型凭据、外部提供者、远程机器、Python 和 TeX 需要各自配置的环境。
