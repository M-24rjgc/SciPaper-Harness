---
description: "Select a configured SSH execution backend for a headless profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-ssh-remote-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle routes a configured non-desktop profile's filesystem, subprocess, and sandbox services to one POSIX SSH host. It does not control Desktop workspace selection. Desktop users add a remote workspace through the sidebar's Add SSH Workspace entry for remote files, terminal, and TypeScript/JavaScript LSP.

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

Add this bundle to a headless or custom profile, then set `DSH_SSH_ENABLE_REMOTE=1` and all five values before starting it: `DSH_SSH_HOST` (an OpenSSH alias), `DSH_SSH_NODE` (absolute remote Node path), `DSH_SSH_HELPER` (absolute remote helper path), `DSH_SSH_HELPER_HASH` (SHA-256 of that helper entry), and `DSH_SSH_WORKSPACE` (absolute remote workspace path). The remote helper must already be installed on a POSIX host, and the alias must have configured credentials and a trusted host key. Without the switch and all five values, the profile retains its local services.

The desktop plugin page may show this installed bundle, but its switch only affects configured non-desktop profiles. To work remotely in Desktop, select Add SSH Workspace in the sidebar and enter an OpenSSH host alias and an absolute POSIX directory. The [remote workspace preset service](../../ssh/remote-workspace-presets/README.md) verifies that directory and composes the Desktop session's remote capabilities.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The patch mounts `dsh-ssh`, `dsh-fs-ssh`, `dsh-subprocess-ssh`, and `dsh-sandbox-ssh` as one backend and disables the three local provider rows only in a configured non-desktop process. SSH streams use independent channels on Windows and TLS-PSK authentication. No runtime invariant companion is published because this bundle only selects the SSH backend; the SSH, filesystem, subprocess and sandbox providers own runtime state.

-----

<a id="further-exploration"></a>
## Further Exploration

[SSH connection](../../ssh/ssh/README.md)

-----

<a id="model-experience"></a>
## Model Experience

### Remote execution

#### What the model sees

Existing `dsh-tool-fs` and command tools operate on the configured remote workspace. The bundle adds no tool name or system prompt.

#### Token effect

Remote file contents and command results consume context through the existing tools. The bundle itself adds no tokens.

#### KV Cache effect

The tool catalog is unchanged when this backend is selected; unchanged tool schemas keep the same prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A reachable POSIX SSH host, compatible Node runtime, installed helper, and matching digest are required for a live connection.
- This bundle's environment switch does not create or select Desktop SSH workspaces; use the sidebar entry for each remote workspace.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
