"""Tests for the spark-to-paper gate adapter (runtime/modes/spark-to-paper/gates/run_gate.py).

Run from packages/research/workbench with the platform Python:

    <platform-python> -m unittest tests/spark_gates_test.py -v

Each test builds a small project, runs one gate the way the research service does
(python -I -X utf8 run_gate.py <gate> --root <project>), and reads the findings line.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PACK = Path(__file__).resolve().parent.parent / "runtime" / "modes" / "spark-to-paper"
TEMPLATE = PACK / "upstream" / "ts-paper" / "templates" / "ts_iieta" / "template.json"


class GateTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="spark gate 中文 "))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def write(self, path, content):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")

    def gate(self, *args):
        result = subprocess.run(
            [sys.executable, "-I", "-X", "utf8", str(PACK / "gates" / "run_gate.py"), *args],
            capture_output=True, text=True, encoding="utf-8", cwd=self.root,
        )
        last = result.stdout.strip().splitlines()[-1]
        return result.returncode, json.loads(last)["findings"]

    def run_gate(self, name, *extra):
        code, findings = self.gate(name, "--root", str(self.root), *extra)
        self.assertEqual(code, 0)
        return findings

    def messages(self, findings, severity="error"):
        return [item["message"] for item in findings if item["severity"] == severity]


class Usage(GateTest):
    def test_rejects_an_unknown_gate_or_a_missing_root(self):
        for args in (["nope", "--root", "."], ["draft"], ["draft", "x", "y"]):
            code, findings = self.gate(*args)
            self.assertEqual(code, 2)
            self.assertIn("usage: run_gate.py", findings[0]["message"])

    def test_reports_an_unreadable_input_as_a_finding(self):
        self.write("template.json", "{broken")
        self.write("refs.bib", "@article{a, author={A}, title={T}, year={2020}, journal={J}}\n")
        findings = self.run_gate("citations", "--stage", "cite")
        self.assertEqual(len(findings), 1)
        self.assertRegex(findings[0]["message"], r"^The citations gate could not read the project: \S*JSONDecodeError")


class Plan(GateTest):
    def test_template_needs_a_template_and_passes_the_bundled_one(self):
        self.assertEqual(self.messages(self.run_gate("template")), ["No template.json in the project: apply a venue template before planning"])
        shutil.copytree(TEMPLATE.parent, self.root, dirs_exist_ok=True)
        self.assertEqual(self.run_gate("template"), [])

    def test_template_reports_a_spec_the_linter_rejects(self):
        self.write("template.json", {"name": "x"})
        self.assertTrue(self.messages(self.run_gate("template")))

    def test_blueprint_needs_a_blueprint_and_names_its_problems(self):
        self.assertEqual(self.messages(self.run_gate("blueprint")), ["No blueprint.json yet: write the plan (ts-paper-plan)"])
        self.write("blueprint.json", {"paper_title": "T", "contributions": ["a"], "sections": {"method": {"citation_types": ["WEIRD"]}}})
        findings = self.run_gate("blueprint")
        self.assertIn("No template.json: the blueprint was checked against the bundled Traitement du Signal template", self.messages(findings, "warning"))
        self.assertTrue(self.messages(findings))
        self.assertTrue(all(item["file"] == "blueprint.json" for item in findings if item["severity"] == "error"))


class Citations(GateTest):
    BIB = "@article{real,\n  author={A. Author},\n  title={Real},\n  year={2024},\n  journal={J},\n  doi={10.1/x}\n}\n@misc{stub,\n  title={Only a title}\n}\n"

    def test_needs_a_bibliography(self):
        self.assertEqual(self.messages(self.run_gate("citations")), ["No refs.bib yet: build the bibliography (ts-paper-cite)"])

    def test_cite_stage_checks_entries_and_the_floor_but_not_the_sections(self):
        shutil.copy(TEMPLATE, self.root / "template.json")
        self.write("refs.bib", self.BIB)
        errors = self.messages(self.run_gate("citations", "--stage", "cite"))
        self.assertTrue(any(message.startswith("stub is incomplete: missing") for message in errors))
        self.assertTrue(any("below the template floor of" in message for message in errors))
        self.assertFalse(any("never cited" in message for message in errors))

    def test_full_stage_checks_cites_in_every_natbib_form(self):
        self.write("refs.bib", self.BIB)
        self.write("sections/method.tex", "As shown \\citep[see][]{real} and \\citealp{ghost}.\n")
        errors = self.messages(self.run_gate("citations"))
        self.assertIn("\\cite{ghost} has no refs.bib entry", errors)
        self.assertIn("refs.bib entry stub is never cited: cite it where it supports a claim, or remove it", errors)
        self.assertFalse(any("entry real is never cited" in message for message in errors))


class Draft(GateTest):
    def test_needs_sections(self):
        self.assertEqual(self.messages(self.run_gate("draft")), ["No sections/*.tex yet: write the paper (ts-paper-write)"])

    def test_flags_invented_numbers_and_ai_tells_in_proposal_mode(self):
        shutil.copy(TEMPLATE, self.root / "template.json")
        self.write("sections/method.tex", "We reach 71.5\\% accuracy. It is worth noting that this plays a crucial role.\n")
        findings = self.run_gate("draft")
        rules = {item["message"].split(":")[0] for item in findings}
        self.assertIn("decimal_in_prose", rules)
        self.assertIn("ai_tell", rules)
        self.assertTrue(any(item.get("file") == "sections/method.tex" for item in findings))


class Story(GateTest):
    def test_needs_a_story_and_rejects_invented_results(self):
        self.assertEqual(self.messages(self.run_gate("story")), ["No story.json yet: build the story (ts-idea2story)"])
        self.write("story.json", {"title": "T", "abstract": "It improves by 30% overall", "problem_framing": "p", "gap_pattern": "g",
                                  "solution": "s", "method_skeleton": "too short", "innovation_claims": [], "experiments_plan": "e"})
        self.assertTrue(self.messages(self.run_gate("story")))


class Figures(GateTest):
    def test_vector_and_critique_pass_without_a_figure_stage(self):
        self.assertEqual(self.run_gate("vector"), [])
        self.assertEqual(self.run_gate("critique"), [])

    def test_vector_reports_missing_files_and_critique_the_manifest(self):
        self.write("figures/figures.manifest.json", {"figures": [
            {"label": "arch", "type": "architecture", "engine": "svg-native"},
            {"label": "flow", "type": "pipeline", "engine": "image-model", "critic_rounds": 1, "svg_redraw": True, "svg_rounds": 2},
        ]})
        vector = self.messages(self.run_gate("vector"))
        self.assertTrue(any(message.startswith("Figure has no file") for message in vector), vector)
        critique = self.messages(self.run_gate("critique"))
        self.assertTrue(any("engine 'svg-native' not allowed" in message for message in critique))
        self.assertTrue(any("critic_rounds < 2" in message for message in critique))
        self.assertTrue(any("svg_rounds=2 < 4" in message for message in critique))


if __name__ == "__main__":
    unittest.main()
