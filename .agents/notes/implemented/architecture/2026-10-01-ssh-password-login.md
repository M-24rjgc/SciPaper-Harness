# Agent Note: SSH password login

Status: implemented

English | [中文](2026-10-01-ssh-password-login.zh.md)

## Problem

An SSH workspace needed an OpenSSH alias, which means a person had to edit `~/.ssh/config` and own a key before they could add a remote machine. People who only have `user@host` and a password could not use one. The [POSIX SSH decision](2026-09-11-posix-ssh-runtime.md) fixed `BatchMode=yes` and strict host-key checking for every ssh child, and the same host string flows into Session headers, the workspace registry, the SQLite catalog, the research environments and the experiment runner, so a second login method had to reach every place that starts `ssh` without changing any persisted format.

## Decision

A host that has a saved password logs in with it; every other host keeps the key, agent and ssh-config path unchanged. The choice is made when a workspace is added and is stored as the presence of a password, not as a field.

**Host strings.** The persisted `host` stays one string: an alias, `user@host`, or either followed by `:port`. `parseSshHost` splits the port and `sshDestinationArguments` yields `-p port host` at the last moment, so workspace records, Session headers, `workspaceLocationKey`, the catalog and the format validators keep their shape and need no migration. A research environment's `sshHost` must equal the workspace's string, which is how remote runs find the same password.

**Askpass.** The ssh child gets `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force` and `DSH_SSH_ASKPASS_SECRET` in its own environment only. The askpass program holds no secret: a POSIX `sh` script, or on Windows `askpass.cmd` running `askpass.ps1` in Windows PowerShell, in a private directory created once per process and removed at exit. The secret never passes through `cmd.exe` parsing, never reaches an argument, and PowerShell writes it as UTF-8 bytes. A confirmation prompt (`SSH_ASKPASS_PROMPT=confirm`) is declined. Options for a password login are `BatchMode=no`, `NumberOfPasswordPrompts=1`, `PubkeyAuthentication=no` and `PreferredAuthentications=password,keyboard-interactive`: a wrong password fails in about half a second, and an encrypted default key cannot be answered with the login password. `StrictHostKeyChecking=yes` and `ForwardAgent=no` stay. Key login keeps its exact argument vector.

**Windows constraints, measured on OpenSSH_for_Windows_8.6p1.** `SSH_ASKPASS_REQUIRE=force` is honored. A `.cmd` askpass runs; a `.js` file or any non-executable fails with CreateProcess error 193. A path with non-ASCII characters fails with error 2, spaces do not, so the directory is the first ASCII location among the temporary directory, `ProgramData` and `Users\Public`. A `.cmd` that expanded the password with `%VAR%` would be parsed by `cmd.exe`, hence PowerShell. Windows has no ControlMaster, so each stream authenticates again.

**Version gate.** `ssh -V` must report OpenSSH 8.4 or newer, the release that introduced `SSH_ASKPASS_REQUIRE`; an older or unrecognized client fails as `unsupported` before connecting, because it could instead prompt on the terminal that started the Harness.

**Storage.** The password is a `credentials` record of kind `api-key` at `ssh/host-<sha-256 of the host, 32 hex>`: the same file and the same protection as every other credential, which is the operating-system user's own file permissions. On Windows that is the user profile's access control list, not encryption, and processes of that user can read it. The hashed key keeps the file from listing hosts. A workspace record, Session header, event, response or error never holds the password. The Remote request carries it once, from the dialog to `remoteWorkspacePresets.inspect`, which verifies it and saves it only after the host accepted it, so a typo never replaces a working password. Choosing key login on a later add forgets it, and deleting the last workspace of a host forgets it.

**Failures.** `classifySshFailure` reads ssh's own phrases, case-sensitively so a remote `EACCES: permission denied` is never taken for a failed login, and yields `auth`, `unreachable`, `host-key`, `host-key-changed` or `unsupported`. `SshFailure` carries that kind and a message with the last diagnostic line, from which the password is removed. The workspace controller maps it to `workspace/ssh-failed` with the reason in its details, and the dialog words each reason in the reader's language. An unknown host key stays a failure of the connection, and a changed key a hard refusal.

**Host-key confirmation.** An unknown key is resolved by an explicit step, not by relaxing the check. When adding a workspace fails with `host-key`, `scanHostKey` asks `ssh -G` which name, port and `known_hosts` file the connection uses, reads the key with `ssh-keyscan` (ed25519, then ECDSA, then RSA) and computes the SHA-256 fingerprint locally. The failure carries the key type and fingerprint to the dialog, which asks "Trust this host?". Only the person's Trust click sends `sshTrustedHostKey`; `trustHostKey` then scans again, requires the same fingerprint, runs a strict no-login probe so a host with a different recorded key is refused as `host-key-changed`, and appends `[host]:port type key` to the first `known_hosts` file ssh reads. Every real connection keeps `StrictHostKeyChecking=yes` and verifies that recorded key. A changed key carries no key and no button. A host behind `ProxyJump` or `ProxyCommand` cannot be scanned directly, so it gets no offer and the dialog falls back to naming the `ssh` command. The refusal of a changed key is enforced in `trustHostKey` itself, not by the dialog hiding a button.

## Alternatives considered

**Put the password in an argument or use `sshpass`.** Arguments are visible to every process of the user, and `sshpass` does not exist on Windows.

**Drive a pseudo-terminal prompt.** It needs a terminal emulator dependency, behaves differently on Windows, and breaks on any changed prompt text. `SSH_ASKPASS` is OpenSSH's own non-interactive channel.

**Replace the system `ssh` with an embedded SSH library for password hosts.** It would split the transport in two, lose `ssh_config` semantics and the control master, and add a native dependency to the helper's stream design.

**Add `user`, `port` and `authKind` fields to `WorkspaceLocation`.** Cleaner to read, but the location is persisted in the workspace domain record, in Session headers whose validators accept exactly two keys, in the SQLite catalog and in the v4-to-v5 format migration. That is an adjacent-format migration for a presentation concern. The string encoding changes none of them. Its cost is that sidebar labels read `user@host:2222:/path`.

**Trust unknown host keys with `StrictHostKeyChecking=accept-new`.** It trusts whatever key the first connection sees, without the person looking at a fingerprint, and would loosen the check of the real connection.

**Drive `StrictHostKeyChecking=ask` without a terminal.** Its prompt is answered by askpass with the confirmation hint, which gives no place to show the fingerprint to a person and ties the decision to the connection that will then carry credentials. Reading the key separately with `ssh-keyscan` keeps the decision before any credential is sent, and the connection itself stays strict.

**Add the key with `ssh-keygen -F`/`ssh-keyscan >> known_hosts` in the dialog layer.** The decision to write must be enforced where the write happens, so `trustHostKey` re-reads the key, compares the confirmed fingerprint and probes for a recorded different key itself.

**Operating-system keychain.** Windows Credential Manager or DPAPI needs a native addon and a new credential provider. The [credentials-local README](../../../../packages/credentials/credentials-local/README.md#known-limitations-and-deferred-work) already defers that provider, and Agent tool processes run as the same user either way.

**"Ask each session" instead of saving.** A resumed session after a restart would need a password prompt in the middle of opening it. Saving is the smallest design that makes resume work; the dialog says plainly where the password is kept.

**Pass the secret to askpass in a file or a named pipe.** A file needs lifetime management across Windows per-stream logins, and a pipe needs a server per spawn. An environment variable that exists only in one child is the narrowest exposure that stays simple.

## Consequences

A person can add `user@host` plus a password and keep every key, agent and ssh-config workflow unchanged. The password is exposed to same-user processes, through the credential file and the environment of a running ssh child; it is not encrypted, and the dialog, the user guide and the package READMEs say so. Windows pays about 0.3 s and one PowerShell start for each stream. Removing the last workspace of a host deletes its password, so an archived session of that workspace needs the workspace added again before it resumes. A first-time host key is confirmed in the dialog; a fingerprint is only as good as the channel it is compared over, so the dialog and the guide tell the person to compare it with one from the server's administrator. Behind a proxy there is no offer and one interactive `ssh` is still needed.

The [POSIX SSH decision](2026-09-11-posix-ssh-runtime.md) remains the owner of the transport; this note adds the login method and is not a supersession of it.

## Verification

Unit tests assert that the password is in no argument vector, no error text and no returned output for the helper start, each Windows stream, the setup commands and the experiment runner, and that a classified failure never contains it. They run the generated askpass program for real on the host platform with a password of `pässwörd测试 &%^"'x!`. A manual run drove the real plan and a real OpenSSH_for_Windows_8.6p1 against a local password-only test server: a correct password succeeded in about 0.3 s, a wrong one failed in about 0.5 s as `auth`, an unknown and a changed host key failed as `host-key` and `host-key-changed`, and a refused port failed as `unreachable`. The same server then checked host-key confirmation with the real `ssh-keyscan` and `ssh`: the scanned fingerprint equals `ssh-keygen -lf` of the server's key, scanning leaves `known_hosts` untouched, a wrong fingerprint is refused and writes nothing, the confirmed one is recorded as `[127.0.0.1]:2222 ssh-ed25519 …` and a strict connection then succeeds, a second confirmation adds no line, and a `known_hosts` that holds a different key for the host is refused by `trustHostKey` without a write. The dialog was also driven in a real browser. No test has run against a stock `sshd`, on Linux or macOS clients, or through a fully composed product profile.
