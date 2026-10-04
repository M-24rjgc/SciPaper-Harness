import { describe, expect, it } from 'vitest'
import { redactSessionLog } from '../src/redact.ts'

describe('exported log credential redaction', () => {
  it('redacts repeated credentials, commands, reasoning and split stream chunks without changing the source', () => {
    const secret = 'demo-Pa55word-ABC'
    const rows = [
      { type: 'session', id: 'root', version: 5 },
      { type: 'user/message', data: { content: [{ type: 'text', text: `密码：${secret}` }] } },
      { type: 'tool/call', data: { arguments: { password: secret, command: `echo ${secret}` } } },
      { type: 'assistant/message', data: { stream: [{ type: 'tool-call-chunks', texts: ['demo-Pa', '55word-', 'ABC'] }], message: { content: [{ type: 'reasoning', text: secret }] } } },
    ]
    const source = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
    const exported = redactSessionLog(source)
    expect(source).toContain(secret)
    expect(exported).not.toContain(secret)
    expect(exported).not.toContain('demo-Pa')
    expect(exported).toContain('[REDACTED]')
    const parsed = exported.trimEnd().split('\n').map(line => JSON.parse(line) as { data: { stream: Array<{ texts: string[] }> } })
    expect(parsed[0]).toEqual(rows[0])
    expect(parsed[3]?.data.stream[0]?.texts).toEqual(['*******', '*******', '***'])
  })

  it('shares detected secrets with descendant logs and preserves unrelated events byte-for-byte', () => {
    const known = new Set<string>()
    redactSessionLog('{"password":"sample-secret"}\n', known)
    expect(redactSessionLog('{"stdout":"sample-secret"}\n', known)).toBe('{"stdout":"[REDACTED]"}\n')
    const ordinary = '{"data":{"text":"literature search","count":7}}\n'
    expect(redactSessionLog(ordinary)).toBe(ordinary)
    expect(redactSessionLog('{"text":"密码demo-secret"}\n')).not.toContain('demo-secret')
    expect(redactSessionLog('{"text":"password: string"}\n')).toBe('{"text":"password: string"}\n')
  })

  it('redacts quoted passwords with spaces, API key fields, bearer tokens and URL credentials', () => {
    const text = JSON.stringify({ text: 'password="abc def"', api_key: 'demo-api-key', authorization: 'Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ', url: 'https://user:url-secret@example.test/' }) + '\n'
    const redacted = redactSessionLog(text)
    for (const secret of ['abc def', 'demo-api-key', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'url-secret']) expect(redacted).not.toContain(secret)
  })

  it('redacts short explicit credentials while keeping event discriminants intact', () => {
    const rows = [
      { type: 'assistant/message', data: { arguments: JSON.stringify({ password: 'a' }), password: 'a', stream: [{ type: 'tool-call-chunks', texts: ['{"password":"', 'a"}'] }] } },
    ]
    const exported = JSON.parse(redactSessionLog(JSON.stringify(rows[0]) + '\n')) as {
      type: string
      data: { password: string; arguments: string; stream: Array<{ texts: string[] }> }
    }
    expect(exported.type).toBe('assistant/message')
    expect(exported.data.password).toBe('[REDACTED]')
    expect(JSON.parse(exported.data.arguments) as { password: string }).toEqual({ password: '[REDACTED]' })
    expect(JSON.parse(exported.data.stream[0]?.texts.join('') ?? '') as { password: string }).toEqual({ password: '[REDACTED]' })
  })

  it.each(['demo-"quote-secret', 'demo-\\slash-secret', 'demo-\nline-secret'])('redacts serialized tool arguments and compact fragments containing escaped credentials (%#)', (secret) => {
    const args = JSON.stringify({ password: secret, command: `use ${secret}`, ordinary: 'preserve this field' })
    const split = Math.floor(args.length / 2)
    const source = JSON.stringify({ data: {
      args,
      stream: [{ type: 'tool-call-chunks', index: 0, time0: 10, dt: [5], args: [args.slice(0, split), args.slice(split)] }],
    } }) + '\n'
    const exported = JSON.parse(redactSessionLog(source)) as {
      data: { args: string; stream: Array<{ args: string[]; dt: number[]; time0: number }> }
    }
    const sanitizedArgs = JSON.parse(exported.data.args) as { password: string; command: string; ordinary: string }
    expect(sanitizedArgs.password).toBe('[REDACTED]')
    expect(sanitizedArgs.command).not.toContain(secret)
    expect(sanitizedArgs.ordinary).toBe('preserve this field')
    const packed = exported.data.stream[0]
    if (packed === undefined) throw new Error('Exported compact stream record is missing')
    expect(packed.args).toHaveLength(2)
    expect(packed.args.every((chunk: unknown) => typeof chunk === 'string')).toBe(true)
    expect(packed.dt).toEqual([5])
    expect(packed.time0).toBe(10)
    const unpacked = JSON.parse(packed.args.join('')) as typeof sanitizedArgs
    expect(unpacked.password).not.toBe(secret)
    expect(unpacked.command).not.toContain(secret)
    expect(unpacked.ordinary).toBe('preserve this field')
  })
})
