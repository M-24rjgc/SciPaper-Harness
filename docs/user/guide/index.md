# Use the Web UI

English | [中文](index.zh.md)

Start the Web UI through the [root README](../../../README.md#run); the command prints its URL. This guide begins after that server is running. The `dsh` process uses its invoking directory as the default filesystem location, but a fresh Web UI has no selected workspace until you add one.

## Configure a model

Open **Settings → Models**, enter a [DeepSeek API key](https://platform.deepseek.com/), and save it. The model route becomes usable immediately without restarting the server.

The [model configuration guide](./providers.md) covers other providers and custom OpenAI-compatible endpoints.

## Choose a workspace

Click **Choose workspace**, add the project directory where you started `dsh`, and select it. The session composer remains unavailable until a workspace is selected.

## Work on a remote machine over SSH

In the research sidebar, click **＋** beside **研究** (Researches) and choose **Add SSH workspace**. The remote machine must run Linux or macOS with Node.js 22 or newer. Enter:

- **Host**: an alias from your `~/.ssh/config`, or `user@host`.
- **Port** (optional): leave it empty for 22.
- **Absolute remote path**: the project directory on the remote machine.
- **Login**: **Key or ssh config (default)** uses your ssh keys, agent and `~/.ssh/config` exactly as `ssh` does. **Password** logs in as the user you typed with the password you enter, so you need no key and no ssh configuration.

The host must be trusted before the first connection, with either login. Run `ssh user@host` once in a terminal, check the fingerprint and answer `yes`; the dialog names this command if the host is still unknown.

A password is checked against the host first and saved only if the host accepts it. It is saved on this computer, in your user profile, in the same credential file as your API keys; it is not encrypted, so anyone who can read your profile can read it. Removing the last workspace on a host deletes its saved password, and adding the workspace again with **Key or ssh config** forgets it too. Remote experiments in researches on that workspace log in with the same password.

When the host cannot be used, the dialog says why: the login was refused, the host could not be reached, the host key is unknown or has changed, or the OpenSSH on your computer is older than 8.4, which password login needs.

## Run a task

Start a session and send:

> Summarize this repository and identify its main packages.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The Web UI asks before operations that require approval under the active permission policy.

## Continue

- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/index.md)
