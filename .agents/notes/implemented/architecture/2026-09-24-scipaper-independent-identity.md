# Agent Note: SciPaper Harness as an independent product

Status: implemented

English | [中文](2026-09-24-scipaper-independent-identity.zh.md)

## Problem

This repository began as DeepSeek Harness 0.1.6-alpha.1 and ships as SciPaper Harness, a desktop research application. Upstream moved more than 2,500 commits past that release within days, with breaking changes, so the application cannot take upstream releases as updates to its base; it maintains the code it has. The application still identified itself as DeepSeek Harness outward: every model request sent a `deepseek-harness` User-Agent with the upstream repository address, web fetches and web-search providers did the same, direct DeepSeek model requests carried a persistent anonymous user id, the plugin-inventory extension reported the running plugin packages with official DeepSeek requests, and every package manifest named the upstream repository.

## Decision

SciPaper Harness keeps no tie to DeepSeek Harness beyond the licence notice and the credits in its README.

- **Request identity.** `APP_IDENTITY` in `@deepseek-ai/dsh-llm` is `scipaper-harness` with this repository's address, so every provider request's User-Agent names this application; web fetch and the Exa, Perplexity and DeepSeek web-search providers send the same product token.
- **No user identifier.** The DeepSeek adapters no longer send `x-deepseek-harness-user-id` or resolve the anonymous user id. The session-id and compaction headers remain, because they describe the request, not the person, and serve the provider's cache affinity.
- **No plugin inventory.** The `plugin-package-inventory-deepseek` row of the base bundle is disabled.
- **Own releases.** Updates come from this repository's GitHub Releases ([Desktop release and update](../../../../apps/desktop/README.md)); the product has its own version line, starting at 0.2.0-alpha.1, and the repository tracks no upstream remote.
- **Manifests.** Every package manifest's `repository` field names this repository.

DeepSeek models remain an optional model provider next to the others, used only when the person configures them. Internal identifiers stay as they are: the `@deepseek-ai/dsh-*` package names, the `dsh` command, `DSH_*` environment variables and the inherited developer documentation. People never see them, and renaming thousands of imports would change no behaviour.

## Consequences

- Provider logs and web servers see `scipaper-harness/<version>` and this repository's address.
- `.anonymous-user-id` is no longer created by model requests; `/feedback` still reads it where it exists.
- Changes from upstream DeepSeek Harness arrive only when someone ports one on purpose.
- The internal `dsh` names remain visible to developers reading the code and its documentation.

## Alternatives considered

**Keep merging upstream releases.** The divergence is too large and upstream is allowed to break compatibility; each merge would be a hand-resolved rewrite of this product's own changes.

**Rename every internal identifier.** It touches thousands of imports, configuration rows and documents for no visible effect, and risks breaking the build for nothing a user gains.

**Keep the upstream request identity.** It misattributes this application's traffic to another project and sent a persistent per-installation identifier nobody here needs.
