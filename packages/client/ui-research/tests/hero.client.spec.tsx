// @vitest-environment jsdom

/**
 * The research mark: the flask that stands where the generic brand mark would
 * be, on the blank-session entry and on the research tab. It is decoration, so
 * it never reaches the accessibility tree.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ResearchHeroMark } from '../src/client/Hero.tsx'

afterEach(() => { cleanup() })

describe('the research mark', () => {
  it('draws at the size its host asks for, keeping the host\'s class', () => {
    const svg = render(<ResearchHeroMark size={20} className="host" />).container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('20')
    expect(svg?.getAttribute('height')).toBe('20')
    expect(svg?.getAttribute('class')).toBe('host')
  })

  it('stands at its own size when the host names none, hidden from assistive technology', () => {
    const svg = render(<ResearchHeroMark />).container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('34')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })
})
