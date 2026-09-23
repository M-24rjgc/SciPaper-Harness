#!/usr/bin/env python3
"""Run one spark-to-paper gate over a research project and print its findings.

    python -I run_gate.py <gate> --root <project> [--stage cite|full]

The gates are spark-to-paper's own linters, run unchanged from ../upstream (see
../NOTICE.md). This adapter only translates each linter's JSON report into the
research check's contract, printed as the last line of standard output:

    {"findings": [{"severity": "error"|"warning", "message": ..., "file": ...}]}

Standard library only.
"""
from __future__ import annotations

import contextlib
import io
import json
import runpy
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
UPSTREAM = HERE.parent / "upstream"


def finding(severity, message, file=None):
    item = {"severity": severity, "message": message}
    if file:
        item["file"] = file
    return item


def run_linter(relative, argv):
    """Run an upstream script as __main__ with the given arguments; return its JSON report."""
    script = UPSTREAM / relative
    out = io.StringIO()
    saved = sys.argv
    sys.argv = [str(script), *argv]
    try:
        with contextlib.redirect_stdout(out):
            runpy.run_path(str(script), run_name="__main__")
    except SystemExit:
        pass  # every linter exits with its verdict; the report is what counts
    finally:
        sys.argv = saved
    text = out.getvalue()
    start = text.find("{")
    if start < 0:
        raise ValueError(f"{relative} printed no report: {text[-400:]}")
    return json.loads(text[start:])


def template_gate(root, _stage):
    if not (root / "template.json").exists():
        return [finding("error", "No template.json in the project: apply a venue template before planning", "template.json")]
    report = run_linter("ts-paper-plan/scripts/template_lint.py", [str(root)])
    if "error" in report:
        return [finding("error", report["error"], "template.json")]
    return [finding("error", issue, "template.json") for issue in report.get("issues", [])]


def blueprint_gate(root, _stage):
    if not (root / "blueprint.json").exists():
        return [finding("error", "No blueprint.json yet: write the plan (ts-paper-plan)", "blueprint.json")]
    findings = []
    if not (root / "template.json").exists():
        findings.append(finding("warning", "No template.json: the blueprint was checked against the bundled Traitement du Signal template", "template.json"))
    report = run_linter("ts-paper-plan/scripts/blueprint_lint.py", [str(root)])
    return findings + [finding("error", issue, "blueprint.json") for issue in report.get("issues", [])]


# Citation rules that only make sense once the sections cite something.
NEEDS_SECTIONS = {"orphan_entry", "cite_without_entry", "section_zero_citations", "claims_map_section_mismatch",
                  "cite_without_claim_justification", "weak_claim_match", "coverage_below_floor"}


def citation_message(issue):
    rule, key = issue.get("rule", "?"), issue.get("key", "")
    if rule == "duplicate_key":
        return f"Duplicate BibTeX key {key}", "refs.bib"
    if rule == "stub_or_incomplete":
        return f"{key} is incomplete: missing {', '.join(issue.get('missing', []))} — complete it from the real record, never invent fields", "refs.bib"
    if rule == "doi_unresolved":
        return f"{key}: DOI {issue.get('doi')} does not resolve", "refs.bib"
    if rule == "cite_without_entry":
        return f"\\cite{{{key}}} has no refs.bib entry", None
    if rule == "orphan_entry":
        return f"refs.bib entry {key} is never cited: cite it where it supports a claim, or remove it", "refs.bib"
    if rule == "cite_without_claim_justification":
        return f"{key} has no claim in claims_map.json", "claims_map.json"
    if rule == "weak_claim_match":
        return f"{key}: support label '{issue.get('label')}' is not a real match for the claim", "claims_map.json"
    if rule == "claims_map_section_mismatch":
        return f"{key}: claims_map.json names section {issue.get('claimed')}, but it is cited in {', '.join(issue.get('actual', []))}", "claims_map.json"
    if rule == "missing_claims_map":
        return "claims_map.json is missing: record the claim each citation supports", "claims_map.json"
    if rule == "section_zero_citations":
        return f"Section {key} cites nothing: every prior-work, dataset and baseline claim needs a real paper", f"sections/{key}.tex"
    return f"{rule}: {key}", None


def citations_gate(root, stage):
    if not (root / "refs.bib").exists():
        return [finding("error", "No refs.bib yet: build the bibliography (ts-paper-cite)", "refs.bib")]
    report = run_linter("ts-paper-cite/scripts/citations_lint.py", [str(root)])
    findings = []
    for issue in report.get("issues", []):
        if stage == "cite" and issue.get("rule") in NEEDS_SECTIONS:
            continue
        message, file = citation_message(issue)
        findings.append(finding("error", message, file))
    for warning in report.get("warnings", []):
        if warning.get("rule") == "section_coverage_out_of_band":
            findings.append(finding("warning", f"Section {warning.get('key')} cites {warning.get('n')} sources, outside its band {warning.get('band')}: redistribute real citations", f"sections/{warning.get('key')}.tex"))
        else:
            findings.append(finding("warning", f"{warning.get('rule')}: {warning.get('key')}", "refs.bib"))
    if stage == "cite":
        spec = {}
        if (root / "template.json").exists():
            spec = json.loads((root / "template.json").read_text(encoding="utf-8"))
        floor = int((spec.get("citations") or {}).get("floor", 40))
        if report.get("n_entries", 0) < floor:
            findings.append(finding("error", f"refs.bib holds {report.get('n_entries', 0)} entries, below the template floor of {floor}: search more broadly for real papers; never fabricate", "refs.bib"))
    return findings


def draft_gate(root, _stage):
    sections = root / "sections"
    if not sections.is_dir() or not any(sections.glob("*.tex")):
        return [finding("error", "No sections/*.tex yet: write the paper (ts-paper-write)")]
    report = run_linter("ts-paper-write/scripts/draft_lint.py", [str(root)])
    findings = []
    for violation in report.get("violations", []):
        file = violation.get("file", "")
        path = None if file.startswith("(") else f"sections/{file}"
        findings.append(finding("error", f"{violation.get('rule')}: {violation.get('snippet')}", path))
    return findings


def story_gate(root, _stage):
    if not (root / "story.json").exists():
        return [finding("error", "No story.json yet: build the story (ts-idea2story)", "story.json")]
    report = run_linter("ts-idea2story/scripts/story_lint.py", [str(root)])
    return [finding("error", issue, "story.json") for issue in report.get("issues", [])]


def vector_gate(root, _stage):
    report = run_linter("ts-figure-optimize/scripts/check_vector_pdf.py", ["check", "--workdir", str(root)])
    findings = [finding("error", f"Figure has no file: {item}") for item in report.get("missing_artifact", [])]
    findings += [finding("error", f"Converted figure has no PDF: {item}") for item in report.get("missing_pdf", [])]
    for item in report.get("not_a_valid_hybrid", []):
        errors = "; ".join(str(error) for error in item.get("errors", []))
        findings.append(finding("error", f"figures/{item.get('figure')}.svg is not an editable figure: {errors}", f"figures/{item.get('figure')}.svg"))
    for label in report.get("kept_png_unconverted", []):
        # The linter files every figure without an SVG here; one with its own PDF (a matplotlib plot) is already vector.
        if not (root / "figures" / f"{label}.pdf").exists():
            findings.append(finding("warning", f"figures/{label}.png stays a raster: redraw it as an editable SVG with a vector PDF (ts-figure-svg)", f"figures/{label}.png"))
    return findings


def critique_gate(root, _stage):
    gates = runpy.run_path(str(UPSTREAM / "ts-paper/scripts/run_gates.py"))
    return [finding("error", problem, "figures/figures.manifest.json") for problem in gates["check_figure_critique"](root)]


GATES = {
    "template": template_gate,
    "blueprint": blueprint_gate,
    "citations": citations_gate,
    "draft": draft_gate,
    "story": story_gate,
    "vector": vector_gate,
    "critique": critique_gate,
}


def main(argv):
    if len(argv) < 3 or argv[0] not in GATES or "--root" not in argv:
        print(json.dumps({"findings": [finding("error", f"usage: run_gate.py <{'|'.join(GATES)}> --root <project> [--stage cite|full]")]}))
        return 2
    root = Path(argv[argv.index("--root") + 1]).resolve()
    stage = argv[argv.index("--stage") + 1] if "--stage" in argv else "full"
    try:
        findings = GATES[argv[0]](root, stage)
    except Exception as error:  # a broken input file reports as a finding, never as a crash
        tail = traceback.format_exception_only(type(error), error)[-1].strip()
        findings = [finding("error", f"The {argv[0]} gate could not read the project: {tail}")]
    print(json.dumps({"findings": findings}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
