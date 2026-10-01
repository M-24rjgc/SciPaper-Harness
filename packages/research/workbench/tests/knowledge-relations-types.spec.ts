import { describe, expect, it } from 'vitest'
import type {
  MergeSuggestion, ProposalOutcome, RegroundOutcome, Refusal, RelationEntity, RelationProposal, CitationOutcome, DecisionOutcome,
  MergeOutcome, EntityOutcome,
} from '../src/knowledge-relations.ts'
import type {
  GapCell, GapMatrix, GroundSummary, Neighbourhood, NeighbourhoodEdge, NeighbourhoodNode, PathHop, PathResult, RelationPath,
} from '../src/knowledge-relations-queries.ts'
import type {
  RelationCitationsView, RelationEdgeView, RelationEntityOutcomeView, RelationEntityView, RelationGapCell, RelationGapPage,
  RelationGroundView,
  RelationHopView, RelationMergeOutcomeView, RelationMergeSuggestionView, RelationNeighbourhoodView, RelationNodeView, RelationPathView,
  RelationPathsPage, RelationProposalInput, RelationProposalOutcomeView, RelationRefusalView, RelationRegroundView,
} from '../src/types.ts'

/** Names a pair of types; the declaration compiles only while every value of `From` is also a value of `To`. */
type Follows<From extends To, To> = [From, To]

// What the client reads must follow what the backend returns, so a backend change that the interfaces miss fails the compiler.
type Reads = [
  Follows<GroundSummary, RelationGroundView>,
  Follows<NeighbourhoodNode, RelationNodeView>,
  Follows<NeighbourhoodEdge, RelationEdgeView>,
  Follows<Neighbourhood, RelationNeighbourhoodView>,
  Follows<PathHop, RelationHopView>,
  Follows<RelationPath, RelationPathView>,
  Follows<PathResult, Omit<RelationPathsPage, 'nodes' | 'candidates'>>,
  Follows<GapCell, RelationGapCell>,
  Follows<GapMatrix, Omit<RelationGapPage, 'wording'>>,
  Follows<ProposalOutcome, RelationProposalOutcomeView>,
  Follows<Refusal, RelationRefusalView>,
  Follows<EntityOutcome, RelationEntityOutcomeView>,
  Follows<RelationEntity, RelationEntityView>,
  Follows<MergeOutcome, RelationMergeOutcomeView>,
  Follows<MergeSuggestion, RelationMergeSuggestionView>,
  Follows<RegroundOutcome, RelationRegroundView>,
  Follows<CitationOutcome, Omit<RelationCitationsView, 'asked' | 'failures'>>,
]

// What a person or the agent proposes must follow what the backend accepts, with the author added by the caller.
type Writes = [Follows<RelationProposalInput & { by: 'user' | 'agent' }, RelationProposal>]

// A decision's outcome keeps the relation by id for the client, and loses nothing the client reads.
type Decisions = Follows<Extract<DecisionOutcome, { status: 'changed' | 'unchanged' }>['status'], 'changed' | 'unchanged'>

describe('the relation graph interfaces of the client', () => {
  it('follow the backend\'s types (checked by the compiler)', () => {
    const checked: [Reads, Writes, Decisions] | undefined = undefined
    expect(checked).toBeUndefined()
  })
})
