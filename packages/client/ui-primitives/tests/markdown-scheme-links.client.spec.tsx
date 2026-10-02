// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider, type MarkdownSchemeLink } from '../src/index.ts'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

type Handler = (link: MarkdownSchemeLink, fallback: ReactNode) => ReactNode

/** A handler that claims `kg:` links with a button and leaves every other scheme to the fallback. */
function claimKg(): ReturnType<typeof vi.fn<Handler>> {
  return vi.fn<Handler>((link, fallback) => link.scheme === 'kg'
    ? <button type="button" data-destination={link.destination}>{link.label}</button>
    : fallback)
}

describe('Markdown scheme links', () => {
  it('draws a dropped link as its content when the scope has no handler', () => {
    const { container } = render(<MarkdownText text="See [MoBA](kg:ai:paper:42) and [**bold** x](ftp://example.org/a)." />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('p')?.innerHTML).toBe('See MoBA and <strong>bold</strong> x.')
  })

  it('offers the scheme, the authored destination and the plain label of a settled link to the handler', () => {
    const handler = claimKg()
    const view = render(
      <MarkdownDelegateProvider renderSchemeLink={handler}>
        <MarkdownText text="Use [MoBA](kg:ai:paper:42) here." />
      </MarkdownDelegateProvider>,
    )
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]?.[0]).toEqual({ scheme: 'kg', destination: 'kg:ai:paper:42', label: 'MoBA' })
    const chip = view.getByRole('button', { name: 'MoBA' })
    expect(chip.getAttribute('data-destination')).toBe('kg:ai:paper:42')
    expect(view.container.querySelector('a')).toBeNull()
    expect(view.container.querySelector('p')?.textContent).toBe('Use MoBA here.')
  })

  it('keeps the destination exactly as written, including characters a URL would encode', () => {
    const handler = claimKg()
    render(
      <MarkdownDelegateProvider renderSchemeLink={handler}>
        <MarkdownText text="[FlexPrefill vs 固定分块](kg:extends:method:a>method:固定分块)" />
      </MarkdownDelegateProvider>,
    )
    expect(handler.mock.calls[0]?.[0]).toEqual({
      scheme: 'kg', destination: 'kg:extends:method:a>method:固定分块', label: 'FlexPrefill vs 固定分块',
    })
  })

  it('lower-cases the scheme and reads the label from text, code, nested formatting, image alternatives and breaks', () => {
    const handler = vi.fn<Handler>((_link, fallback) => fallback)
    render(
      <MarkdownDelegateProvider renderSchemeLink={handler}>
        <MarkdownText text={'[a *b* `c` ![d](https://example.org/i.png)\\\ne <i>f</i> [^1]](KG:x)\n\n[^1]: note'} />
      </MarkdownDelegateProvider>,
    )
    expect(handler.mock.calls[0]?.[0]).toEqual({ scheme: 'kg', destination: 'KG:x', label: 'a b c de <i>f</i> ' })
  })

  it('offers a reference-style link through its definition', () => {
    const handler = claimKg()
    const view = render(
      <MarkdownDelegateProvider renderSchemeLink={handler}>
        <MarkdownText text={'Read [MoBA][moba].\n\n[moba]: kg:ai:paper:42'} />
      </MarkdownDelegateProvider>,
    )
    expect(handler.mock.calls[0]?.[0]).toEqual({ scheme: 'kg', destination: 'kg:ai:paper:42', label: 'MoBA' })
    expect(view.getByRole('button', { name: 'MoBA' })).toBeTruthy()
  })

  it('draws the fallback for a scheme the handler does not claim', () => {
    const handler = claimKg()
    const { container } = render(
      <MarkdownDelegateProvider renderSchemeLink={handler}>
        <MarkdownText text="Run [this](javascript:alert(1)) and [that](vscode://file/x)." />
      </MarkdownDelegateProvider>,
    )
    expect(handler.mock.calls.map(([link]) => link.scheme)).toEqual(['javascript', 'vscode'])
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('p')?.textContent).toBe('Run this and that.')
  })

  it('never offers what the renderer already handles', () => {
    const handler = claimKg()
    const openFile = vi.fn()
    const { container } = render(
      <MarkdownDelegateProvider renderSchemeLink={handler} openFile={openFile}>
        <MarkdownText text={[
          '[web](https://example.org/a)', '[mail](mailto:a@example.org)', '[bad](http://)', '[again](HTTPS://)',
          '[file](notes/a.md)', '[drive](C:/work/a.md)', '[relative](./a)', '[fragment](#top)',
        ].join(' ')} />
      </MarkdownDelegateProvider>,
    )
    expect(handler).not.toHaveBeenCalled()
    expect([...container.querySelectorAll('a')].map(anchor => anchor.textContent)).toEqual(['web', 'mail'])
    expect(container.textContent).toContain('bad')
    expect(container.textContent).toContain('relative')
  })

  it('offers nothing while the message streams and draws the link once it settles', () => {
    const handler = claimKg()
    const text = 'Use [MoBA](kg:ai:paper:42) here.'
    const view = render(
      <MarkdownDelegateProvider renderSchemeLink={handler}>
        <MarkdownText text={text} streaming />
      </MarkdownDelegateProvider>,
    )
    expect(handler).not.toHaveBeenCalled()
    expect(view.container.querySelector('button')).toBeNull()
    expect(view.container.querySelector('p')?.textContent).toBe('Use MoBA here.')
    view.rerender(
      <MarkdownDelegateProvider renderSchemeLink={handler}>
        <MarkdownText text={text} />
      </MarkdownDelegateProvider>,
    )
    expect(view.getByRole('button', { name: 'MoBA' })).toBeTruthy()
  })

  it('reaches an already drawn link when the scope replaces its handler', () => {
    const first = vi.fn<Handler>(link => <b>{`first ${link.label}`}</b>)
    const second = vi.fn<Handler>(link => <i>{`second ${link.label}`}</i>)
    const element = (handler: Handler) => (
      <MarkdownDelegateProvider renderSchemeLink={handler}>
        <MarkdownText text="[MoBA](kg:x)" />
      </MarkdownDelegateProvider>
    )
    const view = render(element(first))
    expect(view.getByText('first MoBA')).toBeTruthy()
    view.rerender(element(second))
    expect(view.queryByText('first MoBA')).toBeNull()
    expect(view.getByText('second MoBA')).toBeTruthy()
  })

  it('lets the claimed element take clicks without the renderer navigating', () => {
    const open = vi.fn()
    const view = render(
      <MarkdownDelegateProvider renderSchemeLink={(link, fallback) => link.scheme === 'kg'
        ? <button type="button" onClick={open}>{link.label}</button>
        : fallback}>
        <MarkdownText text="[MoBA](kg:x)" />
      </MarkdownDelegateProvider>,
    )
    fireEvent.click(view.getByRole('button', { name: 'MoBA' }))
    expect(open).toHaveBeenCalledTimes(1)
  })
})
