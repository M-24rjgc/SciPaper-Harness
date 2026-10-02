// @vitest-environment jsdom

/**
 * A `kg:` link in an assistant reply. It is a chip only for an id that a knowledge call of the conversation touched, reads
 * the person's marks as they stand now, and opens its node in the graph beside the conversation; any other id stays the
 * link's text. The conversations and traces are the ones the research host writes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ResearchProject, ResearchSnapshot } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { KnowledgeLink, type KnowledgeLinkProps } from '../src/client/KnowledgeLink.tsx'
import type { KnowledgeMarksState, ResearchView } from '../src/client/contract.ts'
import type { KnowledgeChat } from '../src/client/followValues.ts'
import { en, zh } from '../src/client/locales.ts'
import { MODES } from './fixtures/modes.ts'
import { chatOf, knowledgeCall, markOn, PATHS, RECALL } from './fixtures/trace.ts'

afterEach(() => { cleanup() })

const SESSION = 'session-summary'

/** A dictionary lookup that interpolates `{name}` the way the locale seat does. */
function lookup(dictionary: Record<string, string>): KnowledgeLinkProps['t'] {
  return (key: string, params?: Record<string, unknown>) => {
    const template = dictionary[key] ?? key
    return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
  }
}

const STUDY: ResearchProject = newProject({ root: 'C:\\research\\summary', title: '长文摘要一致性评测', brief: '', mode: 'spark-to-paper', route: 'data' }, 'workspace' as WorkspaceId)
STUDY.sessionId = SESSION

/** The study at a revision of its record. */
function study(revision = 1): ResearchProject {
  return { ...STUDY, revision }
}

function snapshotOf(project: ResearchProject, enabled = true): ResearchSnapshot {
  return {
    projects: [project], preferences: {}, components: [], modes: MODES,
    ...enabled ? { knowledge: { enabled: true, modules: { map: true, evidence: true, memory: true, relations: true } } } : {},
  }
}

interface Seat {
  chat?: KnowledgeChat
  marks?: KnowledgeMarksState
  snapshot?: ResearchSnapshot | null
  dictionary?: Record<string, string>
}

const CHAT = chatOf([
  { turn: 1, calls: [knowledgeCall({ action: 'recall' }, RECALL), knowledgeCall({ action: 'relations-paths' }, PATHS)] },
])
const RECALL_CALL = (CHAT.nodes.get('tool-kg-1')?.data as { root: { callId: string } }).root.callId
const PATHS_CALL = (CHAT.nodes.get('tool-kg-2')?.data as { root: { callId: string } }).root.callId

function face(destination: string, label: string, seat: Seat = {}): { props: KnowledgeLinkProps; reads: string[]; opened: unknown[] } {
  const reads: string[] = []
  const opened: unknown[] = []
  const view: ResearchView = { snapshot: seat.snapshot === undefined ? snapshotOf(study()) : seat.snapshot, tasks: [] }
  return {
    reads, opened,
    props: {
      scheme: 'kg', destination, label, sessionId: SESSION,
      t: lookup(seat.dictionary ?? zh),
      useChat: (select: (chat: KnowledgeChat) => unknown) => select(seat.chat ?? CHAT),
      useResearch: (select: (value: ResearchView) => unknown) => select(view),
      useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
      useMarks: (select: (value: KnowledgeMarksState) => unknown) => select(seat.marks ?? {}),
      readMarks: (projectId: string) => { reads.push(projectId) },
      openKnowledge: (params: unknown) => { opened.push(params) },
    } as KnowledgeLinkProps,
  }
}

describe('a kg link in a reply', () => {
  it('is the link text and nothing else for an id no knowledge call of the conversation touched', () => {
    for (const destination of ['kg:ai:paper:invented', 'kg:', 'kg:ai:paper:moba%00', 'kg:compares-with:method:a>method:b']) {
      const { props } = face(destination, 'MoBA')
      const { container, unmount } = render(<KnowledgeLink {...props} />)
      expect(container.innerHTML).toBe('MoBA')
      unmount()
    }
  })

  it('is plain text in a conversation whose calls never touched the id, even when another conversation did', () => {
    const { props } = face('kg:ai:paper:moba', 'MoBA', { chat: chatOf([{ turn: 1, calls: [] }]) })
    const { container } = render(<KnowledgeLink {...props} />)
    expect(container.innerHTML).toBe('MoBA')
  })

  it('is a chip for a node a call touched, named as the agent wrote it, and opens the node in the graph of that call', () => {
    const { props, opened } = face('kg:ai:paper:flex', 'FlexPrefill')
    const { getByRole } = render(<KnowledgeLink {...props} />)
    const chip = getByRole('button', { name: 'FlexPrefill' })
    expect(chip.getAttribute('data-look')).toBe('plain')
    expect(chip.getAttribute('title')).toBe('在图谱里看 FlexPrefill')
    fireEvent.click(chip)
    expect(opened).toEqual([{ call: RECALL_CALL, node: 'ai:paper:flex' }])
  })

  it('is outlined while its node is pinned and struck through while it is marked not relevant, by the marks as they stand now', () => {
    const marks: KnowledgeMarksState = {
      [STUDY.id]: { honour: true, marks: [markOn('moba', 'pin', 'MoBA'), markOn('minf', 'irrelevant', 'MInference')] },
    }
    const pinned = render(<KnowledgeLink {...face('kg:ai:paper:moba', 'MoBA', { marks }).props} />)
    expect(pinned.getByRole('button', { name: 'MoBA，已钉住' }).getAttribute('data-look')).toBe('pinned')
    const struck = render(<KnowledgeLink {...face('kg:ai:paper:minf', 'MInference', { marks }).props} />)
    expect(struck.getByRole('button', { name: 'MInference，已标为不相关' }).getAttribute('data-look')).toBe('struck')
    const plain = render(<KnowledgeLink {...face('kg:ai:paper:flex', 'FlexPrefill', { marks }).props} />)
    expect(plain.getByRole('button', { name: 'FlexPrefill' }).getAttribute('data-look')).toBe('plain')
  })

  it('follows a change of the marks and shows its node plain while the person has paused the agent following them', () => {
    const state = (verdict: 'pin' | 'irrelevant', honour: boolean): KnowledgeMarksState => ({ [STUDY.id]: { honour, marks: [markOn('flex', verdict, 'FlexPrefill')] } })
    const first = face('kg:ai:paper:flex', 'FlexPrefill', { marks: state('pin', true) })
    const view = render(<KnowledgeLink {...first.props} />)
    expect(view.getByRole('button').getAttribute('data-look')).toBe('pinned')
    view.rerender(<KnowledgeLink {...face('kg:ai:paper:flex', 'FlexPrefill', { marks: state('irrelevant', true) }).props} />)
    expect(view.getByRole('button').getAttribute('data-look')).toBe('struck')
    view.rerender(<KnowledgeLink {...face('kg:ai:paper:flex', 'FlexPrefill', { marks: state('irrelevant', false) }).props} />)
    expect(view.getByRole('button').getAttribute('data-look')).toBe('plain')
  })

  it('is a relation chip with the relation sentence for its title, opening the first end of the relation', () => {
    const { props, opened } = face('kg:compares-with:method:fixed>method:flex', 'Fixed blocks —对比→ FlexPrefill')
    const { getByRole } = render(<KnowledgeLink {...props} />)
    const chip = getByRole('button', { name: '关系：Fixed blocks —对比→ FlexPrefill' })
    expect(chip.getAttribute('data-look')).toBe('relation')
    expect(chip.getAttribute('title')).toBe('在图谱里看 Fixed blocks —对比→ FlexPrefill')
    fireEvent.click(chip)
    expect(opened).toEqual([{ call: PATHS_CALL, node: 'method:fixed' }])
  })

  it('names a chip by what the call saw when the agent wrote no text, and reads in English', () => {
    const node = render(<KnowledgeLink {...face('kg:ai:paper:flex', '', { dictionary: en }).props} />)
    expect(node.getByRole('button', { name: 'FlexPrefill' }).getAttribute('title')).toBe('Show FlexPrefill in the graph')
    const relation = render(<KnowledgeLink {...face('kg:compares-with:method:fixed>method:flex', '', { dictionary: en }).props} />)
    expect(relation.getByRole('button', { name: /^Relation: Fixed blocks —/ })).toBeTruthy()
  })

  it('reads the marks once for a node of a graph, and again when the record changes', () => {
    const first = face('kg:ai:paper:flex', 'FlexPrefill')
    const view = render(<KnowledgeLink {...first.props} />)
    expect(first.reads).toEqual([STUDY.id])
    view.rerender(<KnowledgeLink {...first.props} />)
    expect(first.reads).toHaveLength(1)
    const next = face('kg:ai:paper:flex', 'FlexPrefill', { snapshot: snapshotOf(study(2)) })
    view.rerender(<KnowledgeLink {...next.props} />)
    expect(next.reads).toEqual([STUDY.id])
  })

  it('reads no marks for a relation, an entity of the relation graph, a plain id, or a research without the knowledge graph', () => {
    const relation = face('kg:compares-with:method:fixed>method:flex', 'x')
    const entity = face('kg:method:flex', 'x')
    const missing = face('kg:ai:paper:invented', 'x')
    const off = face('kg:ai:paper:flex', 'x', { snapshot: snapshotOf(study(), false) })
    const loading = face('kg:ai:paper:flex', 'x', { snapshot: null })
    for (const seat of [relation, entity, missing, off, loading]) render(<KnowledgeLink {...seat.props} />)
    expect([relation, entity, missing, off, loading].flatMap(seat => seat.reads)).toEqual([])
  })

  it('draws a node chip while the record has not arrived, plain, since no research says what is marked', () => {
    const { props } = face('kg:ai:paper:flex', 'FlexPrefill', { snapshot: null })
    const { getByRole } = render(<KnowledgeLink {...props} />)
    expect(getByRole('button').getAttribute('data-look')).toBe('plain')
  })
})
