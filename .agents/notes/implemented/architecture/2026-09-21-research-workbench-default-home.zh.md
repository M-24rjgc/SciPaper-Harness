# Agent Note: 科研工作台装在 DeepSeek Harness 旁边，而不是盖在它上面

Status: implemented

[English](2026-09-21-research-workbench-default-home.md) | 中文

## 问题

科研工作台是作为独立产品分发的。同一台机器上可能已经装着官方的 DeepSeek Harness，两者绝不能共用用户数据：共用一个根目录，会把本产品的会话、存储、设置与 profile 写进另一套安装的目录树，双方会互相读取、互相覆盖对方的记录。

隔离确实存在，但只有一处。`apps/desktop/src/main.ts` 在其他一切解析之前把 `DSH_HOME` 指向 `~/.research-workbench`，所以发行的 Electron 应用是对的。其余一概不是。`dsh --profile web`、命令行上的 `dsh`、以及 `scripts/dev-web.ts` 都会解析到默认的 `~/.dsh`，读到另一套安装的工作区和会话历史。开发期间跑一次 web 预览，就往真实的 DeepSeek Harness 主目录里写进了一个 profile 骨架、一个空会话和一条工作区记录。

## 决策

`DSH_HOME_DIR_NAME` 改为 `.research-workbench`，于是每个入口的默认主目录都是本产品自己的。`$DSH_HOME` 仍然可以覆盖它，桌面启动器也仍然优先读 `RESEARCH_WORKBENCH_HOME`。

隔离应当属于默认值，而不是属于某个 bundle 行或某个启动器。`resolveDshHome` 在任何配置加载之前就运行——profile 发现在启动过程中已经读了 `<home>/profiles`——所以 `packages/bundle/web-app/cordis.patch.yml` 里的一行，会在它想影响的那些路径解析完之后才生效。正是这个先后顺序，让那个多余的 `profiles/web/cordis.yml` 落进了另一套安装。

`packages/util/home-paths/tests/home-paths.spec.ts` 断言默认值不是官方 Harness 主目录、`dshCachePath()` 不含 `.dsh` 路径段，以及 `$DSH_HOME` 对刻意指定的调用方仍然可达。

## 考虑过的替代方案

**在 web bundle 里设置主目录。** 那一行会在 profile 发现之后才加载，启动流程对主目录做的第一件事仍然会用 `~/.dsh`。

**在 `apps/cli/src/bin.ts` 顶部设置 `process.env.DSH_HOME`。** 这能堵住 CLI 和 web profile，却堵不住测试、生成器或将来新增的入口，而且会让同一个正确值在桌面启动器和 CLI 里各写一遍。

**连 `DSH_HOME` 变量名一起改。** 桌面启动器已经把 `RESEARCH_WORKBENCH_HOME` 映射到它，已发布的文档写着它，Python SDK 也要求它。改默认目录已经回答了隔离需求；改名只会弄坏调用方。

## 后果

已经存在的 `~/.research-workbench`——桌面应用自发布以来一直在写——成为每个入口读取的主目录，因此 CLI 与 web 预览现在看到的是桌面应用看到的同一批项目。

不会从 `~/.dsh` 迁移任何东西。刻意想与官方安装共用主目录的开发者，显式设置 `DSH_HOME` 即可。

`dshHomeDisplay` 现在把默认值标为 `~/.research-workbench`，`docs/user/guide/network-proxy.zh.md` 也改为说明 API key 旁边那个文件是 `~/.research-workbench/.env`。
