---
description: "从插件页启用本机桌面操作。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-computer-use-cua-bundle

[English](README.md) | 中文

## 概述

这个可选组合包同时装配电脑操作服务与 Cua Driver 原生提供方。随应用提供，默认关闭。

## 目录

- [使用此包](#use-this-package)
- [实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

在桌面版侧栏打开**插件**，启用**桌面操作**。宿主随后加载供 Agent 调用的本机电脑操作提供方。关闭组合包会移除相应工具。应用需要获得操作系统授予的桌面查看与控制权限。

-----

<a id="understand-the-implementation"></a>
## 实现

`cordis.patch.yml` 同时挂载 `dsh-computer-use` 和 `dsh-computer-use-cua-driver-native`。组合包自身没有可变运行时状态，也不发布运行时不变量入口。

-----

<a id="further-exploration"></a>
## 延伸阅读

[电脑操作子系统](../../../docs/subsystems/computer-use.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### Cua Driver 工具

#### 模型看到什么

启用 `computer-use-cua-native` 行后，Agent 会看到已安装的 Cua Driver 提供的工具说明。工具结果可以包含文本和截图；图像输入需要兼容的模型路线与附件存储。

#### Token 影响

驱动的工具 schema 会进入模型请求。工具调用和被接收的截图结果会占用上下文，直到被压缩。

#### KV Cache 影响

启用或关闭组合包会改变后续请求的工具目录。不变的工具目录可以保持稳定的前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 电脑操作依赖受支持的桌面环境和操作系统权限。原生驱动失败可能影响宿主进程。
- 这个组合包操作共享桌面，不提供按会话隔离的桌面环境。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
