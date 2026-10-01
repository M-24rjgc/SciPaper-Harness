/** Optional relation graph provider; it reads and writes only the project's own record and needs no graph engine. */
import { setTimeout as delay } from 'node:timers/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { getJson } from './literature.ts'
import {
  applyCitationWorks, applyProposals, citationQueries, createCitationFetcher, mergeEntities, mergeSuggestions, readRelations,
  regroundRelations, rejectRelation, relationGraph, restoreRelation, updateRelations, upsertEntity,
  type EntityView, type JsonGetter, type RelationGraphView, type RelationProject,
} from './knowledge-relations.ts'
import { nameKey } from './knowledge-relations-grounding.ts'
import {
  describeGapMatrix, describeNeighbourhood, describePath, findEntities, gapMatrix, neighbourhood, passageIndex, relationPaths,
} from './knowledge-relations-queries.ts'
import { OperationScope } from './operation-scope.ts'
import type {
  RelationCitationsView, RelationDecisionOutcomeView, RelationEntityKind, RelationEntityOutcomeView, RelationGapPage, RelationKindId,
  RelationMergeOutcomeView, RelationMergeSuggestionView, RelationNodeSummary, RelationPathsPage, RelationProposalInput,
  RelationProposalOutcomeView, RelationRegroundView, RelationRejectedView, RelationsPage,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { researchKnowledgeRelations: ResearchKnowledgeRelations }
}

/** Relation graph configuration. */
export interface Config {
  /** How many days a fetched reference list is kept before it is fetched again. */
  citationMaxAgeDays: number
  /** Pause between two requests to OpenAlex or Crossref, in milliseconds; OpenAlex allows ten a second without a key. */
  pauseMs: number
}

/** Most connected entities a page lists. */
const HUBS = 12
/** Rejected relations a page lists. */
const REJECTED_LISTED = 50
/** The client's locale keys for the gap matrix's heading and states (the wording is in the Agent Note on the relation graph). */
const GAP_WORDING: RelationGapPage['wording'] = {
  heading: 'relationsGapHeading',
  states: {
    'reported': 'relationsGapReported', 'project-only': 'relationsGapProjectOnly', 'stale': 'relationsGapStale',
    'mentioned': 'relationsGapMentioned', 'absent': 'relationsGapAbsent', 'uncovered': 'relationsGapUncovered',
  },
}

/** A research whose root holds the relation graph file; the parts of the record the graph reads come with it. */
export type RecordedProject = RelationProject & { root: string }
/** The part of the record that locates the relation graph file. */
export type ProjectRoot = Pick<RecordedProject, 'root'>

/** What the desktop or the agent asks of the neighbourhood read. */
export interface GraphQuery {
  /** An entity id, or a name or alias; the most connected entity when absent. */
  entity?: string | undefined
  kind?: RelationEntityKind | undefined
  hops?: 1 | 2 | undefined
  maxNodes?: number | undefined
  includeStale?: boolean | undefined
  kinds?: RelationKindId[] | undefined
}

/** The paths asked for between two entities. */
export interface PathQuery {
  from: string
  to: string
  kind?: RelationEntityKind | undefined
  k?: number | undefined
  maxHops?: number | undefined
  includeStale?: boolean | undefined
  kinds?: RelationKindId[] | undefined
}

/** The gap matrix asked for. */
export interface GapQuery {
  axis: 'task' | 'dataset' | 'setting'
  rows?: string[] | undefined
  columns?: string[] | undefined
  rollUp?: boolean | undefined
  limit?: number | undefined
}

/** Who acts on the relation graph: the person, or the agent whose proposals face the strict grounding rule. */
export type Actor = 'user' | 'agent'

/** A result for the desktop and the same result in the words the agent reads. */
export interface Answered<T> {
  page: T
  /** The backend's description of the result, for the agent. */
  text: string
}

/** Entities an id or a name stands for: the id itself, an id a merged entity used to have, or the entities whose name or alias it is. */
function resolveNode(graph: RelationGraphView, text: string, kind: RelationEntityKind | undefined): string[] {
  const named = text.trim()
  if (graph.entities.has(named)) return [named]
  const former = [...graph.entities.values()].find(({ entity }) => entity.formerIds?.includes(named) === true)
  if (former !== undefined) return [former.entity.id]
  const ids = findEntities(graph, named, kind)
  // A name that is exactly one entity's name beats the entities that only mention it.
  const exact = ids.filter(id => nameKey((graph.entities.get(id) as EntityView).entity.name) === nameKey(named))
  return exact.length === 1 ? exact : ids
}

function summary(graph: RelationGraphView, id: string): RelationNodeSummary {
  const { entity, status } = graph.entities.get(id) as EntityView
  const degree = (graph.touching.get(id) ?? []).filter(view => view.status !== 'rejected').length
  return { id, kind: entity.kind, name: entity.name, aliases: entity.aliases, status, degree }
}

function byText(a: string, b: string): number { return Number(a > b) - Number(a < b) }

/**
 * The relation graph of a research: typed relations between its methods, tasks, datasets, metrics and papers, each
 * grounded in a quotation of one of its sources.
 */
export class ResearchKnowledgeRelations extends Service {
  static Config: s<Config> = s.object({
    citationMaxAgeDays: s.number().step(1).min(1).default(30),
    pauseMs: s.number().step(1).min(0).default(120),
  })
  private readonly scope = new OperationScope('The relation graph plugin was disabled')
  /** Reads one provider document for the reference lists, as the literature search does. */
  private readonly getter: JsonGetter = getJson

  /**
   * Register the relation graph provider and abort its work in flight when the plugin is disabled.
   * @param ctx - the plugin context.
   * @param config - how long reference lists are kept, and the pause between provider requests.
   */
  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'researchKnowledgeRelations')
    ctx.effect(() => () => this.scope.close(), 'research-knowledge-relations.close')
  }

  /** Waits between provider requests; it ends early, rejecting, when the work is cancelled. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return delay(ms, undefined, { signal })
  }

  /** The stored graph and the view of it derived from the current record. */
  private async derived(project: RecordedProject): Promise<{ file: Awaited<ReturnType<typeof readRelations>>['file']; problems: string[]; graph: RelationGraphView }> {
    const { file, problems } = await readRelations(project.root)
    return { file, problems, graph: relationGraph(file, project) }
  }

  /**
   * Read the graph around an entity: its neighbourhood, the most connected entities and the rejected relations.
   * @param project - the record; its evidence text is not read.
   * @param query - the entity (id, name or alias) and the neighbourhood's limits.
   * @param signal - caller cancellation.
   * @returns the page, and the neighbourhood described for the agent.
   */
  graph(project: RecordedProject, query: GraphQuery, signal: AbortSignal): Promise<Answered<RelationsPage>> {
    return this.scope.run(signal, async () => {
      const { file, problems, graph } = await this.derived(project)
      const views = [...graph.relations.values()]
      const hubs = [...graph.entities.keys()].map(id => summary(graph, id)).filter(node => node.degree > 0)
        .sort((a, b) => b.degree - a.degree || byText(a.id, b.id)).slice(0, HUBS)
      const counts = {
        entities: file.entities.length, relations: views.filter(view => view.status !== 'rejected').length,
        stale: views.filter(view => view.status === 'stale').length, rejected: views.filter(view => view.status === 'rejected').length,
        citationLists: file.citations.length,
      }
      const rejected = views.filter(view => view.status === 'rejected').sort((a, b) => byText(b.relation.updatedAt, a.relation.updatedAt))
        .slice(0, REJECTED_LISTED).map((view): RelationRejectedView => {
          const { relation } = view
          return {
            id: relation.id, kind: relation.kind, from: relation.from, to: relation.to, fromName: summary(graph, relation.from).name,
            toName: summary(graph, relation.to).name, ...relation.rejected === undefined ? {} : { rejection: relation.rejected },
          }
        })
      const page = (match: RelationsPage['match'], candidates: RelationNodeSummary[], center?: string): Answered<RelationsPage> => {
        const found = center === undefined ? undefined : neighbourhood(graph, {
          center, depth: query.hops, maxNodes: query.maxNodes, includeStale: query.includeStale, kinds: query.kinds,
        })
        const base = { problems, counts, match, hubs, candidates, rejected }
        if (found === undefined) {
          const named = (list: RelationNodeSummary[]): string => list.map(node => `${node.name} (${node.kind}, ${node.id})`).join('; ')
          const text = match === 'unknown' ? `No entity of the relation graph is named "${query.entity}".${hubs.length ? ` Most connected: ${named(hubs)}.` : ''}`
            : match === 'ambiguous' ? `"${query.entity}" names several entities; use an id: ${named(candidates)}.`
              : 'The relation graph has no relations yet.'
          return { page: { ...base }, text: [...problems, text].join('\n') }
        }
        return { page: { ...base, neighbourhood: found }, text: [...problems, describeNeighbourhood(found)].join('\n') }
      }
      if (query.entity === undefined) return page('none', [], hubs[0]?.id)
      const ids = resolveNode(graph, query.entity, query.kind)
      if (ids.length === 0) return page('unknown', [])
      if (ids.length > 1) return page('ambiguous', ids.slice(0, HUBS).map(id => summary(graph, id)))
      return page('found', [], ids[0])
    })
  }

  /**
   * Find the best explained paths between two entities.
   * @param project - the record; its evidence text is not read.
   * @param query - the two ends (ids, names or aliases) and the search limits.
   * @param signal - caller cancellation.
   * @returns the paths with the grounds of every hop, and the paths described for the agent.
   */
  paths(project: RecordedProject, query: PathQuery, signal: AbortSignal): Promise<Answered<RelationPathsPage>> {
    return this.scope.run(signal, async () => {
      const { graph } = await this.derived(project)
      const ends = { from: resolveNode(graph, query.from, query.kind), to: resolveNode(graph, query.to, query.kind) }
      const ambiguous = ends.from.length > 1 || ends.to.length > 1
      const none = (code: 'unknown-node' | 'ambiguous-node', text: string): Answered<RelationPathsPage> => ({
        page: {
          from: ends.from.length === 1 ? ends.from[0] as string : query.from, to: ends.to.length === 1 ? ends.to[0] as string : query.to,
          paths: [], none: code, nodes: [],
          ...code === 'ambiguous-node' ? { candidates: { from: ends.from.slice(0, HUBS).map(id => summary(graph, id)), to: ends.to.slice(0, HUBS).map(id => summary(graph, id)) } } : {},
        },
        text,
      })
      if (ends.from.length === 0 || ends.to.length === 0) {
        return none('unknown-node', `No entity of the relation graph is named "${ends.from.length === 0 ? query.from : query.to}".`)
      }
      if (ambiguous) return none('ambiguous-node', 'A name matches several entities; use ids from relations-neighbourhood.')
      const result = relationPaths(graph, {
        from: ends.from[0] as string, to: ends.to[0] as string, k: query.k, maxHops: query.maxHops,
        includeStale: query.includeStale, kinds: query.kinds,
      })
      const ids = [...new Set(result.paths.flatMap(path => path.nodes))]
      const text = result.paths.length === 0
        ? `No path joins ${result.from} and ${result.to}${result.none === 'same-node' ? ': they are one entity' : ' within the hop limit'}.`
        : result.paths.map((path, at) => `Path ${at + 1}: ${describePath(graph, path)}`).join('\n\n')
      return { page: { ...result, nodes: ids.map(id => summary(graph, id)) }, text }
    })
  }

  /** Entity ids for rows or columns given as ids or names; a name that matches none or several is an error naming it. */
  private nodes(graph: RelationGraphView, names: readonly string[], kind: RelationEntityKind): string[] {
    return names.map((name) => {
      const ids = resolveNode(graph, name, kind)
      if (ids.length !== 1) {
        throw new Error(ids.length === 0 ? `No ${kind} of the relation graph is named "${name}".` : `"${name}" names several ${kind}s (${ids.join(', ')}); use an id.`)
      }
      return ids[0] as string
    })
  }

  /**
   * Build the gap matrix of methods against tasks, datasets or settings over the project's own sources.
   * @param project - the record with evidence text loaded; the matrix reads its passages.
   * @param query - the axis, optionally the rows and columns (ids or names), and whether subtypes count; they do not by default.
   * @param signal - caller cancellation.
   * @returns the matrix with the wording keys, and the matrix described for the agent.
   */
  gaps(project: RecordedProject, query: GapQuery, signal: AbortSignal): Promise<Answered<RelationGapPage>> {
    return this.scope.run(signal, async () => {
      const { graph } = await this.derived(project)
      const matrix = gapMatrix(graph, {
        axis: query.axis, limit: query.limit, rollUp: query.rollUp ?? false,
        rows: query.rows === undefined ? undefined : this.nodes(graph, query.rows, 'method'),
        columns: query.columns === undefined || query.axis === 'setting' ? query.columns : this.nodes(graph, query.columns, query.axis),
      }, passageIndex(project))
      return { page: { ...matrix, wording: GAP_WORDING }, text: describeGapMatrix(matrix) }
    })
  }

  /**
   * Check and record proposed relations, each on its own.
   * @param project - the record with evidence text loaded; quotations are searched in it.
   * @param proposals - at most 50 relations with their grounds.
   * @param by - who proposes; the agent's quotations face the strict grounding rule, the person's the lighter one.
   * @param signal - caller cancellation.
   * @returns one outcome per proposal in order, and the repair done to a damaged stored file.
   */
  propose(
    project: RecordedProject, proposals: readonly RelationProposalInput[], by: Actor, signal: AbortSignal,
  ): Promise<Answered<RelationProposalOutcomeView[]> & { repaired: string[] }> {
    return this.scope.run(signal, async () => {
      const now = new Date()
      const proposed = proposals.map(proposal => ({ ...proposal, by }))
      const change = await updateRelations(project.root, now, file => applyProposals(file, project, proposed, now))
      const repaired = change.backup === undefined ? [] : [...change.problems, `The damaged file was copied to ${change.backup} before it was rewritten.`]
      return { page: change.result, text: [...describeOutcomes(change.result), ...repaired].join('\n'), repaired }
    })
  }

  /**
   * Reject or restore a relation, or one of its grounds.
   * @param project - the record (only its root is used).
   * @param change - `reject` or `restore`, the relation, the ground when only one is meant, and a reason for a rejection.
   * @param by - who decides; the person's rejection stands against the agent until the person restores it.
   * @param signal - caller cancellation.
   * @returns the outcome.
   */
  decide(
    project: ProjectRoot,
    change: { verb: 'reject' | 'restore'; relation: string; ground?: string | undefined; reason?: string | undefined },
    by: Actor, signal: AbortSignal,
  ): Promise<RelationDecisionOutcomeView> {
    return this.scope.run(signal, async () => {
      const now = new Date()
      const { verb, ...input } = change
      const edit = verb === 'reject' ? rejectRelation : restoreRelation
      const { result } = await updateRelations(project.root, now, file => edit(file, { ...input, by }, now))
      return result.status === 'refused' ? result : { status: result.status, relation: result.relation.id }
    })
  }

  /**
   * Create an entity, or add aliases to the one a name already names.
   * @param project - the record (only its root is used).
   * @param input - the kind, name and aliases.
   * @param by - who acts.
   * @param signal - caller cancellation.
   * @returns the outcome.
   */
  entity(
    project: ProjectRoot, input: { kind: 'method' | 'task' | 'dataset' | 'metric'; name: string; aliases?: string[] | undefined },
    by: Actor, signal: AbortSignal,
  ): Promise<RelationEntityOutcomeView> {
    return this.scope.run(signal, async () => {
      const now = new Date()
      return (await updateRelations(project.root, now, file => upsertEntity(file, { ...input, by }, now))).result
    })
  }

  /**
   * Merge one entity into another of its kind; no operation undoes it.
   * @param project - the record (only its root is used).
   * @param input - the merged entity and the survivor, by id.
   * @param by - who merges.
   * @param signal - caller cancellation.
   * @returns the outcome.
   */
  merge(
    project: ProjectRoot, input: { from: string; into: string }, by: Actor, signal: AbortSignal,
  ): Promise<RelationMergeOutcomeView> {
    return this.scope.run(signal, async () => {
      const now = new Date()
      return (await updateRelations(project.root, now, file => mergeEntities(file, { ...input, by }, now))).result
    })
  }

  /**
   * Pairs of entities that may be one.
   * @param project - the record (only its root is used).
   * @param signal - caller cancellation.
   * @returns the suggestions and the same described for the agent.
   */
  suggestions(project: ProjectRoot, signal: AbortSignal): Promise<Answered<RelationMergeSuggestionView[]>> {
    return this.scope.run(signal, async () => {
      const { file } = await readRelations(project.root)
      const found = mergeSuggestions(file)
      const names = new Map(file.entities.map(entity => [entity.id, entity.name]))
      const name = (id: string): string => names.get(id) as string
      const text = found.length === 0 ? 'No two entities look like one.'
        : found.map(item => `${name(item.a)} (${item.a}) and ${name(item.b)} (${item.b}): ${item.reason} ("${item.names[0]}" / "${item.names[1]}")`).join('\n')
      return { page: found, text }
    })
  }

  /**
   * Check the quotations whose source moved to a new revision against it, and move those that still hold.
   * @param project - the record with evidence text loaded.
   * @param signal - caller cancellation.
   * @returns how many quotations moved and how many no longer hold.
   */
  reground(project: RecordedProject, signal: AbortSignal): Promise<RelationRegroundView> {
    return this.scope.run(signal, async () => {
      const now = new Date()
      return (await updateRelations(project.root, now, file => regroundRelations(file, project, now))).result
    })
  }

  /**
   * Fetch the reference lists of the papers whose list is missing or older than the configured age from OpenAlex and
   * Crossref, and record every citation among the project's papers. Cancelling stops the requests; nothing is written then.
   * @param project - the record.
   * @param signal - caller cancellation.
   * @returns the papers asked for, the lists now cached, the citations added, and the failed requests.
   */
  citations(project: RecordedProject, signal: AbortSignal): Promise<RelationCitationsView> {
    return this.scope.run(signal, async (scoped) => {
      const { file } = await readRelations(project.root)
      const asked = citationQueries(file, project, new Date(), this.config.citationMaxAgeDays)
      const fetcher = createCitationFetcher(this.getter, {
        pauseMs: this.config.pauseMs, sleep: (ms, wait) => this.sleep(ms, wait), now: () => new Date(),
      })
      const fetched = asked.length === 0 ? { works: [], failures: [] } : await fetcher.fetch(asked, scoped)
      scoped.throwIfAborted()
      const now = new Date()
      const { result } = await updateRelations(project.root, now, stored => applyCitationWorks(stored, project, fetched.works, now))
      return { asked: asked.length, ...result, failures: fetched.failures }
    })
  }
}

/** One line per proposal, in order: what was recorded, or what to change. */
function describeOutcomes(outcomes: readonly RelationProposalOutcomeView[]): string[] {
  return outcomes.map((outcome, at) => {
    if (outcome.status === 'refused') return `${at + 1}. refused (${outcome.code}): ${outcome.message}`
    const notes = [...outcome.restored ? ['lifted an earlier rejection'] : [], ...outcome.locatorCorrected ? ['locator corrected'] : [], ...outcome.warnings]
    return `${at + 1}. ${outcome.status} ${outcome.relation} [ground ${outcome.ground}]${notes.length === 0 ? '' : ` (${notes.join('; ')})`}`
  })
}

export default ResearchKnowledgeRelations
