/** The product's mark and name in the native sidebar's brand row. */
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** The flask mark, drawn in the sidebar's brand seat. */
export function ResearchMark(): ReactNode {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M8 3h8M10 3v7L4.6 19a1.3 1.3 0 0 0 1.1 2h12.6a1.3 1.3 0 0 0 1.1-2L14 10V3M8 15h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><circle cx="12" cy="17.5" r="1" fill="currentColor"/></svg>
}

/** The independent product name in the native sidebar. */
export function ResearchBrand(props: PropsLocale<'research'>): ReactNode { return <span>{props.t('name')}</span> }
