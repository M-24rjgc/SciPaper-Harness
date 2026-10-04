/** Native CPython temporary-file and offline-pip behavior under the Windows runner. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AclWriteGrant, workspaceWriteSid } from '../src/index.ts'

const python = process.env.DSH_RESEARCH_TEST_PYTHON ?? 'python'
const pythonAvailable = process.platform === 'win32'
  && spawnSync(python, ['-c', 'import pip'], { timeout: 5_000, stdio: 'ignore' }).status === 0
const runnerEntry = fileURLToPath(new URL('../src/runner.ts', import.meta.url))

describe.skipIf(!pythonAvailable)('windows-acl CPython', () => {
  it('emits one mkdir audit event with native arguments and honors audit-hook denial before protected creation', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-python-audit-ws-'))
    const temp = mkdtempSync(join(tmpdir(), 'dsh-python-audit-temp-'))
    const script = join(workspace, 'audit-probe.py')
    writeFileSync(script, [
      'import os, pathlib, sys',
      'root = pathlib.Path(sys.argv[1])',
      'blocked = root / "blocked"',
      'protected = root / "protected"',
      'ordinary = root / "ordinary"',
      'pathlike = root / "pathlike"',
      'class OncePath:',
      '    def __init__(self): self.calls = 0',
      '    def __fspath__(self):',
      '        self.calls += 1',
      '        assert self.calls == 1, "mkdir converted the supplied path more than once"',
      '        return str(pathlike)',
      'events = []',
      'def audit(event, args):',
      '    if event == "os.mkdir":',
      '        events.append(args)',
      '        if args[0] == str(blocked): raise PermissionError("synthetic mkdir audit denial")',
      'sys.addaudithook(audit)',
      'try: os.mkdir(blocked, 0o700)',
      'except PermissionError as error: assert str(error) == "synthetic mkdir audit denial"',
      'else: raise AssertionError("protected mkdir ignored the audit-hook denial")',
      'assert not blocked.exists()',
      'os.mkdir(protected, 0o700)',
      'os.mkdir(ordinary, 0o777)',
      'os.mkdir(OncePath(), 0o700)',
      'assert events == [(str(blocked), 0o700, -1), (str(protected), 0o700, -1), (str(ordinary), 0o777, -1), (str(pathlike), 0o700, -1)], events',
      'protected.rmdir(); ordinary.rmdir(); pathlike.rmdir()',
      'print("MKDIR-AUDIT: OK")',
    ].join('\n'))
    try {
      const result = spawnSync(process.execPath, [
        '--import', 'tsx/esm', runnerEntry,
        '--workspace', workspace, '--temp', temp, '--mode', 'workspace-write',
        '--', python, script, workspace,
      ], { timeout: 30_000, encoding: 'utf8' })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('MKDIR-AUDIT: OK')
      expect(existsSync(join(workspace, 'blocked'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true })
      rmSync(temp, { recursive: true })
    }
  }, 35_000)

  it('creates, closes, reopens and removes Python temporary files in granted directories', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-python-ws-'))
    const temp = mkdtempSync(join(tmpdir(), 'dsh-python-temp-'))
    const outside = mkdtempSync(join(tmpdir(), 'dsh-python-outside-'))
    const outsideGrant = AclWriteGrant.create(workspaceWriteSid(outside))
    outsideGrant.add(outside)
    const script = join(workspace, 'temp-probe.py')
    writeFileSync(script, [
      'import os, pathlib, tempfile, sys',
      'print("MKDIR: " + os.mkdir.__module__, flush=True)',
      'for directory in (None, sys.argv[1]):',
      '    with tempfile.TemporaryDirectory(dir=directory) as root:',
      '        path = pathlib.Path(root) / "test.txt"',
      '        path.write_text("first")',
      '        path.write_text("second")',
      '        assert path.read_text() == "second"',
      '        path.unlink()',
      '    fd, name = tempfile.mkstemp(dir=directory)',
      '    import os',
      '    os.close(fd)',
      '    pathlib.Path(name).write_text("reopened")',
      '    pathlib.Path(name).unlink()',
      'print("TEMPFILES: OK")',
      'for candidate in (pathlib.Path(sys.argv[2]) / "escaped.txt", pathlib.Path(sys.argv[2]) / "escaped-dir"):',
      '    try:',
      '        if candidate.suffix: candidate.write_text("escape")',
      '        else: os.mkdir(candidate, 0o700)',
      '    except PermissionError: pass',
      '    else: raise AssertionError("write escaped the workspace")',
      'print("OUTSIDE: DENIED")',
    ].join('\n'))
    try {
      const result = spawnSync(process.execPath, [
        '--import', 'tsx/esm', runnerEntry,
        '--workspace', workspace, '--temp', temp, '--mode', 'workspace-write',
        '--', python, script, workspace, outside,
      ], { timeout: 30_000, encoding: 'utf8' })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('TEMPFILES: OK')
      expect(result.stdout).toContain('OUTSIDE: DENIED')
      expect(existsSync(join(outside, 'escaped.txt'))).toBe(false)
      expect(existsSync(join(outside, 'escaped-dir'))).toBe(false)
      expect(readFileSync(script, 'utf8')).toContain('TEMPFILES: OK')
    } finally {
      rmSync(workspace, { recursive: true })
      rmSync(temp, { recursive: true })
      outsideGrant.dispose()
      rmSync(outside, { recursive: true })
    }
  }, 35_000)

  it('installs a local wheel with offline pip and ignores a workspace sitecustomize of the same name', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-python-pip-ws-'))
    const temp = mkdtempSync(join(tmpdir(), 'dsh-python-pip-temp-'))
    const script = join(workspace, 'pip-probe.py')
    writeFileSync(join(workspace, 'sitecustomize.py'), 'raise RuntimeError("workspace sitecustomize was selected")\n')
    writeFileSync(join(workspace, 'sibling.py'), 'value = 42\n')
    writeFileSync(script, [
      'import os, pathlib, subprocess, sys, zipfile',
      'import sibling',
      'assert sibling.value == 42',
      'root = pathlib.Path(sys.argv[1])',
      'wheel = root / "dsh_probe-1.0-py3-none-any.whl"',
      'with zipfile.ZipFile(wheel, "w") as archive:',
      '    archive.writestr("dsh_probe.py", "value = 73\\n")',
      '    archive.writestr("dsh_probe-1.0.dist-info/METADATA", "Metadata-Version: 2.1\\nName: dsh-probe\\nVersion: 1.0\\n")',
      '    archive.writestr("dsh_probe-1.0.dist-info/WHEEL", "Wheel-Version: 1.0\\nGenerator: dsh-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")',
      '    archive.writestr("dsh_probe-1.0.dist-info/RECORD", "")',
      'target = root / "installed"',
      'result = subprocess.run([sys.executable, "-m", "pip", "--isolated", "install", "--no-index", "--no-deps", "--no-cache-dir", "--disable-pip-version-check", "--target", str(target), str(wheel)], cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)',
      'assert result.returncode == 0, result.stdout',
      'sys.path.insert(0, str(target))',
      'import dsh_probe',
      'assert dsh_probe.value == 73',
      'print("OFFLINE-PIP: OK")',
    ].join('\n'))
    try {
      const result = spawnSync(process.execPath, [
        '--import', 'tsx/esm', runnerEntry,
        '--workspace', workspace, '--temp', temp, '--mode', 'workspace-write',
        '--', python, script, workspace,
      ], { timeout: 30_000, encoding: 'utf8' })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain('OFFLINE-PIP: OK')
      expect(readFileSync(join(workspace, 'installed', 'dsh_probe.py'), 'utf8')).toBe('value = 73\n')
    } finally {
      rmSync(workspace, { recursive: true })
      rmSync(temp, { recursive: true })
    }
  }, 35_000)
})
