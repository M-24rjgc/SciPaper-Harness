# Agent Note: Tracking DeepSeek Harness releases by real merges

Status: implemented

English | [中文](2026-09-30-tracking-dsh-releases.zh.md)

## Problem

SciPaper Harness began as a copy of DeepSeek Harness 0.1.6-alpha.1. [The independent-identity decision](2026-09-24-scipaper-independent-identity.md) stopped taking upstream releases because upstream had moved thousands of commits and every merge looked like a hand-resolved rewrite. That cost the product what upstream keeps fixing: Windows shell and sandbox work, the model catalog, persistence migrations, new client features. The product also needs a way to say which upstream release its inherited code corresponds to, since its own version line (`0.2.0-alpha.N`) says nothing about that.

## Decision

The inherited monorepo is the product's kernel, and the kernel follows upstream release tags through real Git merges.

- **Connected history.** The import commit is joined to upstream's tag history, so `git merge <tag>` has a true merge base. Merges land on a branch first (`upgrade/dsh-<version>`), never directly on `main`.
- **Two version lines.** Every lockstep `package.json` carries the product version in `version` and the embedded upstream release in `scipaper.kernel { name, version, revision }`. The product stays on `0.2.0-alpha.N`: the desktop updater derives its channel from that suffix and would not offer an `-rc` build to alpha installs, so a version-line conflict always keeps ours. `getDshRuntimeVersion()` reads the kernel marker, and plugin compatibility checks judge peers against it.
- **Stamping.** After a merge, every manifest's kernel block is rewritten to the merged tag and its full commit. The rc.2 merge rewrote 332 manifests in one scripted pass.
- **Generated files are regenerated, not merged.** Slot catalog, persistence catalog and schema, format index, tool and config catalogs, translation hash records and third-party notices come from their generators after the source is merged.
- **Product changes stay expressible.** Research-edition behaviour lives in `packages/research/*`, `packages/client/ui-research` and the `packages/bundle/research-app` bundle; edits to inherited packages are limited to copy, configuration and the recorded exceptions, and each merge re-checks them.

The rc.2 merge (2026-09-30) applied this:

- Desktop host now ships three entries, `index`, `cli` (upstream's terminal command) and `office-cli` (ours); the terminal command is named `sph`, carries the SciPaper executable name, and owns its own registry key and mutex.
- The research preset switches `ask_user_question` to upstream's timed mode with a default timeout of `-1`. A call waits for the answer, as a checkpoint needs; a question that does not block passes a finite timeout and the agent continues, receiving the answer later as a user message.
- The Session log upload switch in General settings is disabled in the research edition with the other telemetry rows.
- Open-in-app follows upstream's directory-path props; the remote-workspace guard moved into the two slot adapters.
- Upstream's session format is still V4; ours is V5 because it records where a Session executes (the SSH workspaces). Persistence records for both chains coexist, and a future upstream V5 will need a deliberate reconciliation.

## Consequences

- Upgrading is a merge plus a scripted stamp, a generator pass and the verification ladder, not a port.
- Every inherited file we edit is a possible conflict on the next merge, so new product work goes in the product packages first.
- Product and kernel versions can no longer be confused: `version` is what users install, `scipaper.kernel.version` is what the code is based on.

## Alternatives considered

**Keep porting fixes by hand.** Each fix is small, but the set is unbounded and nothing records which upstream state the code matches.

**Adopt upstream's version numbers.** The updater would stop offering builds to existing alpha installs, and the product would appear to be an upstream release.

**Rebase our work on each tag.** It rewrites shared history and repeats the same conflicts on every rebase; a merge resolves each conflict once.
