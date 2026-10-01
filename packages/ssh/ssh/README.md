---
description: "OpenSSH connection configuration and remote helper lifecycle for deployments composing POSIX file, process and sandbox providers."
kind: "package-reference"
---

# @deepseek-ai/dsh-ssh

English | [中文](README.zh.md)

## Summary

`dsh-ssh` connects a Windows, Linux or macOS Harness host to an installed helper on a POSIX SSH host. One deployment-owned OpenSSH alias, or a `user@host[:port]` destination with a saved password, supplies authentication and host identity; the paired filesystem, subprocess and sandbox providers use that connection. The connection verifies installed artifact digests before readiness; the helper owns remote cleanup when the connection closes or its lease expires.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Compose this service with [`fs-ssh`](../fs-ssh/README.md), [`subprocess-ssh`](../subprocess-ssh/README.md) and [`sandbox-ssh`](../sandbox-ssh/README.md) in a custom `dsh` profile. The host runs the Harness, model transport and Session storage; the remote machine supplies the files and processes. Headless profiles support this arrangement.

### Deployment prerequisites

The remote endpoint requires Linux or macOS. Linux and macOS clients use connection multiplexing and Unix-socket forwarding; Windows clients use independent SSH exec channels for streams. Configure the alias or destination, credentials and known-host entry before startup: the service requires strict host-key checking and disables agent forwarding. Key, agent and ssh-config authentication run in `BatchMode` with no interactive flow; a saved password is the only other login ([Password login](#password-login)).

Install the built helper on the remote host, or use [`remote-workspace-presets`](../remote-workspace-presets/README.md) to install the self-contained helper under a private remote home directory. Keep Node, helper, bootstrap and their dependencies outside the workspace and writable temporary roots. They must also remain outside a backend’s replaced temporary tree, such as bwrap’s private `/tmp`; the workspace may still be under `/tmp`. Digest verification detects an unexpected installed artifact after helper startup; it does not make writable deployment files safe to execute or authenticate a malicious SSH host.

| Field | Default | Meaning |
|---|---|---|
| `host` | required | Existing OpenSSH host alias, or `user@host` with an optional `:port` |
| `node`, `helper`, `workspace` | required | Absolute remote Node executable, bundled helper entry and default workspace |
| `helperHash` | required | Lowercase SHA-256 of the installed helper entry |
| `bootstrapPath`, `bootstrapHash` | omitted | Paired remote PTC entry and its lowercase SHA-256 |
| `requestTimeoutMs` | `30000` | Connection and administrative-request deadline, from 1 through 2,147,483,647 ms |
| `maxFrameBytes` | `67108864` | Per-message JSON payload ceiling, at most 64 MiB |
| `maxPending` | `128` | Ordinary outstanding requests; heartbeat and bounded cleanup requests have reserved capacity |
| `leaseMs` | `30000` | Helper heartbeat lease, from 3000 to 600000 ms |

For PTC, configure both bootstrap fields and pass the verified `ctx.ssh.nodeExecutable` and `ctx.ssh.bootstrapPath` to [`NodePtcRuntime`](../../ptc-runtime/ptc-runtime-node/README.md). Basic filesystem and Bash use may omit the pair. The `bootstrapPath` getter refuses an unconfigured PTC deployment.

### Password login

A host that has a saved password logs in with it instead of keys. The password is a credential record that [`credentials`](../../credentials/credentials/README.md) keeps under `ssh/host-<hash of the host>`; `ctx.credentials` must be composed for a password to be read. Saved passwords are written by [`remote-workspace-presets`](../remote-workspace-presets/README.md) after the host accepted them.

Every ssh child of such a host receives `SSH_ASKPASS` and `SSH_ASKPASS_REQUIRE=force`. The askpass program is a script in a private temporary directory; it prints the password from the child's environment variable `DSH_SSH_ASKPASS_SECRET`, so the password is in no argument, file, log or error text, and diagnostics drop every occurrence of it. The child runs without `BatchMode`, with one password attempt, public keys off, and only password and keyboard-interactive methods, so a wrong password fails at once. Strict host-key checking stays on for both logins: an unknown or changed host key fails and never prompts. [Trusting a new host](#trusting-a-new-host) is a separate, explicit step.

This needs OpenSSH 8.4 or newer, which introduced `SSH_ASKPASS_REQUIRE`; older or unrecognized clients fail with kind `unsupported` before any connection. On Windows the program is `askpass.cmd` running `askpass.ps1` in Windows PowerShell, which writes the password as UTF-8 without passing it through `cmd.exe`. The Windows OpenSSH client cannot start a program from a path with non-ASCII characters, so the directory is created under the temporary directory, `ProgramData` or `Users\Public`, whichever is first and ASCII. Windows opens one authenticated connection per stream, so each stream logs in again.

The package entry `@deepseek-ai/dsh-ssh/auth` exports the pieces every ssh caller shares: `parseSshHost` and `sshDestinationArguments` for `user@host:port`, `planSshAuth`, the `SshPasswordStore`, and `SshFailure` with `classifySshFailure`, which reduce ssh diagnostics to `auth`, `unreachable`, `host-key`, `host-key-changed` or `unsupported`.

### Trusting a new host

A host whose key is not in `known_hosts` fails as `host-key`. `@deepseek-ai/dsh-ssh/host-key` lets a person confirm that key instead of running `ssh` by hand. `scanHostKey(host)` asks `ssh -G` which name, port and `known_hosts` file the connection uses, reads the key with `ssh-keyscan` (ed25519 first, then ECDSA, then RSA) and returns its type and SHA-256 fingerprint, which is computed locally. It authenticates nothing and writes nothing, and returns nothing for a host behind `ProxyJump` or `ProxyCommand`, whose key cannot be scanned directly.

`trustHostKey(host, fingerprint)` is the only writer, and a caller reaches it only with a fingerprint a person confirmed. It scans again and refuses with `host-key-changed` when the key no longer matches. It also runs a strict probe that needs no login, so a host that already has a different key recorded is refused as `host-key-changed` and never trusted; a changed key is always a hard refusal. Otherwise it appends `[host]:port type key`, or the bare name for port 22, to the first `known_hosts` file ssh reads. Every real connection after that still runs with `StrictHostKeyChecking=yes`, so the recorded key is what it verifies. Both functions work the same for key and password hosts.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The OpenSSH master carries private administrative RPC. Each program stream uses a separate forwarded Unix socket and an independent SSH channel. Program stdout cannot forge administrative replies or occupy the control stream’s channel window. SSH transport congestion still affects the shared connection.

Each stream reservation has a random 256-bit TLS pre-shared key carried only by administrative RPC. TLS authenticates both endpoints and protects every stream byte; the key is never sent as a stream preface. Socket directories are private (`0700`) and sockets use `0600`. Replacing a writable socket path cannot impersonate an endpoint or reveal the stream key; an attacker can still interrupt service or relay opaque TLS records.

Connection disposal joins forwarding and cancellation subprocesses and partially established streams before removing local resources. Transport loss rejects pending operations and invalidates the connection. The helper starts managed cleanup on SSH EOF, termination signals or heartbeat expiry. A disconnected client cannot confirm the remote outcome; operations are never reconnected or replayed automatically.

Failed startup and process results release their reservations after native quiescence; the bounded completion cache preserves the original rejection for later result reads. Helper shutdown also joins endpoint and directory cleanup already in progress.

For terminals opting into shell activity observation, root exit retains the reservation and its remaining work. Activity RPC continues to reach the provider; explicit termination awaits quiescence before releasing endpoints and recording the completed result. Helper connection disposal and lease expiry retain their existing termination authority.

The helper starts with `--disable-sigusr1`, so a same-user process signal cannot open its Node debugger.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SSH subsystem](../../../docs/subsystems/ssh.md) — execution coordinates, transport semantics and lifecycle ownership.
- [POSIX SSH decision](../../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md) — rationale, alternatives and required verification.
- [SSH password login decision](../../../.agents/notes/implemented/architecture/2026-10-01-ssh-password-login.md) — askpass transport, storage, host-key policy and rejected alternatives.

-----

<a id="model-experience"></a>
## Model Experience

None, as host aliases, authentication and stream capabilities are private deployment details and consumers own every model-visible operation.

#### KV Cache effect

This provider contributes no request-prefix content. Its consumers own model-visible tools and results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The low-level connection does not provision a helper, reconnect or replay operations; `remote-workspace-presets` supplies helper installation and preset registration.
- Web workspace UI paths still assume host filesystem access; use headless or a custom composition whose consumers honor provider paths.
- TLS stream keys do not protect against remote OS process-memory inspection or debugging. File-effect policy retains the selected sandbox backend’s limits.
- A saved password is protected as the credential file is: by the operating-system user's own file permissions, which on Windows are the user profile's access control list. Processes of that user, including Agent tool processes, can read the file and the environment of a running ssh child. An operating-system keychain is not used.
- Host-key confirmation reads the key with `ssh-keyscan`, so it is unavailable behind a proxy; the connection then fails as `host-key` without a key and the person must run `ssh` once. A fingerprint is only as trustworthy as the channel it is compared over; the person must compare it with one the server's administrator provides.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published. Wire validation and the owning filesystem, subprocess and sandbox providers enforce the observable obligations; this adapter adds no independently observed state relation.

</details>
