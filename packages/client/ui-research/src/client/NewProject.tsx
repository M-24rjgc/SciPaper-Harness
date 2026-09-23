/** Start a research project from the composer with a typed or picked directory. */
import type { ReactNode } from 'react'
import { useSessionProject, type SessionSeatProps, type WorkbenchProps } from './contract.ts'
import { ResearchProjectEntry } from './ProjectEntry.tsx'

/** The composer draft, which becomes the project's initial brief. */
export interface NewProjectOwnerProps {
  useInput: (select: (state: { draft: string }) => string) => string
}

/** Offer a new project from a conversation that works outside every project. */
export function ResearchNewProject(props: WorkbenchProps & SessionSeatProps & NewProjectOwnerProps): ReactNode {
  const draft = props.useInput(state => state.draft)
  if (useSessionProject(props)) return null
  return <ResearchProjectEntry {...props} composerDraft={draft.trim()} />
}
