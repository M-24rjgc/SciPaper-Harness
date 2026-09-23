---
name: figures-from-data
description: Use to make result plots and data figures — always from a script over real collected or imported data, saved as vector PDF, registered with the data and script that produced them.
---

# Figures from data

A result plot is only as trustworthy as the data and code behind it, so both are recorded.

## Steps

1. **Pick the data**: collected run outputs/metrics or imported data evidence. Never type values into a plotting script.
2. **Write the script** `code/figures/<name>.py` that reads those files and writes `figures/<name>.pdf`:
   - `matplotlib` with `savefig('figures/<name>.pdf', bbox_inches='tight')` — vector output;
   - size for the column: ~3.3 in wide (single column) or ~7 in (full width); fonts 8–9 pt; `pdf.fonttype = 42`;
   - colour-blind-safe palette, distinguishable in grayscale (markers/line styles too);
   - labelled axes with units; legend only when needed; error bars/bands when there are seeds.
3. **Run it** in the project environment (`pwsh`/`bash` with the environment's python; it has matplotlib if you added it to the requirements — add it if not).
4. **Register** the figure: `research_artifact` register-artifact `{path: "figures/<name>.pdf", kind: "figure", evidence: [link to the data source], inputArtifacts: [{id: <script artifact>, revision}]}` — register the script first as `code`.
5. **Include** it with `\includegraphics[width=\linewidth]{figures/<name>}` in a `figure` with a caption that states what is plotted and the takeaway.
6. **Look at it** in the compiled paper (`visual-self-review`).

## Done when

`research_check` scope `figures` has no errors, and no result plot is flagged for missing provenance or raster format.
