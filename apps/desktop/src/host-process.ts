/** Electron Node-mode child lifecycle for the shared Web application. */

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { PlatformSession } from '@deepseek-ai/dsh-deepseek-account'
import type { DesktopBrowserOperation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { desktopNodeEnvironment } from './node-environment.ts'

interface ReadyEvent {
  readonly type: 'ready'
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

interface FatalEvent {
  readonly type: 'fatal'
  readonly message: string
  /** The Host's complete inspected error: stack, enumerable properties, cause chain. */
  readonly diagnostic?: string
}

interface PlatformSessionEvent {
  readonly type: 'platform-session'
  readonly session: PlatformSession | null
}

interface BrowserOperationEvent {
  readonly type: 'browser-operation'
  readonly requestId: number
  readonly operation: DesktopBrowserOperation
}

interface BrowserOperationCancelEvent {
  readonly type: 'browser-operation-cancel'
  readonly requestId: number
}

type DesktopHostEvent = ReadyEvent | FatalEvent | PlatformSessionEvent | BrowserOperationEvent
  | BrowserOperationCancelEvent | { readonly type: 'shutdown-complete' } | {
    readonly type: 'browser-authorize'
    readonly requestId: number
    readonly storageKey?: string
    readonly error?: string
  } | {
    readonly type: 'update-tasks'
    readonly requestId: number
    readonly active: boolean
    readonly error?: string
  } | {
    readonly type: 'quit-inspection'
    readonly requestId: number
    readonly activeTasks: boolean
    readonly scheduledTasks: boolean
    readonly error?: string
  }

/** Correlated answer to one shell control request. */
type DesktopHostControlResponse = Extract<DesktopHostEvent, { readonly requestId: number }>

/** What quitting now would affect, as reported by the Host. */
export interface DesktopQuitInspection {
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
}

/** Quit inspection deadline; a slower Host counts as unknown work and the shell asks before quitting. */
export const QUIT_INSPECTION_DEADLINE_MS = 2_000

const MAX_HOST_DIAGNOSTIC_CHARS = 64 * 1024

function isBrowserOperation(value: unknown): value is DesktopBrowserOperation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0 || candidate.sessionId.length > 256
    || (candidate.tabId !== undefined && (typeof candidate.tabId !== 'string' || candidate.tabId.length > 128))) return false
  switch (candidate.action) {
    case 'list': case 'inspect': case 'screenshot': return true
    case 'click': return typeof candidate.selector === 'string' && candidate.selector.length > 0 && candidate.selector.length <= 1024
    case 'type': return typeof candidate.selector === 'string' && candidate.selector.length > 0 && candidate.selector.length <= 1024
      && typeof candidate.text === 'string' && candidate.text.length <= 4096
    case 'scroll': return typeof candidate.deltaY === 'number' && Number.isFinite(candidate.deltaY)
      && Math.abs(candidate.deltaY) <= 3000
    case 'navigate': return typeof candidate.url === 'string' && candidate.url.length <= 4096
    default: return false
  }
}

function isDesktopHostEvent(message: unknown): message is DesktopHostEvent {
  if (typeof message !== 'object' || message === null || !('type' in message)) return false
  const candidate = message as Record<string, unknown>
  switch (candidate.type) {
    case 'shutdown-complete':
      return true
    case 'ready':
      return typeof candidate.url === 'string'
    case 'platform-session': {
      const session = candidate.session
      if (session === null) return true
      if (typeof session !== 'object' || !('origin' in session) || !('token' in session)
        || typeof session.origin !== 'string' || typeof session.token !== 'string' || session.token.length === 0) return false
      if (!('userId' in session) || (session.userId !== null
        && (typeof session.userId !== 'string' || session.userId.length === 0))) return false
      if ('embeddedPageDist' in session && typeof session.embeddedPageDist !== 'string') return false
      if ('requestHeaders' in session && (typeof session.requestHeaders !== 'object' || session.requestHeaders === null
        || Array.isArray(session.requestHeaders)
        || Object.entries(session.requestHeaders).some(([name, value]) => typeof value !== 'string'
          || name !== name.toLowerCase() || /[\r\n]/.test(value)
          || ['authorization', 'x-dsh-auth-token', 'host', 'content-length', 'transfer-encoding', 'connection', 'content-type'].includes(name)))) return false
      try {
        const url = new URL(session.origin)
        return url.origin === session.origin && !url.username && !url.password
          && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      } catch { return false }
    }
    case 'fatal':
      return typeof candidate.message === 'string' && (candidate.diagnostic === undefined || typeof candidate.diagnostic === 'string')
    case 'update-tasks':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.active === 'boolean'
        && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'quit-inspection':
      return Number.isSafeInteger(candidate.requestId) && typeof candidate.activeTasks === 'boolean'
        && typeof candidate.scheduledTasks === 'boolean' && (candidate.error === undefined || typeof candidate.error === 'string')
    case 'browser-operation':
      return Number.isSafeInteger(candidate.requestId) && isBrowserOperation(candidate.operation)
    case 'browser-operation-cancel':
      return Number.isSafeInteger(candidate.requestId)
    case 'browser-authorize':
      return Number.isSafeInteger(candidate.requestId)
        && ((typeof candidate.storageKey === 'string' && candidate.storageKey.length > 0 && candidate.error === undefined)
          || (typeof candidate.error === 'string' && candidate.storageKey === undefined))
    default:
      return false
  }
}

async function exitsWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => { resolve(false) }, milliseconds)
    timer.unref()
  })
  try {
    return await Promise.race([exit.then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Browser authentication URL reported by the running Web application. */
export interface DesktopHostReady {
  readonly url: string
  readonly injections?: readonly unknown[] | undefined
}

/** The child has exited, but task teardown did not finish successfully. */
export class DesktopHostUncleanExitError extends Error {}

/**
 * A Host failure reported over IPC before the process exited. `message` is what
 * the Host chose to show; `diagnostic` is its complete inspected error, kept
 * separately so a crash report can print it verbatim instead of a string escaped
 * inside another error's properties.
 */
export class DesktopHostFatalError extends Error {
  readonly #diagnostic: string | undefined

  /**
   * @param message - The Host's failure message.
   * @param diagnostic - The Host's inspected error, when the Host supplied one.
   */
  constructor(message: string, diagnostic: string | undefined) {
    super(message)
    this.#diagnostic = diagnostic
  }

  /** The Host's inspected error; a getter so `util.inspect` of this error does not repeat it as an escaped property. */
  get diagnostic(): string | undefined { return this.#diagnostic }
}

/** One Web backend running under the Electron executable in Node mode. */
export class DesktopHostProcess {
  private child: ChildProcess | undefined
  private readyResolve!: (ready: DesktopHostReady) => void
  private readyReject!: (error: Error) => void
  private readonly readyPromise = new Promise<DesktopHostReady>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private exitPromise: Promise<void> | undefined
  private stderr = ''
  private failureReported = false
  private stopping = false
  private shutdownCompleted = false
  private nextControlId = 1
  private readonly controlRequests = new Map<number, {
    resolve: (response: DesktopHostControlResponse) => void
    reject: (error: Error) => void
  }>()
  private readonly browserOperations = new Map<number, AbortController>()

  /**
   * @param node - Absolute Electron executable in Node mode.
   * @param runtimeDir - Immutable packages carried by the current application.
   * @param projectDir - Desktop plugin profile and child working directory.
   * @param inspectPort - Optional loopback inspector port for workspace development.
   * @param environment - Environment inherited by the Host and its plugin subprocesses.
   * @param onFailure - Receives the first unexpected child failure, including after readiness.
   * @param primaryRuntime - Optional bundled dependency payload; when supplied, missing sibling
   *   `office-skills` resources fail Host startup.
   * @param packageManager - Bundled pnpm entry and Node launcher directory, scoped to package operations.
   * @param onPlatformSession - Private credential updates for embedded Platform views.
   */
  constructor(
    private readonly node: string,
    private readonly runtimeDir: string,
    private readonly projectDir: string,
    private readonly inspectPort?: number,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly onFailure?: (error: Error) => void,
    private readonly primaryRuntime?: string,
    private readonly packageManager?: { readonly pnpm: string; readonly nodeBin: string },

    private readonly onPlatformSession?: (session: PlatformSession | null) => void,
    private readonly onBrowserOperation?: (operation: DesktopBrowserOperation, signal: AbortSignal) => Promise<unknown>,
  ) {}

  /**
   * Start this child once and await its Web application URL.
   * @returns Ready facts supplied by the child after application startup.
   */
  async start(): Promise<DesktopHostReady> {
    if (this.child !== undefined) return this.readyPromise
    const entry = join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
    const child = spawn(this.node, [
      '--expose-internals',
      ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${String(this.inspectPort)}`]),
      entry,
      this.runtimeDir,
      this.projectDir,
      this.primaryRuntime ?? join(this.runtimeDir, '..', 'runtime', 'primary-runtime'),
      ...this.packageManager === undefined ? [] : [this.packageManager.pnpm, this.packageManager.nodeBin],
    ], {
      cwd: this.projectDir,
      windowsHide: true,
      env: desktopNodeEnvironment(this.node, undefined, this.environment),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-MAX_HOST_DIAGNOSTIC_CHARS) })
    child.stdout?.pipe(process.stdout)
    child.on('message', (message: unknown) => {
      if (!isDesktopHostEvent(message)) {
        this.fail(new Error('dsh desktop host sent an invalid IPC event'))
        child.kill('SIGTERM')
        return
      }
      if (message.type === 'ready') this.readyResolve({ url: message.url, injections: message.injections })
      else if (message.type === 'platform-session') this.onPlatformSession?.(message.session)
      else if (message.type === 'shutdown-complete') {
        if (this.stopping) this.shutdownCompleted = true
        else this.fail(new Error('dsh desktop host acknowledged an unrequested shutdown'))
      }
      else if (message.type === 'fatal') this.fail(new DesktopHostFatalError(message.message, message.diagnostic))
      else if (message.type === 'browser-operation') {
        if (this.browserOperations.has(message.requestId)) {
          this.fail(new Error('dsh desktop host reused a browser operation ID'))
          child.kill('SIGTERM')
          return
        }
        const controller = new AbortController()
        this.browserOperations.set(message.requestId, controller)
        void Promise.resolve().then(() => {
          if (this.stopping || this.onBrowserOperation === undefined) throw new Error('desktop browser: Host is unavailable')
          controller.signal.throwIfAborted()
          return this.onBrowserOperation(message.operation, controller.signal)
        }).then((value) => {
          if (child.connected) child.send({ type: 'browser-operation-result', requestId: message.requestId, value })
        }, (error: unknown) => {
          if (child.connected) child.send({ type: 'browser-operation-result', requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error) })
        }).finally(() => { this.browserOperations.delete(message.requestId) })
      }
      else if (message.type === 'browser-operation-cancel') this.browserOperations.get(message.requestId)?.abort()
      else {
        const request = this.controlRequests.get(message.requestId)
        if (message.error === undefined) request?.resolve(message)
        else request?.reject(new Error(message.error))
      }
    })
    child.once('error', (error) => { this.fail(error) })
    this.exitPromise = new Promise<void>((resolve) => {
      child.once('close', (code) => {
        const suffix = this.stderr.trim() === '' ? '' : `: ${this.stderr.trim()}`
        if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with ${String(code)}${suffix}`))
        else this.fail(new Error(`dsh desktop host stopped${suffix}`))
        resolve()
      })
    })
    return this.readyPromise
  }

  /**
   * Inspect active work or lock request admission for update handoff.
   * @param action - Read-only inspection, admission lock, or recovery unlock.
   * @returns Whether live tasks would be affected. Locking drains admitted API requests before inspecting tasks;
   * an unanswered drain fails at the control-request deadline without authorizing installation.
   */
  async updateTasks(action: 'inspect' | 'lock' | 'unlock'): Promise<boolean> {
    const response = await this.control({ type: 'update-tasks', action }, 10_000, 'desktop update: task inspection timed out')
    if (response.type !== 'update-tasks') throw new Error('desktop update: Host answered with a different control response')
    return response.active
  }

  /**
   * Ask the Host what quitting now would interrupt.
   * @returns Active tasks and armed scheduled reminders; rejects when the Host is unavailable or misses
   * {@link QUIT_INSPECTION_DEADLINE_MS}, and the shell then asks before quitting.
   */
  async inspectQuit(): Promise<DesktopQuitInspection> {
    const response = await this.control({ type: 'quit-inspection' }, QUIT_INSPECTION_DEADLINE_MS, 'desktop quit: inspection timed out')
    if (response.type !== 'quit-inspection') throw new Error('desktop quit: Host answered with a different control response')
    return { activeTasks: response.activeTasks, scheduledTasks: response.scheduledTasks }
  }

  /** Ask the Host for a real conversation's canonical browser storage identity. */
  async authorizeBrowser(sessionId: string): Promise<string> {
    if (!sessionId || sessionId.length > 256) throw new Error('desktop browser: invalid conversation identity')
    const response = await this.control({ type: 'browser-authorize', sessionId }, 10_000,
      'desktop browser: authorization timed out')
    if (response.type !== 'browser-authorize' || response.storageKey === undefined) {
      throw new Error('desktop browser: Host answered with a different control response')
    }
    return response.storageKey
  }

  private async control(
    request: { readonly type: 'update-tasks'; readonly action: 'inspect' | 'lock' | 'unlock' }
      | { readonly type: 'quit-inspection' } | { readonly type: 'browser-authorize'; readonly sessionId: string },
    deadlineMs: number, deadlineMessage: string,
  ): Promise<DesktopHostControlResponse> {
    const child = this.child
    if (child === undefined || !child.connected || this.failureReported || this.stopping) {
      throw new Error(`${request.type === 'update-tasks' ? 'desktop update'
        : request.type === 'browser-authorize' ? 'desktop browser' : 'desktop quit'}: Host is unavailable`)
    }
    const requestId = this.nextControlId++
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<DesktopHostControlResponse>((resolve, reject) => {
        this.controlRequests.set(requestId, { resolve, reject })
        timer = setTimeout(() => { reject(new Error(deadlineMessage)) }, deadlineMs)
        child.send({ ...request, requestId }, (error) => { if (error != null) reject(error) })
      })
    } finally {
      clearTimeout(timer)
      this.controlRequests.delete(requestId)
    }
  }

  /**
   * Request teardown and await child exit, escalating termination when needed.
   * @param requireGraceful - Reject update handoff after forced termination or unsuccessful child exit.
   * @returns Completion of owned process teardown. DesktopHostUncleanExitError confirms exit but refuses installation;
   * other failures do not confirm exit.
   */
  async stop(requireGraceful = false): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.stopping = true
    for (const controller of this.browserOperations.values()) controller.abort()
    this.onPlatformSession?.(null)
    if (child.connected) child.send({ type: 'shutdown' }, (error) => { if (error !== null) this.fail(error) })
    const exited = this.exitPromise ?? Promise.resolve()
    const graceful = await exitsWithin(exited, 10_000)
    if (!graceful) child.kill('SIGTERM')
    if (!await exitsWithin(exited, 5_000)) {
      child.kill('SIGKILL')
      if (!await exitsWithin(exited, 5_000)) {
        throw new Error('dsh desktop host did not exit after SIGKILL')
      }
    }
    this.child = undefined
    if (requireGraceful && (!graceful || child.exitCode !== 0 || !this.shutdownCompleted)) {
      // This diagnostic reaches expandable UI; arbitrary plugin stderr can contain credentials.
      throw new DesktopHostUncleanExitError(`desktop update: Host did not complete graceful task teardown (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, shutdown acknowledged ${String(this.shutdownCompleted)}, graceful deadline exceeded ${String(!graceful)})`)
    }
  }

  private fail(error: Error): void {
    for (const controller of this.browserOperations.values()) controller.abort()
    this.onPlatformSession?.(null)
    this.readyReject(error)
    for (const request of this.controlRequests.values()) request.reject(error)
    this.controlRequests.clear()
    if (!this.failureReported && !this.stopping) {
      this.failureReported = true
      try { this.onFailure?.(error) } catch (listenerError) {
        console.error('desktop host failure listener failed', listenerError)
      }
    }
  }
}
