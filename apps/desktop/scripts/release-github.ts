/**
 * Publish one packaged Windows build of SciPaper Harness as a GitHub release: the
 * installer, its blockmap for differential downloads, and the channel files the
 * installed application's updater reads. Run it after `package:win:x64:unsigned`;
 * it uploads through the GitHub CLI, logged in to an account that can write to the
 * repository. A prerelease version (`0.2.0-alpha.1`) publishes a prerelease, which
 * installed prerelease copies update to.
 *
 *     pnpm --dir apps/desktop run release:github [--notes-file <file>]
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { SCIPAPER_RELEASES, scipaperInstallerName } from './scipaper-identity.mjs'

/** One release as it will be created. */
export interface GitHubReleasePlan {
  readonly tag: string
  readonly title: string
  readonly prerelease: boolean
  /** The installer, its blockmap, then the channel files. */
  readonly files: readonly string[]
}

/**
 * The update channel electron-updater reads for a version: its prerelease name, else `latest`.
 * @param version - A semantic version.
 * @returns The channel, whose metadata file is `<channel>.yml`.
 */
export function updateChannel(version: string): string {
  return /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/u.exec(version)?.[1] ?? 'latest'
}

/**
 * Check that a packaged build is complete and consistent, and list what to upload.
 * @param artifactsDir - The directory electron-builder wrote the Windows installer to.
 * @param version - The Desktop version being released.
 * @returns The release to create.
 */
export function planGitHubRelease(artifactsDir: string, version: string): GitHubReleasePlan {
  const installer = join(artifactsDir, scipaperInstallerName(version))
  const blockmap = `${installer}.blockmap`
  const channel = updateChannel(version)
  const channelFile = join(artifactsDir, `${channel}.yml`)
  const latest = join(artifactsDir, 'latest.yml')
  // electron-builder writes latest.yml for the GitHub provider; the updater of a prerelease
  // reads `<channel>.yml` first, so the channel file is written beside it with the same content.
  // Any channel file already there was written by an earlier release from an earlier build.
  if (channelFile !== latest && existsSync(latest)) copyFileSync(latest, channelFile)
  for (const file of [installer, blockmap, channelFile]) {
    if (!existsSync(file)) throw new Error(`release: ${file} is missing; package the Windows installer for ${version} first`)
  }
  // The updater reads the prerelease channel and falls back to `latest`; both describe this installer.
  const channelFiles = [...new Set([channel, 'latest'])].map(name => join(artifactsDir, `${name}.yml`)).filter(file => existsSync(file))
  const sha512 = createHash('sha512').update(readFileSync(installer)).digest('base64')
  for (const file of channelFiles) {
    const metadata = readFileSync(file, 'utf8')
    if (!metadata.split(/\r?\n/u).includes(`version: ${version}`)) throw new Error(`release: ${file} does not describe version ${version}`)
    if (!metadata.includes(`sha512: ${sha512}`)) throw new Error(`release: ${file} does not match the installer's SHA-512`)
  }
  return { tag: `v${version}`, title: `SciPaper Harness ${version}`, prerelease: channel !== 'latest', files: [installer, blockmap, ...channelFiles] }
}

/**
 * The GitHub CLI arguments that create the release with its files.
 * @param plan - The checked release.
 * @param notesFile - Release notes in Markdown, or undefined to let GitHub list the changes.
 * @returns Arguments for `gh`.
 */
export function ghReleaseArguments(plan: GitHubReleasePlan, notesFile: string | undefined): string[] {
  return [
    'release', 'create', plan.tag, ...plan.files,
    '--repo', `${SCIPAPER_RELEASES.owner}/${SCIPAPER_RELEASES.repo}`,
    '--title', plan.title,
    ...notesFile === undefined ? ['--generate-notes'] : ['--notes-file', notesFile],
    ...plan.prerelease ? ['--prerelease'] : [],
  ]
}

function main(): void {
  const { values } = parseArgs({ options: { 'notes-file': { type: 'string' } } })
  const appRoot = resolve(import.meta.dirname, '..')
  const version = (JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version: string }).version
  const plan = planGitHubRelease(join(desktopTargetBuildPaths('win-x64').root, 'unsigned-artifacts'), version)
  const result = spawnSync('gh', ghReleaseArguments(plan, values['notes-file']), { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`release: gh release create exited with ${String(result.status ?? result.error)}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) main()
