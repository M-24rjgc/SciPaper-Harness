/** A complete offline PDF with optional Flate compression for parser and provider regressions. */
import { deflateSync } from 'node:zlib'

/** Build a complete one-page document without remote fonts or external references. */
export function pdf(text: string, compressed = false): Uint8Array {
  const stream = `BT /F1 12 Tf 30 100 Td (${text}) Tj ET`
  const payload = compressed ? deflateSync(Buffer.from(stream)).toString('latin1') : stream
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${payload.length}${compressed ? ' /Filter /FlateDecode' : ''} >>\nstream\n${payload}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.7\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const start = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return new Uint8Array(Buffer.from(body, 'latin1'))
}
