# Agent Note: Research Workbench installs beside DeepSeek Harness, not over it

Status: implemented

English | [中文](2026-09-21-research-workbench-default-home.zh.md)

## Problem

Research Workbench is distributed as its own product. A person may already run an official DeepSeek Harness on the same machine, and the two must not share user data: a shared root would put this product's sessions, storages, settings and profiles into the other installation's tree, where each reads and rewrites the other's records.

The separation existed, but in one place only. `apps/desktop/src/main.ts` set `DSH_HOME` to `~/.research-workbench` before anything else resolved, so the shipped Electron application was correct. Nothing else was. `dsh --profile web`, `dsh` on the command line, and `scripts/dev-web.ts` all resolved the default `~/.dsh` and read the other installation's workspaces and session history. Running the web preview during development wrote a profile scaffold, a blank session and a workspace record into a real DeepSeek Harness home.

## Decision

`DSH_HOME_DIR_NAME` is `.research-workbench`, so the default home of every entry point is this product's own. `$DSH_HOME` still overrides it, and the desktop launcher still prefers `RESEARCH_WORKBENCH_HOME`.

The separation belongs to the default rather than to a bundle row or a launcher. `resolveDshHome` runs before any configuration loads — profile discovery already reads `<home>/profiles` during boot — so a row in `packages/bundle/web-app/cordis.patch.yml` would be applied after the paths it needs to influence were resolved. That ordering is exactly what let the stray `profiles/web/cordis.yml` reach the other installation.

`packages/util/home-paths/tests/home-paths.spec.ts` asserts the default is not an official Harness home, that `dshCachePath()` contains no `.dsh` segment, and that `$DSH_HOME` still reaches one for a caller who asks on purpose.

## Alternatives considered

**Set the home in the web bundle.** The row would load after profile discovery, so the first thing the boot does with the home would still use `~/.dsh`.

**Set `process.env.DSH_HOME` at the top of `apps/cli/src/bin.ts`.** It closes the CLI and the web profile but not a test, a generator, or a future entry point, and it leaves the correct value duplicated in the desktop launcher and the CLI.

**Rename the `DSH_HOME` variable too.** The desktop launcher already maps `RESEARCH_WORKBENCH_HOME` onto it, published documentation names it, and the Python SDK requires it. Changing the default directory answers the isolation requirement; renaming the override would only break callers.

## Consequences

An existing `~/.research-workbench`, which the desktop application has been writing since it shipped, becomes the home every entry point reads, so the CLI and the web preview now see the same projects the desktop does.

Nothing migrates from `~/.dsh`. A developer who was deliberately sharing a home with an official installation sets `DSH_HOME` explicitly.

`dshHomeDisplay` now labels the default `~/.research-workbench`, and `docs/user/guide/network-proxy.md` names `~/.research-workbench/.env` as the file that sits beside the API key.
