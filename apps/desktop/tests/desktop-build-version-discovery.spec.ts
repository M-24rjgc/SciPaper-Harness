import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  desktopBuildDateSegment,
  suggestDesktopBuildVersion,
} from '../scripts/desktop-build-version-discovery.ts'

const PRERELEASE = '0.1.6-alpha.2'
const STABLE = '0.1.6'
const DATE = '20260921'
const directories: string[] = []
const bucket = vi.hoisted(() => ({ keys: [] as string[], prefixes: [] as string[] }))

vi.mock('../scripts/desktop-cos.ts', () => ({
  DESKTOP_COS_REGION: 'ap-beijing',
  createDesktopCos: () => ({
    getBucket(
      request: { Prefix: string },
      callback: (error: null, data: { Contents: { Key: string }[]; IsTruncated: string }) => void,
    ) {
      bucket.prefixes.push(request.Prefix)
      callback(null, { Contents: bucket.keys.map(Key => ({ Key })), IsTruncated: 'false' })
    },
  }),
}))

async function artifactsWith(names: readonly string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-discovery-'))
  directories.push(directory)
  for (const name of names) await writeFile(join(directory, name), '')
  return directory
}

afterEach(async () => {
  bucket.keys.length = 0
  bucket.prefixes.length = 0
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})

describe('desktop build version discovery', () => {
  it('formats the date segment in the build host time zone', () => {
    expect(desktopBuildDateSegment(new Date(2026, 8, 21))).toBe('20260921')
    expect(desktopBuildDateSegment(new Date(2026, 0, 5))).toBe('20260105')
  })

  it('starts at one when nothing is taken', async () => {
    const artifactsRoot = await artifactsWith([])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.1`)
  })

  it('numbers a stable product version under the documented test prerelease', async () => {
    const artifactsRoot = await artifactsWith([`deepseek-harness-${STABLE}-test.${DATE}.4-win-x64.exe`])
    await expect(suggestDesktopBuildVersion({ productVersion: STABLE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${STABLE}-test.${DATE}.5`)
  })

  it('numbers after the highest local artifact for the same date', async () => {
    const artifactsRoot = await artifactsWith([
      `deepseek-harness-${PRERELEASE}.${DATE}.1-win-x64.exe`,
      `deepseek-harness-${PRERELEASE}.${DATE}.2-win-x64.exe`,
      `deepseek-harness-${PRERELEASE}.${DATE}.10-win-x64.exe`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.11`)
  })

  it('keeps every existing SciPaper trial installer when choosing the next build number', async () => {
    const productVersion = '0.2.0-alpha.4'
    const date = '20260928'
    const artifactsRoot = await artifactsWith([
      `scipaper-harness-${productVersion}.${date}.1-win-x64.exe`,
      `scipaper-harness-${productVersion}.${date}.2-win-x64.exe`,
      `scipaper-harness-${productVersion}.${date}.3-win-x64.exe`,
      `scipaper-harness-${productVersion}.${date}.99-win-x64.exe.blockmap`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion, target: 'win-x64', environment: {}, date, artifactsRoot }))
      .resolves.toBe(`${productVersion}.${date}.4`)
  })

  it('counts installers from separate unsigned runs while preserving legacy top-level artifacts', async () => {
    const productVersion = '0.2.0-alpha.4'
    const date = '20260928'
    const artifactsRoot = await artifactsWith([`scipaper-harness-${productVersion}.${date}.1-win-x64.exe`])
    const run = join(artifactsRoot, 'runs', 'trial-2')
    await mkdir(run, { recursive: true })
    await writeFile(join(run, `scipaper-harness-${productVersion}.${date}.2-win-x64.exe`), 'installer')
    await expect(suggestDesktopBuildVersion({ productVersion, target: 'win-x64', environment: {}, date, artifactsRoot }))
      .resolves.toBe(`${productVersion}.${date}.3`)
  })

  it('counts installers from the shortened unsigned output root', async () => {
    const productVersion = '0.2.0-alpha.4'
    const date = '20260928'
    const artifactsRoot = await artifactsWith([`scipaper-harness-${productVersion}.${date}.1-win-x64.exe`])
    const unsignedRunsRoot = join(artifactsRoot, 'short')
    const run = join(unsignedRunsRoot, 'a1b2c3')
    await mkdir(run, { recursive: true })
    await writeFile(join(run, `scipaper-harness-${productVersion}.${date}.2-win-x64.exe`), 'installer')
    await expect(suggestDesktopBuildVersion({ productVersion, target: 'win-x64', environment: {}, date, artifactsRoot, unsignedRunsRoot }))
      .resolves.toBe(`${productVersion}.${date}.3`)
  })

  it('counts both SciPaper uploads and local builds without reusing a local number', async () => {
    const releaseId = 'a'.repeat(32)
    const productVersion = '0.2.0-alpha.4'
    const remotePrefix = `dsh-desk/${releaseId}/bin/win-x64/scipaper-harness-`
    bucket.keys.push(`${remotePrefix}${productVersion}.${DATE}.5-win-x64.exe`)
    const artifactsRoot = await artifactsWith([`scipaper-harness-${productVersion}.${DATE}.6-win-x64.exe`])
    const environment = {
      DOWNLOAD_TEST_ORIGIN: 'https://test.example.com',
      DOWNLOAD_TEST_RELEASE_ID: releaseId,
      DOWNLOAD_TEST_COS_BUCKET: 'example-bucket',
      DOWNLOAD_TEST_COS_SECRET_ID: 'fixture-id',
      DOWNLOAD_TEST_COS_SECRET_KEY: 'fixture-key',
    }
    await expect(suggestDesktopBuildVersion({ productVersion, target: 'win-x64', environment, date: DATE, artifactsRoot }))
      .resolves.toBe(`${productVersion}.${DATE}.7`)
    expect(bucket.prefixes).toEqual([remotePrefix])
  })

  it('ignores artifacts from another date or product version', async () => {
    const artifactsRoot = await artifactsWith([
      `deepseek-harness-${PRERELEASE}.20260920.7-win-x64.exe`,
      `deepseek-harness-0.1.5-alpha.1.${DATE}.9-win-x64.exe`,
      `deepseek-harness-${PRERELEASE}-win-x64.exe`,
      'unrelated.exe',
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.1`)
  })

  it('reads macOS artifact names too', async () => {
    const artifactsRoot = await artifactsWith([
      `deepseek-harness-${PRERELEASE}.${DATE}.3-mac-arm64.dmg`,
      `deepseek-harness-${PRERELEASE}.${DATE}.3-mac-arm64.zip`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'mac-arm64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.4`)
  })

  it('counts unsigned Windows artifacts written under their own suffix', async () => {
    const artifactsRoot = await artifactsWith([
      `deepseek-harness-${PRERELEASE}.${DATE}.2-win-x64-unsigned.exe`,
      `deepseek-harness-${PRERELEASE}.${DATE}.5-win-x64-unsigned.exe.blockmap`,
    ])
    await expect(suggestDesktopBuildVersion({ productVersion: PRERELEASE, target: 'win-x64', environment: {}, date: DATE, artifactsRoot }))
      .resolves.toBe(`${PRERELEASE}.${DATE}.3`)
  })
})
