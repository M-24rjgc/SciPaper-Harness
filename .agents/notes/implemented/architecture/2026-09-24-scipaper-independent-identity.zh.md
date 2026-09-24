# Agent Note: SciPaper Harness as an independent product

Status: implemented

[English](2026-09-24-scipaper-independent-identity.md) | 中文

## 问题

这个仓库起步于 DeepSeek Harness 0.1.6-alpha.1，以 SciPaper Harness 的名义作为桌面科研应用发布。短短几天内，上游已比那个版本多出 2,500 多个提交，而且包含破坏性变更，所以本应用无法把上游版本当作底座的更新来接收；它维护的是自己手里的代码。但它对外仍然以 DeepSeek Harness 的身份出现：每个模型请求都带着 `deepseek-harness` 的 User-Agent 和上游仓库地址，网页抓取和网页搜索服务也一样；直连 DeepSeek 模型的请求带着一个持久的匿名用户 id；插件清单扩展会在官方 DeepSeek 请求中上报正在运行的插件包；每个包的清单文件也都写着上游仓库。

## 决策

除许可证声明和 README 里的致谢之外，SciPaper Harness 与 DeepSeek Harness 不再有任何关联。

- **请求身份。** `@deepseek-ai/dsh-llm` 中的 `APP_IDENTITY` 改为 `scipaper-harness`，并附上本仓库地址，因此每个服务商请求的 User-Agent 都写明是本应用；网页抓取以及 Exa、Perplexity、DeepSeek 网页搜索服务发送同一个产品标识。
- **不带用户标识。** DeepSeek 适配器不再发送 `x-deepseek-harness-user-id`，也不再读取匿名用户 id。会话 id 与压缩标头保留：它们描述的是请求本身而不是人，并服务于服务商的缓存亲和。
- **不报插件清单。** 基础 bundle 中的 `plugin-package-inventory-deepseek` 行已停用。
- **自己的发布。** 更新来自本仓库的 GitHub Releases（[桌面发布与更新](../../../../apps/desktop/README.zh.md)）；产品有自己的版本线，从 0.2.0-alpha.1 开始，仓库不再跟踪任何上游远程。
- **包清单。** 每个包清单的 `repository` 字段都写本仓库。

DeepSeek 模型仍作为可选的模型服务商之一，与其他服务商并列，只有用户自己配置时才会使用。内部标识保持原样：`@deepseek-ai/dsh-*` 包名、`dsh` 命令、`DSH_*` 环境变量，以及继承下来的开发文档。用户不会看到它们，而重命名几千处 import 不会改变任何行为。

## 影响

- 服务商日志和网站服务器看到的是 `scipaper-harness/<版本>` 和本仓库地址。
- 模型请求不再创建 `.anonymous-user-id`；该文件存在时，`/feedback` 仍会读取它。
- 上游 DeepSeek Harness 的改动只有在有人专门移植时才会进来。
- 阅读代码和开发文档的开发者仍会看到内部的 `dsh` 名称。

## 考虑过的其他方案

**继续合并上游版本。** 差异太大，而且上游允许破坏兼容性；每次合并都等于手工重写本产品自己的改动。

**重命名所有内部标识。** 要改几千处 import、配置行和文档，却没有任何可见效果，还可能毫无收益地弄坏构建。

**保留上游的请求身份。** 这会把本应用的流量错记到另一个项目名下，还会发送一个这里谁都不需要的、每个安装都固定不变的标识。
