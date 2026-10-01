# 安装与更新 SciPaper Harness

[English](install-and-update.md) | 中文

本指南介绍如何在 Windows 上安装 SciPaper Harness、它如何自动更新、你的数据存在哪里，以及如何从源码构建并发布。

## 安装

1. 在 [Releases 页面](https://github.com/M-24rjgc/SciPaper-Harness/releases)的最新版本里下载 `scipaper-harness-<版本>-win-x64.exe`。
2. 运行它。安装包还没有代码签名，Windows 会提示「未知发布者」：点「更多信息」，再点「仍要运行」。安装位置可以自己选。
3. 打开 SciPaper Harness，在「设置 → 模型」里添加模型服务商和密钥。「设置 → 科研」里的生图密钥（gpt-image-2）和嵌入接口密钥是可选的。

draw.io、Python 和 uv 随安装包一起提供，编辑示意图和运行实验都不需要另装任何东西。LaTeX 不随安装包提供：编译论文时，SciPaper Harness 使用你电脑上已安装的 MiKTeX 或 TeX Live，或你在「设置 → 科研」里指定的 TeX 程序目录，并且从不改动这份安装。只有一个都找不到时，它才会在第一次需要时下载一份私有的 TinyTeX；论文缺少的宏包也只装进这份私有的 TinyTeX。

## 更新

软件打开 10 秒后会检查一次本仓库的新版本，你在菜单里点「检查更新…」时也会检查。有新版本时，它会先问你，再下载，并用该版本的 SHA-512 校验下载内容，然后在重启时完成安装。每次只下载安装包里有变化的部分。

目前发布的都是 `alpha` 通道的预览版：新版本可能会改变项目的存储方式或 agent 的工作方式。

## 你的数据

- `~/.research-workbench` 保存项目记录、对话、设置，以及已下载的配图库图片缓存。
- 项目自己的文件（论文、图、代码、数据、实验运行）都留在你为它选择的文件夹里。
- API 密钥保存在你用户目录下的 `~/.research-workbench/.credentials.yaml`；它们从不写进项目，也不会传给实验环境。

更新或卸载软件都不会动这些数据。

## 反馈问题

打开对话的「轨迹」标签。工具栏上显示这段对话的「日志 ID」，例如 `c2d58e92`，所以一张轨迹页的截图本身就写明了它对应哪份日志。点 ID 旁边的复制按钮，可把完整的 ID（`session-` 加一长串标识）放进剪贴板；点「导出日志」，则把整段对话保存为文件名含完整 ID 的 ZIP，桌面版会问你保存到哪里。反馈时把 ID 或 ZIP 连同你的描述一起发给开发者。对话右上角「…」菜单里也有「复制日志 ID」和「下载 Session 日志」，在「对话」标签里同样可用。

ZIP 里是纯文本的对话日志（`session.v<N>.jsonl`）、它的子 agent 日志和附件，因此可能包含你项目里的文件内容、路径和工具输出，分享前请先看一遍。除非你自己发出去，否则不会上传任何东西。开发者只凭这个 ID 就能在你的电脑上找到日志：`~/.research-workbench/sessions/<项目文件夹>/` 下以完整 ID 命名、或以 `session-` 加简写 ID 开头的那个文件夹里，有 `session.v<N>.jsonl.zstd`。

<a id="build-from-source"></a>

## 从源码构建

先安装 Node.js 24 和 pnpm，然后在仓库目录里运行：

```sh
pnpm install
pnpm run build:research
```

打包 Windows 安装包，再通过 GitHub CLI 把它发布为本仓库的一个 Release（需要登录一个对本仓库有写权限的账号）：

```sh
pnpm --dir apps/desktop run package:win:x64:unsigned
pnpm --dir apps/desktop run release:github
```

[桌面应用 README](../../../apps/desktop/README.zh.md) 详细介绍了更新源和发布前的检查。
