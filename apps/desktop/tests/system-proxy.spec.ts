import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseSystemProxy, readWindowsProxyOverride, resolveDesktopSystemProxyConfig, translateWindowsBypassList,
  withDesktopSystemProxy,
  type DesktopSystemProxyConfig,
} from '../src/system-proxy.ts'

/** The bypass list Clash Verge writes to the Windows system proxy, measured on a real machine. */
const CLASH_OVERRIDE = 'localhost;127.*;192.168.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;'
  + '172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;<local>'

const enabled: DesktopSystemProxyConfig = { enabled: true, timeoutMs: 1_000 }
let directory: string
let homeEnvFile: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-system-proxy-'))
  homeEnvFile = join(directory, '.env')
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

/** Electron's `resolveProxy` answering one string for every URL, or one per scheme. */
function system(https: string, http: string = https) {
  return vi.fn(async (url: string) => url.startsWith('https:') ? https : http)
}

describe('resolveDesktopSystemProxyConfig', () => {
  it('follows the system proxy by default with a three-second deadline', () => {
    expect(resolveDesktopSystemProxyConfig({})).toEqual({ enabled: true, timeoutMs: 3_000 })
  })

  it('accepts auto, off, and a deadline override', () => {
    expect(resolveDesktopSystemProxyConfig({ DSH_DESKTOP_SYSTEM_PROXY: 'auto' }).enabled).toBe(true)
    expect(resolveDesktopSystemProxyConfig({ DSH_DESKTOP_SYSTEM_PROXY: 'off' }).enabled).toBe(false)
    expect(resolveDesktopSystemProxyConfig({ DSH_DESKTOP_SYSTEM_PROXY_TIMEOUT_MS: '8000' }).timeoutMs).toBe(8_000)
  })

  it.each(['on', '0', 'OFF', ''])('rejects the mode %j', (value) => {
    expect(() => resolveDesktopSystemProxyConfig({ DSH_DESKTOP_SYSTEM_PROXY: value }))
      .toThrow('DSH_DESKTOP_SYSTEM_PROXY must be "auto" or "off"')
  })

  it.each(['999', '1.5', 'soon', '2147483648'])('rejects the deadline %s', (value) => {
    expect(() => resolveDesktopSystemProxyConfig({ DSH_DESKTOP_SYSTEM_PROXY_TIMEOUT_MS: value }))
      .toThrow('DSH_DESKTOP_SYSTEM_PROXY_TIMEOUT_MS must be an integer from 1000 through 2147483647')
  })
})

describe('parseSystemProxy', () => {
  it.each([
    ['PROXY 127.0.0.1:7897', 'http://127.0.0.1:7897'],
    ['proxy proxy.corp.test:8080', 'http://proxy.corp.test:8080'],
    ['HTTP 10.0.0.2:3128', 'http://10.0.0.2:3128'],
    ['HTTPS secure-proxy.test:443', 'https://secure-proxy.test'],
    ['PROXY [::1]:8080', 'http://[::1]:8080'],
    ['  PROXY 127.0.0.1:7897 ; DIRECT', 'http://127.0.0.1:7897'],
    ['PROXY first:80; PROXY second:80', 'http://first'],
  ])('reads %j as the proxy %s', (result, url) => {
    expect(parseSystemProxy(result)).toEqual({ kind: 'proxy', url })
  })

  it.each(['DIRECT', 'direct', '', '  ', ';', 'DIRECT; PROXY 127.0.0.1:7897'])('reads %j as a direct connection', (result) => {
    expect(parseSystemProxy(result)).toEqual({ kind: 'direct' })
  })

  it.each([
    'SOCKS5 127.0.0.1:1080',
    'SOCKS 127.0.0.1:1080',
    'SOCKS4 127.0.0.1:1080',
    'QUIC proxy.test:443',
    'PROXY',
    'PROXY a:80 b:80',
    'PROXY :80',
    'PROXY proxy.test:80/path',
    'PROXY proxy.test:80?x=1',
    'PROXY proxy.test:80#x',
    'PROXY proxy.test:99999',
    'mystery',
  ])('reports %j as unsupported, never as a proxy', (result) => {
    expect(parseSystemProxy(result)).toEqual({ kind: 'unsupported', entry: result.trim() })
  })

  it('shortens an unsupported entry before it reaches a log line', () => {
    const choice = parseSystemProxy(`SOCKS5 ${'x'.repeat(200)}:1080`)
    expect(choice).toMatchObject({ kind: 'unsupported' })
    expect(choice.kind === 'unsupported' && choice.entry.length).toBe(80)
  })
})

describe('translateWindowsBypassList', () => {
  it('keeps host and suffix entries and counts the address ranges it cannot express', () => {
    expect(translateWindowsBypassList(CLASH_OVERRIDE)).toEqual({ entries: ['localhost'], dropped: 20 })
  })

  it('carries domains, ports, a bare address, and a bypass-all entry', () => {
    expect(translateWindowsBypassList('*.Corp.Example.com; .internal.test ;intranet.test:8080;192.168.1.5;;'))
      .toEqual({ entries: ['*.corp.example.com', '.internal.test', 'intranet.test:8080', '192.168.1.5'], dropped: 0 })
    expect(translateWindowsBypassList('*')).toEqual({ entries: ['*'], dropped: 0 })
  })

  it.each(['10.*', '<local>', '[::1]', 'http://*.example.com', 'exa*mple.com', 'a b.test', 'host:port'])('drops %j', (entry) => {
    expect(translateWindowsBypassList(entry)).toEqual({ entries: [], dropped: 1 })
  })
})

describe('readWindowsProxyOverride', () => {
  const reply = (type: string, value: string) =>
    `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    ProxyOverride    ${type}    ${value}\r\n\r\n`

  it('reads the value from the registry listing', async () => {
    const query = vi.fn(async () => reply('REG_SZ', CLASH_OVERRIDE))

    await expect(readWindowsProxyOverride(query)).resolves.toBe(CLASH_OVERRIDE)
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/System32[\\/]reg\.exe$/),
      ['query', String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`, '/v', 'ProxyOverride'],
    )
  })

  it('finds reg.exe under the system root, defaulting to C:\\Windows when none is set', async () => {
    const query = vi.fn(async (_executable: string, _args: readonly string[]) => reply('REG_SZ', 'localhost'))

    vi.stubEnv('SystemRoot', undefined)
    await readWindowsProxyOverride(query)
    vi.stubEnv('SystemRoot', 'D:\\Windows')
    await readWindowsProxyOverride(query)

    const [fallback, custom] = query.mock.calls.map(call => call[0])
    expect(fallback).toMatch(/^C:\\Windows[\\/]System32[\\/]reg\.exe$/)
    expect(custom).toMatch(/^D:\\Windows[\\/]System32[\\/]reg\.exe$/)
  })

  it('reads an expandable string value', async () => {
    await expect(readWindowsProxyOverride(async () => reply('REG_EXPAND_SZ', '*.corp.test'))).resolves.toBe('*.corp.test')
  })

  it('reports no list when the listing has no ProxyOverride line', async () => {
    await expect(readWindowsProxyOverride(async () => '\r\nHKEY_CURRENT_USER\\Software\r\n')).resolves.toBeUndefined()
  })

  it('treats exit code 1, a missing value, as no list and rethrows any other failure', async () => {
    await expect(readWindowsProxyOverride(async () => { throw Object.assign(new Error('missing'), { code: 1 }) }))
      .resolves.toBeUndefined()
    await expect(readWindowsProxyOverride(async () => { throw Object.assign(new Error('no reg.exe'), { code: 'ENOENT' }) }))
      .rejects.toThrow('no reg.exe')
  })

  it.runIf(process.platform === 'win32')('queries the real registry', async () => {
    const value = await readWindowsProxyOverride()
    expect(value === undefined || typeof value === 'string').toBe(true)
  })
})

describe('withDesktopSystemProxy', () => {
  it('leaves the environment alone when the setting is off, without asking the system', async () => {
    const resolveProxy = system('PROXY 127.0.0.1:7897')
    const base = { PATH: 'bin' }

    const result = await withDesktopSystemProxy(base, { config: { ...enabled, enabled: false }, homeEnvFile, resolveProxy })

    expect(result).toEqual({ environment: base, notices: [] })
    expect(result.environment).toBe(base)
    expect(resolveProxy).not.toHaveBeenCalled()
  })

  it.each([
    ['HTTPS_PROXY'], ['https_proxy'], ['HTTP_PROXY'], ['http_proxy'], ['ALL_PROXY'], ['all_proxy'], ['Https_Proxy'],
  ])('lets %s win over the system proxy', async (name) => {
    const resolveProxy = system('PROXY 127.0.0.1:7897')
    const base = { [name]: 'http://corp-proxy.test:3128', PATH: 'bin' }

    const result = await withDesktopSystemProxy(base, { config: enabled, homeEnvFile, resolveProxy })

    expect(result.environment).toBe(base)
    expect(result.notices).toEqual([])
    expect(resolveProxy).not.toHaveBeenCalled()
  })

  it('treats a blank proxy variable as unset', async () => {
    const result = await withDesktopSystemProxy({ HTTPS_PROXY: '   ', HTTP_PROXY: '' }, {
      config: enabled, homeEnvFile, resolveProxy: system('PROXY 127.0.0.1:7897'),
    })

    expect(result.environment.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(result.environment.HTTP_PROXY).toBe('http://127.0.0.1:7897')
  })

  it.each(['HTTPS_PROXY=http://127.0.0.1:7890', 'https_proxy=http://127.0.0.1:7890', 'ALL_PROXY=http://127.0.0.1:7890',
    '# note\nHTTP_PROXY="http://127.0.0.1:7890"'])('lets the Harness-home .env declare %j', async (line) => {
    writeFileSync(homeEnvFile, `${line}\nFOO=bar\n`)
    const resolveProxy = system('PROXY 127.0.0.1:7897')
    const base = { PATH: 'bin' }

    const result = await withDesktopSystemProxy(base, { config: enabled, homeEnvFile, resolveProxy })

    expect(result).toEqual({ environment: base, notices: [] })
    expect(resolveProxy).not.toHaveBeenCalled()
  })

  it('picks up the system proxy when the environment and .env name none', async () => {
    writeFileSync(homeEnvFile, 'DEEPSEEK_API_KEY=test\nNO_PROXY_NOTE=ignored\n')
    const resolveProxy = system('PROXY 127.0.0.1:7897')
    const base = { PATH: 'bin' }

    const { environment, notices } = await withDesktopSystemProxy(base, { config: enabled, homeEnvFile, resolveProxy })

    expect(environment).toEqual({
      PATH: 'bin',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      HTTP_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: 'localhost,127.0.0.1,::1,[::1]',
    })
    expect(base).toEqual({ PATH: 'bin' })
    expect(resolveProxy).toHaveBeenCalledWith('https://example.com/')
    expect(resolveProxy).toHaveBeenCalledWith('http://example.com/')
    expect(notices).toEqual([{
      level: 'info',
      message: 'desktop system proxy: the Host uses http://127.0.0.1:7897 from the operating system proxy settings',
    }])
  })

  it('works without a Harness-home .env', async () => {
    const result = await withDesktopSystemProxy({}, { config: enabled, homeEnvFile, resolveProxy: system('PROXY 127.0.0.1:7897') })

    expect(result.environment.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
  })

  it('routes http: only when the system proxies http: too', async () => {
    const { environment } = await withDesktopSystemProxy({}, {
      config: enabled, homeEnvFile, resolveProxy: system('PROXY 127.0.0.1:7897', 'DIRECT'),
    })

    expect(environment.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(environment).not.toHaveProperty('HTTP_PROXY')
  })

  it('carries a PAC answer that names an HTTPS proxy', async () => {
    const { environment } = await withDesktopSystemProxy({}, {
      config: enabled, homeEnvFile, resolveProxy: system('HTTPS secure.test:443; DIRECT', 'PROXY plain.test:8080; DIRECT'),
    })

    expect(environment).toMatchObject({ HTTPS_PROXY: 'https://secure.test', HTTP_PROXY: 'http://plain.test:8080' })
  })

  it.each([
    ['a direct answer', 'DIRECT', 'DIRECT', 0],
    ['a direct HTTPS answer beside a proxied HTTP one, which the Host would reuse for https:', 'DIRECT', 'PROXY 127.0.0.1:7897', 0],
    ['an empty answer', '', '', 0],
  ])('leaves the environment alone for %s', async (_label, https, http, noticeCount) => {
    const base = { PATH: 'bin' }

    const result = await withDesktopSystemProxy(base, { config: enabled, homeEnvFile, resolveProxy: system(https, http) })

    expect(result.environment).toBe(base)
    expect(result.notices).toHaveLength(noticeCount)
  })

  it('does not route a SOCKS system proxy and says so', async () => {
    const base = { PATH: 'bin' }

    const result = await withDesktopSystemProxy(base, { config: enabled, homeEnvFile, resolveProxy: system('SOCKS5 127.0.0.1:1080') })

    expect(result.environment).toBe(base)
    expect(result.notices).toEqual([{
      level: 'warn',
      message: 'desktop system proxy: "SOCKS5 127.0.0.1:1080" is not an HTTP proxy, which is the only kind the Host routes through; the Host connects directly',
    }])
  })

  it('falls back to a direct connection when the resolution fails', async () => {
    const base = { PATH: 'bin' }
    const rejected = await withDesktopSystemProxy(base, {
      config: enabled, homeEnvFile, resolveProxy: async () => { throw new Error('network service crashed') },
    })
    const thrown = await withDesktopSystemProxy(base, {
      config: enabled, homeEnvFile, resolveProxy: () => { throw new TypeError('resolveProxy is not a function') },
    })

    expect(rejected.environment).toBe(base)
    expect(rejected.notices).toEqual([{ level: 'warn', message: 'desktop system proxy: network service crashed; the Host connects directly' }])
    expect(thrown.environment).toBe(base)
    expect(thrown.notices[0]?.message).toContain('resolveProxy is not a function')
  })

  it('reports a failure that is not an Error by its text', async () => {
    const result = await withDesktopSystemProxy({}, {
      config: enabled, homeEnvFile,
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the case under test.
      resolveProxy: () => Promise.reject('placeholder'),
    })

    expect(result.notices).toEqual([{ level: 'warn', message: 'desktop system proxy: placeholder; the Host connects directly' }])
  })

  it('falls back to a direct connection when the resolution outlasts the deadline', async () => {
    const base = { PATH: 'bin' }

    const result = await withDesktopSystemProxy(base, {
      config: { enabled: true, timeoutMs: 20 }, homeEnvFile, resolveProxy: () => new Promise<string>(() => {}),
    })

    expect(result.environment).toBe(base)
    expect(result.notices).toEqual([{
      level: 'warn', message: 'desktop system proxy: resolving the proxy took longer than 20 ms; the Host connects directly',
    }])
  })

  it('keeps the user NO_PROXY, replaces every casing of the names it writes, and leaves other names alone', async () => {
    const base = { no_proxy: 'Corp.test,localhost', NO_PROXY: 'ignored.test', Http_Proxy: ' ', PATH: 'bin', NODE_USE_ENV_PROXY: '1' }

    const { environment } = await withDesktopSystemProxy(base, {
      config: enabled, homeEnvFile, resolveProxy: system('PROXY 127.0.0.1:7897'),
    })

    expect(environment).toEqual({
      PATH: 'bin',
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      HTTP_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: 'Corp.test,localhost,127.0.0.1,::1,[::1]',
    })
  })

  it('keeps the NO_PROXY the Harness-home .env declares', async () => {
    writeFileSync(homeEnvFile, 'NO_PROXY=lab.test\n')

    const { environment } = await withDesktopSystemProxy({}, {
      config: enabled, homeEnvFile, resolveProxy: system('PROXY 127.0.0.1:7897'),
    })

    expect(environment.NO_PROXY).toBe('lab.test,localhost,127.0.0.1,::1,[::1]')
  })

  it('adds the system bypass list and reports the entries it cannot express', async () => {
    const readBypassList = vi.fn(async () => CLASH_OVERRIDE)

    const { environment, notices } = await withDesktopSystemProxy({}, {
      config: enabled, homeEnvFile, resolveProxy: system('PROXY 127.0.0.1:7897'), readBypassList,
    })

    expect(environment.NO_PROXY).toBe('localhost,127.0.0.1,::1,[::1]')
    expect(notices).toEqual([{
      level: 'info',
      message: 'desktop system proxy: the Host uses http://127.0.0.1:7897 from the operating system proxy settings'
        + '; skipped bypass entries that NO_PROXY cannot express (address ranges, <local>): 20',
    }])
  })

  it('carries domain bypass entries once, after the user list', async () => {
    const { environment } = await withDesktopSystemProxy({ NO_PROXY: 'lab.test' }, {
      config: enabled, homeEnvFile, resolveProxy: system('PROXY 127.0.0.1:7897'),
      readBypassList: async () => '*.corp.test;LAB.test;localhost',
    })

    expect(environment.NO_PROXY).toBe('lab.test,localhost,127.0.0.1,::1,[::1],*.corp.test')
  })

  it('bypasses everything when the user or the system says so', async () => {
    const user = await withDesktopSystemProxy({ NO_PROXY: '*' }, {
      config: enabled, homeEnvFile, resolveProxy: system('PROXY 127.0.0.1:7897'),
    })
    const systemList = await withDesktopSystemProxy({}, {
      config: enabled, homeEnvFile, resolveProxy: system('PROXY 127.0.0.1:7897'), readBypassList: async () => '*',
    })

    expect(user.environment.NO_PROXY).toBe('*')
    expect(systemList.environment.NO_PROXY).toBe('*')
  })

  it('applies the proxy without a bypass list when there is none or it cannot be read', async () => {
    const none = await withDesktopSystemProxy({}, {
      config: enabled, homeEnvFile, resolveProxy: system('PROXY 127.0.0.1:7897'), readBypassList: async () => undefined,
    })
    const failed = await withDesktopSystemProxy({}, {
      config: enabled, homeEnvFile, resolveProxy: system('PROXY 127.0.0.1:7897'),
      readBypassList: async () => { throw new Error('reg.exe is blocked') },
    })

    expect(none.environment.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(none.notices.map(notice => notice.level)).toEqual(['info'])
    expect(failed.environment.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(failed.notices).toEqual([
      { level: 'warn', message: 'desktop system proxy: the system bypass list could not be read (reg.exe is blocked)' },
      expect.objectContaining({ level: 'info' }),
    ])
  })

  it('warns about an unreadable .env and still applies the proxy', async () => {
    mkdirSync(homeEnvFile)

    const { environment, notices } = await withDesktopSystemProxy({}, {
      config: enabled, homeEnvFile, resolveProxy: system('PROXY 127.0.0.1:7897'),
    })

    expect(environment.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(notices[0]).toMatchObject({ level: 'warn', message: expect.stringContaining(`${homeEnvFile} could not be read`) as string })
  })

  it('never puts a credential in a notice or in the proxy it hands over', async () => {
    const result = await withDesktopSystemProxy({}, {
      config: enabled, homeEnvFile, resolveProxy: system('PROXY user:secret@proxy.test:8080'),
    })

    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result.environment).toEqual({})
    expect(result.notices).toEqual([
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('"PROXY (address withheld)"') as string }),
    ])
  })
})
