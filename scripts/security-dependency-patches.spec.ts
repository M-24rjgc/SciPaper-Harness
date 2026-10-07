import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import extract from 'extract-zip'
import { strToU8, Zip, ZipPassThrough } from 'fflate'

const roots: string[] = []
const canCreateFileSymlink = await (async () => {
  const root = await mkdtemp(join(tmpdir(), 'scipaper-symlink-capability-'))
  try {
    await writeFile(join(root, 'target'), '')
    await symlink(join(root, 'target'), join(root, 'link'), 'file')
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')) return false
    throw error
  } finally {
    await rm(root, { recursive: true })
  }
})()
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true })
})

async function fixture(entries: { name: string; content: string; symlink?: boolean }[]) {
  const root = await mkdtemp(join(tmpdir(), 'scipaper-zip-security-'))
  roots.push(root)
  const output = join(root, 'output')
  await mkdir(output)
  const chunks: Uint8Array[] = []
  const zip = new Zip((error, data) => {
    if (error) throw error
    chunks.push(data)
  })
  for (const entry of entries) {
    const file = new ZipPassThrough(entry.name)
    file.os = 3
    file.attrs = (entry.symlink ? 0o120777 : 0o100644) << 16
    zip.add(file)
    file.push(strToU8(entry.content), true)
  }
  zip.end()
  const archive = join(root, 'fixture.zip')
  await writeFile(archive, Buffer.concat(chunks))
  return { root, output, archive }
}

describe('installed ZIP extraction security patch', () => {
  it.each(['../outside.txt', '../../outside.txt'])('rejects an escaping relative symlink target %s before creating the link', async (target) => {
    const { output, archive } = await fixture([{ name: 'link', content: target, symlink: true }])
    await expect(extract(archive, { dir: output })).rejects.toThrow('Out of bound path')
    await expect(lstat(join(output, 'link'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an absolute target and leaves the outside canary unchanged', async () => {
    const f = await fixture([])
    const outside = join(f.root, 'outside.txt')
    await writeFile(outside, 'original')
    const malicious = await fixture([{ name: 'link', content: outside, symlink: true }])
    await expect(extract(malicious.archive, { dir: malicious.output })).rejects.toThrow('Out of bound path')
    expect(await readFile(outside, 'utf8')).toBe('original')
  })

  it.skipIf(!canCreateFileSymlink)('refuses a regular entry whose final path is an existing outside symlink', async () => {
    const { root, output, archive } = await fixture([{ name: 'link', content: 'overwrite' }])
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'original')
    await symlink(outside, join(output, 'link'), 'file')
    await expect(extract(archive, { dir: output })).rejects.toThrow('Out of bound path')
    expect(await readFile(outside, 'utf8')).toBe('original')
  })

  it('does not create outside directories before rejecting a linked parent', async () => {
    const { root, output, archive } = await fixture([{ name: 'link/new/child.txt', content: 'overwrite' }])
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(output, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(extract(archive, { dir: output })).rejects.toThrow('Out of bound path')
    await expect(lstat(join(outside, 'new'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows an existing internal directory link without losing nested files', async () => {
    const { output, archive } = await fixture([{ name: 'link/nested/child.txt', content: 'inside' }])
    await mkdir(join(output, 'target'))
    await symlink(join(output, 'target'), join(output, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await extract(archive, { dir: output })
    expect(await readFile(join(output, 'target/nested/child.txt'), 'utf8')).toBe('inside')
  })

  it('accepts an internal directory target spelled through an alias of the extraction root', async () => {
    const { root, output, archive } = await fixture([{ name: 'link/nested/child.txt', content: 'inside' }])
    const alias = join(root, 'output-alias')
    await mkdir(join(output, 'target'))
    await symlink(output, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(join(alias, 'target'), join(output, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await extract(archive, { dir: alias })
    expect(await readFile(join(output, 'target/nested/child.txt'), 'utf8')).toBe('inside')
  })

  it('preserves nested files and overwrites ordinary files', async () => {
    const { output, archive } = await fixture([
      { name: 'nested/target.txt', content: 'before' },
      { name: 'nested/target.txt', content: 'after' },
    ])
    await extract(archive, { dir: output })
    expect(await readFile(join(output, 'nested/target.txt'), 'utf8')).toBe('after')
  })

  it.skipIf(!canCreateFileSymlink)('rejects an inside target that resolves through a dangling outside symlink', async () => {
    const { root, output, archive } = await fixture([{ name: 'alias', content: 'planted/child', symlink: true }])
    await symlink(join(root, 'missing-outside'), join(output, 'planted'), 'file')
    await expect(extract(archive, { dir: output })).rejects.toThrow('Out of bound path')
    await expect(lstat(join(output, 'alias'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(!canCreateFileSymlink)('refuses duplicate file entries that write through an earlier archived symlink', async () => {
    const { output, archive } = await fixture([
      { name: 'target.txt', content: 'original' },
      { name: 'alias', content: 'target.txt', symlink: true },
      { name: 'alias', content: 'overwrite' },
    ])
    await expect(extract(archive, { dir: output })).rejects.toThrow('Out of bound path')
    expect(await readFile(join(output, 'target.txt'), 'utf8')).toBe('original')
  })

  it.skipIf(process.platform === 'win32')('preserves macOS framework directory symlinks', async () => {
    const { output, archive } = await fixture([
      { name: 'Versions/A/Library', content: 'library' },
      { name: 'Versions/Current', content: 'A', symlink: true },
      { name: 'Library', content: 'Versions/Current/Library', symlink: true },
      { name: 'ordinary.txt', content: 'before' },
      { name: 'ordinary.txt', content: 'after' },
    ])
    await extract(archive, { dir: output })
    expect(await readFile(join(output, 'Library'), 'utf8')).toBe('library')
    expect((await lstat(join(output, 'Versions/Current'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(output, 'ordinary.txt'), 'utf8')).toBe('after')
  })

  it.skipIf(!canCreateFileSymlink)('preserves internal file symlinks, nested files and ordinary overwrites', async () => {
    const { output, archive } = await fixture([
      { name: 'nested/target.txt', content: 'before' },
      { name: 'nested/target.txt', content: 'after' },
      { name: 'alias', content: 'nested/target.txt', symlink: true },
    ])
    await extract(archive, { dir: output })
    expect(await readFile(join(output, 'alias'), 'utf8')).toBe('after')
    expect((await lstat(join(output, 'alias'))).isSymbolicLink()).toBe(true)
  })
})

interface HttpMessage {
  url?: string
  method?: string
  status?: number
  headers: Record<string, string>
}
interface CachePolicy {
  now(): number
  evaluateRequest(request: HttpMessage): { response?: { headers: Record<string, string> } }
  satisfiesWithoutRevalidation(request: HttpMessage): boolean
  useStaleWhileRevalidate(): boolean
  revalidatedPolicy(request: HttpMessage, response: HttpMessage): { modified: boolean }
  timeToLive(): number
  toObject(): object
}
interface CachePolicyConstructor {
  new(request: HttpMessage, response: HttpMessage, options?: { shared: boolean }): CachePolicy
  fromObject(value: object): CachePolicy
}
function cachePolicy(responseHeaders: Record<string, string>, shared = true, requestHeaders: Record<string, string> = {}) {
  const Policy = createRequire(import.meta.url)('http-cache-semantics') as CachePolicyConstructor
  const request: HttpMessage = { url: 'https://cache.test/item', method: 'GET', headers: { host: 'cache.test', ...requestHeaders } }
  const policy = new Policy(request, { status: 200, headers: responseHeaders }, { shared })
  const now = policy.now()
  policy.now = () => now + 1000
  return { Policy, policy, request: { ...request, headers: { host: 'cache.test', 'cache-control': 'max-stale=86400' } } }
}

describe('installed HTTP cache security patch', () => {
  it.each([
    { 'cache-control': 'max-age=0', 'set-cookie': 'session=another-user' },
    { 'cache-control': 'private, max-age=0' },
    { 'cache-control': 'no-store, max-age=0' },
    { 'cache-control': 'no-cache, max-age=0' },
    { 'cache-control': 'proxy-revalidate, max-age=0' },
  ])('does not let max-stale authorize a prohibited shared response %j', (response) => {
    const { Policy, policy, request } = cachePolicy(response)
    expect(policy.evaluateRequest(request).response).toBeUndefined()
    expect(policy.satisfiesWithoutRevalidation(request)).toBe(false)
    expect(Policy.fromObject(policy.toObject()).satisfiesWithoutRevalidation(request)).toBe(false)
  })

  it('does not reuse an authenticated response for a later anonymous request', () => {
    const { policy, request } = cachePolicy({ 'cache-control': 'max-age=0' }, true, { authorization: 'Bearer test-fixture' })
    expect(policy.evaluateRequest(request).response).toBeUndefined()
  })

  it('does not reuse a prohibited response through stale revalidation or error fallback', () => {
    const { policy, request } = cachePolicy({ 'cache-control': 'no-cache, max-age=0, stale-while-revalidate=600, stale-if-error=600' })
    expect(policy.useStaleWhileRevalidate()).toBe(false)
    expect(policy.timeToLive()).toBe(0)
    expect(policy.revalidatedPolicy(request, { status: 503, headers: {} }).modified).toBe(true)
  })

  it.each(['proxy-revalidate', 'must-revalidate'])('permits fresh %s content and refuses stale reuse', (directive) => {
    const { policy, request } = cachePolicy({ 'cache-control': `${directive}, max-age=60, stale-while-revalidate=600, stale-if-error=600` })
    expect(policy.satisfiesWithoutRevalidation(request)).toBe(true)
    expect(policy.timeToLive()).toBeGreaterThan(0)
    const now = policy.now()
    policy.now = () => now + 120000
    expect(policy.satisfiesWithoutRevalidation(request)).toBe(false)
    expect(policy.useStaleWhileRevalidate()).toBe(false)
    expect(policy.timeToLive()).toBe(0)
    expect(policy.revalidatedPolicy(request, { status: 503, headers: {} }).modified).toBe(true)
  })

  it('allows ordinary stale public content, explicit public cookies and personal private caches', () => {
    for (const [headers, shared] of [
      [{ 'cache-control': 'public, max-age=0' }, true],
      [{ 'cache-control': 'public, max-age=0', 'set-cookie': 'public=fixture' }, true],
      [{ 'cache-control': 'private, max-age=0' }, false],
    ] as const) {
      const { policy, request } = cachePolicy(headers, shared)
      expect(policy.satisfiesWithoutRevalidation(request)).toBe(true)
    }
  })
})

interface UuidFunction {
  (value: string, namespace: string, buffer?: Uint8Array, offset?: number): string | Uint8Array
}
interface UuidModule { v3: UuidFunction; v5: UuidFunction }

describe('installed UUID buffer bounds patch', () => {
  it.each(['v3', 'v5'] as const)('rejects %s writes outside the output buffer before modifying it', (method) => {
    const uuid = createRequire(import.meta.url)('uuid') as UuidModule
    for (const offset of [-1, 2, 16, 1.5]) {
      const buffer = new Uint8Array(8).fill(170)
      expect(() => uuid[method]('fixture', '6ba7b810-9dad-11d1-80b4-00c04fd430c8', buffer, offset)).toThrow(RangeError)
      expect([...buffer]).toEqual(Array(8).fill(170))
    }
  })

  it.each(['esm-node', 'esm-browser'] as const)('enforces the same bounds through the %s export face', async (face) => {
    const base = dirname(createRequire(import.meta.url).resolve('uuid/package.json'))
    for (const method of ['v3', 'v5']) {
      const uuid = await import(pathToFileURL(join(base, 'dist', face, `${method}.js`)).href) as { default: UuidFunction }
      const buffer = new Uint8Array(8).fill(170)
      expect(() => uuid.default('fixture', '6ba7b810-9dad-11d1-80b4-00c04fd430c8', buffer, 4)).toThrow(RangeError)
      expect([...buffer]).toEqual(Array(8).fill(170))
    }
  })

  it('retains valid UUID strings and exact sized buffer writes', () => {
    const uuid = createRequire(import.meta.url)('uuid') as UuidModule
    for (const method of ['v3', 'v5'] as const) {
      const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
      const value = uuid[method]('fixture', namespace)
      expect(typeof value).toBe('string')
      const buffer = new Uint8Array(20).fill(170)
      expect(uuid[method]('fixture', namespace, buffer, 4)).toBe(buffer)
      expect(Buffer.from(buffer.subarray(4)).toString('hex')).toBe(String(value).replaceAll('-', ''))
      expect([...buffer.subarray(0, 4)]).toEqual([170, 170, 170, 170])
    }
  })

  it('enforces the bounds in the published UMD bundle', () => {
    const base = dirname(createRequire(import.meta.url).resolve('uuid/package.json'))
    const uuid = createRequire(import.meta.url)(join(base, 'dist/umd/uuid.min.js')) as UuidModule
    for (const method of ['v3', 'v5'] as const) {
      expect(() => uuid[method]('fixture', '6ba7b810-9dad-11d1-80b4-00c04fd430c8', new Uint8Array(8), 4)).toThrow(RangeError)
    }
  })
})

interface SprintfModule { readonly sprintf: (format: string, ...values: (string | number)[]) => string }
describe('installed printf precision patch', () => {
  it.each(['src/sprintf.js', 'dist/sprintf.min.js'])('bounds precision and padding through %s without aborting formatting', (entry) => {
    const base = dirname(createRequire(import.meta.url).resolve('sprintf-js/package.json'))
    const { sprintf } = createRequire(import.meta.url)(join(base, entry)) as SprintfModule
    for (const type of ['f', 'e', 'g']) {
      const result = sprintf(`%.101${type}`, 1.25)
      expect(result.length).toBeLessThan(110)
      expect(result).toBe(sprintf(`%.100${type}`, 1.25))
    }
    expect(sprintf('%10001s', 'fixture')).toHaveLength(10000)
    expect(sprintf('%.0g', 1.25)).toBe(sprintf('%.1g', 1.25))
    expect(sprintf('%08.2f', 1.25)).toBe('00001.25')
    expect(sprintf('%.0f', 1.25)).toBe('1')
  })
})
