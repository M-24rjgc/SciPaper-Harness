/** Real Chromium requests from an application, opaque iframe and Worker against a synthetic loopback Host. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, protocol, session } from 'electron'
import { DesktopWebRequestAuthorization, DESKTOP_REQUEST_AUTH_HEADER } from '../../lib/types/web-request-authorization.js'
import { isDesktopApplicationDocument } from '../../lib/types/ipc.js'
import { forwardWebRequest } from '../../lib/types/web-document.js'

app.setPath('userData', mkdtempSync(join(tmpdir(), 'dsh-document-authorization-')))
app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }])

const authorization = new DesktopWebRequestAuthorization()
const hostRequests = []
const socketRequests = []
const blocked = new Set()
const blockedSockets = new Set()
const signals = new Map()
let window
let host
let timer
let finished = false
const done = Promise.withResolvers()

function observe(name, value) {
  signals.set(name, value)
  if (signals.size === 9) done.resolve()
}

async function finish(error) {
  if (finished) return
  finished = true
  clearTimeout(timer)
  window?.destroy()
  host?.closeAllConnections()
  if (host?.listening) await new Promise((resolve, reject) => host.close(failure => failure ? reject(failure) : resolve()))
  if (error) {
    console.error(error)
    app.exit(1)
  } else {
    console.log(JSON.stringify({ passed: true, blockedDynamicReads: [...blocked], hostRequests: hostRequests.map(row => row.path),
      blockedSockets: [...blockedSockets], authenticatedSockets: socketRequests.filter(row => row.authenticated).map(row => row.path) }))
    app.quit()
  }
}

async function main() {
  try {
    await app.whenReady()
    host = createServer((request, response) => {
      hostRequests.push({ path: request.url, authenticated: request.headers.cookie === 'synthetic-owned',
        privateProof: request.headers[DESKTOP_REQUEST_AUTH_HEADER] })
      response.writeHead(200, { 'content-type': 'application/javascript', 'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'" })
      response.end(request.url.startsWith('/api/file')
        ? 'parent.postMessage("forbidden-script-executed","*")' : '// synthetic asset\n')
    })
    host.on('upgrade', (request, socket) => {
      const authenticated = request.headers.cookie === 'synthetic-owned'
        && request.headers.origin === `http://127.0.0.1:${host.address().port}`
      socketRequests.push({ path: request.url, authenticated, privateProof: request.headers[DESKTOP_REQUEST_AUTH_HEADER] })
      if (!authenticated) { socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
      const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
      socket.on('data', () => { socket.end(Buffer.from([0x88, 0])) })
    })
    await new Promise((resolve, reject) => {
      host.once('error', reject)
      host.listen(0, '127.0.0.1', resolve)
    })
    const origin = `http://127.0.0.1:${host.address().port}/`
    const socketOrigin = origin.replace('http:', 'ws:')
    const socketProbe = (type, report) => `{
      const socket=new WebSocket(${JSON.stringify(`${socketOrigin}${type}`)});let settled=false;
      const report=status=>{if(settled)return;settled=true;${report}};
      socket.onopen=()=>{report('open');socket.close()};socket.onerror=()=>report('refused');
    }`
    const opaqueSocket = socketProbe('opaque-worker-ws', 'postMessage({type:"opaque-worker-ws",status})')
    const opaqueWorker = 'fetch("dsh-app://app/api/opaque-worker").then(r=>postMessage({type:"opaque-worker",status:r.status}));' + opaqueSocket
    const child = '<!doctype html><script src="dsh-app://app/api/file?path=synthetic.js"></script>'
      + `<script>const w=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(opaqueWorker)}],{type:"text/javascript"})));`
      + 'w.onmessage=e=>parent.postMessage(e.data,"*")</script>'
    const editor = '<!doctype html><script>' + socketProbe('same-origin-frame-ws',
      'parent.postMessage({type:"same-origin-frame-ws",status},"dsh-app://app")')
      + `const worker=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(socketProbe('same-origin-worker-ws',
        'postMessage({type:"same-origin-worker-ws",status})'))}],{type:'text/javascript'})));
        worker.onmessage=e=>parent.postMessage(e.data,'dsh-app://app');</script>`
    const escaped = child.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    const workerSource = 'fetch("dsh-app://app/api/worker").then(r=>postMessage({type:"worker",status:r.status}));'
      + 'fetch("dsh-app://app/plugins/@fixture/module/client.worker.js?rev=012345abcdef").then(r=>postMessage({type:"static-worker",status:r.status}));'
      + socketProbe('worker-ws', 'postMessage({type:"worker-ws",status})')
    const root = `<!doctype html><body><iframe sandbox="allow-scripts" srcdoc="${escaped}"></iframe>
    <iframe sandbox="allow-scripts allow-same-origin" src="dsh-app://app/api/research/drawio/fixture.html"></iframe><script>
    window.addEventListener('message',event=>{
      if(['opaque-worker','opaque-worker-ws','same-origin-frame-ws','same-origin-worker-ws'].includes(event.data?.type))console.log(JSON.stringify(event.data));
      if(event.data==='forbidden-script-executed')console.log(JSON.stringify({type:'forbidden-execution'}));
    });
    fetch('/api/main').then(r=>console.log(JSON.stringify({type:'main',status:r.status})));
    ${socketProbe('main-ws', 'console.log(JSON.stringify({type:"main-ws",status}))')}
    const worker=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}],{type:'text/javascript'})));
    worker.onmessage=event=>console.log(JSON.stringify(event.data));
    </script></body>`
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['dsh-app://app/*', 'ws://127.0.0.1/*'] }, (details, callback) => {
      const owner = window?.webContents
      const owned = owner !== undefined && details.webContentsId === owner.id && details.frame === owner.mainFrame
        && isDesktopApplicationDocument(owner.mainFrame.url)
      if (new URL(details.url).protocol === 'dsh-app:') {
        callback({ requestHeaders: authorization.authorizeHeaders(details.requestHeaders, owned) })
        return
      }
      if (!owned) { blockedSockets.add(new URL(details.url).pathname); callback({ cancel: true }); return }
      const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]))
      if (headers.origin !== 'dsh-app://app') { callback({ cancel: true }); return }
      callback({ requestHeaders: { ...headers, origin: new URL(origin).origin, cookie: 'synthetic-owned', 'sec-fetch-site': 'same-origin' } })
    })
    protocol.handle('dsh-app', (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/') return new Response(root, { headers: { 'content-type': 'text/html' } })
      const admitted = authorization.admit(request)
      if (admitted === undefined) {
        blocked.add(url.pathname)
        return new Response('forbidden', { status: 403, headers: { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff' } })
      }
      if (url.pathname === '/api/research/drawio/fixture.html') return new Response(editor, { headers: { 'content-type': 'text/html' } })
      return forwardWebRequest(admitted, origin, 'synthetic-owned')
    })
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true } })
    window.webContents.on('console-message', (event) => {
      try {
        const value = JSON.parse(event.message)
        if (value.type === 'forbidden-execution') done.reject(new Error('Opaque iframe executed an authenticated file script'))
        else if (['main', 'worker', 'static-worker', 'opaque-worker', 'main-ws', 'worker-ws', 'opaque-worker-ws', 'same-origin-frame-ws', 'same-origin-worker-ws']
          .includes(value.type)) observe(value.type, value.status)
      } catch (error) {
        if (event.message.startsWith('{')) done.reject(error)
      }
    })
    timer = setTimeout(() => done.reject(new Error('Desktop document authorization fixture timed out')), 15_000)
    await window.loadURL('dsh-app://app/')
    await done.promise
    assert.equal(signals.get('main'), 200)
    assert.equal(signals.get('worker'), 403)
    assert.equal(signals.get('opaque-worker'), 403)
    assert.equal(signals.get('static-worker'), 200)
    assert.equal(signals.get('main-ws'), 'open')
    // Chromium attributes a primary-document Worker socket to that trusted creator frame.
    assert.equal(signals.get('worker-ws'), 'open')
    for (const type of ['opaque-worker-ws', 'same-origin-frame-ws', 'same-origin-worker-ws']) assert.equal(signals.get(type), 'refused')
    for (const path of ['/api/file', '/api/worker', '/api/opaque-worker']) assert.ok(blocked.has(path))
    assert.equal(hostRequests.length, 2)
    for (const row of hostRequests) {
      assert.ok(row.authenticated)
      assert.equal(row.privateProof, undefined)
    }
    assert.deepEqual(socketRequests.filter(row => row.authenticated).map(row => row.path).sort(), ['/main-ws', '/worker-ws'])
    for (const row of socketRequests) assert.equal(row.privateProof, undefined)
    await finish()
  } catch (error) { await finish(error) }
}

void main()
