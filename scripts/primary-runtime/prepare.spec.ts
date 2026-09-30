import { readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { zipSync } from 'fflate'
import { expect, it } from 'vitest'
import {
  downloadPrimaryRuntimeAsset, prepareOfficeSkillAssets, preparePrimaryRuntimePythonPaths,
  primaryRuntimePayloadDigest, smokePrimaryRuntime, unpackPrimaryRuntimeWheel,
} from './prepare.ts'
import lock from './lock.json' with { type: 'json' }
import { removeOwnedDirectory } from '../../apps/desktop/src/owned-directory.ts'

it('covers every SDK wheel target with the shared interpreter lock', () => {
  const platforms = JSON.parse(readFileSync(new URL('../../python/sdk-runtime/platforms.json', import.meta.url), 'utf8')) as Record<string, unknown>
  expect(Object.keys(lock.targets).sort()).toEqual(Object.keys(platforms).map(target => target.replace('macos-', 'mac-')).sort())
})

const libraryWheel = Buffer.from('UEsDBAoAAAAAAASeLl0sYMPjDAAAAAwAAAAJAAAAc2FtcGxlLnB5c2FtcGxlID0gNDIKUEsBAh4DCgAAAAAABJ4uXSxgw+MMAAAADAAAAAkAAAAAAAAAAQAAAKSBAAAAAHNhbXBsZS5weVBLBQYAAAAAAQABADcAAAAzAAAAAAA=', 'base64')
const relocatedWheel = Buffer.from('UEsDBAoAAAAAAASeLl3x0Nj9FAAAABQAAAAeAAAAc2FtcGxlLTEuMC5kYXRhL3NjcmlwdHMvc2FtcGxlcmVxdWlyZXMgcmVsb2NhdGlvbgpQSwECHgMKAAAAAAAEni5d8dDY/RQAAAAUAAAAHgAAAAAAAAABAAAApIEAAAAAc2FtcGxlLTEuMC5kYXRhL3NjcmlwdHMvc2FtcGxlUEsFBgAAAAABAAEATAAAAFAAAAAAAA==', 'base64')
const externalLibraryWheel = Buffer.from('UEsDBBQAAAAAAAAAIVyBOE8OHAAAABwAAAAhAAAAc2FtcGxlLTEuMC5kYXRhL3B1cmVsaWIvc2FtcGxlLnB5cmVxdWlyZXMgbGlicmFyeSByZWxvY2F0aW9uClBLAQIUAxQAAAAAAAAAIVyBOE8OHAAAABwAAAAhAAAAAAAAAAAAAACAAQAAAABzYW1wbGUtMS4wLmRhdGEvcHVyZWxpYi9zYW1wbGUucHlQSwUGAAAAAAEAAQBPAAAAWwAAAAAA', 'base64')

it.each(Object.entries(lock.targets))('records every locked wheel distribution and version for %s', (_target, artifact) => {
  const normalize = (name: string): string => name.toLowerCase().replace(/[-_.]+/gu, '-')
  const distributions = [...artifact.wheels, ...lock.wheels].map(({ url }) => {
    const [name, version] = basename(new URL(url).pathname).split('-')
    return [normalize(name!), version] as const
  })
  const declared = Object.entries(lock.pythonPackages).map(([name, version]) => [normalize(name), version] as const)
  expect(new Set(distributions.map(([name]) => name)).size).toBe(distributions.length)
  expect(new Set(declared.map(([name]) => name)).size).toBe(declared.length)
  expect(Object.fromEntries(distributions)).toEqual(Object.fromEntries(declared))
})

it('keeps a target payload identity independent of other target archives', () => {
  const changed = structuredClone(lock)
  changed.targets['win-x64'].wheels[0]!.sha256 = 'a'.repeat(64)
  expect(primaryRuntimePayloadDigest('mac-arm64', changed, '11.7.0')).toBe(primaryRuntimePayloadDigest('mac-arm64', lock, '11.7.0'))
  expect(primaryRuntimePayloadDigest('win-x64', changed, '11.7.0')).not.toBe(primaryRuntimePayloadDigest('win-x64', lock, '11.7.0'))
})

it('invalidates payload identity for shared wheels, package versions and package-manager changes', () => {
  const wheel = structuredClone(lock), distribution = structuredClone(lock)
  wheel.wheels[0]!.sha256 = 'a'.repeat(64)
  distribution.pythonPackages['python-docx'] = '1.2.1'
  const original = primaryRuntimePayloadDigest('mac-arm64', lock, '11.7.0')
  expect(primaryRuntimePayloadDigest('mac-arm64', wheel, '11.7.0')).not.toBe(original)
  expect(primaryRuntimePayloadDigest('mac-arm64', distribution, '11.7.0')).not.toBe(original)
  expect(primaryRuntimePayloadDigest('mac-arm64', lock, '11.7.1')).not.toBe(original)
})

it('invalidates only Windows payload identity when its native import startup module changes', () => {
  expect(primaryRuntimePayloadDigest('win-x64', lock, '11.7.0', 'first'))
    .not.toBe(primaryRuntimePayloadDigest('win-x64', lock, '11.7.0', 'second'))
  for (const target of ['linux-x64', 'linux-arm64', 'mac-x64', 'mac-arm64'] as const) {
    expect(primaryRuntimePayloadDigest(target, lock, '11.7.0', 'first'))
      .toBe(primaryRuntimePayloadDigest(target, lock, '11.7.0', 'second'))
  }
})

it('prepares Windows import startup files and leaves other targets and sitecustomize untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'primary-python-paths-'))
  try {
    const windows = join(root, 'windows')
    const site = join(windows, 'Lib', 'site-packages')
    await mkdir(site, { recursive: true })
    await writeFile(join(site, 'sitecustomize.py'), '# preserved upstream hook\n')
    await preparePrimaryRuntimePythonPaths('win-x64', windows)
    await preparePrimaryRuntimePythonPaths('win-x64', windows)
    expect(await readFile(join(site, 'sitecustomize.py'), 'utf8')).toBe('# preserved upstream hook\n')
    expect(await readFile(join(site, '00_scipaper_python_paths.pth'), 'utf8')).toBe('import _scipaper_python_paths\n')
    for (const target of ['linux-x64', 'linux-arm64', 'mac-x64', 'mac-arm64'] as const) {
      const untouched = join(root, target)
      await preparePrimaryRuntimePythonPaths(target, untouched)
      await expect(readFile(join(untouched, 'Lib/site-packages/00_scipaper_python_paths.pth')))
        .rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reports missing distribution metadata before trying to execute a stale native payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-stale-runtime-'))
  try {
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
      components: { python: '3.12.14', numpy: '2.3.5', pandas: '3.0.1' } }))
    expect(() => { smokePrimaryRuntime(root) }).toThrow('missing Python distribution versions; prepare the payload')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('extracts a hash-verified cached library without a Python installer or network request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-wheel-'))
  try {
    const hash = createHash('sha256').update(libraryWheel).digest('hex')
    const archive = join(root, hash)
    await writeFile(archive, libraryWheel)
    expect(await downloadPrimaryRuntimeAsset('https://unused.invalid/library.whl', hash, root)).toBe(archive)
    await unpackPrimaryRuntimeWheel(archive, join(root, 'site-packages'))
    expect(await readFile(join(root, 'site-packages/sample.py'), 'utf8')).toBe('sample = 42\n')
    await writeFile(archive, 'corrupt archive')
    await expect(downloadPrimaryRuntimeAsset('https://unused.invalid/library.whl', hash, root)).rejects.toThrow('checksum mismatch')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('fully extracts a large deflate-compressed wheel entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-large-wheel-'))
  try {
    const expected = Buffer.alloc(1024 * 1024)
    // Seeded xorshift bytes keep the compressed entry larger than the stream buffers.
    let state = 26
    for (let index = 0; index < expected.length; index++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      expected[index] = state & 255
    }
    const archive = join(root, 'large.whl')
    await writeFile(archive, zipSync({ 'large.bin': expected }, { level: 6 }))
    await unpackPrimaryRuntimeWheel(archive, root)
    expect(await readFile(join(root, 'large.bin'))).toEqual(expected)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('retains auxiliary wheel scripts without generating command wrappers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-wheel-'))
  try {
    const archive = join(root, 'relocated.whl')
    await writeFile(archive, relocatedWheel)
    await unpackPrimaryRuntimeWheel(archive, join(root, 'site-packages'))
    expect(await readFile(join(root, 'site-packages/sample-1.0.data/scripts/sample'), 'utf8')).toBe('requires relocation\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects library files requiring an unsupported installation scheme', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-wheel-'))
  try {
    const archive = join(root, 'relocated.whl')
    await writeFile(archive, externalLibraryWheel)
    await expect(unpackPrimaryRuntimeWheel(archive, join(root, 'site-packages'))).rejects.toThrow('unsupported installation paths')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('copies complete Office resources outside the application archive and removes obsolete assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-office-assets-'))
  try {
    const source = join(root, 'package', 'assets')
    const destination = join(root, 'Contents', 'Resources', 'runtime', 'office-skills')
    await mkdir(join(source, 'scripts'), { recursive: true })
    await writeFile(join(source, 'scripts', 'check_office.py'), 'print("checker")\n')
    for (const name of ['office-docx', 'office-pptx', 'office-xlsx']) {
      await mkdir(join(source, name))
      await writeFile(join(source, name, 'SKILL.md'), `# ${name}\n`)
    }
    await prepareOfficeSkillAssets(source, destination)
    await writeFile(join(destination, 'obsolete.py'), 'old helper')
    await prepareOfficeSkillAssets(source, destination)
    for (const name of ['office-docx', 'office-pptx', 'office-xlsx']) {
      expect(await readFile(join(destination, name, 'SKILL.md'), 'utf8')).toBe(`# ${name}\n`)
    }
    expect(await readFile(join(destination, 'scripts', 'check_office.py'), 'utf8')).toBe('print("checker")\n')
    await expect(readFile(join(destination, 'obsolete.py'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true }) }
})

it('replaces a linked Office output without touching its target and refuses linked output ancestors', async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), '科研 Office assets-'))
  try {
    const source = join(root, 'assets'), external = join(root, '保留项目'), runtime = join(root, 'runtime')
    await mkdir(source)
    await mkdir(external)
    await mkdir(runtime)
    await writeFile(join(source, 'SKILL.md'), '# Office\n')
    await writeFile(join(external, 'paper.txt'), 'preserved')
    const destination = join(runtime, 'office-skills')
    symlinkSync(external, destination, process.platform === 'win32' ? 'junction' : 'dir')
    await prepareOfficeSkillAssets(source, destination)
    expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toBe('# Office\n')
    expect(await readFile(join(external, 'paper.txt'), 'utf8')).toBe('preserved')
    const linkedRuntime = join(root, 'linked-runtime')
    symlinkSync(external, linkedRuntime, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(prepareOfficeSkillAssets(source, join(linkedRuntime, 'office-skills'))).rejects.toThrow('linked ancestor')
    expect(await readFile(join(external, 'paper.txt'), 'utf8')).toBe('preserved')
  } finally { removeOwnedDirectory(root) }
})

it('gives Python-only payloads a distinct identity', () => {
  expect(primaryRuntimePayloadDigest('linux-x64', lock, undefined)).not.toBe(primaryRuntimePayloadDigest('linux-x64', lock, '11.7.0'))
})

it('keeps carrier pnpm versions aligned with the shared payload build', () => {
  const root = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    packageManager: string
    devDependencies: { pnpm: string }
  }
  const desktop = JSON.parse(readFileSync(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8')) as {
    devDependencies: { pnpm: string }
  }
  expect(desktop.devDependencies.pnpm).toBe(root.devDependencies.pnpm)
  expect(root.packageManager).toBe(`pnpm@${root.devDependencies.pnpm}`)
})
