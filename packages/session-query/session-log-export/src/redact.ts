/** Credential redaction for exported copies; persisted session events remain unchanged. */
const MARKER = '[REDACTED]'
const SECRET_KEY = /^(?:password|passwd|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|DSH_SSH_ASKPASS_SECRET)$/iu
const LABEL = '(?:password|passwd|passphrase|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|DSH_SSH_ASKPASS_SECRET|密码)'
const ASSIGNMENT = new RegExp(`${LABEL}${String.raw`\s*(?:[:=：]|是|为)\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"';，。]+))`}`, 'giu')
const TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})\b/gu

function remember(value: string, secrets: Set<string>, explicit = false): void {
  if (!explicit && (/^(?:string|password|passwd|passphrase|undefined|null|none|your[_-]?(?:password|api[_-]?key))$/iu.test(value)
    || /^<.*>$/u.test(value))) return
  if (value.length >= (explicit ? 1 : 4) && value.length <= 4096 && value !== MARKER) secrets.add(value)
}

function discover(value: unknown, secrets: Set<string>, key = '', serializedDepth = 0): void {
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key)) remember(value, secrets, true)
    if (serializedDepth < 3 && value.length <= 4_000_000 && /^[\s]*[\[{]/u.test(value)) {
      try { discover(JSON.parse(value) as unknown, secrets, '', serializedDepth + 1) } catch {}
    }
    for (const match of value.matchAll(ASSIGNMENT)) remember(match[1] ?? match[2] ?? match[3] ?? '', secrets)
    for (const match of value.matchAll(/密码\s*(?:[:=：]|是|为)?\s*["']?([A-Za-z0-9][^\s"'`;，。]{3,})/gu)) remember(match[1] ?? '', secrets)
    for (const match of value.matchAll(TOKEN)) remember(match[0], secrets)
    for (const match of value.matchAll(/https?:\/\/[^\s/:]+:([^\s/@]+)@/gu)) remember(match[1] ?? '', secrets)
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) discover(child, secrets, '', serializedDepth)
    if (value.every(child => typeof child === 'string')) discover(value.join(''), secrets, '', serializedDepth)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [name, child] of Object.entries(value)) discover(child, secrets, name, serializedDepth)
  }
}

function replace(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) text = text.split(secret).join(MARKER)
  return text
}

/** Mask secrets spanning compact stream fragments while preserving their chunk boundaries. */
function fragments(values: string[], secrets: readonly string[]): string[] {
  const joined = values.join('')
  const ranges: Array<[number, number]> = []
  for (const secret of secrets) {
    let start = joined.indexOf(secret)
    while (start >= 0) { ranges.push([start, start + secret.length]); start = joined.indexOf(secret, start + secret.length) }
  }
  let offset = 0
  return values.map((value) => {
    const end = offset + value.length
    let masked = value
    for (const [start, finish] of ranges) {
      const left = Math.max(start, offset) - offset
      const right = Math.min(finish, end) - offset
      if (left < right) masked = `${masked.slice(0, left)}${'*'.repeat(right - left)}${masked.slice(right)}`
    }
    offset = end
    return replace(masked, secrets)
  })
}

function sanitize(value: unknown, secrets: readonly string[], serializedDepth = 0): unknown {
  if (typeof value === 'string') {
    if (serializedDepth < 3 && value.length <= 4_000_000 && /^[\s]*[\[{]/u.test(value)) {
      try {
        const parsed = JSON.parse(value) as unknown
        const cleaned = sanitize(parsed, secrets, serializedDepth + 1)
        if (JSON.stringify(parsed) !== JSON.stringify(cleaned)) return JSON.stringify(cleaned)
      } catch {}
    }
    return replace(value, secrets)
  }
  if (Array.isArray(value)) {
    if (value.every(child => typeof child === 'string')) {
      const joined = value.join('')
      const cleaned = sanitize(joined, secrets, serializedDepth)
      if (typeof cleaned === 'string' && cleaned !== joined && /^[\s]*[\[{]/u.test(joined)) {
        let offset = 0
        return value.map((part, index) => {
          const end = index === value.length - 1 ? cleaned.length : offset + part.length
          const text = cleaned.slice(offset, end)
          offset = end
          return text
        })
      }
      return fragments(value, secrets)
    }
    return value.map(child => sanitize(child, secrets, serializedDepth))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      SECRET_KEY.test(key) && typeof child === 'string' && child.length > 0 ? MARKER : sanitize(child, secrets, serializedDepth),
    ]))
  }
  return value
}

/**
 * Discover credential values in one logical log without retaining its parsed rows.
 * @param content - one session's canonical JSONL text.
 * @param secrets - archive-wide credential values accumulated by the caller.
 */
export function discoverSessionLogSecrets(content: string, secrets: Set<string>): void {
  for (const line of content.split('\n')) {
    let value: unknown = line
    try { value = JSON.parse(line) as unknown } catch {}
    discover(value, secrets)
  }
}

/**
 * Redact credential fields and repeat detected values of four or more characters across the exported log.
 * @param content - canonical session JSONL text to redact without modifying stored logs.
 * @param knownSecrets - archive-wide credential values discovered before export; updated with this log's values.
 * @returns redacted JSONL preserving record order and non-credential values.
 */
export function redactSessionLog(content: string, knownSecrets: Set<string> = new Set()): string {
  const lines = content.split('\n').map((line) => {
    try { return { json: true, value: JSON.parse(line) as unknown } }
    catch { return { json: false, value: line } }
  })
  for (const line of lines) discover(line.value, knownSecrets)
  const secrets = [...new Set([...knownSecrets].filter(secret => secret.length >= 4)
    .flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)]))]
    .sort((a, b) => b.length - a.length)
  if (knownSecrets.size === 0) return content
  return lines.map(line => line.json ? JSON.stringify(sanitize(line.value, secrets)) : replace(String(line.value), secrets)).join('\n')
}
