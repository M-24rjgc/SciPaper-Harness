---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-29-session-v5-execution

[English](2026-09-29-session-v5-execution.md) | 中文

## 概述

会话格式 V5 为 SessionHeader 和 JSONL 文件头增加执行位置标识，使 POSIX SSH 工作目录与本地主机文件系统保持区分。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-session-v5-execution
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-11-initial"
    after: "de6fbe29fc1f06c815a00507df87938b387f86f2ea62e73c2d7d518a413013b0"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "43402183993a615660748657fb626f40eb6a215a6343f77c54faf2d043960b56"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

格式版本由 V4 升级到 V5。V4 到 V5 的迁移将既有会话标记为本地执行，并保留工作目录、继承关系和事件。V5 支持本地会话以及由主机别名标识的 SSH 会话；旧运行时应迁移或拒绝 V5，不能把远端路径解释为本地路径。

<a id="verification"></a>
## 验证

session-format-v4-to-v5 的 execution 测试覆盖 SSH POSIX 路径往返、V4 本地工作目录与继承关系保持不变、拒绝 SSH 会话中的 Windows 路径，以及交付标记的会话归属校验。

<a id="dev-note"></a>
## 开发备注

无。
