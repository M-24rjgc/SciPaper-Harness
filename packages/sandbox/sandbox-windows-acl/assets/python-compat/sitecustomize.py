"""Preserve sandbox capabilities in CPython's protected 0o700 directories."""

import ctypes
import json
import os
import sys
from ctypes import wintypes


def _install():
    raw = os.environ.get("DSH_PYTHON_SANDBOX_ROOTS")
    if os.name != "nt" or not raw:
        return
    user = os.environ["DSH_PYTHON_SANDBOX_USER_SID"]

    roots = []
    for path, sid in json.loads(raw):
        canonical = os.path.normcase(os.path.realpath(path, strict=True))
        identity = os.stat(canonical)
        roots.append((canonical, sid, identity.st_dev, identity.st_ino))

    class SecurityAttributes(ctypes.Structure):
        _fields_ = [
            ("length", wintypes.DWORD),
            ("descriptor", wintypes.LPVOID),
            ("inherit", wintypes.BOOL),
        ]

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    convert = advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(wintypes.LPVOID), ctypes.POINTER(wintypes.DWORD)]
    convert.restype = wintypes.BOOL
    create = kernel.CreateDirectoryW
    create.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(SecurityAttributes)]
    create.restype = wintypes.BOOL
    free = kernel.LocalFree
    free.argtypes = [wintypes.LPVOID]
    free.restype = wintypes.LPVOID
    original = os.mkdir

    def mkdir(path, mode=0o777, *, dir_fd=None):
        if mode != 0o700 or dir_fd is not None:
            return original(path, mode, dir_fd=dir_fd)
        filesystem_path = os.fspath(path)
        absolute = os.path.abspath(os.fsdecode(filesystem_path))
        parent = os.path.normcase(os.path.realpath(os.path.dirname(absolute), strict=True))
        target = os.path.join(parent, os.path.basename(absolute))
        capability = None
        for root, sid, device, inode in roots:
            try:
                inside = os.path.commonpath((target, root)) == root
            except ValueError:
                inside = False
            if inside:
                current = os.stat(root)
                if (current.st_dev, current.st_ino) != (device, inode):
                    raise PermissionError("Sandbox directory identity changed", root)
                capability = sid
                break
        if capability is None:
            return original(filesystem_path, mode, dir_fd=dir_fd)
        sys.audit("os.mkdir", filesystem_path, mode, -1)
        # Keep user/owner/admin protection and add no capability except the directory's own root.
        sddl = ("D:P(D;CI;0x40;;;WD)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
                "(A;OICI;FA;;;OW)(A;OICI;FA;;;" + user + ")"
                "(A;OICI;0x13019f;;;" + capability + ")S:(ML;OICI;NW;;;LW)")
        descriptor = wintypes.LPVOID()
        if not convert(sddl, 1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
            if not create(target, ctypes.byref(attributes)):
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            free(descriptor)

    os.mkdir = mkdir
    # Safe startup resolves this packaged module before any module in the command's directory.
    # Restore ordinary script/module imports only after installing the compatibility function.
    explicit_safe_path = False
    for argument in getattr(sys, "orig_argv", [])[1:]:
        if not argument.startswith("-") or argument in ("-", "-c", "-m"):
            break
        if not argument.startswith(("--", "-X", "-W")) and "P" in argument:
            explicit_safe_path = True
    if (sys.flags.safe_path and not sys.flags.isolated and not explicit_safe_path
            and os.environ.get("DSH_PYTHON_RESTORE_PATH") == "1"):
        entry = sys.argv[0] if sys.argv else ""
        initial = os.path.dirname(os.path.abspath(entry)) if entry and not entry.startswith("-") else os.getcwd()
        if not sys.path or sys.path[0] != initial:
            sys.path.insert(0, initial)


_install()
