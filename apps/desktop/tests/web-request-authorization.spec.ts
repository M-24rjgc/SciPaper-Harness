import { expect, it } from 'vitest'
import { DESKTOP_REQUEST_AUTH_HEADER, DesktopWebRequestAuthorization } from '../src/web-request-authorization.ts'

it('admits native main-frame requests, strips the proof and excludes opaque frames and workers', async () => {
  const owner = new DesktopWebRequestAuthorization()
  const address = 'dsh-app://app/api/file?path=synthetic.js'
  expect(owner.admit(new Request(address))).toBeUndefined()
  const native = owner.authorizeHeaders({ 'X-Dsh-Desktop-Frame': 'forged', 'content-type': 'application/json' }, true)
  const request = new Request(address, { method: 'POST', headers: native, body: 'synthetic-body' })
  const admitted = owner.admit(request)
  expect(admitted).toBeDefined()
  expect(admitted!.headers.has(DESKTOP_REQUEST_AUTH_HEADER)).toBe(false)
  expect(admitted!.headers.get('content-type')).toBe('application/json')
  expect(await admitted!.text()).toBe('synthetic-body')
  const unowned = owner.authorizeHeaders({ ...native, 'X-Dsh-Desktop-Frame': 'forged' }, false)
  expect(Object.keys(unowned).some(name => name.toLowerCase() === DESKTOP_REQUEST_AUTH_HEADER)).toBe(false)
  expect(owner.admit(new Request(address, { headers: unowned }))).toBeUndefined()
  expect(new DesktopWebRequestAuthorization().admit(new Request(address, { headers: native }))).toBeUndefined()
})

it('permits only revisioned plugin scripts and managed editor assets without a main-frame proof', () => {
  const owner = new DesktopWebRequestAuthorization()
  for (const address of [
    'dsh-app://app/plugins/??@scope/plugin/client.js&rev=012345abcdef',
    'dsh-app://app/plugins/??@scope/plugin/client.js.map,other/client.js.map&rev=012345abcdef',
    'dsh-app://app/plugins/@scope/plugin/client.part-1.js?rev=012345abcdef',
    'dsh-app://app/plugins/@scope/plugin/client.part-1.js.map?rev=012345abcdef',
    'dsh-app://app/api/research/drawio/index.html?embed=1',
    'dsh-app://app/api/research/drawio/js/editor.js',
  ]) {
    expect(owner.admit(new Request(address))).toBeDefined()
    expect(owner.admit(new Request(address, { method: 'HEAD' }))).toBeDefined()
    expect(owner.admit(new Request(address, { method: 'POST', body: 'write' }))).toBeUndefined()
  }
  for (const address of [
    'dsh-app://app/plugins/events', 'dsh-app://app/plugins/events?rev=012345abcdef',
    'dsh-app://app/plugins/graph', 'dsh-app://app/plugins/metadata',
    'dsh-app://app/plugins/@scope/plugin/client.part-1.js',
    'dsh-app://app/plugins/??@scope/plugin/client.js&rev=invalid',
    'dsh-app://app/plugins/??@scope/plugin/events&rev=012345abcdef',
    'dsh-app://app/api/research/drawio-malicious.js', 'dsh-app://app/api/research/file?path=synthetic.js',
    'dsh-app://app/api/research/drawio/../file?path=synthetic.js',
    'dsh-app://app:1234/api/research/drawio/index.html',
  ]) expect(owner.admit(new Request(address))).toBeUndefined()
})
