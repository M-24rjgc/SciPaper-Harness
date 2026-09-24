# 安装与更新 SciPaper Harness

[English](install-and-update.md) | 中文

本指南介绍如何在 Windows 上安装 SciPaper Harness、它如何自动更新、你的数据存在哪里，以及如何从源码构建并发布。

## 安装

1. 在 [Releases 页面](https://github.com/M-24rjgc/SciPaper-Harness/releases)的最新版本里下载 `scipaper-harness-<版本>-win-x64.exe`。
2. 运行它。安装包还没有代码签名，Windows 会提示「未知发布者」：点「更多信息」，再点「仍要运行」。安装位置可以自己选。
3. 打开 SciPaper Harness，在「设置 → 模型」里添加模型服务商和密钥。「设置 → 科研」里的生图密钥（gpt-image-2）和嵌入接口密钥是可选的。

LaTeX、draw.io、Python 和 uv 都随安装包一起提供，编译论文、编辑示意图和运行实验都不需要另装任何东西。

## 更新

软件打开 10 秒后会检查一次本仓库的新版本，你在菜单里点「检查更新…」时也会检查。有新版本时，它会先问你，再下载，并用该版本的 SHA-512 校验下载内容，然后在重启时完成安装。每次只下载安装包里有变化的部分。

目前发布的都是 `alpha` 通道的预览版：新版本可能会改变项目的存储方式或 agent 的工作方式。

## 你的数据

- `~/.research-workbench` 保存项目记录、对话、设置，以及已下载的配图库图片缓存。
- 项目自己的文件（论文、图、代码、数据、实验运行）都留在你为它选择的文件夹里。
- API 密钥存放在操作系统的凭据库中，从不写进项目。

更新或卸载软件都不会动这些数据。

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
