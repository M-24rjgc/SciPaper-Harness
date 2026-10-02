/**
 * A `kg:` link in an assistant reply, drawn as a chip. The agent writes `[MoBA](kg:ai:paper:42)` with an id it read in a
 * knowledge call's result. The link is a chip only when a knowledge call of this conversation touched that id; a made-up
 * id, one from another conversation and a malformed one stay the link's plain text. A chip reads the person's marks as
 * they stand now, so it is struck through while its node is marked not relevant and outlined while it is pinned, and a click
 * brings its node into focus in the graph beside the conversation, as the chips of the tool card do.
 */
import { useEffect, useMemo, type ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageLinkProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { sessionProject, type ResearchLinkInjected } from './contract.ts'
import { verdictOf } from './followValues.ts'
import { knowledgeTargetOf, linkIds, sameTarget } from './linkValues.ts'
import { relationSentence } from './relationsValues.ts'
import styles from './KnowledgeLink.module.css'

/** A `kg:` link's props: the slot's own, the research dictionary, and the injected record, marks and graph opener. */
export type KnowledgeLinkProps = MessageLinkProps & PropsLocale<'research'> & InjectFace<ResearchLinkInjected>

/**
 * One `kg:` link of an assistant reply.
 * @param props - the link's scheme, destination and plain label with the research face.
 * @returns the chip for a node or relation the conversation's knowledge calls touched, else the label as plain text.
 */
export function KnowledgeLink(props: KnowledgeLinkProps): ReactNode {
  const { destination, label, t } = props
  const ids = useMemo(() => linkIds(destination), [destination])
  const target = props.useChat(chat => knowledgeTargetOf(chat, ids), sameTarget)
  const snapshot = props.useResearch(view => view.snapshot)
  const directories = props.useDirectories(value => value)
  const project = sessionProject(snapshot?.projects, props.sessionId, directories)
  const read = props.useMarks(state => project === undefined ? undefined : state[project.id])
  // A chip reads whether its node is marked now, so the marks are read once a chip names a node of a graph, and again
  // whenever the record changes: the agent marks through its own calls, which the marks store does not see.
  const marked = target?.kind === 'node' && target.node.source !== 'relations' && snapshot?.knowledge?.enabled === true
  useEffect(() => { if (marked && project !== undefined) props.readMarks(project.id) }, [marked, project?.id, project?.revision])
  if (target === undefined) return label
  if (target.kind === 'relation') {
    const sentence = relationSentence(target.names.from, target.edge.kind, target.names.to, t)
    const text = label === '' ? sentence : label
    return <button type="button" className={styles.chip} data-look="relation" data-kg-link="relation" aria-label={t('kgLinkRelation', { name: text })}
      title={t('kgLinkOpen', { name: sentence })} onClick={() => { props.openKnowledge({ call: target.call, node: target.edge.from }) }}>{text}</button>
  }
  const text = label === '' ? target.node.label : label
  const verdict = read?.honour === false ? undefined : verdictOf(read?.marks ?? [], target.id)
  return <button type="button" className={styles.chip} data-look={verdict === 'pin' ? 'pinned' : verdict === 'irrelevant' ? 'struck' : 'plain'}
    data-kg-link="node" aria-label={verdict === 'pin' ? t('kfChipPinned', { name: text }) : verdict === 'irrelevant' ? t('kfChipIrrelevant', { name: text }) : text}
    title={t('kgLinkOpen', { name: target.node.label })} onClick={() => { props.openKnowledge({ call: target.call, node: target.id }) }}>{text}</button>
}
