/** Knowledge calls and traces as the research host writes them, and a conversation that holds them, for the specs of the 对话 view. */
import type { ChatConversationViewNode, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { KnowledgeMarkView, KnowledgeTrace } from '@deepseek-ai/dsh-research-workbench/types'
import type { KnowledgeChat } from '../../src/client/followValues.ts'

let sequence = 0

/**
 * A settled knowledge call whose result carries a trace as its metadata.
 * @param args - the call's arguments.
 * @param meta - the metadata the host persisted: a trace, null for a call with nothing to draw, or anything a spec wants to malform.
 * @param over - fields of the result to replace.
 * @returns the result as the conversation holds it.
 */
export function knowledgeCall(args: Record<string, unknown>, meta: unknown, over: Partial<ToolResultNode> = {}): ToolResultNode {
  sequence += 1
  return {
    kind: 'tool-result', seq: sequence, time: 2_000, callId: `kg-${sequence}`, call: { name: 'research_knowledge', argsRaw: JSON.stringify(args) },
    callTime: 1_000, content: [{ type: 'text', text: '{"message":"done"}' }], isError: false, subCalls: [], meta, ...over,
  }
}

/** One turn of a spec conversation: the results its tool rows hold, in order, beside rows of other kinds. */
export interface SpecTurn {
  turn: number
  calls: readonly ToolResultNode[]
}

/**
 * The parts of a Chat target that the search for knowledge calls reads, over turns of tool rows.
 * @param turns - the turns, oldest first.
 * @returns the conversation; a key it does not hold reads as absent.
 */
export function chatOf(turns: readonly SpecTurn[]): KnowledgeChat {
  const nodes = new Map<string, ChatConversationViewNode>()
  const keys = new Map<number, string[]>()
  for (const { turn, calls } of turns) {
    keys.set(turn, [`turn-${turn}-assistant`, ...calls.map(call => `tool-${call.callId}`)])
    nodes.set(`turn-${turn}-assistant`, { key: `turn-${turn}-assistant`, kind: 'assistant-step', id: `a${turn}`, target: 'chat', data: {}, anchorSeq: turn, location: { kind: 'unresolved' }, visibility: 'visible' })
    for (const call of calls) {
      nodes.set(`tool-${call.callId}`, {
        key: `tool-${call.callId}`, kind: 'tool-call', id: call.callId, target: 'chat', data: { root: call }, anchorSeq: call.seq, location: { kind: 'unresolved' }, visibility: 'visible',
      })
    }
  }
  return {
    timeline: { turnOrder: turns.map(item => item.turn) },
    locations: { getTurn: turn => keys.get(turn) ?? [] },
    nodes: { get: key => nodes.get(key) },
  }
}

/** The moves of a researcher's turn: a recall that pinned MoBA and left MInference out, and the paths that followed. */
export const RECALL: KnowledgeTrace = {
  v: 1, action: 'recall', query: 'block sparse attention long context', edges: [], marks: { count: 3 },
  nodes: [
    { id: 'ai:paper:moba', source: 'ai', kind: 'paper', label: 'MoBA', use: 'pinned', index: 7 },
    { id: 'ai:paper:minf', source: 'ai', kind: 'paper', label: 'MInference', use: 'skipped', index: 9 },
    { id: 'ai:pattern:adaptive', source: 'ai', kind: 'pattern', label: 'Adaptive sparse attention', use: 'recalled' },
    { id: 'ai:paper:flex', source: 'ai', kind: 'paper', label: 'FlexPrefill', use: 'recalled', index: 11 },
  ],
}
/** Two paths from the fixed-block method to full attention, one hop of which the person recorded. */
export const PATHS: KnowledgeTrace = {
  v: 1, action: 'relations-paths', paths: 2,
  nodes: [
    { id: 'method:fixed', source: 'relations', kind: 'method', label: 'Fixed blocks', use: 'end' },
    { id: 'method:flex', source: 'relations', kind: 'method', label: 'FlexPrefill' },
    { id: 'method:full', source: 'relations', kind: 'method', label: 'Full attention', use: 'end' },
  ],
  edges: [
    { id: 'compares-with:method:fixed>method:flex', kind: 'compares-with', from: 'method:fixed', to: 'method:flex', walked: true },
    { id: 'compares-with:method:flex>method:full', kind: 'compares-with', from: 'method:flex', to: 'method:full', walked: true },
  ],
}
/** The neighbourhood of the fixed-block method, in which the person's relation and the agent's appear. */
export const AROUND: KnowledgeTrace = {
  v: 1, action: 'relations-neighbourhood',
  nodes: PATHS.nodes.map(node => node.id === 'method:fixed' ? { ...node, use: 'centre' as const } : { id: node.id, source: node.source, kind: node.kind, label: node.label }),
  edges: [
    { id: 'compares-with:method:fixed>method:flex', kind: 'compares-with', from: 'method:fixed', to: 'method:flex', by: 'user' },
    { id: 'compares-with:method:flex>method:full', kind: 'compares-with', from: 'method:flex', to: 'method:full', by: 'agent' },
  ],
}
/** A listing of the person's marks. */
export const MARKS_READ: KnowledgeTrace = { v: 1, action: 'marks', nodes: [], edges: [], marks: { count: 3, honour: true } }

/**
 * A mark of the person on a paper of the built-in graph.
 * @param id - the paper's id in the graph.
 * @param verdict - pin or irrelevant.
 * @param title - the paper's name.
 * @returns the mark as the host lists it.
 */
export function markOn(id: string, verdict: KnowledgeMarkView['verdict'], title: string): KnowledgeMarkView {
  return { id: `ai:paper:${id}`, target: { kind: 'paper', graph: 'ai', id }, verdict, by: 'user', at: '2026-10-02T00:00:00.000Z', title }
}
