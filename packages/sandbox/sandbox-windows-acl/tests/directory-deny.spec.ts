/** Directory-tree preparation, handle ownership and failure-before-root-commit checks. */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import koffi from 'koffi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withDirectoryDenies } from '../src/directory-deny.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import * as abi from '../src/win32-abi.ts'

const PVOID = koffi.pointer('void')
const scratch: string[] = []

/** The tested directory helper calls only this fixture's checked binding subset. */
function bindingTable(api: Partial<Win32Bindings>): Win32Bindings {
  return api as Win32Bindings
}

/** One actual directory tree with mocked security APIs; filesystem enumeration stays real. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-directory-deny-'))
  scratch.push(root)
  const child = join(root, 'child')
  mkdirSync(child)
  writeFileSync(join(child, 'file.txt'), 'unchanged')
  const paths = new Map<NativePtr, string>()
  const closed: string[] = []
  const state = { attributes: abi.FILE_ATTRIBUTE_DIRECTORY, read: 0, merge: 0, apply: 0, nullDacl: false, nullMerged: false }
  const api = {
    createFileW: vi.fn((path: string, _access: number, _share: number, _security: NativePtr | null,
      _creation: number, _flags: number, _template: NativePtr | null) => {
      const handle = BigInt(paths.size + 1) as NativePtr
      paths.set(handle, path)
      return handle
    }),
    closeHandle: vi.fn((handle: NativePtr) => { closed.push(paths.get(handle)!); return 1 }),
    getFileInformationByHandleEx: vi.fn((_handle: NativePtr, _cls: number, info: Buffer) => {
      info.writeUInt32LE(state.attributes, 0)
      return 1
    }),
    getSecurityInfo: vi.fn((_handle: NativePtr, _type: number, _info: number, _owner: null,
      _group: null, dacl: NativePtr, _sacl: null, descriptor: NativePtr) => {
      if (state.read !== 0) return state.read
      koffi.encode(dacl, PVOID, state.nullDacl ? 0n : 88n)
      koffi.encode(descriptor, PVOID, 66n)
      return 0
    }),
    setEntriesInAclW: vi.fn((_count: number, _entry: Buffer, _old: NativePtr, slot: NativePtr) => {
      if (state.merge !== 0) return state.merge
      koffi.encode(slot, PVOID, state.nullMerged ? 0n : 99n)
      return 0
    }),
    setSecurityInfo: vi.fn(() => state.apply),
    localFree: vi.fn(() => 0n as NativePtr),
    getLastError: vi.fn(() => 5),
    formatMessageW: vi.fn(() => 0),
  } satisfies Partial<Win32Bindings>
  return { root, child, api, closed, paths, state }
}

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true })
})

describe('directory delete restrictions', () => {
  it('prepares each directory once, skips files, and holds the root until its commit', () => {
    const { root, child, api, closed } = fixture()
    const grandchild = join(child, 'grandchild')
    mkdirSync(grandchild)
    const entry = Buffer.alloc(48)
    const matches = vi.fn(() => false)
    const commit = vi.fn(() => {
      expect(closed).toEqual([grandchild, child])
      expect(api.setSecurityInfo).toHaveBeenCalledTimes(2)
    })
    withDirectoryDenies(bindingTable(api), root, entry, matches, commit)
    expect(commit).toHaveBeenCalledOnce()
    expect(closed).toEqual([grandchild, child, root])
    expect(api.createFileW).toHaveBeenCalledWith(root, abi.DIRECTORY_METADATA_ACCESS,
      abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE, null, abi.OPEN_EXISTING,
      abi.FILE_FLAG_BACKUP_SEMANTICS | abi.FILE_FLAG_OPEN_REPARSE_POINT, null)
    expect(api.setSecurityInfo).toHaveBeenCalledWith(2n, abi.SE_FILE_OBJECT,
      abi.DACL_SECURITY_INFORMATION, null, null, 99n, null)
  })

  it('still scans already prepared child directories without rewriting them', () => {
    const { root, api } = fixture()
    const commit = vi.fn()
    withDirectoryDenies(bindingTable(api), root, Buffer.alloc(48), () => true, commit)
    expect(api.getSecurityInfo).toHaveBeenCalledOnce()
    expect(api.setEntriesInAclW).not.toHaveBeenCalled()
    expect(api.localFree).toHaveBeenCalledWith(66n)
    expect(commit).toHaveBeenCalledOnce()
  })

  it('uses write-DACL access when a running process holds a child as its cwd', () => {
    const { root, child, api } = fixture()
    const open = api.createFileW
    vi.mocked(api.getLastError).mockReturnValue(abi.ERROR_SHARING_VIOLATION)
    api.createFileW = vi.fn((path, access, ...args) => path === child && access === abi.MAXIMUM_ALLOWED
      ? -1n as NativePtr : open(path, access, ...args))
    const commit = vi.fn()
    withDirectoryDenies(bindingTable(api), root, Buffer.alloc(48), () => false, commit)
    expect(api.createFileW).toHaveBeenCalledWith(child, abi.DIRECTORY_METADATA_ACCESS | abi.WRITE_DAC,
      abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE, null, abi.OPEN_EXISTING,
      abi.FILE_FLAG_BACKUP_SEMANTICS | abi.FILE_FLAG_OPEN_REPARSE_POINT, null)
    expect(commit).toHaveBeenCalledOnce()
  })

  it('reports a failed handle close alongside the preparation error', () => {
    const { root, api, state, closed } = fixture()
    state.apply = 5
    const close = api.closeHandle
    api.closeHandle = vi.fn((handle: NativePtr) => { close(handle); return 0 })
    const commit = vi.fn()
    expect(() => { withDirectoryDenies(bindingTable(api), root, Buffer.alloc(48), () => false, commit) }).toThrow(AggregateError)
    expect(closed).toHaveLength(2)
    expect(commit).not.toHaveBeenCalled()
  })

  it.each(['read', 'merge', 'apply'] as const)('does not commit root authority after a child %s failure', (operation) => {
    const { root, child, api, state, closed } = fixture()
    state[operation] = 5
    const commit = vi.fn()
    expect(() => { withDirectoryDenies(bindingTable(api), root, Buffer.alloc(48), () => false, commit) }).toThrow()
    expect(commit).not.toHaveBeenCalled()
    expect(closed).toEqual([child, root])
    if (operation === 'apply') expect(api.localFree).toHaveBeenCalledWith(99n)
    if (operation !== 'read') expect(api.localFree).toHaveBeenCalledWith(66n)
  })

  it.each(['nullDacl', 'nullMerged'] as const)('fails closed on %s and frees the descriptor', (operation) => {
    const { root, api, state } = fixture()
    state[operation] = true
    const commit = vi.fn()
    expect(() => { withDirectoryDenies(bindingTable(api), root, Buffer.alloc(48), () => false, commit) }).toThrow()
    expect(commit).not.toHaveBeenCalled()
    expect(api.localFree).toHaveBeenCalledWith(66n)
  })

  it('skips links without opening or changing their external target', () => {
    const { root, api, paths } = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'dsh-directory-outside-'))
    scratch.push(outside)
    const link = join(root, 'linked')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      withDirectoryDenies(bindingTable(api), root, Buffer.alloc(48), () => false, () => undefined)
      expect([...paths.values()]).not.toContain(link)
      expect([...paths.values()]).not.toContain(outside)
    } finally { unlinkSync(link) }
  })

  it('rejects a root handle that is a reparse point before root commit', () => {
    const { root, api, state } = fixture()
    state.attributes |= abi.FILE_ATTRIBUTE_REPARSE_POINT
    const commit = vi.fn()
    expect(() => { withDirectoryDenies(bindingTable(api), root, Buffer.alloc(48), () => false, commit) }).toThrow(/reparse point/u)
    expect(api.getSecurityInfo).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it('attempts both allocation frees and prevents root commit when cleanup fails', () => {
    const { root, api } = fixture()
    vi.mocked(api.localFree).mockReturnValue(1n as NativePtr)
    const commit = vi.fn()
    expect(() => { withDirectoryDenies(bindingTable(api), root, Buffer.alloc(48), () => false, commit) }).toThrow(AggregateError)
    expect(api.localFree).toHaveBeenCalledWith(99n)
    expect(api.localFree).toHaveBeenCalledWith(66n)
    expect(commit).not.toHaveBeenCalled()
  })
})
