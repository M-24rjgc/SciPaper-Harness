/** Install a paired single-file helper through a configured OpenSSH alias. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, posix } from 'node:path'
import { gzipSync } from 'node:zlib'
import { planSshAuth, sshFailureFrom, SSH_HOST_PATTERN, type SshPasswordLookup } from '@deepseek-ai/dsh-ssh/auth'

const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_HELPER_BYTES = 8 * 1024 * 1024
const MAX_LSP_ARCHIVE_BYTES = 32 * 1024 * 1024

/** One workspace the remote helper can address. */
export interface RemoteWorkspaceRequest { host: string; path: string }

/**
 * How the setup commands authenticate. Without either field the host uses OpenSSH keys, agent or
 * configuration.
 */
export interface RemoteWorkspaceAuth {
  /** A password to verify before it is saved; it takes the place of a saved one. */
  password?: string
  /** Saved passwords; one saved for the host is used. */
  passwords?: SshPasswordLookup
}

/** Verified executable and canonical directory coordinates on an SSH host. */
export interface RemoteWorkspaceRuntime {
  node: string
  helper: string
  helperHash: string
  canonicalPath: string
  rg?: string
  typescriptLanguageServer: string
}

/** Validate SSH host and POSIX path before either reaches an SSH argument.
 * @param request - OpenSSH alias or `user@host[:port]`, and the proposed remote workspace path.
 */
export function validateRemoteWorkspace(request: RemoteWorkspaceRequest): void {
  if (!SSH_HOST_PATTERN.test(request.host)) throw new Error('SSH host must be an OpenSSH alias or user@host with an optional :port')
  if (!posix.isAbsolute(request.path) || /[\0\r\n]/u.test(request.path)) throw new Error('SSH workspace path must be an absolute POSIX path')
}

function quote(value: string): string {
  const apostrophe = '\u0027'
  return `${apostrophe}${value.replaceAll(apostrophe, `${apostrophe}\\${apostrophe}${apostrophe}`)}${apostrophe}`
}

/** Run one bounded noninteractive SSH command, optionally streaming an artifact into stdin.
 * @param host - OpenSSH host alias, or `user@host[:port]`.
 * @param command - fully quoted command for the remote shell.
 * @param input - optional artifact streamed to remote standard input.
 * @param timeoutMs - maximum command runtime in milliseconds.
 * @param auth - how to authenticate; keys, agent and ssh configuration when omitted.
 * @returns remote standard output without trailing whitespace.
 * @throws {SshFailure} when ssh reports a wrong password, an unreachable host or an untrusted host key; the
 * message is free of the password.
 */
export async function sshCommand(
  host: string, command: string, input?: Uint8Array, timeoutMs = 30_000, auth: RemoteWorkspaceAuth = {},
): Promise<string> {
  const plan = await planSshAuth(host, auth.passwords, auth.password)
  const child = spawn('ssh', [
    '-T', ...plan.options, '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    ...plan.destination, command,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...plan.env === undefined ? {} : { env: { ...process.env, ...plan.env } } })
  const chunks: Buffer[] = []
  const errors: Buffer[] = []
  let outputBytes = 0
  let errorBytes = 0
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
  const done = new Promise<string>((resolve, reject) => {
    child.once('error', reject)
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_RESPONSE_BYTES) child.kill('SIGTERM')
      else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length
      if (errorBytes <= MAX_RESPONSE_BYTES) errors.push(chunk)
    })
    child.once('close', (code) => {
      if (timedOut) { reject(new Error(`SSH command timed out after ${timeoutMs} ms`)); return }
      if (outputBytes > MAX_RESPONSE_BYTES) reject(new Error('SSH setup returned too much output'))
      else if (code !== 0) {
        const text = plan.redact(Buffer.concat(errors).toString('utf8').trim())
        reject(sshFailureFrom(text, new Error(`SSH setup failed (exit ${String(code)}): ${text}`)))
      } else resolve(Buffer.concat(chunks).toString('utf8').trim())
    })
  })
  child.stdin.on('error', () => { /* A failed remote command may close its input before upload completes. */ })
  child.stdin.end(input)
  try { return await done } finally { clearTimeout(timeout) }
}

const DISCOVER_NODE = 'process.stdout.write(JSON.stringify({node:process.execPath,major:Number(process.versions.node.split(".")[0])}))'

const INSTALL_HELPER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
(async () => {
  const digest = process.argv[1];
  const workspace = process.argv[2];
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home) || !path.isAbsolute(workspace)) throw Error('absolute home and workspace paths required');
  const canonicalPath = fs.realpathSync(workspace);
  if (!fs.statSync(canonicalPath).isDirectory()) throw Error('SSH workspace is not a directory');
  fs.accessSync(canonicalPath, fs.constants.R_OK | fs.constants.X_OK);
  const root = path.join(home, '.scipaper-harness');
  const dir = path.join(root, 'ssh-helper', digest);
  for (const current of [root, path.dirname(dir), dir]) {
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw Error('SSH helper directory must be private and owned by the login user');
  }
  const helper = path.join(dir, 'helper.mjs');
  const temporary = path.join(dir, '.upload-' + crypto.randomUUID());
  const stream = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > ${MAX_HELPER_BYTES}) throw Error('SSH helper artifact exceeds size limit');
      hash.update(chunk);
      if (!stream.write(chunk)) await new Promise(resolve => stream.once('drain', resolve));
    }
    await new Promise((resolve, reject) => { stream.once('error', reject); stream.end(resolve); });
    if (hash.digest('hex') !== digest) throw Error('SSH helper upload digest mismatch');
    if (fs.existsSync(helper) && fs.lstatSync(helper).isSymbolicLink()) throw Error('SSH helper target is a symlink');
    fs.chmodSync(temporary, 0o500);
    fs.renameSync(temporary, helper);
    const installed = crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex');
    if (installed !== digest) throw Error('SSH helper installed digest mismatch');
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  const executable = name => {
    for (const folder of (process.env.PATH || '').split(path.delimiter)) {
      if (!folder || !path.isAbsolute(folder)) continue;
      const found = path.join(folder, name);
      try { fs.accessSync(found, fs.constants.X_OK); if (fs.statSync(found).isFile()) return fs.realpathSync(found); } catch {}
    }
  };
  process.stdout.write(JSON.stringify({helper,canonicalPath,rg:executable('rg')}));
})().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
`

/** Private, content-addressed installation of the paired TypeScript language server. */
const INSTALL_LSP = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
(async () => {
  const digest = process.argv[1];
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home) || !/^[0-9a-f]{64}$/.test(digest)) throw Error('invalid LSP destination');
  const root = path.join(home, '.scipaper-harness');
  const parent = path.join(root, 'ssh-lsp');
  for (const current of [root, parent]) {
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw Error('SSH LSP directory must be private and owned by the login user');
  }
  const chunks = [];
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > ${MAX_LSP_ARCHIVE_BYTES}) throw Error('SSH LSP archive exceeds size limit');
    chunks.push(chunk);
    hash.update(chunk);
  }
  if (hash.digest('hex') !== digest) throw Error('SSH LSP archive digest mismatch');
  const json = zlib.gunzipSync(Buffer.concat(chunks), { maxOutputLength: 80 * 1024 * 1024 });
  const entries = JSON.parse(json.toString('utf8'));
  if (!Array.isArray(entries) || entries.length < 3 || entries.length > 256) throw Error('invalid SSH LSP archive');
  const files = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') throw Error('invalid SSH LSP entry');
    if (!/^(?:typescript-language-server|typescript)\/(?:package\.json|LICENSE(?:\.txt)?|ThirdPartyNoticeText\.txt|lib\/[A-Za-z0-9_.-]+)$/.test(entry[0]) || files.has(entry[0])) throw Error('invalid SSH LSP path');
    files.set(entry[0], Buffer.from(entry[1], 'base64'));
  }
  for (const required of ['typescript-language-server/lib/cli.mjs', 'typescript/package.json', 'typescript/lib/tsserver.js', 'typescript/lib/_tsserver.js', 'typescript/lib/typescript.js']) {
    if (!files.has(required)) throw Error('incomplete SSH LSP archive');
  }
  const target = path.join(parent, digest);
  const temporary = path.join(parent, '.upload-' + crypto.randomUUID());
  const manifest = [];
  try {
    fs.mkdirSync(temporary, { mode: 0o700 });
    for (const [relative, content] of files) {
      const output = path.join(temporary, 'node_modules', relative);
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      fs.writeFileSync(output, content, { flag: 'wx', mode: 0o500 });
      manifest.push([relative, crypto.createHash('sha256').update(content).digest('hex')]);
    }
    fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify({ digest, manifest }), { flag: 'wx', mode: 0o400 });
    if (!fs.existsSync(target)) {
      try { fs.renameSync(temporary, target); } catch (error) { if (!fs.existsSync(target)) throw error; }
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true });
  }
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw Error('SSH LSP installation is not private');
  const installed = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
  if (installed.digest !== digest || JSON.stringify(installed.manifest) !== JSON.stringify(manifest)) throw Error('SSH LSP manifest mismatch');
  for (const [relative, expected] of manifest) {
    const file = path.join(target, 'node_modules', relative);
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) throw Error('SSH LSP file verification failed: ' + relative);
  }
  process.stdout.write(JSON.stringify({typescriptLanguageServer:path.join(target, 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs')}));
})().catch(error => { process.stderr.write(String(error.stack || error)); process.exitCode = 1; });
`

/** Build an offline archive from release dependencies, with no remote package-manager dependency.
 * @returns compressed archive bytes and their SHA-256 digest.
 */
export async function buildRemoteLspArchive(): Promise<{ bytes: Buffer; hash: string }> {
  const languageServer = dirname(fileURLToPath(import.meta.resolve('typescript-language-server/package.json')))
  const typescript = dirname(fileURLToPath(import.meta.resolve('typescript/package.json')))
  const entries: Array<[string, string]> = []
  const add = async (name: string, file: string) => { entries.push([name, (await readFile(file)).toString('base64')]) }
  await add('typescript-language-server/package.json', join(languageServer, 'package.json'))
  await add('typescript-language-server/LICENSE', join(languageServer, 'LICENSE'))
  await add('typescript-language-server/lib/cli.mjs', join(languageServer, 'lib', 'cli.mjs'))
  for (const name of ['package.json', 'LICENSE.txt', 'ThirdPartyNoticeText.txt']) {
    await add(`typescript/${name}`, join(typescript, name))
  }
  const lib = join(typescript, 'lib')
  for (const item of (await readdir(lib, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.isFile() && /^[A-Za-z0-9_.-]+$/u.test(item.name)) await add(`typescript/lib/${item.name}`, join(lib, item.name))
  }
  const bytes = gzipSync(Buffer.from(JSON.stringify(entries)), { level: 6 })
  if (bytes.length > MAX_LSP_ARCHIVE_BYTES) throw new Error('Bundled SSH LSP exceeds the upload size limit')
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') }
}

function parseObject(text: string, operation: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error(`${operation} returned invalid JSON`) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${operation} returned invalid coordinates`)
  return value as Record<string, unknown>
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || /[\0\r\n]/u.test(value)) throw new Error(`${label} is not an absolute POSIX path`)
  return value
}

/** Upload the local release helper and validate the remote directory before preset registration.
 * @param request - host and remote workspace path.
 * @param auth - how to authenticate; keys, agent and ssh configuration when omitted.
 * @returns verified remote helper, language server, and canonical workspace paths.
 */
export async function provisionRemoteWorkspace(
  request: RemoteWorkspaceRequest, auth: RemoteWorkspaceAuth = {},
): Promise<RemoteWorkspaceRuntime> {
  validateRemoteWorkspace(request)
  const helperBytes = await readFile(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-ssh/helper')))
  if (helperBytes.length > MAX_HELPER_BYTES) throw new Error('Bundled SSH helper exceeds the upload size limit')
  const helperHash = createHash('sha256').update(helperBytes).digest('hex')
  const nodeFacts = parseObject(await sshCommand(request.host, `node --disable-sigusr1 -e ${quote(DISCOVER_NODE)}`, undefined, undefined, auth), 'SSH Node discovery')
  const node = absolutePath(nodeFacts.node, 'Remote Node executable')
  if (typeof nodeFacts.major !== 'number' || nodeFacts.major < 22) throw new Error('SSH host needs Node.js 22 or newer')
  const installed = parseObject(await sshCommand(request.host,
    `${quote(node)} --disable-sigusr1 -e ${quote(INSTALL_HELPER)} ${quote(helperHash)} ${quote(request.path)}`,
    helperBytes, undefined, auth), 'SSH helper installation')
  const archive = await buildRemoteLspArchive()
  const lsp = parseObject(await sshCommand(request.host,
    `${quote(node)} --disable-sigusr1 -e ${quote(INSTALL_LSP)} ${quote(archive.hash)}`,
    archive.bytes, 120_000, auth), 'SSH LSP installation')
  return {
    node,
    helper: absolutePath(installed.helper, 'Installed SSH helper'),
    helperHash,
    canonicalPath: absolutePath(installed.canonicalPath, 'SSH workspace'),
    ...installed.rg === undefined ? {} : { rg: absolutePath(installed.rg, 'Remote ripgrep') },
    typescriptLanguageServer: absolutePath(lsp.typescriptLanguageServer, 'Remote TypeScript language server'),
  }
}
