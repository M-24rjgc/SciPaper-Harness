/**
 * The pure parts of a `kg:` link in an assistant reply. The agent writes an ordinary Markdown link whose destination is
 * `kg:` and an id it read in a knowledge call's result; the link is a chip only for an id that one of the conversation's
 * own knowledge calls touched, found in the traces those calls left, and is plain text for anything else. The destination
 * is untrusted model text: it is looked up by exact id and never followed.
 */
import type { KnowledgeTraceEdge, KnowledgeTraceNode } from '@deepseek-ai/dsh-research-workbench/types'
import { turnCalls, type KnowledgeChat } from './followValues.ts'
import { knowledgeTraceOf } from './toolCallValues.ts'

/** The scheme the research claims in assistant text. */
export const KNOWLEDGE_SCHEME = 'kg'

/** A node or a relation a knowledge call of the conversation touched, and the call that touched it. */
export type KnowledgeTarget =
  | { kind: 'node'; id: string; call: string; node: KnowledgeTraceNode }
  | { kind: 'relation'; id: string; call: string; edge: KnowledgeTraceEdge; names: { from: string; to: string } }

/**
 * The ids a link destination can name: the text after the scheme, and the same text with its percent escapes decoded
 * when it has any and they are well formed.
 * @param destination - the destination as the author wrote it, such as `kg:ai:paper:42`.
 * @returns the candidate ids, in the order to try them; empty when nothing follows the scheme.
 */
export function linkIds(destination: string): string[] {
  const id = destination.slice(destination.indexOf(':') + 1)
  if (id === '') return []
  if (!id.includes('%')) return [id]
  try {
    // Every `%` either starts an escape, which changes the text, or makes the text malformed, which throws.
    return [id, decodeURIComponent(id)]
  } catch {
    // URIError: a malformed escape names no id beyond the literal text.
    return [id]
  }
}

/**
 * The latest knowledge call of the conversation whose trace holds one of the ids, as a node or as a relation.
 * Only settled, successful calls count, and the calls of every loaded turn are searched, newest first.
 * @param snapshot - the Chat target of the conversation.
 * @param ids - the candidate ids of one link.
 * @returns what the id names and the call that touched it; undefined for an id no call of the conversation touched.
 */
export function knowledgeTargetOf(snapshot: KnowledgeChat, ids: readonly string[]): KnowledgeTarget | undefined {
  if (ids.length === 0) return undefined
  const turns = snapshot.timeline.turnOrder
  for (let at = turns.length - 1; at >= 0; at--) {
    for (const call of turnCalls(snapshot, turns[at] as number).reverse()) {
      const trace = knowledgeTraceOf(call)
      if (trace === undefined) continue
      for (const id of ids) {
        const node = trace.nodes.find(item => item.id === id)
        if (node !== undefined) return { kind: 'node', id, call: call.callId, node }
        const edge = trace.edges.find(item => item.id === id)
        if (edge !== undefined) {
          const nameOf = (end: string): string => trace.nodes.find(item => item.id === end)?.label ?? end
          return { kind: 'relation', id, call: call.callId, edge, names: { from: nameOf(edge.from), to: nameOf(edge.to) } }
        }
      }
    }
  }
  return undefined
}

/**
 * Whether two lookups name the same thing, so that a selector hook does not publish an equal target again.
 * @param left - one lookup.
 * @param right - the other.
 * @returns true when both are absent, or both hold the same call and the same node or relation.
 */
export function sameTarget(left: KnowledgeTarget | undefined, right: KnowledgeTarget | undefined): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}
