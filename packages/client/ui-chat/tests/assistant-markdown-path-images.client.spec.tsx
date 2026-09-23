// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AssistantMarkdown, localPathMediaUrl } from '../src/client/chat/AssistantMarkdown.tsx'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../src/client/contract/slots.ts'
import type { AssistantBlock } from '../src/client/contract/snapshot.ts'

afterEach(cleanup)

const t = ((_key: string) => 'label') as unknown as ChatViewSlotProps['t']
const renderMessageImages = (() => null) as unknown as ChatNodeOwnerProps['renderMessageImages']

function textBlock(text: string): AssistantBlock {
  return { kind: 'text', text }
}

const ORIGIN = 'http://127.0.0.1:3080'

describe('localPathMediaUrl', () => {
  it.each(['C:\\研究 project\\graph.png', 'D:/Research/graph.png'])('serves Windows drive path %s through the authenticated file API', (path) => {
    const url = new URL(localPathMediaUrl('http:', ORIGIN, path)!)
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toBe('/api/file')
    expect(url.searchParams.get('path')).toBe(path)
  })

  it('maps an absolute POSIX path on an HTTP page to the file API', () => {
    expect(localPathMediaUrl('http:', ORIGIN, '/tmp/graph.png'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('/tmp/graph.png')}`)
    expect(localPathMediaUrl('https:', 'https://127.0.0.1:3080', '/tmp/graph.png'))
      .toBe(`https://127.0.0.1:3080/api/file?path=${encodeURIComponent('/tmp/graph.png')}`)
  })

  it('keeps non-HTTP transports inert', () => {
    expect(localPathMediaUrl('file:', 'file:///app', '/tmp/graph.png')).toBeUndefined()
    expect(localPathMediaUrl('ws:', ORIGIN, '/tmp/graph.png')).toBeUndefined()
  })

  it('keeps destinations that cannot be Host-served local files inert', () => {
    expect(localPathMediaUrl('http:', ORIGIN, '')).toBeUndefined()
    expect(localPathMediaUrl('http:', ORIGIN, '//cdn.example.com/x.png')).toBeUndefined()
    expect(localPathMediaUrl('http:', ORIGIN, 'relative.png')).toBeUndefined()
    expect(localPathMediaUrl('http:', ORIGIN, 'C:relative.png')).toBeUndefined()
    expect(localPathMediaUrl('http:', ORIGIN, '\\\\server\\share\\x.png')).toBeUndefined()
  })

  it('encodes the full path including spaces', () => {
    expect(localPathMediaUrl('http:', ORIGIN, '/tmp/my graph.png'))
      .toBe(`${ORIGIN}/api/file?path=${encodeURIComponent('/tmp/my graph.png')}`)
  })
})

describe('AssistantMarkdown local-path images', () => {
  it.each(['/tmp/graph.png', 'C:\\Research\\graph.png', 'D:/Research/graph.png'])(
    'renders local image %s in closing prose through the same-origin API', (path) => {
      const { container } = render(
        <AssistantMarkdown
          blocks={[textBlock(`See ![diagram](${path}) for the layout.`)]}
          streaming={false}
          renderMessageImages={renderMessageImages}
          t={t}
        />,
      )
      const image = container.querySelector('img')
      expect(image?.getAttribute('alt')).toBe('diagram')
      const url = new URL(image?.getAttribute('src') ?? '')
      expect(url.pathname).toBe('/api/file')
      expect(url.searchParams.get('path')).toBe(path)
    },
  )

  it('keeps non-absolute destinations inert', () => {
    const { container } = render(
      <AssistantMarkdown
        blocks={[textBlock('See ![diagram](relative.png).')]}
        streaming={false}
        renderMessageImages={renderMessageImages}
        t={t}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('diagram')
  })
})
