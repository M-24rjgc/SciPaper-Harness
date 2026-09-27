---
description: "SciPaper's research edition: project workspaces, research agents, evidence, experiments, and paper artifacts composed over the DSH Web application."
kind: "package-bundle"
---

# @deepseek-ai/dsh-research-app

English | [中文](README.zh.md)

## Summary

This bundle assembles SciPaper Harness's research workspace over `dsh-base` and `dsh-web-app`. Start `dsh --profile research` to create research projects, maintain evidence and claims, run experiments, and work on paper artifacts in the browser. The `web` and Desktop profiles also include this research edition by default.

## Use this package

Apply the bundle after the base and Web layers. Its two patches select the `research` agent preset and mount the research Host service and browser interface. The plugin manager and configuration pages remain available for additional capabilities.

The research preset declares ten tool modules independently: project, evidence, artifact, environment, experiment, board, media, knowledge, checks, and tasks. Each row loads `@deepseek-ai/dsh-research-workbench/tools` with its own `modules` selection. Research mode skills use a separate `@deepseek-ai/dsh-research-workbench/mode-skills` row. Disable or configure individual rows in the profile patch without replacing the shared research data service.

## Understand the implementation

The browser interface belongs to `@deepseek-ai/dsh-client-ui-research`; this package owns composition and startup migration only. No runtime invariant companion is published because live research state is owned and observed by the research service rather than this composition layer.

The `migration` export provides `migrateResearchProfile({ home, profileDir })`. Call it before loading an existing research profile. It preserves original configuration bytes in exclusive backups, journals interrupted writes, converts supported legacy model and preset settings, and rejects conflicting configurations before replacing them. The separate settings importer retains rejected sections for repair.

## Further Exploration

- [Research data and tools](../../research/workbench/README.md)
- [Research browser interface](../../client/ui-research/README.md)
- [Generic Web application](../web-app/README.md)

## Model Experience

### Research preset

#### What the model sees

The `research` preset combines the standard agent tools with research tools and skills. Tools share project identifiers and evidence records through the research service. `research_check` returns advisory findings; it does not automatically approve scientific claims. Independent experiment processes remain managed by the research experiment runtime.

#### Token effect

Enabled tool modules add their schemas to requests, while loaded research skills add their instructions. Disabled modules contribute no tool schemas through their preset rows.

#### KV Cache effect

Changing the enabled tool modules or research mode can alter subsequent request prefixes. Stable preset composition leaves those contributions unchanged between requests.

## Known Limitations and Deferred Work

- Migration rejects legacy settings that have no equivalent in the selected adapter, including custom Chat Completions Files API limits and custom preset discovery roots. Existing files are retained. Model credentials, external providers, remote machines, Python, and TeX require their respective configured environments.
