"""Tests for the SVG figure scripts (runtime/figures): the upstream audit and the PDF export.

Run from packages/research/workbench with the platform Python (it has svglib, reportlab, pypdfium2):

    <platform-python> -m unittest tests/figures_test.py -v
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

FIGURES = Path(__file__).resolve().parent.parent / "runtime" / "figures"
MARKERS = """<svg xmlns="http://www.w3.org/2000/svg" width="480" height="260" viewBox="0 0 480 260">
  <style>text{font-family:'Times New Roman', serif;font-size:22px}</style>
  <defs>
    <marker id="ar" markerWidth="6.4" markerHeight="4.8" refX="6.1" refY="2.4" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0 0 L6.4 2.4 L0 4.8 Z" fill="context-stroke"/></marker>
    <marker id="dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4"><circle cx="5" cy="5" r="5"/></marker>
    <marker id="fixed" orient="45" markerWidth="4" markerHeight="4"><rect width="4" height="4"/></marker>
  </defs>
  <rect x="20" y="30" width="120" height="50" fill="#eef"/><text x="35" y="62">Input</text>
  <path d="M140 55 L324 55" stroke="#c00" stroke-width="2" marker-end="url(#ar)"/>
  <path d="m80 80 c0 120 320 120 320 6 z" fill="none" stroke="#333" marker-start="url(#dot)" marker-end="url(#ar)"/>
  <line x1="240" y1="240" x2="240" y2="140" stroke="#333" style="marker-end:url(#ar);stroke-width:2"/>
  <polyline points="20,240 120,200 200,240" fill="none" stroke="#333" marker-mid="url(#dot)" marker-end="url(#fixed)"/>
  <polygon points="300,200 340,240 260,240" fill="none" stroke="#333" marker-start="url(#missing)"/>
  <path d="M300 150 H340 V180 Q360 190 380 180 T420 180 S440 200 460 180 A10 10 0 0 1 470 170" fill="none" stroke="#333" marker-end="url(#ar)"/>
</svg>"""


class FigureScripts(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="figures 中文 "))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_script(self, name, *args):
        return subprocess.run([sys.executable, "-I", "-X", "utf8", str(FIGURES / name), *map(str, args)],
                              capture_output=True, text=True, encoding="utf-8")

    def test_the_audit_passes_its_own_selftest(self):
        result = self.run_script("audit_svg.py", "--selftest")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("selftest ok", result.stdout)

    def test_export_draws_markers_as_shapes_keeps_text_and_renders_previews(self):
        svg = self.root / "arch.svg"
        svg.write_text(MARKERS, encoding="utf-8")
        result = self.run_script("export_figure.py", svg, self.root / "out" / "arch.pdf", self.root / "previews", 900, 300)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout.strip().splitlines()[-1])
        # end; start + end; end; one mid + end; the missing marker is skipped; the end of the path using every command.
        self.assertEqual(report["markers"], 7)
        self.assertTrue(report["text"])
        self.assertEqual(report["images"], 0)
        self.assertEqual([Path(p).name for p in report["previews"]], ["arch.900.png", "arch.300.png"])
        self.assertTrue(all(Path(p).stat().st_size > 0 for p in report["previews"]))
        self.assertTrue((self.root / "out" / "arch.pdf").read_bytes().startswith(b"%PDF"))

    def test_export_reports_an_unreadable_svg(self):
        svg = self.root / "broken.svg"
        svg.write_text("<svg", encoding="utf-8")
        result = self.run_script("export_figure.py", svg, self.root / "broken.pdf", self.root / "previews")
        self.assertEqual(result.returncode, 1)
        self.assertIn("is not well-formed XML", json.loads(result.stdout)["error"])
        self.assertEqual(self.run_script("export_figure.py").returncode, 2)


if __name__ == "__main__":
    unittest.main()
