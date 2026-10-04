/** Shared conversion rules for the synchronous formatter and isolated fetch Worker. */
'use strict'

/** Build the shared converter from the runtime-selected local parser dependencies. */
function createHtmlConverter(TurndownService, gfm) {
  /**
   * The shared HTML→markdown converter: turndown over its bundled domino DOM,
   * with GitHub-flavored tables/strikethrough (`@joplin/turndown-plugin-gfm`).
   * The style options are fixed model-facing presentation (matching the repo's
   * markdown conventions), not deployment tunables. `remove` drops non-content
   * elements wholesale — turndown's default keeps their text. The instance is
   * stateless across `turndown()` calls and safe to share.
   */
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
  turndown.use(gfm)
  turndown.addRule('removeNonVisibleContent', {
    filter(node) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED'].includes(node.nodeName)) return true
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true
      if (node.nodeName === 'INPUT' && node.getAttribute('type')?.toLowerCase() === 'hidden') return true
      const declarations = node.getAttribute('style')?.split(';') ?? []
      return declarations.some((declaration) => {
        const separator = declaration.indexOf(':')
        if (separator === -1) return false
        const property = declaration.slice(0, separator).trim().toLowerCase()
        const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/u, '')
        return (property === 'display' && value === 'none')
          || (property === 'visibility' && (value === 'hidden' || value === 'collapse'))
      })
    },
    replacement() {
      return ''
    },
  })

  /** Render one GFM table cell without interpreting HTML span counts. */
  function renderTableCell(content, index) {
    const prefix = index === 0 ? '| ' : ' '
    const escaped = content.trim().replace(/\n\r/g, '<br>').replace(/\n/g, '<br>').replace(/\|+/g, '\\|').padEnd(3, ' ')
    return `${prefix}${escaped} |`
  }

  /** Whether a row is the table's Markdown heading row. */
  function isTableHeadingRow(row) {
    const cells = Array.from(row.cells)
    const section = row.parentElement
    const table = section.parentElement
    return (section.nodeName === 'THEAD' || table.rows[0] === row)
      && cells.every(cell => cell.nodeName === 'TH')
  }

  /** Map an HTML table-cell alignment to the GFM separator marker. */
  function tableBorder(cell) {
    const alignment = (cell.getAttribute('align') || cell.style.textAlign || '').toLowerCase()
    if (alignment === 'left') return ':---'
    if (alignment === 'right') return '---:'
    if (alignment === 'center') return ':---:'
    return '---'
  }

  turndown.addRule('tableCellWithoutSpanExpansion', {
    filter: ['th', 'td'],
    replacement(content, node) {
      const cell = node
      const row = cell.parentNode
      // GFM cannot represent spanning cells. Ignoring colspan keeps conversion
      // work and output proportional to the source instead of the numeric attribute.
      return renderTableCell(content, Array.prototype.indexOf.call(row.childNodes, cell))
    },
  })
  turndown.addRule('tableRowWithoutSpanExpansion', {
    filter: 'tr',
    replacement(content, node) {
      const row = node
      const border = isTableHeadingRow(row)
        ? Array.from(row.cells, (cell, index) => renderTableCell(tableBorder(cell), index)).join('')
        : ''
      return `\n${content}${border.length > 0 ? `\n${border}` : ''}`
    },
  })

  /** Convert a bounded source prefix without evaluating scripts or loading remote resources. */
  function renderHtml(html, maxInputChars) {
    const content = html.slice(0, maxInputChars)
    const sourceTruncated = content.length !== html.length
    if (exceedsConversionDepth(content)) return { text: '[HTML content omitted: unable to convert safely.]', sourceTruncated }
    try { return { text: turndown.turndown(content), sourceTruncated } }
    catch { return { text: '[HTML content omitted: unable to convert safely.]', sourceTruncated } }
  }

  return { renderHtml }
}

/** Reject impractical lexical nesting before the DOM converter runs. */
const MAX_CONVERSION_DEPTH = 512

/** Elements that never take a closing tag, so they do not grow the lexical stack. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** Elements whose contents HTML parses as text until their matching end tag. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'noscript'])

/** Whether a character can occur after a raw-text end-tag name. */
function isTagBoundary(char) {
  return char === undefined || char === '>' || char === '/' || /\s/.test(char)
}

/** Find the matching raw-text end tag without interpreting markup-like body text. */
function findRawTextEnd(lowerHtml, name, from) {
  const prefix = `</${name}`
  let candidate = lowerHtml.indexOf(prefix, from)
  while (candidate !== -1 && !isTagBoundary(lowerHtml[candidate + prefix.length])) {
    candidate = lowerHtml.indexOf(prefix, candidate + prefix.length)
  }
  return candidate
}

/**
 * Conservatively reject HTML whose lexical element stack crosses the conversion
 * depth ceiling. The single pass ignores closing tags inside comments, skips
 * raw-text bodies, respects quoted `>` characters, and only accepts a closing
 * tag for the current element; malformed input therefore over-counts rather
 * than hiding nesting.
 *
 * @param html - the decoded HTML body.
 * @returns whether the body crosses {@link MAX_CONVERSION_DEPTH}.
 */
function exceedsConversionDepth(html) {
  const lowerHtml = html.toLowerCase()
  const openElements = []
  let offset = 0
  let inComment = false

  while (offset < html.length) {
    const start = html.indexOf('<', offset)
    if (inComment) {
      const end = html.indexOf('-->', offset)
      if (end !== -1 && (start === -1 || end < start)) {
        inComment = false
        offset = end + 3
        continue
      }
    }
    if (start === -1) break
    if (!inComment && html.startsWith('<!--', start)) {
      inComment = true
      offset = start + 4
      continue
    }

    let cursor = start + 1
    const closing = html[cursor] === '/'
    if (closing) cursor += 1
    const nameStart = cursor
    while (/[a-zA-Z0-9-]/.test(html[cursor] ?? '')) cursor += 1
    if (cursor === nameStart || !/[a-zA-Z]/.test(html.charAt(nameStart))) {
      offset = start + 1
      continue
    }

    const name = lowerHtml.slice(nameStart, cursor)
    let quote
    while (cursor < html.length) {
      const char = html[cursor]
      cursor += 1
      if (quote !== undefined) {
        if (char === quote) quote = undefined
      } else if (char === '"' || char === "'") {
        quote = char
      } else if (char === '>') {
        break
      }
    }
    if (html[cursor - 1] !== '>') break

    if (closing) {
      if (!inComment && openElements.at(-1) === name) openElements.pop()
    } else {
      let last = cursor - 2
      while (/\s/.test(html.charAt(last))) last -= 1
      if (!VOID_ELEMENTS.has(name) && html[last] !== '/') {
        openElements.push(name)
        if (openElements.length > MAX_CONVERSION_DEPTH) return true
        if (!inComment && RAW_TEXT_ELEMENTS.has(name)) {
          const end = findRawTextEnd(lowerHtml, name, cursor)
          if (end === -1) break
          offset = end
          continue
        }
      }
    }
    offset = cursor
  }
  return false
}

module.exports = { createHtmlConverter }
