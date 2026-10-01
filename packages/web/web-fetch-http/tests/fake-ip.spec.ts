import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID } from '@deepseek-ai/dsh-web-fetch-http'
import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'
import * as fetchPlugin from '@deepseek-ai/dsh-web-fetch-http'
import { isFakeIpAddress, publicHttpNetwork, resolvePublicAddresses } from '../src/network.ts'
import type { AddressResolver } from '../src/network.ts'

type Answer = { address: string; family: 4 | 6 }

/** What a TUN-mode fake-ip proxy answers for the DNS64 probe hostname, as measured on a Clash Verge host. */
const PROBE_ANSWER: Answer[] = [{ address: '198.18.1.27', family: 4 }, { address: '2001:2::115', family: 6 }]

/** A system resolver that answers from a fixed table the way a local fake-ip DNS server does. */
function fakeDns(table: Record<string, Answer[]>): AddressResolver {
  return async hostname => table[hostname] ?? (hostname === 'ipv4only.arpa' ? PROBE_ANSWER : [])
}

const signal = new AbortController().signal
const allow = { allowFakeIp: true }
const strict = { allowFakeIp: false }

const limits: HttpFetchLimits = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'test-agent/1.0',
  allowFakeIpDns: true,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fake-ip ranges', () => {
  it('covers exactly 198.18.0.0/15 and 2001:2::/48', () => {
    for (const address of [
      '198.18.0.0', '198.18.0.216', '198.19.255.255',
      '2001:2::', '2001:2::d1', '2001:2:0:ffff:ffff:ffff:ffff:ffff', '[2001:2::7e]',
    ]) {
      expect(isFakeIpAddress(address), address).toBe(true)
    }
    for (const address of [
      '198.17.255.255', '198.20.0.0', '8.8.8.8', '127.0.0.1', '10.0.0.1',
      '2001:2:1::', '2001:3::1', '2001:1::1', '2001:4860:4860::8888', '::1',
      // A proxy never produces a mapped address, so the mapped spelling is not a fake-ip answer.
      '::ffff:198.18.0.1',
      'not-an-ip',
    ]) {
      expect(isFakeIpAddress(address), address).toBe(false)
    }
  })
})

describe('resolving a fake-ip answer', () => {
  it('accepts a hostname whose every address is a fake IPv4 address', async () => {
    const resolver = fakeDns({ 'github.test': [{ address: '198.18.0.216', family: 4 }, { address: '198.19.0.2', family: 4 }] })

    await expect(resolvePublicAddresses('github.test', signal, resolver, allow)).resolves.toEqual([
      { address: '198.18.0.216', family: 4 },
      { address: '198.19.0.2', family: 4 },
    ])
  })

  it('accepts a hostname whose every address is a fake IPv6 address', async () => {
    const resolver = fakeDns({ 'arxiv.test': [{ address: '2001:2::7e', family: 6 }] })

    await expect(resolvePublicAddresses('arxiv.test', signal, resolver, allow))
      .resolves.toEqual([{ address: '2001:2::7e', family: 6 }])
  })

  it('accepts the dual-stack answer a fake-ip proxy gives', async () => {
    const resolver = fakeDns({
      'github.test': [{ address: '198.18.0.216', family: 4 }, { address: '2001:2::d1', family: 6 }],
    })

    await expect(resolvePublicAddresses('github.test', signal, resolver, allow)).resolves.toEqual([
      { address: '198.18.0.216', family: 4 },
      { address: '2001:2::d1', family: 6 },
    ])
  })

  it.each([
    ['a private IPv4 address', '10.0.0.5', 4],
    ['a loopback IPv4 address', '127.0.0.1', 4],
    ['a link-local IPv4 address', '169.254.169.254', 4],
    ['a public IPv4 address', '8.8.8.8', 4],
    ['a loopback IPv6 address', '::1', 6],
    ['a unique-local IPv6 address', 'fc00::1', 6],
  ] as const)('refuses an answer that mixes a fake-ip address with %s', async (_label, other, family) => {
    const resolver = fakeDns({ 'mixed.test': [{ address: '198.18.0.216', family: 4 }, { address: other, family }] })

    await expect(resolvePublicAddresses('mixed.test', signal, resolver, allow)).rejects.toThrow(expect.objectContaining({
      code: 'WEB_BLOCKED_URL',
      // A mixed answer is not what a fake-ip proxy produces, so the plain refusal applies.
      message: 'URL hostname "mixed.test" resolves to a non-public IP address',
    }))
  })

  it('refuses a mixed answer whichever address comes first', async () => {
    const resolver = fakeDns({ 'mixed.test': [{ address: '127.0.0.1', family: 4 }, { address: '198.18.0.216', family: 4 }] })

    await expect(resolvePublicAddresses('mixed.test', signal, resolver, allow))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it.each(['198.18.0.216', '198.19.255.255', '[2001:2::d1]', '2001:2::7e'])(
    'refuses the IP literal %s even when fake-ip answers are allowed',
    async (literal) => {
      const resolver = vi.fn(fakeDns({}))

      await expect(resolvePublicAddresses(literal, signal, resolver, allow)).rejects.toThrow(expect.objectContaining({
        code: 'WEB_BLOCKED_URL',
        // No DNS answer stands behind a literal, so the proxy explanation does not apply.
        message: `URL hostname "${literal}" resolves to a non-public IP address`,
      }))
      expect(resolver).not.toHaveBeenCalledWith(literal, expect.anything())
    },
  )

  it('names the likely cause and both remedies when fake-ip answers are not allowed', async () => {
    const resolver = fakeDns({ 'github.test': [{ address: '198.18.0.216', family: 4 }, { address: '2001:2::d1', family: 6 }] })

    for (const policy of [strict, undefined]) {
      const refusal = await resolvePublicAddresses('github.test', signal, resolver, policy).catch((error: unknown) => error)
      expect(refusal).toMatchObject({ code: 'WEB_BLOCKED_URL' })
      const message = (refusal as Error).message
      expect(message).toContain('URL hostname "github.test" resolves to a non-public IP address')
      expect(message).toContain('fake-ip proxy (Clash, mihomo, sing-box')
      expect(message).toContain('benchmarking-range address')
      expect(message).toContain('allowFakeIpDns')
      expect(message).toContain('HTTPS_PROXY')
    }
  })

  it('still checks every address of an ordinary answer', async () => {
    const resolver = fakeDns({ 'ok.test': [{ address: '8.8.8.8', family: 4 }], 'bad.test': [{ address: '10.0.0.1', family: 4 }] })

    await expect(resolvePublicAddresses('ok.test', signal, resolver, allow)).resolves.toEqual([{ address: '8.8.8.8', family: 4 }])
    await expect(resolvePublicAddresses('bad.test', signal, resolver, allow)).rejects.toThrow(expect.objectContaining({
      message: 'URL hostname "bad.test" resolves to a non-public IP address',
    }))
  })
})

describe('provider destination policy', () => {
  const dns = fakeDns({
    'github.test': [{ address: '198.18.0.216', family: 4 }, { address: '2001:2::d1', family: 6 }],
    'internal.test': [{ address: '198.18.0.216', family: 4 }, { address: '10.0.0.5', family: 4 }],
  })

  /** Run the real address policy over fake DNS and capture what the transport would pin. */
  function observe() {
    vi.spyOn(publicHttpNetwork, 'resolve')
      .mockImplementation((hostname, abort, _resolver, policy) => resolvePublicAddresses(hostname, abort, dns, policy))
    return vi.spyOn(publicHttpNetwork, 'request').mockResolvedValue({
      response: new Response('paper', { status: 200, headers: { 'content-type': 'text/plain' } }) as never,
      close: async () => {},
    })
  }

  it('fetches a fake-ip hostname through the proxy by pinning the fake addresses', async () => {
    const request = observe()

    const result = await new HttpFetchProvider(limits).fetch({ url: 'https://github.test/owner/repo' })

    expect(result).toMatchObject({ statusCode: 200, body: { kind: 'text', content: 'paper' } })
    expect(request).toHaveBeenCalledExactlyOnceWith(
      new URL('https://github.test/owner/repo'),
      [{ address: '198.18.0.216', family: 4 }, { address: '2001:2::d1', family: 6 }],
      expect.any(Object),
      expect.any(AbortSignal),
    )
  })

  it('refuses the same hostname and opens no connection when the option is off', async () => {
    const request = observe()

    await expect(new HttpFetchProvider({ ...limits, allowFakeIpDns: false }).fetch({ url: 'https://github.test/' }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_BLOCKED_URL',
        message: expect.stringContaining('set HTTPS_PROXY so the proxy resolves the name') as string,
      }))
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses a mixed answer even when the option is on', async () => {
    const request = observe()

    await expect(new HttpFetchProvider(limits).fetch({ url: 'https://internal.test/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    expect(request).not.toHaveBeenCalled()
  })

  it('refuses a fake-ip IP literal URL even when the option is on', async () => {
    const request = observe()

    await expect(new HttpFetchProvider(limits).fetch({ url: 'https://198.18.0.216/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    expect(request).not.toHaveBeenCalled()
  })

  it('hands the configured policy to the default resolver', async () => {
    const resolve = vi.spyOn(publicHttpNetwork, 'resolve').mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    vi.spyOn(publicHttpNetwork, 'request').mockImplementation(async () => ({
      response: new Response('ok', { headers: { 'content-type': 'text/plain' } }) as never,
      close: async () => {},
    }))

    await new HttpFetchProvider(limits).fetch({ url: 'https://example.test/' })
    await new HttpFetchProvider({ ...limits, allowFakeIpDns: false }).fetch({ url: 'https://example.test/' })

    expect(resolve.mock.calls.map(call => call[3])).toEqual([{ allowFakeIp: true }, { allowFakeIp: false }])
  })
})

describe('web-fetch-http plugin config', () => {
  async function mount(config: fetchPlugin.Config): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: LOCAL_FETCH_PROVIDER_ID })
    await ctx.plugin(fetchPlugin, config)
    vi.spyOn(publicHttpNetwork, 'resolve').mockImplementation((hostname, abort, _resolver, policy) =>
      resolvePublicAddresses(hostname, abort, fakeDns({ 'github.test': [{ address: '198.18.0.216', family: 4 }] }), policy))
    vi.spyOn(publicHttpNetwork, 'request').mockResolvedValue({
      response: new Response('page', { headers: { 'content-type': 'text/plain' } }) as never,
      close: async () => {},
    })
    return ctx
  }

  it('allows fake-ip answers by default', async () => {
    const ctx = await mount({})

    await expect(ctx.web.fetch({ url: 'https://github.test/' })).resolves.toMatchObject({ statusCode: 200 })
  })

  it('refuses them when allowFakeIpDns is false', async () => {
    const ctx = await mount({ allowFakeIpDns: false })

    await expect(ctx.web.fetch({ url: 'https://github.test/' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })
})
