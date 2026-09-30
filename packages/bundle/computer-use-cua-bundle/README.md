---
description: "Enable local desktop control from the plugin manager."
kind: "package-bundle"
---

# @deepseek-ai/dsh-computer-use-cua-bundle

English | [中文](README.zh.md)

## Summary

This optional bundle composes the computer-use service and Cua Driver native provider. Shipped profiles leave it disabled.

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

Open **Plugins** in the desktop sidebar and enable **Desktop control**. The host loads the local computer-use provider for subsequent agent calls. Disable the bundle to remove its tools. The operating system must allow the application to inspect and control the desktop.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The bundle patch mounts `dsh-computer-use` and `dsh-computer-use-cua-driver-native` together. No runtime invariant companion is published because this bundle only composes providers; the computer-use service and native driver own runtime state.

-----

<a id="further-exploration"></a>
## Further Exploration

[Computer use subsystem](../../../docs/subsystems/computer-use.md)

-----

<a id="model-experience"></a>
## Model Experience

### Cua Driver tools

#### What the model sees

When the `computer-use-cua-native` row is enabled, the agent sees tool descriptions supplied by the installed Cua Driver. Tool results may contain text and screenshots; image input requires a compatible model route and attachment store.

#### Token effect

The driver tool schemas enter model requests. Calls and admitted screenshot results consume context until compacted.

#### KV Cache effect

Enabling or disabling the bundle changes the available tool catalog in later requests. An unchanged catalog keeps its prefix stable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Computer control requires a supported desktop and operating-system permissions. A native driver failure can affect the host process.
- This bundle controls the shared desktop. It does not provide per-session desktop isolation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
