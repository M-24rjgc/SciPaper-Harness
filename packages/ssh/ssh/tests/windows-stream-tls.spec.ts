/** TLS-PSK can authenticate a duplex assembled from SSH's stdin and stdout. */
import { once } from 'node:events'
import { createConnection, type AddressInfo } from 'node:net'
import { Duplex, PassThrough } from 'node:stream'
import { createServer, type TLSSocket } from 'node:tls'
import { describe, expect, it } from 'vitest'
import { authenticateStream, SSH_STREAM_TLS_OPTIONS } from '../src/stream-security.ts'

describe('SSH exec-channel TLS transport', () => {
  it('exchanges authenticated bytes through a stdio duplex on Windows', async () => {
    const capability = Buffer.alloc(32, 0x42)
    const accepted: TLSSocket[] = []
    const server = createServer({
      ...SSH_STREAM_TLS_OPTIONS,
      pskCallback: (_socket, identity) => identity === 'dsh-stream' ? capability : null,
    }, (socket) => {
      accepted.push(socket)
      socket.on('data', (data) => { socket.write(Buffer.from(`reply:${String(data)}`)) })
    })
    server.on('tlsClientError', () => {})
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    const upstream = createConnection({ host: '127.0.0.1', port: address.port })
    const input = new PassThrough()
    const output = new PassThrough()
    input.on('error', () => {})
    output.on('error', () => {})
    input.pipe(upstream)
    upstream.pipe(output)
    const raw = Duplex.from({ readable: output, writable: input })
    raw.on('error', () => {})
    let secure: TLSSocket | undefined
    try {
      secure = await authenticateStream(raw, capability.toString('hex'), 3000)
      secure.on('error', () => {})
      const response = once(secure, 'data')
      secure.write('ping')
      secure.resume()
      expect(String((await response)[0])).toBe('reply:ping')
    } finally {
      secure?.destroy()
      raw.destroy()
      upstream.destroy()
      for (const socket of accepted) socket.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    }
  })
})
