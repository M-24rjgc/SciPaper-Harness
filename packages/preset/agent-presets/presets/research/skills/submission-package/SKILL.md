---
name: submission-package
description: Use at the end — run the full check, fix what remains, confirm with the user when checkpoints are on, and export the submission package with its reproducibility manifest.
---

# Submission package

## Steps

1. **Full check**: `research_check` (scope all). Fix every error; read every warning and fix or justify it (e.g. an unverified entry you confirmed by hand).
2. **Venue requirements**: the official template (`import-template`), page limit, anonymisation for double-blind review (no author names, acknowledgements or self-identifying links), required sections (limitations, broader impact, reproducibility checklist) where the venue asks for them.
3. **Final compile and look**: compile, `render-pages`, `read_image` every page one last time.
4. **Decision**: with `checkpoints` autonomy, ask the user before the final export (`ask_user_question`) — summarise what is in the paper and anything left for the author; `record-decision`. With `automatic`, record that you exported and why it is ready.
5. **Export**: `research_artifact` export. The archive holds the sources, the compiled PDF, every registered file, the experiment inputs/metrics and a manifest with the check report. It is named `submission-…` only when the check is clean and the PDF is current; otherwise `draft-…`.

## Report to the user

PDF path and page count; sections; number of references (all verified); figures and tables; review outcome (issues found, fixed, left for the author); the experiment runs the results come from; anything the author must still do (e.g. fill the author block, upload supplementary data).
