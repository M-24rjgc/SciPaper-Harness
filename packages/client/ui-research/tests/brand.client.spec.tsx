// @vitest-environment jsdom

/** The product's mark and name in the native sidebar's brand row. */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ResearchBrand, ResearchMark } from '../src/client/Brand.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

describe('the brand row', () => {
  it('names the product, beside a mark that says nothing to a screen reader', () => {
    expect(render(<ResearchBrand t={((key: keyof typeof zh) => zh[key]) as never} />).container.textContent).toBe(zh.name)
    cleanup()
    const mark = render(<ResearchMark />).container.querySelector('svg')
    expect(mark?.getAttribute('aria-hidden')).toBe('true')
  })
})
