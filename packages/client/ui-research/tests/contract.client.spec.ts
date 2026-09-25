/**
 * How a seat finds the research of its conversation and the installed modes,
 * and how a path inside a research folder is named relative to it.
 */
import { describe, expect, it } from 'vitest'
import { pathInProject, sessionProject, useModes, type ResearchView, type WorkbenchProps } from '../src/client/contract.ts'
import { MODES } from './fixtures/modes.ts'

describe('matching a session to its project', () => {
  it('prefers the bound project, then the innermost folder containing the session', () => {
    const outer = { root: 'C:\\Research', sessionId: 'x' }
    const inner = { root: 'C:\\Research\\Paper\\', sessionId: undefined }
    const posix = { root: '/data/Paper' }
    expect(sessionProject([outer, inner], 'x')).toBe(outer)
    expect(sessionProject([outer, inner], 'y', { y: 'c:/research/paper/sections' })).toBe(inner)
    expect(sessionProject([outer, inner], 'y', { y: 'D:/elsewhere' })).toBeUndefined()
    expect(sessionProject([posix], 'y', { y: '/data/paper' })).toBeUndefined()
    expect(sessionProject([posix], 'y', { y: '/data/Paper' })).toBe(posix)
    expect(sessionProject([posix], 'y')).toBeUndefined()
    expect(sessionProject(undefined, 'y', { y: '/data' })).toBeUndefined()
  })

  it('reads the installed modes from the record, and none before it arrives', () => {
    const props = (snapshot: ResearchView['snapshot']): WorkbenchProps => ({
      useResearch: (select: (value: ResearchView) => unknown) => select({ snapshot, tasks: [] }),
    }) as unknown as WorkbenchProps
    expect(useModes(props({ projects: [], preferences: {}, components: [], modes: MODES }))).toBe(MODES)
    expect(useModes(props(null))).toEqual([])
  })
})

describe('a path inside a research folder', () => {
  it('is named relative to the folder, drive letters compared without case and either separator accepted', () => {
    expect(pathInProject('C:\\Research\\Paper\\', 'c:/research/Paper/figures/Arch.drawio')).toBe('figures/Arch.drawio')
    expect(pathInProject('/data/paper', '/data/paper/figures/a b.drawio')).toBe('figures/a b.drawio')
    expect(pathInProject('\\\\server\\share\\p', '//server/share/p/x.drawio')).toBe('x.drawio')
  })

  it('is nothing for the folder itself, a folder beside it, or a POSIX path in another case', () => {
    expect(pathInProject('/data/paper', '/data/paper')).toBeUndefined()
    expect(pathInProject('/data/paper', '/data/paper-2/x.drawio')).toBeUndefined()
    expect(pathInProject('/data/paper', '/data/Paper/x.drawio')).toBeUndefined()
  })
})
