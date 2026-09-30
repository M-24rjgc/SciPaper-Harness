"""Keep native imports usable from deeply installed Windows Python payloads."""

import ntpath
import sys


def _extended_path(path):
    """Preserve import lookup while extending absolute Windows paths."""
    if path.startswith("\\\\?\\") or path.startswith("\\\\.\\"):
        return path
    normalized = ntpath.normpath(path)
    if normalized.startswith("\\\\"):
        return "\\\\?\\UNC\\" + normalized[2:]
    if len(path) > 2 and path[1] == ":" and path[2] in "\\/":
        return "\\\\?\\" + normalized
    return path


if sys.platform == "win32":
    sys.path[:] = [_extended_path(path) for path in sys.path]
