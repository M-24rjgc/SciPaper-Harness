import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ghReleaseArguments, planGitHubRelease, updateChannel } from '../scripts/release-github.ts'

let dir: string | undefined
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

function build(version: string, channels: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'release-github-'))
  const installer = join(dir, `scipaper-harness-${version}-win-x64.exe`)
  writeFileSync(installer, 'installer bytes')
  writeFileSync(`${installer}.blockmap`, 'blockmap')
  const sha512 = createHash('sha512').update('installer bytes').digest('base64')
  for (const [name, metadata] of Object.entries(channels)) writeFileSync(join(dir, `${name}.yml`), metadata.replaceAll('<sha512>', sha512))
  return dir
}

const metadata = (version: string): string => `version: ${version}\nfiles:\n  - url: scipaper-harness-${version}-win-x64.exe\n    sha512: <sha512>\npath: x\nsha512: <sha512>\n`

describe('the GitHub release of a Windows build', () => {
  it('reads the channel from the prerelease name', () => {
    expect(updateChannel('0.2.0-alpha.1')).toBe('alpha')
    expect(updateChannel('1.0.0')).toBe('latest')
  })

  it('uploads the installer, its blockmap and every channel file that describes it, as a prerelease', () => {
    const artifacts = build('0.2.0-alpha.1', { alpha: metadata('0.2.0-alpha.1'), latest: metadata('0.2.0-alpha.1') })
    const plan = planGitHubRelease(artifacts, '0.2.0-alpha.1')
    expect(plan).toMatchObject({ tag: 'v0.2.0-alpha.1', title: 'SciPaper Harness 0.2.0-alpha.1', prerelease: true })
    expect(plan.files.map(file => file.slice(artifacts.length + 1))).toEqual([
      'scipaper-harness-0.2.0-alpha.1-win-x64.exe', 'scipaper-harness-0.2.0-alpha.1-win-x64.exe.blockmap', 'alpha.yml', 'latest.yml',
    ])
    expect(ghReleaseArguments(plan, 'notes.md')).toEqual([
      'release', 'create', 'v0.2.0-alpha.1', ...plan.files, '--repo', 'M-24rjgc/SciPaper-Harness',
      '--title', 'SciPaper Harness 0.2.0-alpha.1', '--notes-file', 'notes.md', '--prerelease',
    ])
  })

  it('writes the prerelease channel file from latest.yml, as electron-builder leaves only that one', () => {
    const artifacts = build('0.2.0-alpha.1', { latest: metadata('0.2.0-alpha.1') })
    const plan = planGitHubRelease(artifacts, '0.2.0-alpha.1')
    expect(plan.files.slice(2).map(file => file.slice(artifacts.length + 1))).toEqual(['alpha.yml', 'latest.yml'])
    expect(readFileSync(join(artifacts, 'alpha.yml'), 'utf8')).toBe(readFileSync(join(artifacts, 'latest.yml'), 'utf8'))
  })

  it('rewrites a channel file an earlier release left behind', () => {
    const artifacts = build('0.2.0-alpha.2', { alpha: metadata('0.2.0-alpha.1'), latest: metadata('0.2.0-alpha.2') })
    expect(planGitHubRelease(artifacts, '0.2.0-alpha.2').files).toHaveLength(4)
    expect(readFileSync(join(artifacts, 'alpha.yml'), 'utf8')).toMatch(/^version: 0\.2\.0-alpha\.2\n/)
  })

  it('publishes a stable version as a full release with generated notes', () => {
    const plan = planGitHubRelease(build('1.0.0', { latest: metadata('1.0.0') }), '1.0.0')
    expect(plan.prerelease).toBe(false)
    expect(ghReleaseArguments(plan, undefined).slice(-3)).toEqual(['--title', 'SciPaper Harness 1.0.0', '--generate-notes'])
  })

  it('refuses a build that is missing a file or describes another installer', () => {
    expect(() => planGitHubRelease(build('0.2.0-alpha.1', {}), '0.2.0-alpha.1')).toThrow(/alpha\.yml is missing/)
    expect(() => planGitHubRelease(build('0.2.0-alpha.1', { alpha: metadata('0.2.0-alpha.0') }), '0.2.0-alpha.1')).toThrow(/does not describe version/)
    expect(() => planGitHubRelease(build('0.2.0-alpha.1', { alpha: 'version: 0.2.0-alpha.1\nsha512: other\n' }), '0.2.0-alpha.1')).toThrow(/SHA-512/)
    expect(() => planGitHubRelease(build('0.2.0-alpha.1', { alpha: metadata('0.2.0-alpha.1') }), '0.2.0-alpha.2')).toThrow(/alpha\.2-win-x64\.exe is missing/)
  })
})
