# Agent Note: Fake-ip DNS answers and the system proxy no longer block web_fetch

Status: implemented

English | [中文](2026-10-01-fake-ip-dns-and-system-proxy.zh.md)

## Problem

In the packaged Windows desktop application, `web_fetch` failed on every URL (github.com, arxiv.org, raw.githubusercontent.com, huggingface.co) with `WEB_BLOCKED_URL`: `URL hostname "…" resolves to a non-public IP address`. The model told the user that the sandbox's DNS resolution blocked every direct fetch.

The machine ran Clash Verge (mihomo) in fake-ip mode with TUN. Measured on 2026-10-01, every public hostname resolved to `198.18.0.0/15` over A and `2001:2::/48` over AAAA: github.com to `198.18.0.216` and `2001:2::d1`, arxiv.org to `198.18.0.132` and `2001:2::7e`, and the DNS64 probe name `ipv4only.arpa` to `198.18.1.27` and `2001:2::115`. The two ranges are the RFC 2544 and RFC 5180 benchmarking ranges, which `ipaddr.js` classifies as `reserved` and `benchmarking`, so `resolvePublicAddresses` refused the whole answer. A fake-ip proxy answers from them on purpose and maps the connection back to the name at its TUN interface. The address therefore says nothing about the destination.

The Windows system proxy was `127.0.0.1:7897`, but the user environment named no proxy variable. The Host's proxy policy reads variables only ([outbound proxy policy](../architecture/2026-08-27-outbound-proxy-policy.md)), `web-fetch-http` resolves and pins locally unless a proxy route applies, and a Start-menu launch carries no `HTTPS_PROXY`. A terminal that had exported the variable skipped local resolution and worked, so the failure appeared only in the packaged application.

The refusal text named neither a proxy nor a remedy, so the model's explanation pointed the user at the sandbox.

## Decision

Three changes. Accepting fake-ip placeholders and following the system proxy each repair the measured machine alone, and they cover different launch states. The refusal text covers the answers that stay refused.

**A DNS answer made only of fake-ip placeholders is accepted.** `dsh-web-fetch-http` gains `allowFakeIpDns` (default `true`). When every address of a hostname lies in `198.18.0.0/15` or `2001:2::/48`, `resolvePublicAddresses` accepts the answer and the connection is pinned to those addresses, so the proxy's TUN interface carries it and resolves the real name. The rule is exactly "every address". A mixed answer (a private, loopback, link-local, or public address beside a placeholder) stays refused. An IP literal in those ranges stays refused, on the direct route and on the proxied route, because no DNS answer stands behind it. An IPv4-mapped IPv6 spelling is not a placeholder. Every redirect hop repeats the check.

**A refusal names its cause.** When an all-placeholder answer is refused, because the option is off, the `WEB_BLOCKED_URL` text says that a fake-ip proxy (Clash, mihomo, sing-box, and similar) answered with a benchmarking-range address, and names both remedies: `allowFakeIpDns` and `HTTPS_PROXY`. Refusals for mixed answers and literals keep the plain text, because the proxy explanation does not apply.

**Desktop follows the operating system proxy when nothing else names one.** `apps/desktop/src/system-proxy.ts` runs each time a Host starts. A non-blank `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` in either casing, in the Host environment or in the Harness-home `.env`, is the user's choice and is left alone. Otherwise Desktop asks Electron's `session.defaultSession.resolveProxy` for `https://example.com/` and `http://example.com/`, which applies Chromium's resolution (manual proxy, PAC script, auto-detection) on every platform. The first entry of an answer decides: `PROXY` and `HTTP` entries become `http://host:port`, `HTTPS` entries become `https://host:port`, and `DIRECT`, a SOCKS or QUIC entry, an entry with credentials or a path, and a resolution that fails or exceeds `DSH_DESKTOP_SYSTEM_PROXY_TIMEOUT_MS` (default 3000) leave the Host direct, with a warning for the unusable cases. When the HTTPS answer is a proxy the Host receives `HTTPS_PROXY`, and `HTTP_PROXY` only if the HTTP answer is a proxy too, because the Host's policy would otherwise reuse the HTTP proxy for `https:`. `NO_PROXY` is the user's own list, the loopback entries, and on Windows the host and domain entries of `ProxyOverride`, read with `reg.exe`; address-range wildcards such as `10.*` and `<local>` are skipped and counted in the log, because the Host's matcher knows only hosts and domain suffixes. `DSH_DESKTOP_SYSTEM_PROXY=off` disables the step, and an invalid value fails startup with the variable's name, following the `DSH_DESKTOP_*` convention of the login-shell read. A path that resolves a proxy skips local DNS entirely, so the fake-ip check never runs for it.

**Why the default allows.** The machine that reported the failure runs the default Clash Verge configuration, and its user is also the one who cannot export variables from a Start-menu launch. A strict default repeats the report for every fake-ip user. The local check exists so that a name the model picks cannot steer the Host's network position at loopback, private, or link-local services. A placeholder answer cannot do that on a machine whose TUN intercepts it, because the proxy, not the address, chooses the destination. The residual exposure is a hostile or misconfigured resolver answering a name inside the ranges on a network that routes them to real hosts, such as some carrier and cloud networks, and `allowFakeIpDns: false` closes it there. This is the same trust an explicit HTTP proxy route already extends to its proxy for name resolution.

## Alternatives considered

**Follow only the system proxy and keep refusing fake-ip answers.** Rejected: it leaves every path that resolves locally broken, including a PAC answer of `DIRECT` for the probe URL, a SOCKS system proxy, a `NO_PROXY` entry, and the `dsh` and Web profiles on a TUN machine.

**Accept fake-ip answers and never read the system proxy.** Rejected: TUN is not always on. A user with only the system proxy toggled gets a direct connection to a placeholder that nothing intercepts, and every other Host request (model calls, search, MCP over HTTP, `git`) also stays direct while the browser is proxied.

**Default `allowFakeIpDns` to false.** Rejected for the reason under "Why the default allows": the strict default is the reported failure.

**Accept every `reserved` or `benchmarking` range.** Rejected: `ipaddr.js` also files the IETF protocol block, the documentation networks, the 6to4 relay block, and `240.0.0.0/4` under `reserved`, and a fake-ip proxy uses none of them. The two ranges are matched explicitly.

**Read the Windows registry inside `dsh-http-proxy`.** Rejected: it reaches Windows only, manual proxies only (no PAC, no auto-detection), and puts `reg.exe` parsing in a library every profile loads. The earlier survey in the [outbound proxy policy](../architecture/2026-08-27-outbound-proxy-policy.md) found that a platform reader can see nothing when the proxy application writes a different network service. Electron's Chromium stack already implements every platform's resolution. The cost is that the `dsh` and Web profiles do not follow the operating system proxy; they keep the documented variables, and a TUN machine is covered by the fake-ip rule.

**Teach `bypassesProxy` IPv4 wildcards and CIDR so `10.*` can be carried.** Rejected for this change: the matcher is shared by the dispatcher and by child processes that use Node's own matcher, so widening its vocabulary is a policy-package decision with its own parity obligations. A literal private address is refused by `web_fetch` regardless of any bypass entry, and the skipped entries are counted in the log.

**Run a local forwarding proxy that calls `resolveProxy` per URL.** Rejected: it adds a listener, an authentication story, and a lifecycle to avoid asking two questions at startup. Per-URL PAC accuracy is the one thing lost, and it is documented.

**Check local DNS on the proxied route as well.** Rejected: a fake-ip resolver answers with placeholders, so the check would say nothing, and a name that resolves differently at the proxy than locally defeats a local check.

## Consequences

The measured machine fetches both test URLs through all three routes (see Testing). Desktop users with an operating system proxy are proxied everywhere the Host makes a request, and tools the Host starts, such as `git` and shell commands, inherit the variables through the existing child-environment rule. A system proxy that is stale or unreachable now breaks Host requests that used to go direct, and `DSH_DESKTOP_SYSTEM_PROXY=off` is the escape.

The proxied route's trust rule reaches further than before. An explicit `HTTPS_PROXY` was a harness-specific statement that the proxy may choose destinations; a system proxy is a setting the user made for their browser. A name that the proxy resolves to a service on the proxy's own machine is no longer refused locally, as with any proxied hop. Literal private, loopback, and fake-ip addresses remain refused before the proxy sees them. A PAC script that routes by site is judged only by the two probe names, and macOS and Linux carry no system bypass list.

`web_fetch` refusals for fake-ip answers tell the model, and through it the user, what to change. The `dsh` and Web profiles are unchanged except that a TUN fake-ip machine no longer needs a variable to fetch.

## Testing

`packages/web/web-fetch-http/tests/fake-ip.spec.ts` pins the range boundaries and the IPv4-mapped exclusion; accepts all-IPv4, all-IPv6, and dual-stack answers; refuses mixed answers beside a private, loopback, link-local, or public IPv4 and a loopback or unique-local IPv6 address in either order; refuses the four literals and checks that the resolver is never asked about them; checks the cause text for the explicit and the default policy; and drives the provider over fake DNS to show which addresses are pinned, that nothing connects when the option is off or the answer is mixed, and that plugin configuration defaults to allowing. `tests/proxy.spec.ts` adds the fake-ip literals on a proxied route. `apps/desktop/tests/system-proxy.spec.ts` covers parsing of PAC-style answers, the Windows bypass translation and registry reader, and every decision of `withDesktopSystemProxy`: environment and `.env` precedence in either casing, blank values, HTTPS-only proxies, SOCKS, failure and deadline fallbacks, `NO_PROXY` merging, and credentials never reaching a log line. `apps/desktop/tests/main-startup.spec.ts` shows the Host receiving the variables, the user's variables and `.env` winning, the opt-out, the warning on failure, the platform gate on the bypass reader, and the loud startup failure.

Real check on the measured machine, 2026-10-01, with live DNS and Electron 44.0.0: `resolveProxy` answered `PROXY 127.0.0.1:7897` for public URLs and `DIRECT` for `127.0.0.1`, `192.168.1.5`, and a single-label host. The provider with no proxy installed and `allowFakeIpDns` off refused `https://arxiv.org/abs/2608.11924` and `https://github.com/` with the new text. With the option on and no proxy it fetched both with HTTP 200 through the TUN interface. With the proxy produced by `withDesktopSystemProxy` from the live Electron answer it fetched both with HTTP 200 through `127.0.0.1:7897`, with the option on and off. No recorded-session snapshot contains the refusal text.
