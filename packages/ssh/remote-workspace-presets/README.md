---
description: "Verified SSH workspace setup and isolated remote Agent capability composition."
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-workspace-presets

English | [中文](README.zh.md)

## Summary

This service verifies a POSIX workspace through an existing OpenSSH alias, installs the bundled helper under the remote login user's private home directory, and registers an isolated Agent preset for that host and canonical path.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the service beside `agentPresets` and the SSH, filesystem, subprocess, sandbox, Bash, search and LSP plugin packages. Call `inspect({ host, path })` to obtain `{ presetId, canonicalPath }`, or `ensure({ host, path })` when only the preset ID is needed. Both methods fail if SSH login, remote Node.js, workspace access, helper or LSP installation, or preset activation fails. The optional `researchTools: true` setting adds ten research tool families when the Host also mounts a shared research workbench service.

The host is an existing OpenSSH alias, or `user@host` with an optional `:port`. SSH runs noninteractively with strict host-key checking and no agent forwarding. The remote host needs Node.js 22 or newer. The service does not provision SSH credentials or relax the host-key policy.

`inspect` also takes an `auth` choice for a workspace that is being added. `{ kind: 'password', password }` verifies that password against the host before anything else and saves it only after the host accepted it, under the host's record in the credential store (see [Password login](../ssh/README.md#password-login)); a wrong password changes nothing and the verification is repeated on the next request. `{ kind: 'key' }` verifies with OpenSSH keys, agent and configuration, and forgets a password saved earlier for the host. A request without `auth`, such as every session resume, uses whatever the host has saved. `forget(host)` deletes the saved password. A refusal rejects with an `SshFailure` whose `kind` is `auth`, `unreachable`, `host-key`, `host-key-changed` or `unsupported`; its message never contains the password.

When the failure is an unknown host key of a workspace being added, the `SshFailure` also carries the key's `type` and SHA-256 `fingerprint`, read with [`scanHostKey`](../ssh/README.md#trusting-a-new-host) without recording anything. A caller that shows it to a person and gets a confirmation calls `inspect` again with `trustHostKey: <that fingerprint>`; the service then records the key in `known_hosts` through `trustHostKey`, which refuses a host that has a different key recorded, and verifies the workspace with strict host-key checking as before. Nothing is written to `known_hosts` without that call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The local package supplies one self-contained helper artifact. SSH streams it to a `0700` directory under `~/.scipaper-harness/ssh-helper`, verifies SHA-256 before and after installation, and stores it with mode `0500`. The remote directory is resolved with `realpath` and checked for read and traverse access before the Agent preset is registered. Bash, file and search operations then use the same remote SSH connection and filesystem realm.

The package also streams a compressed TypeScript language server and compiler runtime into a private, content-addressed remote directory. SHA-256 verification precedes LSP activation; no remote package manager or network download is required. When the remote host has `rg`, the preset adds `glob` and `grep` using its absolute executable path.

-----

<a id="model-experience"></a>
## Model Experience

### Remote workspace tools

#### What the model sees

The selected preset exposes Bash, file, and TypeScript/JavaScript LSP tools for the remote directory. Search tools appear when the SSH host has `rg`. Tool results retain remote POSIX paths. With `researchTools: true`, ten research tool families also appear when the Host mounts the shared workbench service; their records remain in the local Host ledger and require one matching ready SSH environment.

#### Token effect

The selected tool definitions add request-prefix tokens. Tool calls and their results add conversation tokens as the Agent uses them; directory inspection and helper installation add none.

#### KV Cache effect

The selected preset keeps a stable tool-schema prefix across requests while its tool set is unchanged. Enabling research tools or changing remote search availability changes that prefix; tool results append later in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Research tools require a ready SSH environment mapping the remote execution root to one local research project; they do not create remote research records.
- Only POSIX SSH hosts are supported. SSH alias authentication, host-key enrollment and Node.js installation are administered outside this service.
- Saving a password needs a composed `ctx.credentials`; without it a password choice is refused before any SSH command runs. The password stays in the credential store until `forget` or key login replaces it.
- Search depends on a remote `rg` executable. TypeScript/JavaScript LSP is installed from the bundled runtime during workspace setup.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Implementation details</summary>

No invariant companion is published. The SSH helper digest, workspace resolution and preset activation are verified during `inspect` and `ensure`; no independent persisted observation is maintained by this service.

</details>
