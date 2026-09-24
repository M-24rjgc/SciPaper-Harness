import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const RELEASE_ENVIRONMENT = { DSH_DESKTOP_APP_ID: 'io.github.m-24rjgc.scipaper-harness', DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_UNSIGNED: '1' }

/** Edge lengths stored in an .ico file, in directory order (0 in the directory means 256). */
function icoSizes(file: Buffer): number[] {
  expect(file.readUInt16LE(2)).toBe(1)
  return Array.from({ length: file.readUInt16LE(4) }, (_, index) => file.readUInt8(6 + 16 * index) || 256)
}

describe('the app icon', () => {
  it('names the flask icon for the exe, the installer, the uninstaller and the other platforms', async () => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    const config = createElectronBuilderConfig(RELEASE_ENVIRONMENT, 'win32', 'x64')
    const windows = [config.win.icon, config.nsis.installerIcon, config.nsis.uninstallerIcon, config.nsis.installerHeaderIcon]
    expect(new Set(windows).size).toBe(1)
    expect(config.win.icon.endsWith('icon.ico')).toBe(true)
    for (const path of [config.win.icon, config.mac.icon, config.linux.icon]) expect(existsSync(path)).toBe(true)
  })

  it('carries every size the Windows shell draws, from the title bar to the large tile', async () => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    const icon = readFileSync(createElectronBuilderConfig(RELEASE_ENVIRONMENT, 'win32', 'x64').win.icon)
    expect(icoSizes(icon)).toEqual([16, 20, 24, 32, 40, 48, 64, 256])
  })

  it('gives the web page the same flask instead of the upstream mark', () => {
    const favicon = readFileSync(new URL('../../web/public/favicon.svg', import.meta.url), 'utf8')
    expect(favicon).toBe(readFileSync(new URL('../icons/icon-small.svg', import.meta.url), 'utf8'))
    const manifest = JSON.parse(readFileSync(new URL('../../web/public/manifest.webmanifest', import.meta.url), 'utf8')) as { icons: { src: string }[] }
    for (const { src } of manifest.icons) expect(existsSync(new URL(`../../web/public${src}`, import.meta.url))).toBe(true)
  })
})
