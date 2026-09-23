---
name: ccf-project-scaffolder
description: Initialize a CCFA project — the venue's LaTeX template, the artifact folders it needs and ccfa.yaml — preserving existing files. Use for 项目初始化, 目录搭建 and template setup. Workflow planning belongs to ccf-pipeline-orchestrator; research content to its specialist owner.
---

# CCF Project Scaffolder

Adapted from CCFA-Skills `ccf-project-scaffolder` (MIT). The upstream skill is in `references/upstream.md`; the state template is the pack's `upstream/ccf-project-scaffolder/assets/ccfa.yaml`, reproduced below. Follow it; this page says how it runs here.

## Steps

1. Resolve the venue, the requested folders and what already exists (`research_project` current lists the files on record). Ask only about a consequential unresolved location or overwrite.
2. **Template.** `research_artifact` list-venues with the venue's name, then apply-template with its id and stage `review` (anonymous where the venue is) or `final`. This replaces upstream's `venue-guides/index.md` and `ccf-latex-templates/<VENUE>/`: the official style files, `main.tex.tmpl` and `template.json` land at the project root, and the guide and example at `template/<venue>/`. With no venue yet, say so: the writer drafts against the NeurIPS guide as a stated assumption. Never copy an incomplete template or hand-make a style file; a venue the library lacks is a concrete missing dependency to report.
3. **Manuscript.** The research project already has `paper/`, its established manuscript folder, and the file contract reuses established paths: a new paper starts as `paper/main.tex` from `main.tex.tmpl` (its `@@title@@`, `@@abstract@@` and `@@sections@@` slots are the writer's to fill), with the bibliography the template names (`paper/refs.bib`). The compiler finds the venue's class files wherever the paper sits. An existing manuscript stays where it is; never overwrite a manuscript, bibliography or configuration to refresh a scaffold.
4. **ccfa.yaml.** If it is absent, write it from the template, fill only supplied metadata (title, short name, venue, year, mode) and record the real paths in `artifacts.manuscript` and `artifacts.bibliography`. Leave unknown research fields as explicit placeholders. An existing `ccfa.yaml` is read and updated only within the requested scope.
5. Create only the folders the next stages need; `ccfa-workfiles/` subfolders appear when their work starts.
6. Check: `research_check` scope `ccfa-yaml`; compile the template once when a runnable template was requested. Report the created paths and any missing dependency. A dry run returns the proposed tree and writes nothing.

```yaml
version: "0.4.0"
project: { title: "", short_name: "", root: "." }
target_venue: { name: "", year: "", mode: "review" }
stage: { current: "scaffolded", gate: "not_started", updated_at: "" }
artifacts:
  manuscript: "paper/main.tex"
  bibliography: "paper/refs.bib"
  figures: "figures/"
  tables: "tables/"
  experiments: "experiments/"
  reviews: "reviews/"
  submission: "submission/"
claims: []
experiments: []
reviews: []
revision_ledger: { path: "reviews/revision-ledger.md", status: "not_started" }
submission_checks: { path: "submission/checks.md", status: "not_started" }
```

The upstream template names `manuscript/main.tex` and `manuscript/references.bib`; a research project's manuscript folder is `paper/`, so the state records that — or wherever an existing manuscript actually is.

## Done when

`research_check` scope `scaffold` is clean: `ccfa.yaml` exists, carries the v0.4.0 fields and records only project-relative paths.
