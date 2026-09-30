import { describe, expect, it } from 'vitest'
import { patchAsarLibraryResolver, unpackedAsarLibraryPath } from '../src/asar-native.ts'

describe('packaged Cua native library path', () => {
  it('redirects only the app.asar path component to its real unpacked directory', () => {
    expect(unpackedAsarLibraryPath('R:\\resources\\app.asar\\dsh\\cua_driver_sdk.dll'))
      .toBe('R:\\resources\\app.asar.unpacked\\dsh\\cua_driver_sdk.dll')
    expect(unpackedAsarLibraryPath('/opt/app/resources/app.asar/dsh/libcua_driver_sdk.so'))
      .toBe('/opt/app/resources/app.asar.unpacked/dsh/libcua_driver_sdk.so')
    expect(unpackedAsarLibraryPath('C:\\other\\app.asar.unpacked\\driver.dll'))
      .toBe('C:\\other\\app.asar.unpacked\\driver.dll')
  })

  it('patches a shared resolver once and preserves ordinary paths', () => {
    let calls = 0
    const resolver = { resolveLibPath: (path: unknown): string => { calls++; return String(path) } }
    patchAsarLibraryResolver(resolver)
    const first = resolver.resolveLibPath
    patchAsarLibraryResolver(resolver)
    expect(resolver.resolveLibPath).toBe(first)
    expect(resolver.resolveLibPath('R:\\resources\\app.asar\\driver.dll'))
      .toBe('R:\\resources\\app.asar.unpacked\\driver.dll')
    expect(resolver.resolveLibPath('C:\\standalone\\driver.dll'))
      .toBe('C:\\standalone\\driver.dll')
    expect(calls).toBe(2)
  })
})
