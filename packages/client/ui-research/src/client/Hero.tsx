/** The research mark on the blank-session entry and the research tab. */
import type { ReactNode } from 'react'

/** The flask mark standing where the generic brand mark would be. */
export function ResearchHeroMark(props: { size?: number | undefined; className?: string | undefined }): ReactNode {
  const size = props.size ?? 34
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={props.className} aria-hidden="true">
    <path d="M8 3h8M10 3v7L4.6 19a1.3 1.3 0 0 0 1.1 2h12.6a1.3 1.3 0 0 0 1.1-2L14 10V3M8 15h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <circle cx="12" cy="17.5" r="1" fill="currentColor"/>
  </svg>
}
