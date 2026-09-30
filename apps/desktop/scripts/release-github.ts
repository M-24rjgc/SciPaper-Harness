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
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'
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

/** Locate one unsigned installer without crossing into another build run. */
export function findUnsignedArtifactDirectory(root: string, version: string, shortRunsRoot?: string): string {
  const installer = scipaperInstallerName(version)
  const candidates = [root]
  for (const runsRoot of [join(root, 'runs'), shortRunsRoot]) {
    if (runsRoot !== undefined && existsSync(runsRoot)) {
      for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(runsRoot, entry.name))
      }
    }
  }
  const matches = candidates.filter(directory => existsSync(join(directory, installer)))
  if (matches.length > 1) throw new Error(`release: multiple unsigned builds contain ${installer}; select one build directory explicitly`)
  return matches[0] ?? root
}

/** Verify the fields the updater actually consumes, including both modern and legacy download entries. */
function validateChannel(file: string, version: string, installer: string, sha512: string): void {
  const value: unknown = load(readFileSync(file, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`release: invalid metadata in ${file}`)
  const metadata = value as Record<string, unknown>
  if (metadata.version !== version) throw new Error(`release: ${file} does not describe version ${version}`)
  if (metadata.sha512 !== sha512) throw new Error(`release: ${file} does not match the installer's SHA-512`)
  if (metadata.path !== basename(installer)) throw new Error(`release: ${file} has an incorrect installer path`)
  const files = metadata.files
  if (!Array.isArray(files) || files.length !== 1 || files[0] === null || typeof files[0] !== 'object') {
    throw new Error(`release: ${file} must describe exactly one Windows installer`)
  }
  const entry = files[0] as Record<string, unknown>
  if (entry.url !== basename(installer)) throw new Error(`release: ${file} has an incorrect installer URL`)
  if (entry.sha512 !== sha512) throw new Error(`release: ${file} has an incorrect installer entry SHA-512`)
  if (entry.size !== statSync(installer).size) throw new Error(`release: ${file} has an incorrect installer size`)
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
  const sourceChannel = existsSync(latest) ? latest : channelFile
  for (const file of [installer, blockmap, sourceChannel]) {
    if (!existsSync(file)) throw new Error(`release: ${file} is missing; package the Windows installer for ${version} first`)
    if (!statSync(file).isFile() || statSync(file).size === 0) throw new Error(`release: ${file} must be a nonempty regular file`)
  }
  const sha512 = createHash('sha512').update(readFileSync(installer)).digest('base64')
  validateChannel(sourceChannel, version, installer, sha512)
  // GitHub packaging writes latest.yml; prerelease clients request their named channel first.
  // Replace an older channel only after validating the newly packaged metadata.
  if (channelFile !== sourceChannel) copyFileSync(sourceChannel, channelFile)
  const channelFiles = [...new Set([channelFile, latest])].filter(file => existsSync(file))
  return { tag: `v${version}`, title: `SciPaper Harness ${version}`, prerelease: channel !== 'latest', files: [installer, blockmap, ...channelFiles] }
}

/**
 * The GitHub CLI arguments that create a release with its files against an existing remote tag.
 * @param plan - The checked release.
 * @param notesFile - Release notes in Markdown, or undefined to let GitHub list the changes.
 * @returns Arguments for `gh`.
 */
export function ghReleaseArguments(plan: GitHubReleasePlan, notesFile: string | undefined): string[] {
  return [
    'release', 'create', plan.tag, ...plan.files,
    '--repo', `${SCIPAPER_RELEASES.owner}/${SCIPAPER_RELEASES.repo}`,
    '--title', plan.title, '--verify-tag',
    ...notesFile === undefined ? ['--generate-notes'] : ['--notes-file', notesFile],
    ...plan.prerelease ? ['--prerelease'] : [],
  ]
}

function main(): void {
  const { values } = parseArgs({ options: { 'notes-file': { type: 'string' }, 'artifacts-dir': { type: 'string' } } })
  const appRoot = resolve(import.meta.dirname, '..')
  const version = (JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { version: string }).version
  const paths = desktopTargetBuildPaths('win-x64')
  const plan = planGitHubRelease(values['artifacts-dir']
    ?? findUnsignedArtifactDirectory(paths.unsignedArtifacts, version, paths.unsignedRuns), version)
  const result = spawnSync('gh', ghReleaseArguments(plan, values['notes-file']), { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`release: gh release create exited with ${String(result.status ?? result.error)}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) main()
