/**
 * Operating-system proxy for the Host. Node's `fetch` and the Host's proxy policy read only the
 * proxy environment variables, which a Start-menu or Dock launch never carries, so a user whose
 * proxy application changed the system proxy but exported nothing would have every request leave
 * directly. Electron's network stack resolves the system proxy (manual, PAC, auto-detect); this
 * module hands that answer to the Host as the standard variables.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv, promisify } from 'node:util'
import { resolveDurationMs } from './duration-env.ts'

/** Validated system-proxy settings. */
export interface DesktopSystemProxyConfig {
  /** Whether the Host follows the operating system proxy when the environment names none. */
  readonly enabled: boolean
  /** Deadline for each proxy resolution, in milliseconds. */
  readonly timeoutMs: number
}

/** What Electron's proxy resolution reported for one URL, reduced to what the Host can route. */
export type SystemProxyChoice =
  | { readonly kind: 'direct' }
  | { readonly kind: 'proxy'; readonly url: string }
  | { readonly kind: 'unsupported'; readonly entry: string }

/** A line for the Desktop console about what the proxy step did. */
export interface SystemProxyNotice {
  readonly level: 'info' | 'warn'
  readonly message: string
}

/** Inputs of {@link withDesktopSystemProxy}. */
export interface DesktopSystemProxyOptions {
  readonly config: DesktopSystemProxyConfig
  /** The Harness-home `.env`, which can declare a proxy for the Host and then takes precedence. */
  readonly homeEnvFile: string
  /** Electron's `session.defaultSession.resolveProxy`. */
  readonly resolveProxy: (url: string) => Promise<string>
  /** Reads the operating system's raw bypass list; omitted where the platform offers no reader. */
  readonly readBypassList?: (() => Promise<string | undefined>) | undefined
}

/** Result of {@link withDesktopSystemProxy}. */
export interface DesktopSystemProxyResult {
  /** `base`, or a copy of it carrying the system proxy; `base` itself is never modified. */
  readonly environment: NodeJS.ProcessEnv
  readonly notices: readonly SystemProxyNotice[]
}

/** Runs `reg.exe` with `args` and returns its standard output; rejects with the exit code on failure. */
export type RegistryQuery = (executable: string, args: readonly string[]) => Promise<string>

/** URLs asked of the system proxy. A PAC script sees only these, so they are ordinary public hosts. */
const HTTPS_PROBE = 'https://example.com/'
const HTTP_PROBE = 'http://example.com/'

/** Names whose presence, in either casing, means the user already chose how the Host reaches the network. */
const EXPLICIT_PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const

/** The names this module writes; every casing of them is replaced together. */
const WRITTEN_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'])

/** The entries `dsh-http-proxy` always adds to a bypass list, repeated so the injected value is complete by itself. */
const LOOPBACK_BYPASS = ['localhost', '127.0.0.1', '::1', '[::1]'] as const

/** Electron reports PAC-style entries; these three name proxies the Host's policy can route. */
const ROUTABLE_PROXY_PROTOCOLS = new Map([['PROXY', 'http:'], ['HTTP', 'http:'], ['HTTPS', 'https:']])

/** A bypass entry `dsh-http-proxy` can match: a host or domain suffix, optionally with a leading `*.` or `.` and a port. */
const MATCHABLE_BYPASS_ENTRY = /^(?:\*?\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/

const INTERNET_SETTINGS_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`

const execFileAsync = promisify(execFile)

/**
 * Resolve system-proxy settings.
 * @param env - Desktop process environment.
 * @returns `DSH_DESKTOP_SYSTEM_PROXY` (`auto`, the default, or `off`) and
 *   `DSH_DESKTOP_SYSTEM_PROXY_TIMEOUT_MS` (integer milliseconds from 1000 through 2147483647, default 3000).
 * @throws when either value is outside those forms.
 */
export function resolveDesktopSystemProxyConfig(env: NodeJS.ProcessEnv): DesktopSystemProxyConfig {
  const mode = env.DSH_DESKTOP_SYSTEM_PROXY ?? 'auto'
  if (mode !== 'auto' && mode !== 'off') throw new Error('DSH_DESKTOP_SYSTEM_PROXY must be "auto" or "off"')
  return { enabled: mode === 'auto', timeoutMs: resolveDurationMs(env, 'DSH_DESKTOP_SYSTEM_PROXY_TIMEOUT_MS', 3_000) }
}

/**
 * Reduce a PAC-style proxy list to the Host's one decision. The first entry decides: later entries
 * are fallbacks for a proxy that does not answer, which the Host's policy has no way to express, and
 * taking a later entry would route around the proxy the system listed first.
 *
 * @param result - Electron's answer, such as `PROXY 127.0.0.1:7897`, `DIRECT`, or `PROXY a:80; DIRECT`.
 * @returns the proxy URL (never carrying credentials), a direct connection, or the unsupported first entry.
 */
export function parseSystemProxy(result: string): SystemProxyChoice {
  const separator = result.indexOf(';')
  const first = (separator === -1 ? result : result.slice(0, separator)).trim()
  if (first === '' || first.toUpperCase() === 'DIRECT') return { kind: 'direct' }
  const kind = first.replace(/\s.*$/su, '')
  const address = first.slice(kind.length).trim()
  const protocol = ROUTABLE_PROXY_PROTOCOLS.get(kind.toUpperCase())
  const url = protocol === undefined || !/^\S+$/u.test(address) ? null : URL.parse(`${protocol}//${address}`)
  if (protocol === undefined || url === null || url.hostname === '' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    // An address carrying credentials is withheld, because the entry reaches a log line.
    return { kind: 'unsupported', entry: first.includes('@') ? `${kind} (address withheld)` : first.slice(0, 80) }
  }
  return { kind: 'proxy', url: `${protocol}//${url.host}` }
}

/**
 * Translate a Windows `ProxyOverride` list into entries `NO_PROXY` can carry.
 *
 * Windows lists address ranges as wildcards (`10.*`) and `<local>` for single-label hosts; the
 * Host's matcher knows only hosts and domain suffixes, so those entries are dropped and counted. An
 * entry without a leading `*.` also matches subdomains here, which is wider than Windows reads it.
 *
 * @param value - the raw `ProxyOverride` string, separated by semicolons.
 * @returns the entries to carry and how many were dropped.
 */
export function translateWindowsBypassList(value: string): { readonly entries: readonly string[]; readonly dropped: number } {
  const entries: string[] = []
  let dropped = 0
  for (const raw of value.split(';')) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*' || MATCHABLE_BYPASS_ENTRY.test(entry)) entries.push(entry)
    else dropped++
  }
  return { entries, dropped }
}

/**
 * Read the bypass list of the Windows system proxy.
 * @param query - runs `reg.exe`; replaced only by tests.
 * @returns the raw `ProxyOverride` value, or undefined when the user has none.
 * @throws when `reg.exe` cannot run.
 */
export async function readWindowsProxyOverride(query: RegistryQuery = runRegistryQuery): Promise<string | undefined> {
  const executable = join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'reg.exe')
  try {
    const stdout = await query(executable, ['query', INTERNET_SETTINGS_KEY, '/v', 'ProxyOverride'])
    return /^[ \t]*ProxyOverride[ \t]+REG_(?:EXPAND_)?SZ[ \t]+(.*?)[ \t\r]*$/m.exec(stdout)?.[1]
  } catch (error) {
    // `reg query` exits 1 when the value does not exist, which is the ordinary state of a system proxy with no exceptions.
    if ((error as { code?: unknown }).code === 1) return undefined
    throw error
  }
}

/**
 * Give the Host the operating system proxy when nothing else names one.
 *
 * The environment decides first: any of `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` (either casing,
 * non-blank) in `base` or in the Harness-home `.env` is the user's own choice and is left untouched.
 * Otherwise the HTTPS answer of the system decides: `HTTPS_PROXY` is set when it names an HTTP or
 * HTTPS proxy, and `HTTP_PROXY` only when the HTTP answer names one too, so an HTTP-only proxy never
 * becomes the Host's HTTPS route through the Host policy's fallback. A direct answer, a SOCKS or QUIC
 * answer (the Host routes neither), and a failed or slow resolution all leave `base` unchanged.
 * `NO_PROXY` becomes the user's own list, loopback, and the Windows bypass list where it is readable.
 *
 * @param base - environment the Host would otherwise receive.
 * @param options - settings, `.env` location, and the system readers.
 * @returns the Host environment and what to log. Never rejects.
 */
export async function withDesktopSystemProxy(
  base: NodeJS.ProcessEnv, options: DesktopSystemProxyOptions,
): Promise<DesktopSystemProxyResult> {
  const { config, homeEnvFile, resolveProxy, readBypassList } = options
  if (!config.enabled || declaresProxy(base)) return { environment: base, notices: [] }
  const notices: SystemProxyNotice[] = []
  const home = await readHomeEnvironment(homeEnvFile)
  if (home.warning !== undefined) notices.push({ level: 'warn', message: home.warning })
  if (declaresProxy(home.values)) return { environment: base, notices }

  let answers: readonly [string, string]
  try {
    answers = await Promise.all([
      withDeadline(resolveProxy(HTTPS_PROBE), config.timeoutMs),
      withDeadline(resolveProxy(HTTP_PROBE), config.timeoutMs),
    ])
  } catch (error) {
    notices.push({ level: 'warn', message: `desktop system proxy: ${messageOf(error)}; the Host connects directly` })
    return { environment: base, notices }
  }
  const https = parseSystemProxy(answers[0])
  const http = parseSystemProxy(answers[1])
  if (https.kind === 'unsupported') {
    notices.push({
      level: 'warn',
      message: `desktop system proxy: "${https.entry}" is not an HTTP proxy, which is the only kind the Host routes through; the Host connects directly`,
    })
  }
  if (https.kind !== 'proxy') return { environment: base, notices }

  const bypass = await readBypass(readBypassList, notices)
  const environment: NodeJS.ProcessEnv = { ...base }
  for (const name of Object.keys(environment)) {
    if (WRITTEN_NAMES.has(name.toUpperCase())) Reflect.deleteProperty(environment, name)
  }
  environment.HTTPS_PROXY = https.url
  if (http.kind === 'proxy') environment.HTTP_PROXY = http.url
  environment.NO_PROXY = mergeBypass(
    [envValue(base, 'NO_PROXY') ?? envValue(home.values, 'NO_PROXY') ?? '', ...LOOPBACK_BYPASS, ...bypass.entries],
  )
  notices.push({
    level: 'info',
    message: `desktop system proxy: the Host uses ${https.url} from the operating system proxy settings`
      + (bypass.dropped === 0 ? '' : `; skipped bypass entries that NO_PROXY cannot express (address ranges, <local>): ${bypass.dropped}`),
  })
  return { environment, notices }
}

/** Production {@link RegistryQuery}: `reg.exe` ships with every Windows installation. */
async function runRegistryQuery(executable: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(executable, [...args], { windowsHide: true, timeout: 5_000, encoding: 'utf8' })
  return stdout
}

/** Whether `env` names any proxy the user chose, in either casing. */
function declaresProxy(env: Readonly<Record<string, string | undefined>>): boolean {
  return EXPLICIT_PROXY_NAMES.some(name => envValue(env, name) !== undefined)
}

/**
 * Read one variable in the casing-insensitive way a Windows environment behaves, preferring the
 * lowercase spelling as the Host's policy does.
 *
 * @param env - the environment or `.env` entries to search.
 * @param name - the uppercase variable name.
 * @returns the trimmed first non-blank value, or undefined when none is set.
 */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const lower = name.toLowerCase()
  const spellings = Object.keys(env).filter(key => key.toUpperCase() === name)
    .sort((a, b) => Number(b === lower) - Number(a === lower))
  for (const key of spellings) {
    const value = env[key]?.trim()
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/** The Harness-home `.env` entries, or none plus a warning when the file exists and cannot be read. */
async function readHomeEnvironment(file: string): Promise<{ values: Record<string, string>; warning?: string }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { values: {} }
    return { values: {}, warning: `desktop system proxy: ${file} could not be read (${messageOf(error)})` }
  }
  return { values: parseEnv(text) as Record<string, string> }
}

/** The system bypass list, or nothing plus a warning when the platform reader fails. */
async function readBypass(
  read: (() => Promise<string | undefined>) | undefined, notices: SystemProxyNotice[],
): Promise<{ readonly entries: readonly string[]; readonly dropped: number }> {
  if (read === undefined) return { entries: [], dropped: 0 }
  try {
    const value = await read()
    return value === undefined ? { entries: [], dropped: 0 } : translateWindowsBypassList(value)
  } catch (error) {
    notices.push({ level: 'warn', message: `desktop system proxy: the system bypass list could not be read (${messageOf(error)})` })
    return { entries: [], dropped: 0 }
  }
}

/** Join bypass lists, keeping each entry once in first-seen order; a `*` entry already bypasses everything. */
function mergeBypass(lists: readonly string[]): string {
  const entries = lists.flatMap(list => list.split(/[,\s]+/)).filter(entry => entry !== '')
  if (entries.includes('*')) return '*'
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = entry.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).join(',')
}

/** Fail a proxy resolution that outlasts `timeoutMs`; PAC download and auto-detection can stall. */
async function withDeadline(resolution: Promise<string>, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`resolving the proxy took longer than ${timeoutMs} ms`)) }, timeoutMs)
  })
  try {
    return await Promise.race([resolution, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
