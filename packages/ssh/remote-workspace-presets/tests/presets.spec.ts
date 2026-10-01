import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { SshFailure, SshPasswordStore, type PasswordRecords } from '@deepseek-ai/dsh-ssh/auth'
import RemoteWorkspacePresets from '../src/index.ts'
import { provisionRemoteWorkspace } from '../src/provision.ts'

vi.mock('../src/provision.ts', async original => ({
  ...await original<typeof import('../src/provision.ts')>(),
  provisionRemoteWorkspace: vi.fn(async () => ({
    node: '/usr/bin/node', helper: '/home/alice/.scipaper-harness/ssh-helper/hash/helper.mjs',
    helperHash: 'a'.repeat(64), canonicalPath: '/srv/research', rg: '/usr/bin/rg',
    typescriptLanguageServer: '/usr/bin/typescript-language-server',
  })),
}))

const SECRET = 'pässwörd测试 &%^"\'x!'

/** In-memory credential records standing in for the credential provider. */
function records(): PasswordRecords {
  const stored = new Map<CredentialKey, CredentialRecord>()
  return {
    readRecord: key => Promise.resolve(stored.get(key)),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(stored.get(key))
      if (next !== undefined) stored.set(key, next)
      return next
    },
    deleteRecord: (key) => { stored.delete(key); return Promise.resolve() },
  }
}

beforeEach(() => { vi.mocked(provisionRemoteWorkspace).mockClear() })

async function setup(broken?: string, researchTools = true, credentials?: PasswordRecords) {
  const ctx = new Context()
  if (credentials !== undefined) ctx.provide('credentials', credentials as never)
  const definitions: PresetDefinition[] = []
  const unregistered: string[] = []
  const registry = {
    register: async (definition: PresetDefinition) => {
      definitions.push(definition)
      return async () => { unregistered.push(definition.id) }
    },
    resolve: async (id: string) => ({ id, ...broken === undefined ? {} : { broken } }),
  }
  ctx.effect(() => ctx.reflect.provide('agentPresets', registry))
  const fiber = await ctx.plugin(RemoteWorkspacePresets, { researchTools })
  return { ctx, fiber, definitions, unregistered }
}

describe('remote workspace preset', () => {
  it('mounts one isolated remote service and tool realm after directory verification', async () => {
    const { ctx, fiber, definitions, unregistered } = await setup()
    const remotePresets = ctx.remoteWorkspacePresets
    expect(remotePresets.isRemotePreset('ssh-workspace')).toBe(false)
    const first = await remotePresets.inspect({ host: 'campus', path: '/srv/input' })
    const second = await remotePresets.ensure({ host: 'campus', path: '/srv/input' })
    expect(first.presetId).toMatch(/^ssh-[0-9a-f]{24}$/u)
    expect(first.canonicalPath).toBe('/srv/research')
    expect(second).toBe(first.presetId)
    expect(remotePresets.isRemotePreset(first.presetId)).toBe(true)
    expect(definitions).toHaveLength(1)
    const group = definitions[0]?.plugins[0]
    expect(group?.group).toBe(true)
    expect(group?.isolate).toEqual({ ssh: true, subprocess: true, fs: true, sandbox: true, shell: true, lsp: true })
    const rows = group?.config as Array<{ id: string; config?: unknown }> | undefined
    expect(rows?.map(row => row.id)).toContain('tool-bash')
    expect(rows?.map(row => row.id)).toContain('tool-lsp')
    expect(rows?.find(row => row.id === 'tool-presentation')?.config).toEqual({ mode: 'native' })
    expect(rows?.find(row => row.id === 'ssh')?.config).toHaveProperty('workspace', '/srv/research')
    expect(rows?.find(row => row.id === 'tool-fs-search')?.config).toHaveProperty('rgPath', '/usr/bin/rg')
    const lsp = rows?.find(row => row.id === 'lsp-stdio')?.config as {
      servers?: { typescript?: { command?: string; args?: string[]; extensionToLanguage?: Record<string, string> } }
    } | undefined
    expect(lsp?.servers?.typescript?.command).toBe('/usr/bin/node')
    expect(lsp?.servers?.typescript?.args).toEqual(['/usr/bin/typescript-language-server', '--stdio'])
    expect(lsp?.servers?.typescript?.extensionToLanguage?.['.cjs']).toBe('javascript')
    expect(definitions[0]?.plugins.slice(1)).toEqual([
      'project', 'evidence', 'artifact', 'environment', 'experiment',
      'board', 'media', 'knowledge', 'checks', 'tasks',
    ].map(module => ({ id: `research-${module}`, name: '@deepseek-ai/dsh-research-workbench/tools', config: { modules: [module] } })))
    await fiber.dispose()
    expect(remotePresets.isRemotePreset(first.presetId)).toBe(false)
    expect(unregistered).toEqual([first.presetId])
  })

  it('removes a rejected mount and reports the concrete loader failure', async () => {
    const { ctx, fiber, unregistered } = await setup('SSH helper startup failed')
    await expect(ctx.remoteWorkspacePresets.ensure({ host: 'campus', path: '/srv/input' }))
      .rejects.toThrow('SSH helper startup failed')
    expect(unregistered).toHaveLength(1)
    await fiber.dispose()
  })

  it('keeps a generic SSH preset independent of the research ledger', async () => {
    const { ctx, fiber, definitions } = await setup(undefined, false)
    await ctx.remoteWorkspacePresets.ensure({ host: 'campus', path: '/srv/input' })
    expect(definitions[0]?.plugins).toHaveLength(1)
    await fiber.dispose()
  })

  it('rejects an invalid SSH alias or non-POSIX path before provisioning', async () => {
    const { ctx, fiber } = await setup()
    await expect(ctx.remoteWorkspacePresets.ensure({ host: '-oProxyCommand=evil', path: '/srv' })).rejects.toThrow('OpenSSH alias')
    await expect(ctx.remoteWorkspacePresets.ensure({ host: 'campus', path: 'C:\\work' })).rejects.toThrow('absolute POSIX path')
    await fiber.dispose()
  })

  it('accepts user@host with a port and mounts a preset that names it', async () => {
    const { ctx, fiber, definitions } = await setup()
    await ctx.remoteWorkspacePresets.ensure({ host: 'alice@192.0.2.10:2222', path: '/srv/input' })
    const rows = definitions[0]?.plugins[0]?.config as Array<{ id: string; config?: unknown }>
    expect(rows.find(row => row.id === 'ssh')?.config).toHaveProperty('host', 'alice@192.0.2.10:2222')
    await fiber.dispose()
  })
})

describe('remote workspace login choice', () => {
  const request = { host: 'alice@192.0.2.10:2222', path: '/srv/input' }

  it('verifies a typed password first and saves it only after the host accepted it', async () => {
    const backing = records()
    const { ctx, fiber } = await setup(undefined, false, backing)
    const verified = await ctx.remoteWorkspacePresets.inspect({ ...request, auth: { kind: 'password', password: SECRET } })
    expect(verified.canonicalPath).toBe('/srv/research')
    expect(provisionRemoteWorkspace).toHaveBeenCalledWith(request, { password: SECRET })
    expect(await new SshPasswordStore(backing).get(request.host)).toBe(SECRET)
    await fiber.dispose()
  })

  it('keeps the old password and caches nothing when the host refuses the new one', async () => {
    const backing = records()
    const store = new SshPasswordStore(backing)
    await store.set(request.host, 'old-password')
    const { ctx, fiber } = await setup(undefined, false, backing)
    vi.mocked(provisionRemoteWorkspace).mockRejectedValueOnce(new SshFailure('auth', 'alice: Permission denied (password).'))
    await expect(ctx.remoteWorkspacePresets.inspect({ ...request, auth: { kind: 'password', password: 'typo' } }))
      .rejects.toMatchObject({ name: 'SshFailure', kind: 'auth' })
    expect(await store.get(request.host)).toBe('old-password')
    await ctx.remoteWorkspacePresets.inspect({ ...request, auth: { kind: 'password', password: SECRET } })
    expect(provisionRemoteWorkspace).toHaveBeenCalledTimes(2)
    expect(await store.get(request.host)).toBe(SECRET)
    await fiber.dispose()
  })

  it('drops the saved password when key login is chosen and the host accepts it', async () => {
    const backing = records()
    const store = new SshPasswordStore(backing)
    await store.set(request.host, SECRET)
    const { ctx, fiber } = await setup(undefined, false, backing)
    await ctx.remoteWorkspacePresets.inspect({ ...request, auth: { kind: 'key' } })
    expect(provisionRemoteWorkspace).toHaveBeenCalledWith(request, {})
    expect(await store.get(request.host)).toBeUndefined()
    await fiber.dispose()
  })

  it('accepts key login without a credential provider', async () => {
    const { ctx, fiber } = await setup()
    await expect(ctx.remoteWorkspacePresets.inspect({ ...request, auth: { kind: 'key' } })).resolves.toBeDefined()
    await fiber.dispose()
  })

  it('verifies again whenever a login choice is supplied, even for a verified workspace', async () => {
    const { ctx, fiber } = await setup(undefined, false, records())
    await ctx.remoteWorkspacePresets.ensure(request)
    await ctx.remoteWorkspacePresets.ensure(request)
    expect(provisionRemoteWorkspace).toHaveBeenCalledTimes(1)
    await ctx.remoteWorkspacePresets.inspect({ ...request, auth: { kind: 'password', password: SECRET } })
    expect(provisionRemoteWorkspace).toHaveBeenCalledTimes(2)
    await ctx.remoteWorkspacePresets.ensure(request)
    expect(provisionRemoteWorkspace).toHaveBeenCalledTimes(2)
    await fiber.dispose()
  })

  it('uses the password saved for the host when a session resumes', async () => {
    const backing = records()
    await new SshPasswordStore(backing).set(request.host, SECRET)
    const { ctx, fiber } = await setup(undefined, false, backing)
    await ctx.remoteWorkspacePresets.ensure(request)
    const auth = vi.mocked(provisionRemoteWorkspace).mock.calls[0]?.[1]
    expect(await auth?.passwords?.get(request.host)).toBe(SECRET)
    expect(auth?.password).toBeUndefined()
    await fiber.dispose()
  })

  it('refuses a password it cannot save, or that cannot be sent, before any SSH command runs', async () => {
    const { ctx, fiber } = await setup()
    await expect(ctx.remoteWorkspacePresets.inspect({ ...request, auth: { kind: 'password', password: SECRET } }))
      .rejects.toThrow('needs a credential provider')
    const withStore = await setup(undefined, false, records())
    await expect(withStore.ctx.remoteWorkspacePresets.inspect({ ...request, auth: { kind: 'password', password: 'two\nlines' } }))
      .rejects.toThrow('SSH password must be')
    expect(provisionRemoteWorkspace).not.toHaveBeenCalled()
    await withStore.fiber.dispose()
    await fiber.dispose()
  })

  it('forgets the password saved for a host, and does nothing without a credential provider', async () => {
    const backing = records()
    const store = new SshPasswordStore(backing)
    await store.set(request.host, SECRET)
    const { ctx, fiber } = await setup(undefined, false, backing)
    await ctx.remoteWorkspacePresets.forget(request.host)
    expect(await store.get(request.host)).toBeUndefined()
    await fiber.dispose()
    const bare = await setup()
    await expect(bare.ctx.remoteWorkspacePresets.forget(request.host)).resolves.toBeUndefined()
    await bare.fiber.dispose()
  })
})
