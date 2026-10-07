import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdater } from 'electron-updater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider.js'
import { SemVer } from 'semver'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { parseDesktopRelease } from '../src/release.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'
import { DesktopUpdatePreparationError } from '../src/update-error.ts'
import { zh } from '../src/locale.ts'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('electron-updater', () => ({
  default: { autoUpdater: { autoDownload: true, autoInstallOnAppQuit: true } },
}))

const { DesktopUpdateCoordinator } = await import('../src/update-coordinator.ts')

describe('desktop release metadata', () => {
  it('accepts one exact release identity for Electron and dsh', () => {
    expect(parseDesktopRelease({
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    })).toEqual({
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    })
  })

  it('rejects invalid versions and unsupported host protocols', () => {
    const base = {
      schemaVersion: 1,
      version: '1.2.3',
      hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: '24.17.0',
      pnpmVersion: '11.7.0',
    }
    expect(() => parseDesktopRelease({ ...base, version: 'latest' })).toThrow(/invalid desktop release metadata/u)
    expect(() => parseDesktopRelease({ ...base, hostProtocolVersion: 999 })).toThrow(/invalid desktop release metadata/u)
  })
})

const coordinators: InstanceType<typeof DesktopUpdateCoordinator>[] = []
afterEach(() => { for (const item of coordinators.splice(0)) item.dispose(); vi.restoreAllMocks() })

function fixture(currentVersion = '1.1.0-alpha.1') {
  const events = new EventEmitter()
  const checkForUpdates = vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '1.1.0-rc.2' },
  }))
  const downloadUpdate = vi.fn(async () => {
    events.emit('download-progress', { percent: 58 })
    events.emit('download-progress', { percent: 100 })
    events.emit('update-downloaded', { version: '1.1.0-rc.2' })
    return ['verified-package']
  })
  const quitAndInstall = vi.fn()
  const beforeRestart = vi.fn(async () => true)
  const downloadResult = vi.fn()
  const states: DesktopUpdateState[] = []
  const updater = Object.assign(events, { checkForUpdates, downloadUpdate, quitAndInstall }) as unknown as AppUpdater
  const coordinator = new DesktopUpdateCoordinator(
    (state) => { states.push(state); return state },
    beforeRestart, updater, () => true, () => currentVersion, downloadResult,
  )
  coordinators.push(coordinator)
  return { coordinator, updater, events, states, checkForUpdates, downloadUpdate, quitAndInstall, beforeRestart, downloadResult }
}

describe('desktop update coordinator', () => {
  it.each([
    { currentVersion: '0.3.0', nextVersion: '0.3.1', channel: 'latest', allowPrerelease: false },
    { currentVersion: '0.2.0-alpha.9.20261007.1', nextVersion: '0.3.0', channel: 'alpha', allowPrerelease: true },
  ])('resolves $currentVersion to $nextVersion through the shipped GitHub provider', async ({ currentVersion, nextVersion, channel, allowPrerelease }) => {
    const f = fixture(currentVersion)
    Object.defineProperty(f.updater, 'currentVersion', { value: new SemVer(currentVersion) })
    const executor = new ElectronHttpExecutor()
    const requests: string[] = []
    const feed = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>Preview</title><link href="https://github.com/review/fixture/releases/tag/v0.4.0-alpha.1"/><content>Preview</content></entry>
      <entry><title>Release</title><link href="https://github.com/review/fixture/releases/tag/v${nextVersion}"/><content>Release</content></entry></feed>`
    const request = vi.spyOn(executor, 'request').mockImplementation(async (options) => {
      const path = options.path ?? ''
      requests.push(path)
      if (path === '/review/fixture/releases.atom') return feed
      if (path === '/review/fixture/releases/latest') return JSON.stringify({ tag_name: `v${nextVersion}` })
      if (path === `/review/fixture/releases/download/v${nextVersion}/latest.yml`) {
        return `version: ${nextVersion}\nfiles:\n - url: fixture.exe\n   sha512: fixture\npath: fixture.exe\nsha512: fixture\n`
      }
      if (path === `/review/fixture/releases/download/v${nextVersion}/alpha.yml`) throw new Error('Fixture channel is absent')
      throw new Error(`Unexpected fixture request: ${path}`)
    })
    const provider = new GitHubProvider({ provider: 'github', owner: 'review', repo: 'fixture' }, f.updater,
      { platform: 'win32', executor, isUseMultipleRangeRequest: true })
    // Stable clients select GitHub's stable release; previews retain their selected channel.
    if (allowPrerelease) request.mockImplementationOnce(async () => feed.replace(/<entry><title>Preview<\/title>.*?<\/entry>\n/u, ''))
    f.checkForUpdates.mockImplementation(async () => ({ isUpdateAvailable: true, updateInfo: await provider.getLatestVersion() }))
    expect(await f.coordinator.check(true)).toEqual({ phase: 'available', version: nextVersion })
    expect(f.updater).toMatchObject({ channel, allowPrerelease, allowDowngrade: false })
    expect(requests).toContain(`/review/fixture/releases/download/v${nextVersion}/latest.yml`)
    if (allowPrerelease) expect(requests).toContain(`/review/fixture/releases/download/v${nextVersion}/alpha.yml`)
    else expect(requests).toContain('/review/fixture/releases/latest')
  })

  it('keeps safe preparation diagnostics separate and clears them on an explicit retry', async () => {
    const f = fixture()
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    f.beforeRestart.mockRejectedValueOnce(new DesktopUpdatePreparationError('stop-failed', zh.updateStopFailed, 'exit 0; shutdown acknowledged false'))
    expect(await f.coordinator.install('1.1.0-rc.2')).toEqual({ phase: 'error', version: '1.1.0-rc.2',
      failedOperation: 'install', preparationFailure: 'stop-failed', message: zh.updateStopFailed,
      technicalDetails: 'exit 0; shutdown acknowledged false' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    f.beforeRestart.mockResolvedValueOnce(false)
    expect(await f.coordinator.install('1.1.0-rc.2')).toEqual({ phase: 'ready', version: '1.1.0-rc.2' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })

  it('retains an asynchronous installer failure after quitAndInstall returns', async () => {
    const f = fixture()
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    await f.coordinator.install('1.1.0-rc.2')
    f.events.emit('error', new Error('installer could not start'))
    expect(f.coordinator.state).toMatchObject({ phase: 'error', failedOperation: 'install', message: 'installer could not start' })
  })

  it('waits for platform preparation after its downloaded event and rejects stale download approval', async () => {
    const f = fixture()
    const prepared = Promise.withResolvers<string[]>()
    f.downloadUpdate.mockImplementationOnce(async () => {
      f.events.emit('update-downloaded', { version: '1.1.0-rc.2' })
      return prepared.promise
    })
    await f.coordinator.check()
    await expect(f.coordinator.download('1.1.0-rc.1')).rejects.toThrow(/stale/u)
    const downloading = f.coordinator.download('1.1.0-rc.2')
    await Promise.resolve()
    await Promise.resolve()
    try {
      expect(f.coordinator.state.phase).not.toBe('ready')
      await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow(/not ready/u)
    } finally { prepared.resolve(['verified']); await downloading }
    expect(f.coordinator.state.phase).toBe('ready')
  })

  it('consumes late updater errors until an in-flight check settles after disposal', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const pending = f.coordinator.check()
    await Promise.resolve()
    f.coordinator.dispose()
    expect(() => f.events.emit('error', new Error('late network failure'))).not.toThrow()
    checked.reject(new Error('offline'))
    await pending
    await Promise.resolve()
    expect(f.events.listenerCount('error')).toBe(0)
  })

  it('checks, downloads on demand, then requires separate installation approval', async () => {
    const f = fixture()
    await f.coordinator.check()
    expect(f.downloadUpdate).not.toHaveBeenCalled()
    await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow(/not ready/u)
    await f.coordinator.download('1.1.0-rc.2')
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    expect(f.beforeRestart).not.toHaveBeenCalled()
    expect(f.coordinator.state).toEqual({ phase: 'ready', version: '1.1.0-rc.2' })
    await f.coordinator.install('1.1.0-rc.2')
    expect(f.beforeRestart).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(f.states.map(state => state.phase)).toEqual([
      'available', 'downloading', 'downloading', 'verifying', 'ready', 'installing',
    ])
    expect(f.updater).toMatchObject({
      autoDownload: false, autoInstallOnAppQuit: false, channel: 'alpha',
      allowPrerelease: true, allowDowngrade: false,
    })
  })

  it('joins checks and downloads without retargeting a prepared release', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const checking = f.coordinator.check()
    const manual = f.coordinator.check(true)
    const firstDownload = f.coordinator.download('1.1.0-rc.2')
    const secondDownload = f.coordinator.download('1.1.0-rc.2')
    checked.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.1.0-rc.2' } })
    await Promise.all([checking, manual, firstDownload, secondDownload])
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    await f.coordinator.check(true)
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    await expect(f.coordinator.install('1.2.0')).rejects.toThrow(/not ready/u)
  })

  it('keeps automatic failures silent and exposes a manual caller joining the same check', async () => {
    const f = fixture()
    f.checkForUpdates.mockRejectedValue(new Error('offline'))
    expect(await f.coordinator.check()).toMatchObject({ phase: 'error', failedOperation: 'check' })
    expect(f.states).toEqual([])
    await Promise.all([f.coordinator.check(), f.coordinator.check(true)])
    expect(f.states).toEqual([expect.objectContaining({ phase: 'error', failedOperation: 'check' })])
    expect(f.downloadUpdate).not.toHaveBeenCalled()
  })

  it.each(['1.0.0', '1.1.0-alpha.1', 'invalid'])('does not download or install inapplicable version %s', async (version) => {
    const f = fixture()
    f.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version } })
    await f.coordinator.check()
    await expect(f.coordinator.download('1.1.0-rc.2')).rejects.toThrow(/no checked update/u)
    expect(f.downloadUpdate).not.toHaveBeenCalled()
  })

  it('retains retry state after download failure and never equates 100 percent with readiness', async () => {
    const f = fixture()
    f.downloadUpdate.mockImplementationOnce(async () => {
      f.events.emit('download-progress', { percent: 100 })
      throw new Error('signature rejected')
    })
    await f.coordinator.check()
    expect(await f.coordinator.download('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'download' })
    await expect(f.coordinator.install('1.1.0-rc.2')).rejects.toThrow(/not ready/u)
    await f.coordinator.download('1.1.0-rc.2')
    expect(f.coordinator.state.phase).toBe('ready')
    expect(f.quitAndInstall).not.toHaveBeenCalled()
  })

  it('refuses handoff after failed task preparation while retaining the prepared package', async () => {
    const f = fixture()
    f.beforeRestart.mockRejectedValueOnce(new Error('tasks could not stop'))
    await f.coordinator.check()
    await f.coordinator.download('1.1.0-rc.2')
    expect(await f.coordinator.install('1.1.0-rc.2')).toMatchObject({ phase: 'error', failedOperation: 'install' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    await f.coordinator.install('1.1.0-rc.2')
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('does not publish late check completion after disposal', async () => {
    const f = fixture()
    const checked = Promise.withResolvers<{ isUpdateAvailable: boolean; updateInfo: { version: string } }>()
    f.checkForUpdates.mockImplementation(() => checked.promise)
    const pending = f.coordinator.check()
    f.coordinator.dispose()
    checked.resolve({ isUpdateAvailable: true, updateInfo: { version: '1.1.0-rc.2' } })
    await pending
    expect(f.states).toEqual([])
    expect(f.events.listenerCount('download-progress')).toBe(0)
  })
})


it('reports one download result when callers share an operation and none for cached readiness', async () => {
  const f = fixture()
  await f.coordinator.check()
  await Promise.all([f.coordinator.download('1.1.0-rc.2'), f.coordinator.download('1.1.0-rc.2')])
  await f.coordinator.download('1.1.0-rc.2')
  expect(f.downloadResult).toHaveBeenCalledExactlyOnceWith(true)
})


it.each([new DesktopUpdatePreparationError('stop-failed', 'private diagnostic'), new Error('private URL')])('reports safe download failure classification: %s', async (error) => {
  const f = fixture()
  await f.coordinator.check()
  f.downloadUpdate.mockRejectedValueOnce(error)
  await f.coordinator.download('1.1.0-rc.2')
  expect(f.downloadResult).toHaveBeenCalledExactlyOnceWith(false, error instanceof DesktopUpdatePreparationError ? 'stop-failed' : 'download_failed')
  expect(JSON.stringify(f.downloadResult.mock.calls)).not.toContain('private')
})
