/** Preserve repository dependency fixes when resolving the isolated Desktop runtime. */
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import * as yaml from 'js-yaml'

function stringMap(value: unknown, section: string): Record<string, string> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some(entry => typeof entry !== 'string')) {
    throw new Error(`desktop runtime: invalid ${section} dependency policy`)
  }
  return value as Record<string, string>
}

function workspace(path: string): Record<string, unknown> {
  const value: unknown = yaml.load(readFileSync(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('desktop runtime: invalid dependency policy workspace')
  }
  return value as Record<string, unknown>
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path)
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

/**
 * Copy reviewed patches and external overrides into the build-only runtime project before pnpm resolution.
 * @param project - Isolated runtime staging directory with verified local core tarball overrides.
 * @param repository - Repository root supplying reviewed dependency policies and patch bytes.
 * @returns Nothing; missing patches or paths outside the repository fail before installation.
 */
export function prepareRuntimeDependencyPolicy(project: string, repository: string): void {
  const repositoryRoot = realpathSync(repository)
  const projectRoot = realpathSync(project)
  const policy = workspace(join(repositoryRoot, 'pnpm-workspace.yaml'))
  const manifestPath = join(projectRoot, 'pnpm-workspace.yaml')
  const manifest = workspace(manifestPath)
  const externalOverrides = Object.fromEntries(Object.entries(stringMap(policy.overrides, 'overrides'))
    .filter(([, value]) => !/^(?:link|file|workspace):/u.test(value)))
  const patches = stringMap(policy.patchedDependencies, 'patchedDependencies')
  for (const path of Object.values(patches)) {
    if (isAbsolute(path) || !contained(repositoryRoot, resolve(repositoryRoot, path))
      || !contained(projectRoot, resolve(projectRoot, path))) {
      throw new Error('desktop runtime: dependency patch must be a repository-relative file')
    }
    const source = realpathSync(resolve(repositoryRoot, path))
    if (!contained(repositoryRoot, source)) {
      throw new Error('desktop runtime: dependency patch resolves outside the repository')
    }
    const destination = resolve(projectRoot, path)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
  writeFileSync(manifestPath, yaml.dump({
    ...manifest,
    overrides: { ...externalOverrides, ...stringMap(manifest.overrides, 'runtime overrides') },
    patchedDependencies: patches,
    // The runtime omits development tools; any selected patched version still must apply successfully.
    allowUnusedPatches: true,
  }), { mode: 0o600 })
}
