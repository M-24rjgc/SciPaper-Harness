/** Directory-handle preparation that prevents explicit child allows from overriding inherited delete restrictions. */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { allocPtrSlot, decodePtr, isInvalidHandle, isNullPtr, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import * as abi from './win32-abi.ts'

/** Add a directory's explicit deny without propagating its subtree or changing its owner and label. */
function applyDeny(api: Win32Bindings, handle: NativePtr, path: string, entry: Buffer, matches: (acl: NativePtr) => boolean): void {
  const daclSlot = allocPtrSlot()
  const descriptorSlot = allocPtrSlot()
  const result = api.getSecurityInfo(handle, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
    null, null, daclSlot, null, descriptorSlot)
  if (result !== abi.ERROR_SUCCESS) throwWin32(api, 'GetSecurityInfo', result, path)
  const descriptor = decodePtr(descriptorSlot)
  let merged: NativePtr | null = null
  let failed = false
  let failure: unknown
  try {
    const oldAcl = decodePtr(daclSlot)
    if (oldAcl === null) throw new Error(`Cannot prepare directory with a NULL DACL: ${path}`)
    if (matches(oldAcl)) return
    const mergedSlot = allocPtrSlot()
    const mergeResult = api.setEntriesInAclW(1, entry, oldAcl, mergedSlot)
    if (mergeResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetEntriesInAclW', mergeResult, path)
    merged = decodePtr(mergedSlot)
    if (merged === null) throw new Error(`SetEntriesInAclW returned no directory DACL: ${path}`)
    const applied = api.setSecurityInfo(handle, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION,
      null, null, merged, null)
    if (applied !== abi.ERROR_SUCCESS) throwWin32(api, 'SetSecurityInfo', applied, path)
  } catch (error) {
    failed = true
    failure = error
    throw error
  } finally {
    const cleanupFailures: unknown[] = []
    for (const allocation of [merged, descriptor]) {
      if (allocation === null) continue
      try {
        if (!isNullPtr(api.localFree(allocation))) throwLastError(api, 'LocalFree', path)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(failed ? [failure, ...cleanupFailures] : cleanupFailures, `Directory DACL cleanup failed: ${path}`)
    }
  }
}

/**
 * Prepare every real child directory before committing a root's capability and Low label.
 * MAXIMUM_ALLOWED child handles make SetSecurityInfo update only the selected object.
 * A directory held as another process's cwd needs metadata/write-DACL access instead;
 * that exceptional update may propagate its deny to descendants. The root only needs
 * metadata access while its separate named-security commit performs normal inheritance.
 * Keeps ancestors open without delete sharing and opens leaves without following reparse points.
 * A failed scan or deny prevents the root commit; successful deny-only changes remain restrictive.
 * @param api - active Win32 bindings.
 * @param root - the directory receiving the root grant.
 * @param entry - the container-inheritable Everyone FILE_DELETE_CHILD deny.
 * @param matches - whether a DACL already carries that explicit deny.
 * @param action - root commit after complete preparation, with its directory handle still open.
 */
export function withDirectoryDenies(
  api: Win32Bindings,
  root: string,
  entry: Buffer,
  matches: (acl: NativePtr) => boolean,
  action: () => void,
): void {
  function visit(path: string, isRoot: boolean): void {
    let handle = api.createFileW(path, isRoot ? abi.DIRECTORY_METADATA_ACCESS : abi.MAXIMUM_ALLOWED,
      abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE,
      null, abi.OPEN_EXISTING, abi.FILE_FLAG_BACKUP_SEMANTICS | abi.FILE_FLAG_OPEN_REPARSE_POINT, null)
    if (!isRoot && isInvalidHandle(handle) && api.getLastError() === abi.ERROR_SHARING_VIOLATION) {
      handle = api.createFileW(path, abi.DIRECTORY_METADATA_ACCESS | abi.WRITE_DAC,
        abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE, null, abi.OPEN_EXISTING,
        abi.FILE_FLAG_BACKUP_SEMANTICS | abi.FILE_FLAG_OPEN_REPARSE_POINT, null)
    }
    if (isInvalidHandle(handle)) throwLastError(api, 'CreateFileW', path)
    try {
      const info = Buffer.alloc(abi.FILE_ATTRIBUTE_TAG_INFO_SIZE)
      if (api.getFileInformationByHandleEx(handle, abi.FileAttributeTagInfo, info, info.length) === 0) {
        throwLastError(api, 'GetFileInformationByHandleEx', path)
      }
      const attributes = info.readUInt32LE(0)
      if ((attributes & abi.FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
        if (isRoot) throw new Error(`Windows ACL grant root is a reparse point: ${path}`)
      } else {
        if ((attributes & abi.FILE_ATTRIBUTE_DIRECTORY) === 0) throw new Error(`Windows ACL grant target is not a directory: ${path}`)
        if (!isRoot) applyDeny(api, handle, path, entry, matches)
        for (const child of readdirSync(path, { withFileTypes: true })) {
          if (child.isDirectory() && !child.isSymbolicLink()) visit(join(path, child.name), false)
        }
        if (isRoot) action()
      }
    } catch (error) {
      try {
        if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', path)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Directory preparation and handle cleanup failed: ${path}`)
      }
      throw error
    }
    if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', path)
  }
  visit(root, true)
}
