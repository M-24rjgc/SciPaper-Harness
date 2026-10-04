/**
 * The windows-acl confinement runner: the argv-prefix wrapper the sandbox
 * seam spawns in place of the caller's command. It creates the
 * WRITE_RESTRICTED token with the workspace write-SID allowlist, spawns the
 * wrapped argv under it with the CALLER'S stdio inherited (bytes flow
 * straight through), mirrors the child's exit code, and revokes its temp
 * grant on exit (workspace ACEs stay standing as the reuse cache).
 *
 * Stable argv contract (the seam builds it; a native-exe replacement would
 * keep the same contract):
 *   [node, runner.js, '--workspace', <dir>, '--temp', <dir>,
 *    '--mode', <read-only|workspace-write>,
 *    ['--write-sid', <S-1-4-…>,
 *     '--temp-write-sid', <S-1-4-…>], '--', <argv...>]
 *
 * Modes:
 *  - workspace-write: the workspace and temp directories carry distinct
 *    capability-SID Write grants; other ACL-addressable writes are denied
 *    except for the documented Everyone and hard-link boundaries.
 *  - read-only: no capability-SID grants; the restricting list carries no
 *    capability SID, so a standing grant ACE from an earlier
 *    workspace-write period stays inert. BOTH modes drop Authenticated Users
 *    (CIM unavailable — documented in README) and INTERACTIVE/LOCAL (the
 *    Public tree writes are denied); the two lists share the keep-alive group
 *    (logon SID, EVERYONE) and differ only by the capabilities.
 *
 * `--write-sid` + `--temp-write-sid`: the seam's grant contract — the
 * CALLER has already materialized distinct workspace and private-temp ACEs
 * and owns their revocation, so the runner neither grants nor revokes
 * (`manageDacls: false`). Both values are checked against their owning paths.
 * Without the pair (standalone/agentless use), workspace-write treats
 * `--temp` as a ROOT, creates a random private child directory, derives its
 * own temp SID, and removes that directory after the child exits. In both
 * flows the runner rewrites TMP/TEMP in its OWN environment to the private
 * directory before spawning; the child inherits that block (`lpEnvironment`
 * NULL; an explicit block through koffi trips ERROR_INVALID_PARAMETER in
 * CreateProcessAsUserW, verified empirically). Read-only leaves the ambient
 * temp entries untouched (writes there are denied anyway).
 *
 * Failure contract: every runner-side failure (bad args, missing
 * directories, token/grant/spawn errors) prints `windows-acl-run: <detail>`
 * to stderr and exits 127 — the seam's RUNNER_FAILURE_RULES matches that
 * signature. The child is NEVER spawned unrestricted.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/runner
 */

import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD } from '@deepseek-ai/dsh-subprocess/control'
import { closeSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { allocUint32, decodePtrAt, decodeUint8At, decodeUint32, decodeUint32At, win32 } from './ffi.ts'
import type { Win32Bindings } from './ffi.ts'
import { AclSandbox, assertTempRootOutsideWorkspace } from './index.ts'
import { openCurrentProcessToken } from './token.ts'
import { TokenUser } from './win32-abi.ts'
import { tempWriteSid, workspaceWriteSid } from './workspace-sid.ts'

const RUNNER_SIGNATURE = 'windows-acl-run'
const RUNNER_FAILURE_EXIT = 127

class RunnerFailure extends Error {}

/** Print the runner-failure signature line and unwind. */
function fail(detail: string): never {
  process.stderr.write(`${RUNNER_SIGNATURE}: ${detail}\n`)
  throw new RunnerFailure(detail)
}

interface ParsedArgs {
  workspace: string
  temp: string
  mode: 'read-only' | 'workspace-write'
  writeSid: string | undefined
  tempWriteSid: string | undefined
  command: string
  args: string[]
}

interface OwnedDirectory {
  path: string
  dev: number
  ino: number
  birthtimeMs: number
}

/** Create one private directory and retain the identity required for safe removal. */
function createOwnedDirectory(prefix: string): OwnedDirectory {
  const path = mkdtempSync(prefix)
  const { dev, ino, birthtimeMs } = lstatSync(path)
  return { path, dev, ino, birthtimeMs }
}

/** Remove only the private directory this runner created; replaced objects are left untouched. */
function removeOwnedDirectory(directory: OwnedDirectory): void {
  const info = lstatSync(directory.path, { throwIfNoEntry: false })
  if (info !== undefined && info.isDirectory() && !info.isSymbolicLink()
    && info.dev === directory.dev && info.ino === directory.ino && info.birthtimeMs === directory.birthtimeMs) {
    rmSync(directory.path, { recursive: true })
  }
}

function parseArgs(raw: string[]): ParsedArgs {
  let workspace: string | undefined
  let temp: string | undefined
  let mode: string | undefined
  let writeSid: string | undefined
  let parsedTempWriteSid: string | undefined
  let index = 0
  for (; index < raw.length; index++) {
    const token = raw[index]
    if (token === '--') {
      index++
      break
    }
    index++
    const value = raw[index]
    if (value === undefined) fail(`missing value after ${token}`)
    switch (token) {
      case '--workspace': workspace = value; break
      case '--temp': temp = value; break
      case '--mode': mode = value; break
      case '--write-sid': writeSid = value; break
      case '--temp-write-sid': parsedTempWriteSid = value; break
      default: fail(`unknown argument: ${token}`)
    }
  }
  if (workspace === undefined) fail('missing --workspace')
  if (temp === undefined) fail('missing --temp')
  if (mode !== 'read-only' && mode !== 'workspace-write') fail(`unknown mode: ${String(mode)}`)
  const argv = raw.slice(index)
  const command = argv[0]
  if (command === undefined) fail('missing command after --')
  return { workspace, temp, mode, writeSid, tempWriteSid: parsedTempWriteSid, command, args: argv.slice(1) }
}

function requireDirectory(label: string, path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${label} is not an existing directory: ${path}`)
  }
}

/** The signed-in user's SID for private Python directory ownership, independently of the token's owner group. */
function currentUserSid(api: Win32Bindings): string {
  const token = openCurrentProcessToken(api)
  try {
    const needed = allocUint32()
    api.getTokenInformation(token, TokenUser, null, 0, needed)
    const bytes = decodeUint32(needed)
    if (bytes < 16) fail('GetTokenInformation TokenUser returned an invalid size')
    const info = Buffer.alloc(bytes)
    if (api.getTokenInformation(token, TokenUser, info, info.length, needed) === 0) {
      fail(`GetTokenInformation TokenUser failed (Win32 ${api.getLastError()})`)
    }
    const sid = decodePtrAt(info, 0)
    if (sid === null) fail('GetTokenInformation TokenUser returned no SID')
    const count = decodeUint8At(sid, 1)
    if (count > 15 || api.getLengthSid(sid) < 8 + count * 4) fail('GetTokenInformation TokenUser returned an invalid SID')
    let authority = 0
    for (let offset = 2; offset < 8; offset++) authority = authority * 256 + decodeUint8At(sid, offset)
    const parts = [`S-${decodeUint8At(sid, 0)}-${authority}`]
    for (let index = 0; index < count; index++) parts.push(String(decodeUint32At(sid, 8 + index * 4)))
    return parts.join('-')
  } finally {
    if (api.closeHandle(token) === 0) fail(`CloseHandle user token failed (Win32 ${api.getLastError()})`)
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  // Both directories are validated in both modes: a provider bug that passes
  // a bogus root must fail loudly at the runner boundary, never mid-child.
  requireDirectory('--workspace', parsed.workspace)
  requireDirectory('--temp', parsed.temp)

  const seamManaged = parsed.writeSid !== undefined || parsed.tempWriteSid !== undefined
  if (parsed.mode === 'read-only' && seamManaged) {
    fail('read-only does not accept --write-sid or --temp-write-sid')
  }
  if (parsed.mode === 'workspace-write' && (parsed.writeSid === undefined) !== (parsed.tempWriteSid === undefined)) {
    fail('workspace-write requires --write-sid and --temp-write-sid together')
  }
  if (parsed.mode === 'workspace-write') {
    assertTempRootOutsideWorkspace(parsed.workspace, parsed.temp)
  }

  const api = await win32()
  // Ignore this process's own CTRL+C: the confined child (same console) keeps
  // handling its own; the runner must survive to revoke grants and mirror the
  // child's exit code.
  if (api.setConsoleCtrlHandler(null, 1) === 0) {
    fail(`SetConsoleCtrlHandler failed (Win32 ${api.getLastError()})`)
  }

  let ownedTempDir: OwnedDirectory | undefined
  let pythonCompatibilityDir: OwnedDirectory | undefined
  let sandbox: AclSandbox | undefined
  let initialized = false
  try {
    let privateTempDir: string | null = null
    let writeSid: string | undefined
    let privateTempSid: string | undefined
    if (parsed.mode === 'workspace-write') {
      writeSid = workspaceWriteSid(parsed.workspace)
      if (seamManaged) {
        if (parsed.writeSid !== writeSid) fail('--write-sid does not match --workspace')
        privateTempDir = parsed.temp
        privateTempSid = tempWriteSid(privateTempDir)
        if (parsed.tempWriteSid !== privateTempSid) fail('--temp-write-sid does not match --temp')
      } else {
        ownedTempDir = createOwnedDirectory(join(parsed.temp, 'dsh-'))
        privateTempDir = ownedTempDir.path
        privateTempSid = tempWriteSid(privateTempDir)
      }
    }
    sandbox = new AclSandbox({
      writableDirs: parsed.mode === 'workspace-write' ? [parsed.workspace] : [],
      tempDir: privateTempDir,
      mode: parsed.mode,
      ...writeSid === undefined ? {} : { writeSid },
      ...privateTempSid === undefined ? {} : { tempWriteSid: privateTempSid },
      manageDacls: !seamManaged,
    })
    await sandbox.init()
    initialized = true

    if (privateTempDir !== null) {
      if (api.setEnvironmentVariableW('TMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TMP failed (Win32 ${api.getLastError()})`)
      }
      if (api.setEnvironmentVariableW('TEMP', privateTempDir) === 0) {
        fail(`SetEnvironmentVariableW TEMP failed (Win32 ${api.getLastError()})`)
      }
      pythonCompatibilityDir = createOwnedDirectory(join(privateTempDir, 'dsh-python-'))
      const source = fileURLToPath(new URL('../assets/python-compat/sitecustomize.py', import.meta.url))
      writeFileSync(join(pythonCompatibilityDir.path, 'sitecustomize.py'), readFileSync(source), { flag: 'wx', mode: 0o600 })
      const environment = {
        PYTHONPATH: [pythonCompatibilityDir.path, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
        PYTHONSAFEPATH: '1',
        DSH_PYTHON_RESTORE_PATH: process.env.PYTHONSAFEPATH ? '0' : '1',
        DSH_PYTHON_SANDBOX_USER_SID: currentUserSid(api),
        DSH_PYTHON_SANDBOX_ROOTS: JSON.stringify([
          [realpathSync.native(parsed.workspace), writeSid],
          [realpathSync.native(privateTempDir), privateTempSid],
        ]),
      }
      for (const [key, value] of Object.entries(environment)) {
        if (api.setEnvironmentVariableW(key, value) === 0) {
          fail(`SetEnvironmentVariableW ${key} failed (Win32 ${api.getLastError()})`)
        }
      }
    }

    const child = sandbox.spawn({
      command: parsed.command,
      args: parsed.args,
      stdio: 'inherit',
      ...process.env[SUBPROCESS_CONTROL_ENV] === 'pipe' ? { controlFileDescriptor: SUBPROCESS_CONTROL_FD } : {},
    })
    if (process.env[SUBPROCESS_CONTROL_ENV] === 'pipe') closeSync(SUBPROCESS_CONTROL_FD)
    const result = await child.wait()
    return result.exitCode
  } finally {
    // Cleanup failures must not mask the child's exit code: report and keep going.
    if (initialized) {
      try {
        sandbox?.dispose()
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    if (pythonCompatibilityDir !== undefined) {
      try {
        removeOwnedDirectory(pythonCompatibilityDir)
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    if (ownedTempDir !== undefined) {
      try {
        removeOwnedDirectory(ownedTempDir)
      } catch (error) {
        process.stderr.write(`${RUNNER_SIGNATURE}: cleanup: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
  }
}

main().then(
  (exitCode) => {
    // Exit-code mirroring is full-width on Windows, verified empirically on
    // this machine (Windows 11 build 26200, Node 24): a child that exits
    // with the NTSTATUS 0xC0000005 (STATUS_ACCESS_VIOLATION) is read back
    // by GetExitCodeProcess as the uint32 3221225477, and after
    // process.exitCode = 3221225477 the parent observes exactly
    // 3221225477 (spawnSync status). PowerShell's $LASTEXITCODE and cmd
    // print the signed view (-1073741819), but no truncation or masking
    // happens anywhere in the chain — the mirror contract holds for the
    // full 32-bit range, so no re-mapping is needed.
    process.exitCode = exitCode
  },
  (error: unknown) => {
    if (!(error instanceof RunnerFailure)) {
      process.stderr.write(`${RUNNER_SIGNATURE}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    process.exitCode = RUNNER_FAILURE_EXIT
  },
)
