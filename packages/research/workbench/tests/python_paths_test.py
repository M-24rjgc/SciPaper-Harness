"""Regression coverage for the bundled interpreter's early import paths."""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch


BOOTSTRAP = Path(__file__).resolve().parents[1] / "runtime" / "_scipaper_python_paths.py"
SOURCE = compile(BOOTSTRAP.read_text(encoding="utf8"), str(BOOTSTRAP), "exec")


class PythonPathsTest(unittest.TestCase):
    def test_windows_native_import_paths_are_extended_without_changing_lookup(self):
        original = [
            r"C:\installed\Python\DLLs",
            "C:/installed/Python/Lib",
            r"\\server\share\Python\Lib",
            r"\\?\C:\installed\Python\Lib\site-packages",
            r"\\?\UNC\server\share\Python\Lib",
            r"\\.\device",
            "",
            "relative/site-packages",
            "C:relative",
            r"\root-relative",
            r"C:\installed\old\..\\Python\DLLs",
        ]
        expected = [
            r"\\?\C:\installed\Python\DLLs",
            r"\\?\C:\installed\Python\Lib",
            r"\\?\UNC\server\share\Python\Lib",
            *original[3:-1],
            r"\\?\C:\installed\Python\DLLs",
        ]
        with patch.object(sys, "platform", "win32"), patch.object(sys, "path", original.copy()):
            paths = sys.path
            exec(SOURCE, {})
            self.assertIs(sys.path, paths)
            self.assertEqual(sys.path, expected)
            exec(SOURCE, {})
            self.assertEqual(sys.path, expected)

    def test_non_windows_paths_remain_unchanged(self):
        paths = ["", "/usr/lib/python", "relative", "C:/foreign"]
        with patch.object(sys, "platform", "linux"), patch.object(sys, "path", paths.copy()):
            exec(SOURCE, {})
            self.assertEqual(sys.path, paths)


if __name__ == "__main__":
    unittest.main()
