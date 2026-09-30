import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches, OPTIONAL_BUNDLES, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

const root = fileURLToPath(new URL('..', import.meta.url))
const name = '@deepseek-ai/dsh-ssh-remote-bundle'
const base = fileURLToPath(new URL('../../base/cordis.patch.yml', import.meta.url))
const headless = fileURLToPath(new URL('../../headless/cordis.patch.yml', import.meta.url))
const rows = composeEntries([
  loadOverlayPatches('base', base),
  loadOverlayPatches('headless', headless),
  loadOverlayPatches('ssh remote', join(root, 'cordis.patch.yml')),
])

function row(id: string): (typeof rows)[number] {
  const found = rows.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`missing ${id} row`)
  return found
}

function disabled(id: string, env: Record<string, string | undefined>): boolean {
  const value: unknown = row(id).disabled
  if (typeof value === 'boolean') return value
  if (typeof value !== 'object' || value === null || !('__jsExpr' in value)
    || typeof value.__jsExpr !== 'string') throw new Error(`${id} has no conditional disabled expression`)
  const evaluated: unknown = runInNewContext(value.__jsExpr, { process: { env } })
  if (typeof evaluated !== 'boolean') throw new Error(`${id} disabled expression was not boolean`)
  return evaluated
}

const configured = {
  DSH_SSH_ENABLE_REMOTE: '1',
  DSH_SSH_HOST: 'lab-host',
  DSH_SSH_NODE: '/usr/bin/node',
  DSH_SSH_HELPER: '/opt/dsh/helper.js',
  DSH_SSH_HELPER_HASH: 'a'.repeat(64),
  DSH_SSH_WORKSPACE: '/home/research',
}

describe('optional SSH remote bundle', () => {
  it('ships as an optional complete SSH backend, absent from every default profile', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      icon?: string
      dsh?: { bundle?: { patch?: string } }
      dependencies?: Record<string, string>
    }
    expect(OPTIONAL_BUNDLES).toContain(name)
    for (const template of Object.values(PROFILE_TEMPLATES)) expect(template.bundles).not.toContain(name)
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-ssh': 'workspace:*',
      '@deepseek-ai/dsh-fs-ssh': 'workspace:*',
      '@deepseek-ai/dsh-subprocess-ssh': 'workspace:*',
      '@deepseek-ai/dsh-sandbox-ssh': 'workspace:*',
    })
    expect(row('ssh').name).toBe('@deepseek-ai/dsh-ssh')
    expect(row('fs-ssh').name).toBe('@deepseek-ai/dsh-fs-ssh')
    expect(row('subprocess-ssh').name).toBe('@deepseek-ai/dsh-subprocess-ssh')
    expect(row('sandbox-ssh').name).toBe('@deepseek-ai/dsh-sandbox-ssh')
  })

  it('preserves all local providers until the explicit switch and every remote parameter are present', () => {
    const incomplete = { ...configured, DSH_SSH_HOST: undefined }
    for (const env of [{}, { DSH_SSH_ENABLE_REMOTE: '1' }, incomplete]) {
      for (const id of ['subprocess', 'sandbox', 'fs-sandbox']) expect(disabled(id, env)).toBe(false)
      for (const id of ['ssh', 'fs-ssh', 'subprocess-ssh', 'sandbox-ssh']) expect(disabled(id, env)).toBe(true)
    }
  })

  it('replaces the local backend as one set in a configured headless profile', () => {
    for (const id of ['subprocess', 'sandbox', 'fs-sandbox']) expect(disabled(id, configured)).toBe(true)
    for (const id of ['ssh', 'fs-ssh', 'subprocess-ssh', 'sandbox-ssh']) expect(disabled(id, configured)).toBe(false)
  })

  it('never switches a desktop Host away from its local research workspace', () => {
    const env = { ...configured, DSH_DESKTOP_HOST: '1' }
    for (const id of ['subprocess', 'sandbox', 'fs-sandbox']) expect(disabled(id, env)).toBe(false)
    for (const id of ['ssh', 'fs-ssh', 'subprocess-ssh', 'sandbox-ssh']) expect(disabled(id, env)).toBe(true)
  })
})
