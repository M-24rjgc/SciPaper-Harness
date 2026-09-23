"""Tests for the CCFA pack's gates and scripts (runtime/modes/ccfa).

Run from packages/research/workbench with the platform Python (it has PyYAML, pypdfium2, reportlab):

    <platform-python> -m unittest tests/ccfa_gates_test.py -v

Each gate test builds a small project, runs one gate the way the research service does
(python -I -X utf8 gates/run_gate.py <gate> --root <project>), and reads the findings line.
"""
from __future__ import annotations

import json
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent / "runtime" / "modes" / "ccfa"
VALIDATOR = PACK / "upstream" / "ccf-paper-reviewer" / "scripts" / "validate_version_comparison.py"
STATE_TEMPLATE = PACK / "upstream" / "ccf-project-scaffolder" / "assets" / "ccfa.yaml"
HOME = "C:/" + "Us" + "ers/someone/data"


class ProjectTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="ccfa gate 中文 "))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def write(self, path, content, age=None):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        if age is not None:
            stamp = time.time() + age
            os.utime(target, (stamp, stamp))

    def run_python(self, script, *args):
        return subprocess.run([sys.executable, "-I", "-X", "utf8", str(script), *args],
                              capture_output=True, text=True, encoding="utf-8", cwd=self.root)

    def gate(self, *args):
        result = self.run_python(PACK / "gates" / "run_gate.py", *args)
        return result.returncode, json.loads(result.stdout.strip().splitlines()[-1])["findings"]

    def run_gate(self, name):
        code, findings = self.gate(name, "--root", str(self.root))
        self.assertEqual(code, 0)
        return findings

    def messages(self, findings, severity="error"):
        return [item["message"] for item in findings if item["severity"] == severity]


class Usage(ProjectTest):
    def test_rejects_an_unknown_gate_or_a_missing_root(self):
        for args in (["nope", "--root", "."], ["yaml"], ["yaml", "x", "--root"]):
            code, findings = self.gate(*args)
            self.assertEqual(code, 2)
            self.assertIn("usage: run_gate.py", findings[0]["message"])

    def test_reports_an_unreadable_input_as_a_finding(self):
        (self.root / "ccfa-review-reports" / "folder-review.md").mkdir(parents=True)
        findings = self.run_gate("review")
        self.assertEqual(len(findings), 1)
        self.assertRegex(findings[0]["message"], r"^The review gate could not read the project: \S*(PermissionError|IsADirectoryError)")


class State(ProjectTest):
    def filled(self, **replace):
        text = STATE_TEMPLATE.read_text(encoding="utf-8").replace('name: ""', 'name: "NeurIPS"')
        text = text.replace("manuscript/main.tex", "paper/main.tex").replace("manuscript/references.bib", "paper/refs.bib")
        for old, new in replace.items():
            text = text.replace(old, new)
        return text

    def test_needs_the_file_and_valid_yaml(self):
        self.assertEqual(self.messages(self.run_gate("yaml")), [
            "No ccfa.yaml yet: scaffold the project (ccf-project-scaffolder copies the template and fills the project and venue)"])
        self.write("ccfa.yaml", "version: [unclosed\n")
        findings = self.run_gate("yaml")
        self.assertRegex(findings[0]["message"], r"^ccfa.yaml is not valid YAML: ")
        self.assertEqual(findings[0]["line"], 2)
        self.write("ccfa.yaml", "- a list\n")
        self.assertEqual(self.messages(self.run_gate("yaml")), ["ccfa.yaml must be a mapping of the v0.4.0 fields (copy the scaffolder's template)"])

    def test_the_scaffolded_template_passes_once_its_files_exist(self):
        self.write("ccfa.yaml", self.filled())
        self.assertEqual(self.messages(self.run_gate("yaml"), "warning"), [
            "ccfa.yaml: artifacts.manuscript is paper/main.tex, which does not exist yet — create it or record where it is",
            "ccfa.yaml: artifacts.bibliography is paper/refs.bib, which does not exist yet — create it or record where it is",
        ])
        self.write("paper/main.tex", "\\documentclass{article}")
        self.write("paper/refs.bib", "")
        self.assertEqual(self.run_gate("yaml"), [])

    def test_names_missing_fields_wrong_shapes_and_an_empty_stage(self):
        self.write("ccfa.yaml", 'version: "0.3"\nproject: x\nstage: {current: ""}\nclaims: {}\ntarget_venue: {name: ""}\n')
        findings = self.run_gate("yaml")
        self.assertEqual(self.messages(findings), [
            "ccfa.yaml lacks required field(s): artifacts, experiments, reviews, revision_ledger, submission_checks",
            "ccfa.yaml: project must be a mapping",
            "ccfa.yaml: claims must be a list",
            "ccfa.yaml: stage.current must name the current stage",
        ])
        self.assertEqual(self.messages(findings, "warning"), [
            "ccfa.yaml says version 0.3; the contract is 0.4.0 — keep its fields rather than migrating them",
            "ccfa.yaml names no target venue: the writer drafts against the NeurIPS guide as a stated assumption until one is chosen",
        ])

    def test_keeps_every_recorded_path_inside_the_project_and_off_the_machine(self):
        self.write("paper/main.tex", "x")
        self.write("ccfa.yaml", self.filled(**{'"paper/refs.bib"': f'"{HOME}/refs.bib"', '"submission/checks.md"': '"../elsewhere.md"'}))
        self.assertEqual(self.messages(self.run_gate("yaml")), [
            "ccfa.yaml stores a machine path in artifacts.bibliography: record it relative to the project",
            "ccfa.yaml: submission_checks.path = ../elsewhere.md points outside the project",
        ])


def review_report(status="resolved", template=True):
    """A default-format detailed scientific review built from the upstream profile and rubric."""
    validator = runpy.run_path(str(VALIDATOR))
    lines = ["# Review of the test paper", ""]
    if template:
        lines += ["Template: ccfa-review-1", "Mode: scientific", "Detail: detailed", "Rubric: generic-7", ""]
    for number, titles in validator["_profile_headings"]("scientific", "detailed"):
        lines.append(f"## {number}. {max(titles, key=len)}")
        if number == 6:
            lines += ["### C001: Missing ablation", "- Type: unsupported_claim", "- Severity: major", "- Location: Sec. 4",
                      "- Evidence: Table 2 has no ablation", "- Countercheck: appendix read", "- Judgment: the gain is not attributed",
                      "- Criterion: evidence", "- Resolution: add the ablation", f"- Status: {status}"]
        elif number == 12:
            lines += ["| Dimension | Score | Confidence | Evidence | Deduction |", "| --- | --- | --- | --- | --- |"]
            lines += [f"| {key} | 4 | 3 | Sec. 4 | none |" for key, _, _ in validator["_canonical_criteria"]()]
            lines += ["", "**Overall:** 6", "**Scholarly Confidence:** 3"]
        else:
            lines.append("See [C001]." if number == 14 else "Assessed.")
        lines.append("")
    return "\n".join(lines)


class Review(ProjectTest):
    REPORT = "ccfa-review-reports/test-neurips-review.md"

    def test_needs_a_report(self):
        self.assertEqual(self.messages(self.run_gate("review")), [
            "No review report yet: review the paper with ccf-paper-reviewer and save ccfa-review-reports/<paper-slug>-<venue>-review.md"])

    def test_a_valid_report_with_its_findings_resolved_passes(self):
        self.write(self.REPORT, review_report())
        self.assertEqual(self.run_gate("review"), [])

    def test_an_open_major_finding_holds_the_review(self):
        self.write(self.REPORT, review_report("unresolved"))
        self.assertEqual(self.run_gate("review"), [{
            "severity": "error", "file": self.REPORT,
            "message": "Open major finding C001 (unresolved): Missing ablation — fix it through its owner, then re-review",
        }])

    def test_reports_the_upstream_format_errors(self):
        self.write(self.REPORT, review_report().replace("**Overall:** 6", "**Overall:** 0"))
        self.assertEqual(self.messages(self.run_gate("review")), [
            "Review report (scientific, detailed): Overall must be an integer 1-10, N/A, or not assessed"])

    def test_a_report_in_another_form_is_not_format_checked(self):
        self.write(self.REPORT, review_report(template=False))
        self.assertEqual(self.messages(self.run_gate("review"), "warning"), [
            f"{self.REPORT} does not declare Template: ccfa-review-1 in its scope block, so its format was not checked"])


LEDGER_HEAD = "| comment_id | source | concern | status | location |\n| --- | --- | --- | --- | --- |\n"


class Ledger(ProjectTest):
    def test_needs_a_ledger_with_a_table_and_its_columns(self):
        self.assertEqual(self.messages(self.run_gate("ledger")), [
            "No revision ledger yet: parse the reviews into reviews/revision-ledger.md (ccf-rebuttal-writer, revision-ledger mode)"])
        self.write("reviews/revision-ledger.md", "Nothing yet.\n")
        self.assertEqual(self.messages(self.run_gate("ledger")), [
            "The revision ledger holds no Markdown table: one row per reviewer comment (see revision-ledger.md)"])
        self.write("reviews/revision-ledger.md", "| ID | Concern |\n| --- | --- |\n| R1-C1 | x |\n")
        self.assertEqual(self.messages(self.run_gate("ledger")), ["The revision ledger lacks column(s): status, location"])
        self.write("reviews/revision-ledger.md", LEDGER_HEAD)
        self.assertEqual(self.messages(self.run_gate("ledger")), ["The revision ledger has no rows: record every reviewer comment"])

    def test_lists_unfinished_invalid_duplicate_and_unlocated_rows(self):
        self.write("reviews/revision-ledger.md", LEDGER_HEAD + "\n".join([
            "| R1-C1 | R1 | ablation | done | Sec. 4.2 |",
            "| R1-C2 | R1 | wording | planned |  |",
            "| R1-C2 | R1 | again | accepted_limit | Sec. 6 |",
            "| R2-C1 | R2 | scope | done |  |",
            "| R2-C2 | R2 | typo | fixed | Sec. 1 |",
            "|  | AC | missing id | resolved | Sec. 2 |",
            "| R3-C1 | R3 | short row |",
        ]) + "\n")
        findings = self.run_gate("ledger")
        self.assertEqual([(item["line"], item["message"]) for item in findings], [
            (4, "R1-C2 is still planned: make the change (or record accepted_limit with its reason) and update the row"),
            (5, "Duplicate comment_id R1-C2"),
            (6, "R2-C1 is marked done without a manuscript location"),
            (7, "R2-C2: status 'fixed' is not one of accepted_limit, blocked, done, drafted, not_applicable, open, "
                "partially_resolved, planned, resolved, unresolved"),
            (8, "Ledger row without a comment_id"),
            (9, "Ledger row width differs from its header"),
        ])

    def test_reads_the_ledger_where_ccfa_yaml_records_it_and_accepts_the_compact_template(self):
        self.write("ccfa.yaml", "revision_ledger: {path: responses/ledger.md}\n")
        self.write("responses/ledger.md", "| ID | Status | Action / location |\n| --- | --- | --- |\n| R1-C1 | resolved | Sec. 3 |\n")
        self.assertEqual(self.run_gate("ledger"), [])


CHECKS_HEAD = "Venue: NeurIPS 2026 main track\nOfficial rules: https://neurips.cc/Conferences/2026/CallForPapers\nChecked: 2026-09-24\n\n"
CHECKS_TABLE = "| Check | Status | Evidence | Fix |\n| --- | --- | --- | --- |\n"


class Submission(ProjectTest):
    def test_needs_a_record_with_its_rule_url_date_and_checklist(self):
        self.assertEqual(self.messages(self.run_gate("submission")), [
            "No submission check record yet: run ccf-submission-checker and write submission/checks.md"])
        self.write("submission/checks.md", "Notes only.\n")
        self.assertEqual(self.messages(self.run_gate("submission")), [
            "The submission record names no official rule URL (Official rules: <url>)",
            "The submission record has no check date (Checked: YYYY-MM-DD)",
            "The submission record holds no checklist table (Check | Status | Evidence | Fix)",
        ])
        self.write("submission/checks.md", CHECKS_HEAD + "| Item | Evidence |\n| --- | --- |\n| pages | 9 |\n")
        self.assertEqual(self.messages(self.run_gate("submission")), ["The submission checklist needs Check and Status columns"])
        self.write("submission/checks.md", CHECKS_HEAD + CHECKS_TABLE)
        self.assertEqual(self.messages(self.run_gate("submission")), ["The submission checklist has no rows"])

    def test_fails_are_errors_and_unverified_items_warnings(self):
        self.write("paper/main.tex", "x", age=-3600)
        self.write("submission/checks.md", CHECKS_HEAD + CHECKS_TABLE + "\n".join([
            "| Page limit | pass | 8.7 pages |  |",
            "| Anonymity | fail | author names on page 1 | remove the author block |",
            "| Fonts | fail | Type 3 fonts |  |",
            "| AI-use statement | not verified | form not seen |  |",
            "| Licence | maybe |  |  |",
            "| Short | pass |",
        ]) + "\n")
        findings = self.run_gate("submission")
        self.assertEqual(self.messages(findings), [
            "Submission check fails: Anonymity — remove the author block",
            "Submission check fails: Fonts — fix it and check again",
            "Licence: status 'maybe' is not pass, fail, not applicable or not verified",
            "Checklist row width differs from its header",
        ])
        self.assertEqual(self.messages(findings, "warning"), ["Not verified: AI-use statement"])

    def test_warns_when_the_manuscript_changed_after_the_checks(self):
        self.write("ccfa.yaml", "submission_checks: {path: submission/neurips.md}\n")
        self.write("submission/neurips.md", CHECKS_HEAD + CHECKS_TABLE + "| Page limit | pass | 8 pages |  |\n", age=-3600)
        self.write("paper/main.tex", "x", age=-7200)
        self.write("template/neurips/main.tex", "x")
        self.assertEqual(self.run_gate("submission"), [])
        self.write("paper/refs.bib", "")
        self.assertEqual(self.messages(self.run_gate("submission"), "warning"), [
            "The submission checks predate the latest manuscript changes: check the affected items again"])


class Privacy(ProjectTest):
    def test_finds_home_paths_in_the_sources_and_the_release_folders_only(self):
        self.write("paper/main.tex", f"\\graphicspath{{{{{HOME}/figs/}}}}\n")
        self.write("code/config.yaml", f"data: {HOME}\n")
        self.write("code/.venv/lib/site.py", f"'{HOME}'\n")
        self.write("ccfa-workfiles/writing/notes.md", f"{HOME}\n")
        self.write("template/x/main.tex", f"{HOME}\n")
        self.write("notes.md", f"{HOME}\n")
        findings = self.run_gate("privacy")
        self.assertEqual([(item["file"], item["line"]) for item in findings], [("code/config.yaml", 1), ("paper/main.tex", 1)])
        self.assertEqual(findings[0]["message"], "A local path (windows-user-home) would reveal the author: use a project-relative path")

    def test_a_clean_project_passes(self):
        self.write("paper/main.tex", "\\graphicspath{{../figures/}}\n")
        self.assertEqual(self.run_gate("privacy"), [])


class PlotRecipe(ProjectTest):
    SCRIPT = PACK / "scripts" / "plot_recipe.py"

    def test_lists_the_recipes_with_their_arguments(self):
        listing = json.loads(self.run_python(self.SCRIPT, "--list").stdout)
        self.assertEqual(len(listing["recipes"]), 10)
        self.assertIn("value_key", listing["recipes"]["lollipop_rank"]["arguments"])
        self.assertIn("ccfa", listing["palettes"])

    def test_draws_a_recipe_from_a_spec_file(self):
        self.write("figures/data/rank.json", json.dumps({
            "rows": [{"method": "Ours", "acc": 71.5}, {"method": "Base", "acc": 64.0}],
            "value_key": "acc", "label_key": "method", "title": "Accuracy", "palette": "npg",
        }))
        result = self.run_python(self.SCRIPT, "lollipop_rank", "--spec", "figures/data/rank.json", "--out", "figures/rank.svg", "--width", "600")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["palette"], "npg")
        svg = (self.root / "figures" / "rank.svg").read_text(encoding="utf-8")
        self.assertIn('width="600"', svg)
        self.assertIn("71.5", svg)

    def test_refuses_unknown_arguments_palettes_and_outputs(self):
        self.write("spec.json", json.dumps({"rows": [], "colour": "red"}))
        self.write("list.json", "[1]")
        for args, message in (
            (["lollipop_rank", "--spec", "spec.json", "--out", "x.svg"], "takes no argument(s) colour"),
            (["lollipop_rank", "--spec", "spec.json", "--out", "x.png"], "--out must be an .svg file"),
            (["lollipop_rank", "--spec", "list.json", "--out", "x.svg"], "the spec must be a JSON object"),
            (["nope", "--spec", "spec.json", "--out", "x.svg"], "give a recipe, --spec and --out"),
        ):
            result = self.run_python(self.SCRIPT, *args)
            self.assertEqual(result.returncode, 2)
            self.assertIn(message, result.stderr)
        self.write("spec.json", json.dumps({"rows": [], "value_key": "v", "label_key": "l", "title": "t", "palette": "neon"}))
        self.assertIn("unknown palette neon", self.run_python(self.SCRIPT, "lollipop_rank", "--spec", "spec.json", "--out", "x.svg").stderr)


class PdfToCard(ProjectTest):
    def test_extracts_a_card_skeleton_and_the_full_text_with_pypdfium2(self):
        from reportlab.pdfgen import canvas
        pdf = canvas.Canvas(str(self.root / "paper.pdf"))
        for line, text in enumerate(["Abstract We study sparse attention.", "1 Introduction", "3 Method", "4 Evaluation"]):
            pdf.drawString(72, 720 - 20 * line, text)
        pdf.showPage()
        pdf.drawString(72, 720, "Second page text")
        pdf.save()
        out = "ccfa-workfiles/exemplars/paper"
        result = self.run_python(PACK / "upstream" / "ccf-paper-to-exemplar" / "scripts" / "convert.py", "paper.pdf", "--venue", "neurips",
                                 "--output-dir", out, "--full-text", "--full-text-dir", f"{out}/cache")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        card = (self.root / out / "paper.md").read_text(encoding="utf-8")
        self.assertIn("Venue/year: NEURIPS.", card)
        self.assertIn("[ANALYZE]", card)
        self.assertIn("Sections: abstract + introduction + method + experiments", card)
        full = (self.root / out / "cache" / "paper.full.md").read_text(encoding="utf-8")
        self.assertIn("## Page 1", full)
        self.assertIn("## Page 2", full)
        self.assertIn("Second page text", full)


if __name__ == "__main__":
    unittest.main()
