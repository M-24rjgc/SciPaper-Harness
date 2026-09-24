# SciPaper Harness

[English](README.md) | 中文

SciPaper Harness（简称 SPH，中文界面叫「科研工作台」）是一个桌面科研 agent：从一个想法，或者手头已有的结果出发，把论文一路推进到经得起推敲的投稿。每条引文都能点回它出自的那一页，每个数字都能追溯到产生它的数据或实验运行；实验独立运行，关掉窗口也不会断。

## 预览版

SciPaper Harness 目前是内测预览版（`alpha` 通道）。**新版本可能不兼容旧版本**，Windows 安装包也还没有代码签名。运行前请先阅读[安全须知](SAFETY.zh.md)。

<a id="run"></a>

## 安装与更新

1. 在 [Releases 页面](https://github.com/M-24rjgc/SciPaper-Harness/releases)的最新版本里下载 `scipaper-harness-<版本>-win-x64.exe`。
2. Windows 会提示「未知发布者」：点「更多信息」，再点「仍要运行」。
3. 在「设置 → 模型」里填写模型服务商的密钥；生图（gpt-image-2）和嵌入接口的密钥是可选的，在「设置 → 科研」里填写。

软件打开 10 秒后会检查一次有没有新版本，菜单里的「检查更新…」也能手动检查；确认后它会下载、校验，并在重启时完成安装。每次只下载安装包里有变化的部分。项目和设置保存在 `~/.research-workbench`，更新后都还在。

## 它能做什么

- **通用模式**：拥有全部工具、不设流水线的科研 agent。
- **模式包**：在通用模式之上加入某种方法自己的技能、阶段和检查。目前有 spark-to-paper（从想法、提案或实测结果出发）和 CCFA（完整的 CCF 论文、稿件改进、审稿回复）。一个模式包就是一个目录，新增模式不需要改代码。
- **所有模式共用的底层能力**：带页码级引文的资料库；经 Crossref、OpenAlex 与 arXiv 核实的文献，并获取开放获取的全文；LaTeX，含 139 个 CCF 会议模板、编译和页面渲染；draw.io 与经过审计的 SVG 图，可导出为矢量 PDF；用 gpt-image-2 生图；科研模式知识图谱；约 3,500 张顶会 Figure 1 组成的配图库，供动笔前参考；本机或通过 SSH 的 Python 环境与独立运行的实验；只报告、不拦截的检查，它们定义论文何时算完成。

[科研子系统参考文档](docs/subsystems/research.zh.md)介绍了项目记录、模式、检查和工具。

<a id="run-from-source"></a>

## 从源码构建

先安装 Node.js 24 和 pnpm，然后在仓库目录里运行：

```sh
pnpm install
pnpm run build:research
```

打包 Windows 安装包，并通过已登录的 GitHub CLI 把它发布为本仓库的一个 Release：

```sh
pnpm --dir apps/desktop run package:win:x64:unsigned
pnpm --dir apps/desktop run release:github
```

开发请从[开发指南](docs/development.zh.md)和[架构文档](docs/architecture.zh.md)开始；agent 遵循 [AGENTS.md](AGENTS.md)。

## 致谢

- DeepSeek 开发的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，本软件起步于它的 0.1.6-alpha.1 版本，采用 MIT 许可。SciPaper Harness 是独立项目，与 DeepSeek 没有关联，也未获其认可。
- [spark-to-paper-skills](https://github.com/Spark-To-Paper-Skills/spark-to-paper-skills) 与 [CCFA-Skills](https://github.com/mikubaka88/CCFA-Skills)，两个模式包所依据的方法，采用 MIT 许可；详见各模式包的 `NOTICE.md`。
- [Top-Conf Figure Gallery](https://github.com/qwdwqfwq/topconf-paper-figure-gallery)，配图库随包附带的是它的索引；每张图的版权归其论文所有。

## 许可

[MIT](LICENSE)，保留 DeepSeek 对框架部分的版权声明。第三方依赖及其许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
