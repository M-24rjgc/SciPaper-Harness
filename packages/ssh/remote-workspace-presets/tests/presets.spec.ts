import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import RemoteWorkspacePresets from '../src/index.ts'

vi.mock('../src/provision.ts', async original => ({
  ...await original<typeof import('../src/provision.ts')>(),
  provisionRemoteWorkspace: vi.fn(async () => ({
    node: '/usr/bin/node', helper: '/home/alice/.scipaper-harness/ssh-helper/hash/helper.mjs',
    helperHash: 'a'.repeat(64), canonicalPath: '/srv/research', rg: '/usr/bin/rg',
    typescriptLanguageServer: '/usr/bin/typescript-language-server',
  })),
}))

async function setup(broken?: string, researchTools = true) {
  const ctx = new Context()
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
})
