# Agent Note: fake-ip DNS 应答和系统代理不再阻止 web_fetch

Status: implemented

[English](2026-10-01-fake-ip-dns-and-system-proxy.md) | 中文

## 问题

在打包的 Windows 桌面应用中，`web_fetch` 对每个 URL（github.com、arxiv.org、raw.githubusercontent.com、huggingface.co）都失败，返回 `WEB_BLOCKED_URL`：`URL hostname "…" resolves to a non-public IP address`。模型告诉用户，沙箱的 DNS 解析阻止了所有直接抓取。

该机器运行着处于 fake-ip 模式并开启 TUN 的 Clash Verge（mihomo）。2026-10-01 的实测中，每个公共主机名的 A 记录都解析到 `198.18.0.0/15`，AAAA 记录都解析到 `2001:2::/48`：github.com 为 `198.18.0.216` 和 `2001:2::d1`，arxiv.org 为 `198.18.0.132` 和 `2001:2::7e`，DNS64 探测名 `ipv4only.arpa` 为 `198.18.1.27` 和 `2001:2::115`。这两个范围是 RFC 2544 和 RFC 5180 的基准测试范围，`ipaddr.js` 把它们分别归为 `reserved` 和 `benchmarking`，所以 `resolvePublicAddresses` 拒绝了整个应答。fake-ip 代理有意从中取地址，并在其 TUN 接口把连接映射回名称，因此该地址并不说明目标在哪里。

Windows 系统代理是 `127.0.0.1:7897`，但用户环境没有指定任何代理变量。Host 的代理策略只读取变量（[出站代理策略](../architecture/2026-08-27-outbound-proxy-policy.zh.md)），`web-fetch-http` 在没有代理路径时在本地解析并固定地址，而从开始菜单启动不带 `HTTPS_PROXY`。导出了该变量的终端会跳过本地解析，因此能正常工作，所以故障只出现在打包的应用里。

拒绝信息既没有提到代理，也没有给出补救办法，因此模型的解释把用户引向了沙箱。

## 决策

三项变更。接受 fake-ip 占位地址和遵循系统代理各自单独就能修复实测机器，二者覆盖不同的启动状态。拒绝信息则覆盖仍被拒绝的应答。

**只由 fake-ip 占位地址组成的 DNS 应答会被接受。** `dsh-web-fetch-http` 新增 `allowFakeIpDns`（默认 `true`）。当某个主机名的每个地址都落在 `198.18.0.0/15` 或 `2001:2::/48` 内时，`resolvePublicAddresses` 接受该应答，并把连接固定到这些地址，于是由代理的 TUN 接口承载连接并解析真实名称。规则恰好是“每个地址”。混合应答（占位地址旁还有私有、loopback、link-local 或公共地址）仍被拒绝。这些范围内的 IP 字面量无论走直连路径还是代理路径都仍被拒绝，因为没有任何 DNS 应答支撑它。IPv4 映射的 IPv6 写法不是占位地址。每个重定向跳都会重复这项检查。

**拒绝信息会指出原因。** 全占位地址的应答因选项关闭而被拒绝时，`WEB_BLOCKED_URL` 文本会说明 fake-ip 代理（Clash、mihomo、sing-box 等）给出了基准测试范围内的地址，并指出两种补救办法：`allowFakeIpDns` 和 `HTTPS_PROXY`。混合应答和字面量的拒绝保持原有的普通文本，因为代理的解释对它们不适用。

**Desktop 在没有其他来源指定代理时遵循操作系统代理。** `apps/desktop/src/system-proxy.ts` 在每次启动 Host 时运行。Host 环境或 Harness 主目录 `.env` 中任何非空的 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`（大小写均可）都是用户的选择，保持不动。否则 Desktop 向 Electron 的 `session.defaultSession.resolveProxy` 询问 `https://example.com/` 和 `http://example.com/`，它在各平台上采用 Chromium 的解析（手动代理、PAC 脚本、自动检测）。结果由第一个条目决定：`PROXY` 和 `HTTP` 条目变为 `http://host:port`，`HTTPS` 条目变为 `https://host:port`；`DIRECT`、SOCKS 或 QUIC 条目、带凭据或路径的条目，以及解析失败或超过 `DSH_DESKTOP_SYSTEM_PROXY_TIMEOUT_MS`（默认 3000）的情况，都让 Host 保持直连，其中无法使用的情况会给出警告。HTTPS 结果是代理时，Host 得到 `HTTPS_PROXY`；只有 HTTP 结果也是代理时才设置 `HTTP_PROXY`，否则 Host 的策略会把 HTTP 代理复用于 `https:`。`NO_PROXY` 由用户自己的列表、loopback 条目组成，在 Windows 上还包括用 `reg.exe` 读取的 `ProxyOverride` 中的主机和域名条目；`10.*` 这类地址段通配符和 `<local>` 会被跳过并在日志中计数，因为 Host 的匹配器只认识主机和域名后缀。`DSH_DESKTOP_SYSTEM_PROXY=off` 会关闭这一步，无效取值会让启动失败并指出变量名，这遵循登录 shell 读取所用的 `DSH_DESKTOP_*` 约定。解析出代理的路径完全跳过本地 DNS，因此 fake-ip 检查不会对它运行。

**默认为何允许。** 报告故障的机器使用 Clash Verge 的默认配置，其用户同样无法从开始菜单启动的应用里导出变量。严格的默认值会让每个 fake-ip 用户重复同一个报告。本地检查的目的是让模型选择的名称无法把 Host 的网络位置引向 loopback、私有或 link-local 服务。在 TUN 会拦截的机器上，占位地址做不到这一点，因为决定目标的是代理而不是地址。剩余的暴露面是：在把这些范围路由到真实主机的网络（如部分运营商和云网络）上，恶意或配置错误的解析器把名称应答到这些范围内，而 `allowFakeIpDns: false` 能在那里关闭它。这与显式 HTTP 代理路径已经向其代理授予的名称解析信任相同。

## 考虑过的替代方案

**只遵循系统代理，继续拒绝 fake-ip 应答。** 被否决：每条在本地解析的路径仍然无法使用，包括探测 URL 的 PAC 结果为 `DIRECT`、SOCKS 系统代理、`NO_PROXY` 条目，以及 TUN 机器上的 `dsh` 和 Web profile。

**接受 fake-ip 应答，永不读取系统代理。** 被否决：TUN 并不总是开启。只打开了系统代理开关的用户会直连到一个没有任何东西拦截的占位地址，而 Host 的其他所有请求（模型调用、搜索、HTTP 上的 MCP、`git`）在浏览器走代理时也仍然直连。

**把 `allowFakeIpDns` 默认设为 false。** 被否决，理由见“默认为何允许”：严格的默认值就是已报告的故障。

**接受所有 `reserved` 或 `benchmarking` 范围。** 被否决：`ipaddr.js` 还把 IETF 协议段、文档网络、6to4 中继段和 `240.0.0.0/4` 归入 `reserved`，而 fake-ip 代理一个也不用。因此显式匹配这两个范围。

**在 `dsh-http-proxy` 内读取 Windows 注册表。** 被否决：它只覆盖 Windows，只覆盖手动代理（没有 PAC，没有自动检测），并把 `reg.exe` 解析放进每个 profile 都会加载的库里。[出站代理策略](../architecture/2026-08-27-outbound-proxy-policy.zh.md)中的早先调研发现，代理软件把设置写在另一个网络服务上时，平台读取器什么也看不到。Electron 的 Chromium 栈已经实现了各平台的解析。代价是 `dsh` 和 Web profile 不遵循操作系统代理；它们保留文档规定的变量，TUN 机器则由 fake-ip 规则覆盖。

**让 `bypassesProxy` 支持 IPv4 通配符和 CIDR，以便携带 `10.*`。** 本次变更中被否决：该匹配器由分发器共用，而子进程使用 Node 自带的匹配器，所以扩大它的词汇是一个带有自身一致性义务的策略包决定。无论有没有绕过条目，`web_fetch` 都会拒绝字面量私有地址，被跳过的条目会在日志中计数。

**运行本地转发代理，对每个 URL 调用 `resolveProxy`。** 被否决：为了避免在启动时问两个问题，它要增加一个监听器、一套认证方案和一个生命周期。损失的只有按 URL 的 PAC 精度，这一点已记入文档。

**在代理路径上也检查本地 DNS。** 被否决：fake-ip 解析器返回的是占位地址，检查什么也说明不了；而名称在代理处与在本地解析结果不同时，本地检查也会失效。

## 影响

实测机器通过三条路径都能抓取两个测试 URL（见测试）。有操作系统代理的 Desktop 用户，Host 发出的每个请求都会经过代理；Host 启动的工具（如 `git` 和 shell 命令）通过现有的子进程环境规则继承这些变量。陈旧或不可达的系统代理现在会让原本直连的 Host 请求失败，`DSH_DESKTOP_SYSTEM_PROXY=off` 是退出办法。

代理路径的信任规则比以前延伸得更远。显式的 `HTTPS_PROXY` 是针对本 harness 的声明，表示代理可以选择目标；系统代理则是用户为浏览器做的设置。与任何经代理的跳一样，代理解析到代理所在机器自身服务的名称，不再被本地拒绝。字面量的私有、loopback 和 fake-ip 地址仍会在代理看到之前被拒绝。按站点分流的 PAC 脚本只按两个探测名称判断，macOS 和 Linux 不沿用系统绕过列表。

针对 fake-ip 应答的 `web_fetch` 拒绝会告诉模型，并经由模型告诉用户该改什么。`dsh` 和 Web profile 没有变化，只是 TUN fake-ip 机器抓取时不再需要变量。

## 测试

`packages/web/web-fetch-http/tests/fake-ip.spec.ts` 固定范围边界和 IPv4 映射的排除；接受全 IPv4、全 IPv6 和双栈应答；拒绝占位地址旁有私有、loopback、link-local 或公共 IPv4，以及 loopback 或 unique-local IPv6 地址的混合应答（无论顺序）；拒绝四个字面量并检查解析器从未被要求解析它们；检查显式策略和默认策略的原因文本；并在伪造的 DNS 上驱动提供方，展示固定了哪些地址、选项关闭或应答混合时不会发起连接，以及插件配置默认允许。`tests/proxy.spec.ts` 增加代理路径上的 fake-ip 字面量。`apps/desktop/tests/system-proxy.spec.ts` 覆盖 PAC 风格应答的解析、Windows 绕过列表的转换和注册表读取器，以及 `withDesktopSystemProxy` 的每个决定：环境与 `.env` 的优先级（大小写均可）、空值、仅 HTTPS 的代理、SOCKS、失败与期限回退、`NO_PROXY` 合并，以及凭据绝不进入日志行。`apps/desktop/tests/main-startup.spec.ts` 展示 Host 收到这些变量、用户变量和 `.env` 优先、关闭选项、失败时的警告、绕过列表读取器的平台限定，以及启动时的明确失败。

2026-10-01 在实测机器上的真实检查，使用实时 DNS 和 Electron 44.0.0：`resolveProxy` 对公共 URL 返回 `PROXY 127.0.0.1:7897`，对 `127.0.0.1`、`192.168.1.5` 和单标签主机返回 `DIRECT`。未安装代理且 `allowFakeIpDns` 关闭时，提供方用新文本拒绝了 `https://arxiv.org/abs/2608.11924` 和 `https://github.com/`。选项开启且没有代理时，两者都经 TUN 接口抓取成功，HTTP 200。使用 `withDesktopSystemProxy` 根据实时 Electron 应答产生的代理时，选项开启和关闭两种情况下，两者都经 `127.0.0.1:7897` 抓取成功，HTTP 200。没有任何已录制会话快照包含该拒绝文本。
