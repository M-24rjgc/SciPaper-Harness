---
description: "The research group map: the research ledger service and its model tools behind the research edition, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/research

English | [中文](README.zh.md)

## Summary

The research group turns the harness into a research collaborator that can take an idea, or existing results, to a paper that compiles and can be submitted. It is one service package: the project ledger (`ctx.research`) with its model tools for evidence, literature, files and LaTeX, Python environments, experiments, page renders and the report-only paper check. The agent drives the work; the research agent preset, its skills and the `ui-research` client plugin live outside this group.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`workbench`](workbench/README.md) | Records each research project and checks the paper: evidence, files, decisions, environments, experiments, compiles and exports | `ctx.research`; registers on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Research subsystem](../../docs/subsystems/research.md) — the project record, modes and checks, refusals, and the Cordis API.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-research-workbench) — every accepted config field.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
