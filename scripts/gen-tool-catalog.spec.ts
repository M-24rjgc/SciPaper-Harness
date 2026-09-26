import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { render, type ToolCatalog } from './gen-tool-catalog.ts'

// The website owns the Markdown renderer and Vue compiler used by docs:build.
const siteRequire = createRequire(new URL('../website/package.json', import.meta.url))
const { baseParse } = createRequire(siteRequire.resolve('vue'))('@vue/compiler-dom') as {
  baseParse: (source: string) => unknown
}
let markdown: { render(source: string): string }
beforeAll(async () => {
  const { createMarkdownRenderer } = await import(pathToFileURL(siteRequire.resolve('vitepress')).href) as {
    createMarkdownRenderer: (root: string) => Promise<typeof markdown>
  }
  markdown = await createMarkdownRenderer(resolve(import.meta.dirname, '..'))
})

function catalog(description: string): ToolCatalog {
  return [{
    pkg: '@deepseek-ai/dsh-tool-example',
    requires: [],
    writes: [],
    sources: { example: 'packages/example/src/index.ts' },
    schemas: [{
      name: 'example', description,
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'template/<venue>/' } } },
    }],
  }]
}

describe('tool catalog description rendering', () => {
  it.each([
    ['template/<venue>/', 'template/&lt;venue&gt;/'],
    ['rows: [{cells: {<key>: value}}]', 'rows: [{cells: {&lt;key&gt;: value}}]'],
    ['figures/audit_logs/<name>.audit.json', 'figures/audit_logs/&lt;name&gt;.audit.json'],
  ])('renders %s as visible text instead of a Vue element', (description, escaped) => {
    expect(() => baseParse(markdown.render(description))).toThrow('Element is missing end tag')
    const source = catalog(description)
    const output = render(source)
    expect(source[0]?.schemas[0]?.description).toBe(description)
    expect(output).toContain(escaped)
    expect(() => baseParse(markdown.render(output))).not.toThrow()
  })

  it('preserves code, Markdown links, autolinks, escapes, entities and blockquotes', () => {
    const preserved = [
      '**Read** [guide](<https://example.com/guide>) and <https://example.com/reference>.',
      'Keep `Promise<any>` and ``x < `y` > z``.',
      String.raw`Already escaped \<venue\> and &lt;name&gt;; slash before placeholder: \\<key>.`,
      '',
      '> Quote with `Map<K, V>`.',
      '',
      '```ts',
      'const template = "<venue>"',
      '```',
    ]
    const output = render(catalog(['<section>', '', ...preserved, '', '</section>'].join('\n')))
    expect(output).toContain('&lt;section&gt;')
    expect(output).toContain('&lt;/section&gt;')
    for (const line of preserved.filter(line => !line.includes('slash before placeholder'))) expect(output).toContain(line)
    expect(output).toContain(String.raw`Already escaped \<venue\> and &lt;name&gt;; slash before placeholder: \\&lt;key&gt;.`)
    expect(output).toContain('"description": "template/<venue>/"')
    const html = markdown.render(output)
    expect(html).toContain('href="https://example.com/guide"')
    expect(html).toContain('href="https://example.com/reference"')
    expect(html).toContain('<code>Promise&lt;any&gt;</code>')
    expect(() => baseParse(html)).not.toThrow()
  })
})
