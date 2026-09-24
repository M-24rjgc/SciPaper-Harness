# Install and update SciPaper Harness

English | [中文](install-and-update.zh.md)

This guide covers installing SciPaper Harness on Windows, how it keeps itself up to date, where it keeps your data, and how to build and publish it from source.

## Install

1. Download `scipaper-harness-<version>-win-x64.exe` from the latest release on the [Releases page](https://github.com/M-24rjgc/SciPaper-Harness/releases).
2. Run it. The installer is not code-signed yet, so Windows warns about an unknown publisher: choose **More info**, then **Run anyway**. You can pick the installation folder.
3. Open SciPaper Harness and add your model provider and its key in **Settings → Models**. Under **Settings → Research**, the image-generation key (gpt-image-2) and the embedding key are optional.

LaTeX, draw.io, Python and uv come with the installer, so compiling a paper, editing a diagram and running an experiment work without installing anything else.

## Update

The application checks this repository's releases ten seconds after it opens, and again whenever you choose **Check for Updates…** in its menu. When a newer release exists it asks first, then downloads it, checks the download against the release's SHA-512 and installs it when it restarts. Only the blocks of the installer that changed are downloaded.

Releases are previews on the `alpha` channel: a new one may change how projects are stored or how the agent works.

## Your data

- `~/.research-workbench` holds the project records, conversations, settings and the cache of downloaded gallery figures.
- A project's own files (paper, figures, code, data, runs) stay in the folder you chose for it.
- API keys are kept in the operating system's credential store, never in a project.

Updating or uninstalling the application leaves all of this in place.

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
