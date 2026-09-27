/** Evaluate plugin dsh peer requirements without importing plugin code. */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

/** Incompatible dsh peers and the exact plugin/runtime exemption decision. */
export interface PluginCompatibility {
  name: string
  version: string
  runtimeVersion: string
  /** Only peer requirements not satisfied by the running dsh version. */
  peers: Record<string, string>
  exempted: boolean
}

function objectOf(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function runtimeVersionOf(value: unknown): string {
  if (typeof value !== 'string' || semver.valid(value) === null) {
    throw new Error(`Invalid dsh runtime version: ${JSON.stringify(value)}; expected a semantic version`)
  }
  return value
}

function identityField(manifest: Record<string, unknown>, field: 'name' | 'version'): string {
  const value = Object.hasOwn(manifest, field) ? manifest[field] : undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Plugin manifest ${field} must be a non-empty string when dsh peers are incompatible`)
  }
  return value
}

const productPeers = new Set([
  '@deepseek-ai/dsh-research-app',
  '@deepseek-ai/dsh-research-workbench',
  '@deepseek-ai/dsh-client-ui-research',
])

function runtimeManifest(): Record<string, unknown> {
  // The executable's virtual filesystem intercepts string paths, not URL arguments.
  const filename = fileURLToPath(new URL('../package.json', import.meta.url))
  return objectOf(JSON.parse(fs.readFileSync(filename, 'utf8')), 'app-boot package.json')
}

function kernelOf(manifest: Record<string, unknown>, owner: string): { name: string; version: string } | undefined {
  if (!Object.hasOwn(manifest, 'scipaper')) return undefined
  const product = objectOf(manifest.scipaper, `${owner} scipaper metadata`)
  const kernel = objectOf(Object.hasOwn(product, 'kernel') ? product.kernel : undefined, `${owner} kernel metadata`)
  const name = Object.hasOwn(kernel, 'name') ? kernel.name : undefined
  if (typeof name !== 'string' || name.trim() === '') throw new Error(`${owner} kernel name must be a non-empty string`)
  return { name, version: runtimeVersionOf(Object.hasOwn(kernel, 'version') ? kernel.version : undefined) }
}

/**
 * Read the embedded DSH kernel version in source and bundled installations.
 * Upstream installations without product metadata use the package version.
 * @returns the validated runtime semantic version, preserving its exact spelling.
 * @throws if package.json cannot be read or its version is missing or invalid.
 */
export function getDshRuntimeVersion(): string {
  const manifest = runtimeManifest()
  return kernelOf(manifest, 'app-boot')?.version
    ?? runtimeVersionOf(Object.hasOwn(manifest, 'version') ? manifest.version : undefined)
}

/**
 * Check upstream dsh peers against the kernel and research-only peers against
 * the product release. Packages declaring the host's exact SciPaper release
 * and kernel identity use product versions for all dsh peers. Mismatched or
 * malformed SciPaper declarations are refused, including peerless packages.
 * Prereleases participate in ranges. workspace:^, workspace:~, and workspace:*
 * refer to the current runtime; other invalid ranges are incompatible.
 * @param manifest - parsed plugin package.json; inherited fields are ignored.
 * @param exemptions - exact plugin name@version keys mapped to exact runtime versions.
 * @param runtimeVersion - running dsh version, defaulting to this app-boot package.
 * @returns incompatible peers and exemption status, or undefined when none are incompatible.
 * @throws for malformed metadata, mismatched SciPaper releases, invalid runtime versions, or missing identity on a mismatch.
 */
export function evaluatePluginCompatibility(
  manifest: object,
  exemptions: Readonly<Record<string, readonly string[]>> = {},
  runtimeVersion = getDshRuntimeVersion(),
): PluginCompatibility | undefined {
  runtimeVersionOf(runtimeVersion)
  const fields = objectOf(manifest, 'Plugin manifest')
  const kernel = kernelOf(fields, 'Plugin manifest')
  const dependencies = Object.hasOwn(fields, 'peerDependencies')
    ? objectOf(fields.peerDependencies, 'Plugin manifest peerDependencies') : {}
  const needsProduct = kernel !== undefined || Object.keys(dependencies).some(name => productPeers.has(name))
  const host = needsProduct ? runtimeManifest() : undefined
  const hostKernel = host === undefined ? undefined : kernelOf(host, 'app-boot')
  const productVersion = host === undefined || hostKernel === undefined ? undefined : runtimeVersionOf(host.version)
  if (kernel !== undefined && (hostKernel === undefined || kernel.name !== hostKernel.name
    || kernel.version !== hostKernel.version || kernel.version !== runtimeVersion
    || !Object.hasOwn(fields, 'version') || fields.version !== productVersion)) {
    throw new Error('Plugin SciPaper release metadata must match the running product version and kernel name/version')
  }
  const peers: Record<string, string> = {}
  for (const [name, range] of Object.entries(dependencies)) {
    if (typeof range !== 'string') {
      throw new Error(`Plugin manifest peerDependencies[${JSON.stringify(name)}] must be a string`)
    }
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const version = kernel !== undefined || productPeers.has(name) ? productVersion : runtimeVersion
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? version : range
    if (version === undefined || requirement === undefined || requirement.trim() === ''
      || !semver.satisfies(version, requirement, { includePrerelease: true })) {
      peers[name] = range
    }
  }
  if (Object.keys(peers).length === 0) return undefined
  const name = identityField(fields, 'name')
  const version = identityField(fields, 'version')
  const key = `${name}@${version}`
  const exemptedVersions = Object.hasOwn(exemptions, key) ? exemptions[key] : undefined
  const exempted = exemptedVersions?.includes(runtimeVersion) === true
  return { name, version, runtimeVersion, peers, exempted }
}

/**
 * Describe incompatible peers, their risk, and the exact-version remedy.
 * Surfaces with their own grant mechanism or locale render the structured result themselves.
 * @param issue - incompatible plugin/runtime result, including exempted mismatches.
 * @returns an English diagnostic for logs and stderr.
 */
export function pluginCompatibilityWarning(issue: PluginCompatibility): string {
  const key = `${issue.name}@${issue.version}`
  return `Plugin ${key} is incompatible with dsh ${issue.runtimeVersion}: peerDependencies ${JSON.stringify(issue.peers)}. `
    + 'Running it may cause crashes or data loss. '
    + 'Update the plugin or install a plugin version compatible with this dsh runtime. '
    + `To accept this risk explicitly, grant the exact-version exemption for ${key} on dsh ${issue.runtimeVersion} with \`dsh plugin allow-version\` or the plugin manager, then retry the installation or restart dsh. `
    + `Exact-version exemption: ${issue.exempted ? 'active' : 'not active'}.`
}
