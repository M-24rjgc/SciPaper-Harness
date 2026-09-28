---
description: "Select the Exa search provider from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-search-exa-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle selects Exa as the research workspace's web-search provider. It is off in shipped profiles.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open **Plugins** and enable **Exa search**. Configure an API key under `EXA_API_KEY` before searching. Without a key the provider is registered but unavailable. Disable this bundle to return to the research workspace's default DeepSeek search. Enabling Exa automatically disables the other optional search backend.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The patch selects `exa` on the shared `web` service and mounts `@deepseek-ai/dsh-web-search-exa`. It has no mutable runtime state of its own and publishes no invariant companion.

-----

<a id="further-exploration"></a>
## Further Exploration

[Web search subsystem](../../../docs/subsystems/web.md)

-----

<a id="model-experience"></a>
## Model Experience

### Search results

#### What the model sees

The existing `web_search` tool uses Exa when this bundle is active and its API key is configured. It returns normalized sources. No additional tool name is added.

#### Token effect

Returned source snippets consume the model's context. The bundle itself adds no system prompt.

#### KV Cache effect

Switching providers changes search results, not the tool schema. Repeated unchanged tool schemas keep the same prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Exa requires its own API key and network access.
- Search requires a configured API key before requests can succeed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
