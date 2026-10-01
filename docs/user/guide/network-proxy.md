# Run DSH behind a network proxy

English | [中文](network-proxy.zh.md)

DSH routes its outbound requests — model calls, web search, page fetches, and MCP servers over HTTP — through the proxy named by the standard proxy environment variables. It reads them at launch; nothing else needs configuring. The desktop application also follows the operating system's proxy when no variable names one, as "The desktop application follows the system proxy" below describes. A few paths stay direct by design or by runtime limit, listed under "What stays direct" below.

## Export the variables

```sh
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

Put both lines in your shell profile so every `dsh` invocation inherits them, or in `$DSH_HOME/.env` (`~/.research-workbench/.env` by default) next to your API key; an exported variable always wins over that file. A project's own `.env` cannot set them: it arrives with `git clone`, and DSH refuses to start rather than let a repository decide where your traffic goes.

A proxy that needs credentials takes them in the URL: `http://user:password@proxy.example:8080`. DSH never prints the URL back: a diagnostic names the variable it rejected, so neither the username nor the password appears anywhere.

## Why your browser is proxied but your terminal is not

This is the most common surprise, and it is not specific to DSH. There is no single "system proxy" that all software obeys — there are three unrelated mechanisms:

| Mechanism | Who follows it |
|---|---|
| The operating system's proxy settings | Safari, most native macOS apps, Chrome and Edge |
| The `HTTP_PROXY` / `HTTPS_PROXY` environment variables | `curl`, `git`, `npm`, `pip`, and DSH |
| TUN mode (a virtual network interface) | Everything, transparently |

The "system proxy" switch in a proxy application such as Clash writes only the first one. Browsers pick it up; command-line tools never see it. That is why exporting the variables is a separate step, and why turning on TUN mode makes both work without any variables at all.

The `dsh` command and the Web UI do not read the operating system's proxy settings. Export the variables, or use TUN mode. The desktop application reads them when you export nothing, as the next section describes.

## The desktop application follows the system proxy

An application started from the Start menu, the Dock, or a launcher has no shell to export variables from. When the environment, including `$DSH_HOME/.env`, names no `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY`, the desktop application asks the operating system for its proxy, with the same resolution your browser gets (a manual proxy, a PAC script, or auto-detection), and hands the agent's Host process the answer as `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`. A proxy you export, or write to `$DSH_HOME/.env`, always wins.

- Only an HTTP or HTTPS proxy is used. A SOCKS answer is logged in the Electron console and the Host connects directly.
- The first entry of a PAC answer decides, and `DIRECT` means direct. The application asks about `https://example.com/` and `http://example.com/`, so a PAC script that routes by site is judged by those two names. If the HTTPS answer is direct, nothing is set.
- On Windows the bypass list in Internet Settings is added to `NO_PROXY` for the entries that name a host or a domain. Address ranges such as `10.*` and `<local>` cannot be expressed, as described under "Choose what stays direct", and are skipped. Loopback is always bypassed. macOS and Linux carry no system bypass list over.
- The answer is read each time the Host starts, so a changed system proxy applies after you restart the application.
- Set `DSH_DESKTOP_SYSTEM_PROXY=off` in the environment the application starts with to turn this off. `DSH_DESKTOP_SYSTEM_PROXY_TIMEOUT_MS` (default `3000`) bounds the wait for the answer; a slow or failed answer leaves the Host direct and logs a warning.

## Fake-IP mode (Clash, mihomo, sing-box)

Proxy applications in fake-ip mode answer every DNS query with a placeholder address in `198.18.0.0/15` or `2001:2::/48` and, with TUN mode on, route the connection back to the real site. Without a proxy variable `web_fetch` resolves the name itself and sees only the placeholder, which used to be refused as a non-public address. DSH now accepts a name whose every address is such a placeholder, because the proxy resolves the real destination, just as it does for an explicit proxy. Set `allowFakeIpDns: false` in the `web-fetch-http` configuration to refuse them again; the refusal message then names this cause. A name that also resolves to a private address, and a URL that is itself an address in those ranges, are refused either way. With a proxy variable set, the proxy resolves the name and DSH makes no local check at all.

## Choose what stays direct

`NO_PROXY` lists hosts to reach directly:

```sh
export NO_PROXY=internal.example.com,.corp.example.com,registry.local
```

An entry names a host and matches it together with every subdomain under it: `NO_PROXY=example.com` also sends `api.example.com` direct. A leading `.` or `*.` is accepted and means the same thing. An entry may carry a `:port`, and `*` bypasses everything.

**CIDR ranges do not work.** An operating system bypass list often contains entries like `10.0.0.0/8` or `192.168.0.0/16`; copying those into `NO_PROXY` has no effect. Use host names or domain suffixes instead.

You do not need to list `localhost` or `127.0.0.1`. DSH always bypasses loopback, because its own Web UI and local servers would otherwise route through the proxy and loop.

## Limits worth knowing

**SOCKS proxies are not supported.** A `socks5://` value is reported at startup and skipped, and DSH connects directly for the scheme that named it — setting `HTTPS_PROXY=socks5://…` alongside a usable `HTTP_PROXY` leaves `https:` direct rather than borrowing the HTTP proxy. Point the variables at your proxy application's HTTP port instead — most expose both, and the HTTP one is usually a neighbouring port number.

**`ALL_PROXY` alone is enough.** DSH falls back to it for both schemes, even though Node and curl differ on this. Setting `HTTPS_PROXY` explicitly is still clearer.

**A TLS-intercepting corporate proxy needs its certificate.** If requests fail with a certificate error once the proxy is reachable, point Node at your organisation's CA bundle before launching:

```sh
export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem
```

Node reads that variable only at process start, so export it before running `dsh`.

**Tools DSH runs for you follow the same proxy.** Commands in the bash tool, `git`, `gh`, and MCP servers started as child processes all inherit these variables. A child that is itself a Node program honors them only on Node 22.21 or later; an older Node connects directly. If one of your proxy variables holds a value DSH rejected — a SOCKS URL, say — Node-based tools also connect directly rather than fail to start, while `curl` and `git` still read that value.

**A password in the proxy URL reaches those tools too.** `HTTPS_PROXY=http://alice:s3cret@proxy.example:8080` is a normal environment variable, so every command DSH runs — including the ones the model writes — can read it, and a command that prints its environment puts the password in output that is kept. This is how the variable already behaves for everything else in your shell. If that matters, give the proxy a credential-free entry point, or authenticate it some other way than in the URL.

## What stays direct

Not every request DSH makes goes through the proxy:

- **Anything on this machine.** Loopback is always direct: `localhost`, the whole `127.0.0.0/8` range, `::1`, and `0.0.0.0`. A proxy cannot usefully reach a service that only listens locally.
- **Code the model writes.** Workflow workers and Node ptc-runtime processes receive no proxy settings, so model-authored scripts cannot read a proxy URL that may carry a password. Direct requests must configure any required proxy themselves and remain subject to the execution sandbox.
- **Usage telemetry.** The OTLP exporter uses Node's own HTTP client rather than the one a proxy configures, so telemetry connects directly and simply fails where direct egress is blocked. Nothing you do in DSH depends on it. Set `DSH_TELEMETRY_MODE=DISABLED` to turn it off entirely.
- **`web_fetch` to a literal private address.** A URL naming an address like `http://10.0.0.5/` is refused rather than handed to the proxy, the same refusal it gets with no proxy configured.

## Check that it worked

Ask the agent to fetch a page and watch your proxy application's connection log:

```sh
dsh --profile headless "fetch https://example.com and tell me the page title"
```

If the request does not appear there, confirm the variables survive into DSH's own environment:

```sh
env | grep -i proxy
```
