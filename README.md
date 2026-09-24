# SciPaper Harness

English | [中文](README.zh.md)

SciPaper Harness (SPH; its Chinese interface calls it 科研工作台) is a desktop research agent that carries a paper from an idea, or from results you already have, to a submission you can defend. Every quote points back to the page it came from, every number traces to the data or run that produced it, and experiments run on their own, outliving the window.

It is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.1.6-alpha.1 and is an independent project, not affiliated with or endorsed by DeepSeek.

## Preview

SciPaper Harness is an internal-test preview (the `alpha` channel). **Releases may break compatibility**, and the Windows installer is not code-signed yet. Review the [safety notice](SAFETY.md) before running it.

<a id="run"></a>

## Install and update

1. Download `scipaper-harness-<version>-win-x64.exe` from the latest release on the [Releases page](https://github.com/M-24rjgc/SciPaper-Harness/releases).
2. Windows warns about an unknown publisher: choose **More info**, then **Run anyway**.
3. Add your model provider's key in **Settings → Models**; image generation (gpt-image-2) and embeddings are optional keys under **Settings → Research**.

The application checks for a newer release ten seconds after it opens and on **Check for Updates…** in its menu, then downloads, verifies and installs it on restart. Only the changed blocks of the installer are downloaded. Projects and settings live in `~/.research-workbench` and survive updates.

## What it does

- **General mode**: the research agent with every tool and no pipeline.
- **Mode packs** that add a method's own skills, phases and checks: spark-to-paper (from an idea, a proposal or measured results) and CCFA (a full CCF paper, manuscript improvement, a response to reviews). A pack is a directory; new ones need no code.
- **Shared capabilities in every mode**: sources with page-level quotes; literature verified through Crossref, OpenAlex and arXiv with open-access full text; LaTeX with 139 CCF venue templates, compile and page renders; draw.io and audited SVG figures exported to vector PDF; image generation with gpt-image-2; a research-pattern knowledge graph; a gallery of about 3,500 top-venue Figure 1s to study before drawing; Python environments and detached experiments, local or over SSH; report-only checks that define when a paper is done.

The [research subsystem reference](docs/subsystems/research.md) describes the project record, modes, checks and tools.

<a id="run-from-source"></a>

## Build from source

Install Node.js 24 and pnpm, then run from a checkout:

```sh
pnpm install
pnpm run build:research
```

Package the Windows installer, and publish it as a release of this repository through the logged-in GitHub CLI:

```sh
pnpm --dir apps/desktop run package:win:x64:unsigned
pnpm --dir apps/desktop run release:github
```

Start with the [development guide](docs/development.md) and the [architecture documentation](docs/architecture.md); agents follow [AGENTS.md](AGENTS.md).

## Credits

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) by DeepSeek, the agent harness this application is built on, under the MIT licence.
- [spark-to-paper-skills](https://github.com/Spark-To-Paper-Skills/spark-to-paper-skills) and [CCFA-Skills](https://github.com/mikubaka88/CCFA-Skills), the methods behind the two mode packs, under the MIT licence; see each pack's `NOTICE.md`.
- [Top-Conf Figure Gallery](https://github.com/qwdwqfwq/topconf-paper-figure-gallery), whose index the figure gallery ships; every figure keeps its paper's copyright.

## License

[MIT](LICENSE), keeping DeepSeek's copyright notice for the harness. Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
