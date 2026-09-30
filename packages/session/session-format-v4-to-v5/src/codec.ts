/** V5 framing preserves V4 event rows and adds execution identity to the header. */

import { SessionFormatError, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatCodec, SessionFormatCurrentEncoder, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertReleasedV5Header, executionOf, v4HeaderOf } from './validation.ts'

function physicalV4(value: unknown): SessionFormatHeader {
  if (!isSessionFormatJsonObject(value) || value['version'] !== 5) {
    throw new SessionFormatError('expected format v5 physical header')
  }
  assertReleasedV5Header(value)
  return { type: 'session', ...v4HeaderOf(value as SessionFormatHeader) }
}

function logicalV5(value: unknown, decoded: SessionFormatHeader): SessionFormatHeader {
  const header = value as SessionFormatHeader
  return {
    ...decoded,
    version: 5,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    execution: executionOf(header),
  }
}

/** Released V5 codec: execution metadata wraps the frozen V4 event representation. */
export const releasedV5SessionFormatCodec = Object.freeze({
  version: 5,
  decodeHeader(value: unknown) {
    return logicalV5(value, releasedV4SessionFormatCodec.decodeHeader(physicalV4(value)))
  },
  createDecoder(value, recovery) {
    const decoder = releasedV4SessionFormatCodec.createDecoder(physicalV4(value), recovery)
    return { ...decoder, header: logicalV5(value, decoder.header) }
  },
  encodeHeader(header, inheritedEventCount) {
    assertReleasedV5Header(header)
    const encoded = releasedV4SessionFormatCodec.encodeHeader(v4HeaderOf(header), inheritedEventCount)
    return {
      ...encoded,
      version: 5,
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      execution: executionOf(header),
    }
  },
  encodeEvent: releasedV4SessionFormatCodec.encodeEvent,
} satisfies SessionFormatCodec & SessionFormatCurrentEncoder)
