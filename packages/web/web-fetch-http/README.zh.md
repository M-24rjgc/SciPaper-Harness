---
description: "ctx.web 的匿名公共 HTTP(S) 抓取后端：部署方如何挂载有界、安全的 URL 抓取，含逐跳校验重定向及有界文本/PDF 解码。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-fetch-http

[English](README.md) | 中文

## 概述

有了 `dsh-web-fetch-http`，harness 可以通过 web 服务（`ctx.web`）抓取公共 HTTP(S) 页面，并在不发送凭据的情况下获得状态码与有界、解码后的内容。当组合需要 URL 校验、公开地址解析、连接固定、可配置的匿名跨源重定向、字节和字符上限及显式产品 `User-Agent` 时选择它。它把非 2xx 响应作为结果而非错误返回，并拒绝非公开目标与不受支持的内容类型。PDF 按页提取文本，不执行文档脚本；扫描页需要 OCR。面向模型的 `web_fetch` 工具位于 `dsh-tool-web`，由它渲染本提供方的正文。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `http` 抓取提供方身份注册，因此当它是唯一可用的抓取后端时，`ctx.web.fetch()` 会自动解析到它——也可以用 `fetchProvider: http` 固定。

### 何时选择

当部署必须以有界输出和安全传输抓取公共页面时选择此后端：不发送凭据，每个已解析地址必须是公共地址（默认还接受本机 fake-ip 代理给出的占位应答），每次连接都固定到已校验的地址集合，重定向无法逃出源站，每个响应都有上限。

### 最小配置

加载 web 服务与本提供方；可配置上限都有安全默认值，并在插件构造时验证，因此无效值会直接报错，而不是构造出上限荒谬的提供方。URL 安全上限固定为 2,048 个字符。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-fetch-http'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxResponseBytes` | `5,000,000` | 响应主体最大字节数 |
| `maxBodyChars` | `100,000` | 解码主体最大字符数 |
| `timeoutMs` | `30,000` | 抓取超时——资源兜底，不是面向模型的工具预算 |
| `maxRedirects` | `5` | 允许的重定向最大跳数（`0` 表示不跟随） |
| `userAgent` | `deepseek-harness/…` | 每次请求发送的 `User-Agent` 标头 |
| `allowCrossOriginRedirects` | `false` | 允许匿名跨源跳转，每一跳都校验目标；拒绝 HTTPS 降级 |
| `allowFakeIpDns` | `true` | 抓取所有 DNS 应答都是 fake-ip 代理占位地址（位于 `198.18.0.0/15` 或 `2001:2::/48`）的主机名；`false` 则拒绝 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-fetch-http)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 抓取返回什么

成功调用产生 `WebFetchResult`：允许的重定向之后的最终 URL、HTTP 状态码、分类为 `html` 或 `text` 的解码正文，以及 `truncated` 标志。非 2xx 响应是结果而非错误——状态码是被抓取资源状态的一部分；`WebError` 只用于无法安全获取或表示资源的失败。

```text
const page = await ctx.web.fetch({ url: 'https://example.com' })
// page.body.kind === 'html' | 'text'; page.statusCode === 200 | 404 | ...
```

### 传输行为

提供方保持请求匿名且有界：只接受不含内嵌凭据且不超过 2,048 个字符的 `http:` 与 `https:` URL。它只解析一次主机名；只要结果中有任何 IPv4 或 IPv6 地址不是公共单播地址（下文的 fake-ip 例外除外），就拒绝整个结果，并把连接固定到已校验的地址集合。IPv6 检查会发现活动 DNS64 前缀，并拒绝指向非公开 IPv4 的转换地址。每次同源重定向都会重复解析与固定；跨源重定向须开启 `allowCrossOriginRedirects`，每一跳都重新校验目标。提供方还强制执行字节、字符、跳数和时间上限，拒绝不支持的内容类型，并发送显式产品 `User-Agent`。

经 HTTP 代理（`HTTPS_PROXY` 或 `HTTP_PROXY`，由启动器设置，或由 Desktop 应用依据操作系统代理设置）发送的请求会跳过本地解析与固定，因为由代理解析源站。代理策略绕过的跳数仍走“解析并固定”路径，地址检查会拒绝的 IP 字面量也绝不会交给代理。

### fake-ip 代理

Clash、mihomo 和 sing-box 的 fake-ip 模式会用 `198.18.0.0/15`（IPv4）或 `2001:2::/48`（IPv6）内的占位地址应答每次 DNS 查询，并通过 TUN 接口把连接映射回真实主机名。这两个范围保留用于基准测试（RFC 2544、RFC 5180），绝不是真实的互联网目标，因此这类应答并不说明请求实际去向。启用 `allowFakeIpDns`（默认）时，所有地址都落在这两个范围内的主机名会被抓取：连接固定到占位地址，由代理解析真实名称，这与显式 HTTP 代理路径把解析交给其代理的做法一致。占位地址与任何其他非公开地址混合的应答，以及位于这些范围内的 IP 字面量，仍被拒绝。设置 `allowFakeIpDns: false` 可拒绝这类应答；此时拒绝信息会指出可能原因及两种补救办法：此选项和 `HTTPS_PROXY`。

代价是：恶意或配置错误的解析器把主机名应答到这些范围内时，不再被拒绝。没有 fake-ip 代理的机器上这些范围没有路由，连接会失败；在把它们路由到真实主机的网络（如部分运营商和云网络）上，请求会到达这些主机。此类部署应设置 `allowFakeIpDns: false`。

### 失败与恢复

失败会抛出 `WebError`，其中包含可供程序路由的错误码：`WEB_INVALID_URL`、`WEB_BLOCKED_URL`、`WEB_FETCH_TOO_LARGE`、`WEB_FETCH_TIMEOUT`、`WEB_REDIRECT_BLOCKED`、`WEB_UNSUPPORTED_CONTENT_TYPE`、`WEB_ABORTED` 或 `WEB_PROVIDER_ERROR`。直接调用方可以按错误码路由；面向模型的 `web_fetch` 工具会在自己的错误包装层内把失败文本呈现给模型。由 fake-ip 应答引起的 `WEB_BLOCKED_URL` 会如实说明原因并给出两种补救办法。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本包基于一项职责分离和一套分层超时机制：

- **安全获取与呈现分离。** 本提供方拥有 URL 校验、公开地址强制规则、连接固定、HTTP 传输、重定向策略、上限、charset 与 PDF 文本解码；`dsh-tool-web` 拥有 HTML→markdown 与截断格式化。非 2xx 响应是数据，不是失败。
- **两层超时。** 提供方的 `timeoutMs` 是直接 `ctx.web.fetch()` 调用方的资源兜底；面向模型的工具调用预算属于 `dsh-tool-call-timeout-policy`，由它触发 `exec.signal`。外层截止期限先到时，提供方报告 `WEB_ABORTED`，策略再以 `TOOL_TIMEOUT` 替换；因此 `WEB_FETCH_TIMEOUT` 标识的是提供方预算耗尽的直接服务调用方。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、上限验证、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `HttpFetchProvider`：固定连接、重定向跟随、有界读取、charset 解码 |
| [`src/network.ts`](src/network.ts) | 公开地址解析、DNS64 发现与连接固定 |
| [`src/policy.ts`](src/policy.ts) | URL 校验、同源检查、内容类型分类、charset 解析 |
| — | 不发布运行时不变量配套入口；除所属 seam 强制执行的约定外，本包没有独立的事件序列或可变数据关系。 |

### 读取路径

抓取先校验 URL，只解析一次主机名，结果中只要有非公开地址就拒绝（`allowFakeIpDns` 开启时，只由 fake-ip 占位地址组成的应答会被接受），并把连接固定到已接受地址。每次允许的重定向都重复该检查；不允许的重定向或非公开目标在接收响应字节前失败。最终响应按 `Content-Type` 分类、依声明的 charset 解码，并在字节上限内读取；解码后的文本再截断到字符上限。

PDF 文本提取每次使用独立 Worker，V8 old-generation 上限为 256 MiB，不继承环境变量。这是解析器资源限制，不是操作系统内存沙箱。取消时会终止并等待 Worker 退出。CMap 与字体从已安装的 PDF.js 包读取；不执行文档脚本或 OCR。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的抓取请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——六包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方正文的面向模型 `web_fetch` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-fetch-http)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 `dsh-tool-web`：该工具把本提供方经 `maxBodyChars` 限制的解码文本或由 HTML 转换得到的 markdown 置于抓取结果包装层内，而重定向、标头与传输上限保持隐藏。因 fake-ip 应答而被拒绝时，模型收到的是 `web_fetch` 的错误文本，其中指出可能原因（fake-ip 代理给出了基准测试范围内的地址）与两种补救办法。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方何时不安全或不合适。它们是当前包约束。

- **支持的内容**——html/xhtml、`text/*`、JSON/XML 与 PDF 文本。缺少或不受支持的内容类型明确报错。无效、加密或没有文本的 PDF 会失败，不会返回空内容的成功；不执行 OCR。
- **charset 只来自 `Content-Type` 标头**（默认 UTF-8）——HTML `<meta charset>` 声明会被忽略；声明但无法识别的 charset 标签会抛出异常，而非回退。
- **默认接受 fake-ip 应答**——完全落在 `198.18.0.0/15` 或 `2001:2::/48` 内的主机名会被抓取，因此在把这些范围路由到真实主机的网络上，指向那里的名称会到达这些主机；此类网络应设置 `allowFakeIpDns: false`。该检查从不接受混合应答或 IP 字面量，而经代理发送的请求根本不做本地检查。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
