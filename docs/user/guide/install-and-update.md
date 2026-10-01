# Install and update SciPaper Harness

English | [中文](install-and-update.zh.md)

This guide covers installing SciPaper Harness on Windows, how it keeps itself up to date, where it keeps your data, and how to build and publish it from source.

## Install

1. Download `scipaper-harness-<version>-win-x64.exe` from the latest release on the [Releases page](https://github.com/M-24rjgc/SciPaper-Harness/releases).
2. Run it. The installer is not code-signed yet, so Windows warns about an unknown publisher: choose **More info**, then **Run anyway**. You can pick the installation folder.
3. Open SciPaper Harness and add your model provider and its key in **Settings → Models**. Under **Settings → Research**, the image-generation key (gpt-image-2) and the embedding key are optional.

draw.io, Python and uv come with the installer, so editing a diagram and running an experiment work without installing anything else. LaTeX does not: to compile a paper, SciPaper Harness uses the MiKTeX or TeX Live already installed on your computer, or the TeX binary directory you set under **Settings → Research**, and never changes that installation. Only when it finds none does it download a private copy of TinyTeX, the first time it needs one; LaTeX packages a paper is missing are installed only into that private TinyTeX.

## Update

The application checks this repository's releases ten seconds after it opens, and again whenever you choose **Check for Updates…** in its menu. When a newer release exists it asks first, then downloads it, checks the download against the release's SHA-512 and installs it when it restarts. Only the blocks of the installer that changed are downloaded.

Releases are previews on the `alpha` channel: a new one may change how projects are stored or how the agent works.

## Your data

- `~/.research-workbench` holds the project records, conversations, settings and the cache of downloaded gallery figures.
- A project's own files (paper, figures, code, data, runs) stay in the folder you chose for it.
- API keys are stored in `~/.research-workbench/.credentials.yaml` in your user profile. They are never written into a project or passed to experiment environments.

Updating or uninstalling the application leaves all of this in place.

## Reporting a problem

Open the conversation's **Trajectory** tab. Its toolbar shows the conversation's **Log ID**, for example `c2d58e92`, so a screenshot of the tab already names the log it shows. Press the copy button beside the ID to put the full ID (`session-` followed by a long identifier) on the clipboard, or press **Export log** to save the whole conversation as a ZIP whose name contains the full ID; the desktop app asks where to save it. Send the ID, or the ZIP, with your description. The **…** menu at the top right of the conversation offers **Copy log ID** and **Download session log** as well, in the Chat tab too.

The ZIP holds the conversation log as plain text (`session.v<N>.jsonl`), the logs of its sub-agents, and attachments, so it can contain file contents, paths and tool output from your project; read it before you share it. Nothing is uploaded unless you send it. A developer finds the log on your computer from the ID alone: the folder under `~/.research-workbench/sessions/<project folder>/` that is named by the full ID, or that starts with `session-` and the short ID, holds `session.v<N>.jsonl.zstd`.

<a id="build-from-source"></a>

## Build from source

Install Node.js 24 and pnpm, then run from a checkout:

```sh
pnpm install
pnpm run build:research
```

Package the Windows installer, then publish it as a release of this repository through the GitHub CLI, logged in to an account that can write to it:

```sh
pnpm --dir apps/desktop run package:win:x64:unsigned
pnpm --dir apps/desktop run release:github
```

The [desktop application README](../../../apps/desktop/README.md) describes the update feed and the release check in detail.
