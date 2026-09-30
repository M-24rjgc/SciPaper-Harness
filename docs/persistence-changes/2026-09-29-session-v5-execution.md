---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-29-session-v5-execution

English | [中文](2026-09-29-session-v5-execution.zh.md)

## Summary

Session format V5 adds an execution identity to SessionHeader and the JSONL header so a POSIX SSH working directory remains distinct from the local Host filesystem.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-29-session-v5-execution
baseline: false
changes:
  - root: "JsonlHeaderLine"
    previous: "2026-09-11-initial"
    after: "de6fbe29fc1f06c815a00507df87938b387f86f2ea62e73c2d7d518a413013b0"
    decision: version-bump
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "43402183993a615660748657fb626f40eb6a215a6343f77c54faf2d043960b56"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

The format version advances from V4 to V5. The V4-to-V5 migration marks existing sessions as local and preserves their working directory, lineage and events. V5 accepts local sessions and SSH sessions identified by a host alias; older runtimes must migrate or reject V5 instead of interpreting remote paths as local.

<a id="verification"></a>
## Verification

The session-format-v4-to-v5 execution suite checks SSH POSIX path round-tripping, unchanged V4 local working directory and lineage, rejection of Windows paths for SSH sessions, and validation of Session-owned delivery markers.

<a id="dev-note"></a>
## Dev Note

None.
