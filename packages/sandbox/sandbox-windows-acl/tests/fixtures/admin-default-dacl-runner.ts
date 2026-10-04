/** Run the real Windows runner with an admin-only default DACL on its newly created restricted token. */

import { buildExplicitAccess } from '../../src/acl.ts'
import { allocPtrSlot, decodePtr, ptrAddress, throwLastError, throwWin32, win32Sync } from '../../src/ffi.ts'
import { makeWellKnownSid } from '../../src/token.ts'
import { FILE_ALL_ACCESS, GRANT_ACCESS, TokenDefaultDacl } from '../../src/win32-abi.ts'

const api = win32Sync()
const createRestrictedToken = api.createRestrictedToken.bind(api)
api.createRestrictedToken = (...args) => {
  const result = createRestrictedToken(...args)
  if (result === 0) return result
  api.createRestrictedToken = createRestrictedToken
  const token = decodePtr(args[8])
  if (token === null) throw new Error('Fixture received no restricted token')
  const aclSlot = allocPtrSlot()
  // WELL_KNOWN_SID_TYPE: LocalSystem=22, BuiltinAdministrators=26.
  const trustees = [22, 26].map(type => makeWellKnownSid(api, type))
  const entries = Buffer.concat(trustees.map(sid =>
    buildExplicitAccess(sid, GRANT_ACCESS, FILE_ALL_ACCESS)))
  const merged = api.setEntriesInAclW(2, entries, null, aclSlot)
  if (merged !== 0) {
    api.closeHandle(token)
    throwWin32(api, 'SetEntriesInAclW', merged, 'fixture admin-only default DACL')
  }
  const acl = decodePtr(aclSlot)
  if (acl === null) {
    api.closeHandle(token)
    throw new Error('Fixture received no default DACL')
  }
  try {
    const info = Buffer.alloc(8)
    info.writeBigUInt64LE(ptrAddress(acl))
    if (api.setTokenInformation(token, TokenDefaultDacl, info, info.length) === 0) {
      api.closeHandle(token)
      throwLastError(api, 'SetTokenInformation', 'fixture admin-only default DACL')
    }
  } finally {
    api.localFree(acl)
  }
  console.log('DEFAULT-DACL: ADMIN/SYSTEM')
  return result
}

await import('../../src/runner.ts')
