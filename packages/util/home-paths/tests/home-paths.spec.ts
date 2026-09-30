import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultDshHome,
  dshCachePath,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  resolveDshHome,
} from '@deepseek-ai/dsh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dsh path helpers', () => {
  it('owns the shared default home directory name', () => {
    expect(DSH_HOME_DIR_NAME).toBe('.research-workbench')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.research-workbench')
    expect(defaultDshHome()).toBe(join(homedir(), '.research-workbench'))
  })

  it('never defaults onto an official DeepSeek Harness installation', () => {
    // This product installs beside a DSH install, not over it. A default of
    // `.dsh` would put its sessions, storages, settings and profiles into the
    // other installation's data. Resolution runs before any configuration
    // loads, so no bundle or launcher can correct it afterwards.
    const official = join(homedir(), '.dsh')

    expect(defaultDshHome()).not.toBe(official)
    expect(resolveDshHome(undefined, {})).not.toBe(resolve(official))
    expect(dshCachePath()).not.toContain(`${sep}.dsh${sep}`)
    // The override still reaches it, for a caller that asks on purpose.
    expect(resolveDshHome(undefined, { DSH_HOME: official })).toBe(resolve(official))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('~\\.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('/tmp/.dsh')).toBe('/tmp/.dsh')
    expect(expandHomePath('~other/.dsh')).toBe('~other/.dsh')
  })

  it('resolves explicit path before DSH_HOME and the default', () => {
    const envHome = join(homedir(), 'env-dsh')

    expect(resolveDshHome('/tmp/explicit-dsh', { DSH_HOME: '~/env-dsh' })).toBe(resolve('/tmp/explicit-dsh'))
    expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' })).toBe(envHome)
    expect(resolveDshHome(undefined, {})).toBe(defaultDshHome())
  })

  it('treats an empty or whitespace-only DSH_HOME as unset', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '' })).toBe(defaultDshHome())
    expect(resolveDshHome(undefined, { DSH_HOME: '   ' })).toBe(defaultDshHome())
  })

  it('joins child segments onto the resolved DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    expect(dshHomePath()).toBe(join(homedir(), 'env-dsh'))
    expect(dshHomePath('storages', 'cache')).toBe(join(homedir(), 'env-dsh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(dshHomeDisplay(resolve(defaultDshHome()))).toBe('~/.research-workbench')
    expect(dshHomeDisplay('/some/other/root')).toBe('$DSH_HOME')
  })

  it.each([
    [undefined, join(homedir(), '.research-workbench')],
    ['', join(homedir(), '.research-workbench')],
    ['   ', join(homedir(), '.research-workbench')],
    ['~/env-dsh', join(homedir(), 'env-dsh')],
    ['./relative-dsh', resolve('./relative-dsh')],
  ] as const)('resolves cache paths with DSH_HOME=%j', (home, expectedHome) => {
    vi.stubEnv('DSH_HOME', home)
    try {
      expect(dshCachePath()).toBe(join(expectedHome, 'cache'))
      expect(dshCachePath('models', 'index.json')).toBe(join(expectedHome, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolves configured cache homes before the environment', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    try {
      expect(dshCachePath({ dshHome: '~/explicit-dsh' })).toBe(join(homedir(), 'explicit-dsh', 'cache'))
      expect(dshCachePath({ dshHome: './explicit-dsh' }, 'attachments', 'request-images'))
        .toBe(resolve('./explicit-dsh/cache/attachments/request-images'))
      expect(dshCachePath({}, 'attachments')).toBe(join(homedir(), 'env-dsh', 'cache', 'attachments'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(alias)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
