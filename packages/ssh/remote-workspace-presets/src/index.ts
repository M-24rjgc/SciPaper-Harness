/** Dynamic Agent presets backed by one verified POSIX SSH workspace. */
import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { sshFailureOf, SshFailure, sshPasswordStoreOf, validateSshPassword, type SshPasswordStore } from '@deepseek-ai/dsh-ssh/auth'
import { scanHostKey, trustHostKey } from '@deepseek-ai/dsh-ssh/host-key'
import { provisionRemoteWorkspace, validateRemoteWorkspace, type RemoteWorkspaceAuth, type RemoteWorkspaceRequest, type RemoteWorkspaceRuntime } from './provision.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { remoteWorkspacePresets: RemoteWorkspacePresets }
}

/** Preset identity together with the path resolved on its SSH host. */
export interface RemoteWorkspacePreset {
  presetId: string
  canonicalPath: string
}

/**
 * The authentication a person chose while adding a workspace. `key` uses OpenSSH keys, agent and
 * configuration and forgets any saved password of the host; `password` is verified, then saved.
 */
export type RemoteWorkspaceAuthChoice =
  | { readonly kind: 'key' }
  | { readonly kind: 'password'; readonly password: string }

/** A workspace to verify, with the authentication chosen for its host when the person is adding it. */
export interface RemoteWorkspaceInspection extends RemoteWorkspaceRequest {
  /** Absent for a workspace that already exists, which uses the host's saved authentication. */
  readonly auth?: RemoteWorkspaceAuthChoice
  /**
   * The `SHA256:` fingerprint of an unknown host's key that the person confirmed. The key is recorded in
   * `known_hosts` only when it still matches; the connection itself stays strict.
   */
  readonly trustHostKey?: string
}

/** Product composition may explicitly include research tools when a shared ledger service is mounted. */
export interface Config {
  /** Include the research tool modules supplied by the shared research ledger. */
  researchTools?: boolean
}

function presetId(host: string, canonicalPath: string): string {
  return `ssh-${createHash('sha256').update(host).update('\0').update(canonicalPath).digest('hex').slice(0, 24)}`
}

/**
 * Attach the key an unknown host presents to a `host-key` failure, so the person can confirm its fingerprint.
 * Nothing is recorded here.
 * @param error - what adding the workspace threw.
 * @param host - the host spelling that was tried.
 * @returns a `host-key` failure carrying the key when it could be read safely, otherwise the error unchanged.
 */
async function withHostKey(error: unknown, host: string): Promise<unknown> {
  if (sshFailureOf(error) !== 'host-key') return error
  const offered = await scanHostKey(host)
  return offered === undefined ? error : new SshFailure('host-key', undefined, { type: offered.type, fingerprint: offered.fingerprint })
}

const RESEARCH_MODULES = [
  'project', 'evidence', 'artifact', 'environment', 'experiment',
  'board', 'media', 'knowledge', 'checks', 'tasks',
] as const

function composition(id: string, host: string, runtime: RemoteWorkspaceRuntime, researchTools: boolean): PresetDefinition {
  const remote = [
    { id: 'ssh', name: '@deepseek-ai/dsh-ssh', config: {
      host, node: runtime.node, helper: runtime.helper, helperHash: runtime.helperHash, workspace: runtime.canonicalPath,
    } },
    { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-ssh' },
    { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-ssh' },
    { id: 'fs', name: '@deepseek-ai/dsh-fs-ssh' },
    { id: 'shell', name: '@deepseek-ai/dsh-bash-sandbox', config: { cwd: runtime.canonicalPath } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'tool-presentation', name: '@deepseek-ai/dsh-agent-tool-presentation', config: { mode: 'native' } },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    ...runtime.rg === undefined ? [] : [{ id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: {
      sampleOverCapGlobResults: false, rgPath: runtime.rg,
    } }],
    { id: 'lsp', name: '@deepseek-ai/dsh-lsp' },
    { id: 'lsp-stdio', name: '@deepseek-ai/dsh-lsp-stdio', config: { servers: {
      typescript: {
        command: runtime.node,
        args: [runtime.typescriptLanguageServer, '--stdio'],
        extensionToLanguage: {
          '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript',
          '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript',
        },
      },
    } } },
    { id: 'tool-lsp', name: '@deepseek-ai/dsh-tool-lsp' },
  ]
  return {
    id, name: `${host}:${runtime.canonicalPath}`,
    plugins: [
      {
        id: 'remote-workspace', name: 'cordis:group', group: true,
        isolate: { ssh: true, subprocess: true, sandbox: true, fs: true, shell: true, lsp: true },
        config: remote,
      },
      ...!researchTools ? [] : RESEARCH_MODULES.map(module => ({
        id: `research-${module}`, name: '@deepseek-ai/dsh-research-workbench/tools', config: { modules: [module] },
      })),
    ],
  }
}

/** Registry owner for remotely verified and independently mounted SSH Agent presets. */
export class RemoteWorkspacePresets extends Service {
  static inject = ['agentPresets']
  static Config: schema<Config> = schema.object({ researchTools: schema.boolean().default(false) })
  private readonly pending = new Map<string, Promise<RemoteWorkspacePreset>>()
  /** Verifications that carry a new authentication choice; they are never reused and settle before shutdown. */
  private readonly choosing = new Set<Promise<RemoteWorkspacePreset>>()
  private readonly mounting = new Map<string, Promise<RemoteWorkspacePreset>>()
  private readonly mounted = new Map<string, RemoteWorkspacePreset>()
  private readonly disposers = new Map<string, () => Promise<void>>()
  private closed = false
  private readonly researchTools: boolean

  private isClosed(): boolean { return this.closed }

  /** Whether this service registered the requested preset for an SSH workspace.
   * @param id - preset identity to inspect.
   * @returns whether the preset is mounted or currently mounting here.
   */
  isRemotePreset(id: string): boolean { return this.mounted.has(id) || this.mounting.has(id) }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'remoteWorkspacePresets')
    this.researchTools = config.researchTools === true
    ctx.effect(() => async () => {
      this.closed = true
      await Promise.allSettled([...this.pending.values(), ...this.choosing])
      await Promise.all([...this.disposers.values()].map(dispose => dispose()))
      this.disposers.clear()
      this.mounted.clear()
    })
  }

  /** Verify the directory, install the helper, and register its Agent preset.
   * @param request - configured OpenSSH alias and absolute POSIX workspace.
   * @returns the mounted preset identity.
   */
  async ensure(request: RemoteWorkspaceRequest): Promise<string> { return (await this.inspect(request)).presetId }

  /** Resolve the canonical remote path and mounted preset for a Session header.
   * A request with an authentication choice is always verified again, and a password is saved only after it worked.
   * A request with a confirmed fingerprint first records that host key in `known_hosts`, unless the host has a
   * different key recorded.
   * @param request - SSH host, absolute POSIX workspace and, when a workspace is being added, how to authenticate
   * and which unknown-host fingerprint the person confirmed.
   * @returns preset identity and verified canonical directory.
   * @throws {SshFailure} when SSH reports a wrong password, an unreachable host or an untrusted host key; for an
   * unknown host key of a workspace being added, the failure carries the key's type and fingerprint.
   */
  async inspect(request: RemoteWorkspaceInspection): Promise<RemoteWorkspacePreset> {
    if (this.closed) throw new Error('Remote workspace preset service is closed')
    validateRemoteWorkspace(request)
    if (request.auth?.kind === 'password') validateSshPassword(request.auth.password)
    const key = `${request.host}\0${request.path}`
    if (request.trustHostKey !== undefined) await trustHostKey(request.host, request.trustHostKey)
    if (request.auth !== undefined) {
      // The coordinates alone travel on: nothing below needs the choice object that holds the password.
      try { return await this.choose(key, { host: request.host, path: request.path }, request.auth) }
      catch (error) { throw await withHostKey(error, request.host) }
    }
    const existing = this.pending.get(key)
    if (existing !== undefined) return existing
    const passwords = sshPasswordStoreOf(this.ctx)
    const operation = this.prepare(request, passwords === undefined ? {} : { passwords })
    this.pending.set(key, operation)
    try { return await operation } catch (error) { this.pending.delete(key); throw error }
  }

  /**
   * Forget the password saved for a host once no workspace uses it.
   * @param host - OpenSSH alias or `user@host[:port]`.
   */
  async forget(host: string): Promise<void> {
    await sshPasswordStoreOf(this.ctx)?.delete(host)
  }

  private async choose(key: string, request: RemoteWorkspaceRequest, choice: RemoteWorkspaceAuthChoice): Promise<RemoteWorkspacePreset> {
    const store = sshPasswordStoreOf(this.ctx)
    if (choice.kind === 'password' && store === undefined) throw new Error('Saving an SSH password needs a credential provider')
    // The choice is saved only after the host accepted it, so a typo never replaces a working password.
    const save = async (): Promise<void> => {
      if (choice.kind === 'password') await (store as SshPasswordStore).set(request.host, choice.password)
      else await store?.delete(request.host)
    }
    const operation = this.prepare(request, choice.kind === 'password' ? { password: choice.password } : {}, save)
    this.choosing.add(operation)
    try {
      const result = await operation
      this.pending.set(key, operation)
      return result
    } finally { this.choosing.delete(operation) }
  }

  private async prepare(
    request: RemoteWorkspaceRequest, auth: RemoteWorkspaceAuth, save?: () => Promise<void>,
  ): Promise<RemoteWorkspacePreset> {
    const runtime = await provisionRemoteWorkspace(request, auth)
    if (this.closed) throw new Error('Remote workspace preset service closed during SSH setup')
    await save?.()
    const id = presetId(request.host, runtime.canonicalPath)
    const existing = this.mounted.get(id)
    if (existing !== undefined) return existing
    const pending = this.mounting.get(id)
    if (pending !== undefined) return pending
    const mounting = this.mount(id, request.host, runtime)
    this.mounting.set(id, mounting)
    try { return await mounting } finally { this.mounting.delete(id) }
  }

  private async mount(id: string, host: string, runtime: RemoteWorkspaceRuntime): Promise<RemoteWorkspacePreset> {
    const unregister = await this.ctx.agentPresets.register(composition(id, host, runtime, this.researchTools))
    if (this.closed) { await unregister(); throw new Error('Remote workspace preset service closed during preset activation') }
    try {
      const resolved = await this.ctx.agentPresets.resolve(id)
      if (resolved.broken !== undefined) throw new Error(`SSH Agent preset could not start: ${resolved.broken}`)
    } catch (error) {
      await unregister()
      throw error
    }
    if (this.isClosed()) { await unregister(); throw new Error('Remote workspace preset service closed during preset verification') }
    const result = { presetId: id, canonicalPath: runtime.canonicalPath }
    this.mounted.set(id, result)
    this.disposers.set(id, unregister)
    return result
  }
}

export default RemoteWorkspacePresets
