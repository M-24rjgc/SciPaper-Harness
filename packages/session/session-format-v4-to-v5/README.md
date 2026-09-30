---
description: "Session V4-to-V5 header migration and native V5 admission for local and SSH execution identity."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

English | [中文](README.zh.md)

## Summary

Restore a supported V4 Session as V5 by adding explicit local execution identity to its header. Native V5 headers can instead identify an SSH host and POSIX working directory. The edge preserves the event sequence and inherited cut; the released V4 codec continues to own physical event rows.

## Table of Contents

- [Use this package](#use-this-package)
- [Header and event contract](#header-and-event-contract)
- [Native V5 admission](#native-v5-admission)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The [format catalog](../session-format-catalog/README.md) assembles this adjacent edge for persistence restoration. Direct imports are for catalog assembly and format tests; this library has no Cordis mount configuration. Its [exports](src/index.ts) include `sessionFormatV4ToV5`, the released V4 and V5 codecs, V5 validators, and the V5 artifact restorer.

The migration validates a released V4 header, changes `version` to 5, and sets `execution: { kind: 'local' }`. Its stage copies events in order, preserves their sequence numbers, and retains the inherited prefix count. Persistence owns source reads and verified successor publication.

<a id="header-and-event-contract"></a>
## Header and event contract

| Input | V5 result |
|---|---|
| V4 logical header | All existing fields retained; `version: 5` and local `execution` added. |
| V4 event or compact run | Expanded and emitted without changing the represented events. |
| V5 physical header | V4 physical framing plus `execution`; SSH `cwd` remains a POSIX path even on a Windows Host. |
| V5 event row | Released V4 event encoder and decoder, without an event-shape conversion. |

The source codec validates V4 before conversion. A seeded source retains its inherited event count, including the cut identified by a tagged `session/end-seed` event. A malformed source or target refuses restoration; partial stage emission does not establish success.

<a id="native-v5-admission"></a>
## Native V5 admission

`assertReleasedV5Header` requires version 5 and accepts either `{ kind: 'local' }` or `{ kind: 'ssh', host }`; an SSH host is nonempty and its `cwd`, when present, is an absolute POSIX path. A missing `execution` is treated as local for legacy callers, while V5 encoding writes the normalized identity. SSH `cwd` is omitted from V4 validation and checked against the POSIX rule separately.

`restoreReleasedV5Artifact` applies the released V4 event relationship rules and validates V5 delivery markers against their owning Session and preceding sequence. `assertReleasedV5Relationships` performs the same relationship checks without replacing the artifact. Neither entry performs SSH connection checks or filesystem reads.

<a id="further-exploration"></a>
## Further Exploration

The [format protocol](../session-format/README.md) defines migration stages and refusal. The [V4 edge](../session-format-v3-to-v4/README.md) owns source event semantics; [JSONL persistence](../session-persistence-jsonl/README.md) owns generation publication. The [historical V4 schema](../../../docs/persistence-changes/historical-formats/v4.md) records the selected predecessor inventory.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the Session catalog that restores V4 history before current request assembly.

#### KV Cache effect

The header-only migration changes no restored event content or order. Request assembly decides cache reuse from the resulting conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- V4 Sessions have no SSH execution identity; migration assigns local execution and cannot infer a remote host from `cwd`.
- Native V5 validation checks header and event relationships, not remote host availability or workspace access.
- This edge supports only adjacent V4-to-V5 restoration; older versions pass through their own catalog edges first.

<a id="dev-note"></a>
### Dev Note

No invariant companion is published. The migration stage and codec have no independent runtime registration whose state can diverge.
