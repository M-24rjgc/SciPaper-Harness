import { describe, expect, it } from 'vitest'
import type { EvidenceGraphClaim, EvidenceGraphLink, EvidenceGraphPage, EvidenceGraphSource } from '@deepseek-ai/dsh-research-workbench/types'
import {
  CLAIM_HEIGHT, NODE_GAP, QUESTION_HALF, SOURCE_HEIGHT, cardWhere, citationMeta, countChips, evidenceLayout, expectedRuns,
  invalidationLines, nextStepKey, sourceIndex, sourceKindText, sourceLabel, sourceMeta, statusText, supportOf, whereText,
} from '../src/client/evidenceValues.ts'
import { en, zh } from '../src/client/locales.ts'
import { translate } from './fixtures/translate.tsx'

const t = translate(en)

const source = (id: string, patch: Partial<EvidenceGraphSource> = {}): EvidenceGraphSource =>
  ({ id, kind: 'literature', label: `Source ${id}`, changed: false, ...patch })
const link = (sourceId: string, patch: Partial<EvidenceGraphLink> = {}): EvidenceGraphLink =>
  ({ sourceId, revision: 1, outdated: false, locator: {}, ...patch })
const claim = (id: string, patch: Partial<EvidenceGraphClaim> = {}): EvidenceGraphClaim => ({
  id, text: `Claim ${id}`, kind: 'empirical', status: 'supported', files: [], links: [], expected: [], expectedMore: 0, ...patch,
})
const page = (claims: EvidenceGraphClaim[], sources: EvidenceGraphSource[]): EvidenceGraphPage => ({
  question: 'Does it scale?', claims, sources,
  summary: { claims: claims.length, supported: 0, stale: 0, missing: 0, proposed: 0, contradicted: 0 },
})
const index = (sources: EvidenceGraphSource[]): ReadonlyMap<string, EvidenceGraphSource> => sourceIndex({ sources })

describe('evidenceLayout', () => {
  const stride = SOURCE_HEIGHT + NODE_GAP
  const prototype = page(
    [
      claim('c1', { links: [link('e1'), link('e2')] }),
      claim('c2', { links: [link('e3'), link('e2')] }),
      claim('c3', { status: 'missing', expected: ['e6'] }),
      claim('c4', { links: [link('e4'), link('e5', { outdated: true })] }),
    ],
    ['e1', 'e2', 'e3', 'e6', 'e4', 'e5'].map(id => source(id)),
  )

  it('stacks the evidence in citation order and puts each claim level with its evidence, pushed down only by the claim above', () => {
    const layout = evidenceLayout(prototype)
    expect(layout.sources.map(node => node.top)).toEqual([0, 1, 2, 3, 4, 5].map(row => row * stride))
    expect(layout.sources[0]).toMatchObject({ id: 'e1', top: 0, center: SOURCE_HEIGHT / 2, source: { id: 'e1' } })
    // With 88 px sources 100 px apart and 108 px claims: c1 wants the middle of e1 and e2 (94 px), c2 the middle of
    // e3 and e2 (194, pushed to 214 by c1), c3 e6 (344, level with it), c4 e4 and e5 (494).
    expect(layout.claims.map(node => [node.id, node.top, node.center])).toEqual([
      ['c1', 40, 94], ['c2', 160, 214], ['c3', 290, 344], ['c4', 440, 494],
    ])
    expect(layout.question).toBe(294)
    expect(layout.height).toBe(5 * stride + SOURCE_HEIGHT)
  })

  it('draws a line from the question to every claim and from every claim to each distinct source, dashed for a placeholder', () => {
    const layout = evidenceLayout(prototype)
    expect(layout.questionEdges).toEqual(layout.claims.map(node => ({ claimId: node.id, from: 294, to: node.center })))
    const edges = layout.sourceEdges.map(edge => [
      edge.claimId, edge.sourceId, edge.from, edge.to, edge.expected, edge.outdated, edge.status,
    ])
    expect(edges).toEqual([
      ['c1', 'e1', 94, 44, false, false, 'supported'], ['c1', 'e2', 94, 144, false, false, 'supported'],
      ['c2', 'e3', 214, 244, false, false, 'supported'], ['c2', 'e2', 214, 144, false, false, 'supported'],
      ['c3', 'e6', 344, 344, true, false, 'missing'],
      ['c4', 'e4', 494, 444, false, false, 'supported'], ['c4', 'e5', 494, 544, false, true, 'supported'],
    ])
  })

  it('draws one line when a claim cites a source twice, outdated if either citation is', () => {
    const layout = evidenceLayout(page([claim('c', { links: [link('s'), link('s', { outdated: true })] })], [source('s')]))
    expect(layout.sourceEdges).toEqual([{
      claimId: 'c', sourceId: 's', from: CLAIM_HEIGHT / 2, to: SOURCE_HEIGHT / 2, expected: false, outdated: true, status: 'supported',
    }])
  })

  it('keeps the question clear of the top edge and the columns tall enough for it', () => {
    const layout = evidenceLayout(page([claim('c', { links: [link('s')] })], [source('s')]))
    expect(layout.claims[0]).toMatchObject({ id: 'c', top: 0, center: CLAIM_HEIGHT / 2, claim: { id: 'c' } })
    expect(layout.question).toBe(QUESTION_HALF)
    expect(layout.height).toBe(2 * QUESTION_HALF)
  })

  it('has nothing to place for a graph without claims', () => {
    expect(evidenceLayout(page([], []))).toEqual({ height: 0, question: 0, claims: [], sources: [], questionEdges: [], sourceEdges: [] })
  })

  it('places a claim whose sources are unknown below the one above it and draws no line to them', () => {
    const layout = evidenceLayout(page([claim('a', { links: [link('s')] }), claim('b', { links: [link('gone')] })], [source('s')]))
    expect(layout.claims[1]).toMatchObject({ id: 'b', top: CLAIM_HEIGHT + NODE_GAP, center: CLAIM_HEIGHT + NODE_GAP + CLAIM_HEIGHT / 2 })
    expect(layout.sourceEdges.map(edge => edge.claimId)).toEqual(['a'])
  })
})

describe('the words on the cards', () => {
  it('names a claim status and counts the conclusions, always showing supported, stale and missing and the others when present', () => {
    expect(statusText('stale', t)).toBe('Re-check')
    const quiet = countChips({ claims: 1, supported: 1, stale: 0, missing: 0, proposed: 0, contradicted: 0 }, t)
    expect(quiet).toEqual([
      { kind: 'total', text: '1 conclusion' }, { kind: 'supported', text: '1 with evidence' },
      { kind: 'stale', text: '0 to re-check' }, { kind: 'missing', text: '0 without evidence' },
    ])
    const full = countChips({ claims: 7, supported: 2, stale: 1, missing: 1, proposed: 2, contradicted: 1 }, t)
    expect(full.map(chip => chip.text)).toEqual([
      '7 conclusions', '2 with evidence', '1 to re-check', '1 without evidence', '2 to verify', '1 contradicted',
    ])
    const chinese = countChips({ claims: 4, supported: 2, stale: 1, missing: 1, proposed: 0, contradicted: 0 }, translate(zh))
    expect(chinese.map(chip => chip.text)).toEqual(['4 条结论', '2 条有证据', '1 条待复核', '1 条缺证据'])
  })

  it('says what kind of source a card is, and that it changed', () => {
    expect(sourceKindText(source('a', { kind: 'run' }), t)).toBe('Run')
    expect(sourceKindText(source('a'), t)).toBe('Literature')
    expect(sourceKindText(source('a', { kind: 'file' }), t)).toBe('File')
    expect(sourceKindText(source('a', { kind: 'expected-run' }), t)).toBe('Expected run')
    expect(sourceKindText(source('a', { changed: true }), t)).toBe('Literature · source changed')
    expect(sourceKindText(source('a', { kind: 'none' }), t)).toBe('Not yet')
  })

  it('names a run with its seed, a source by its title, and the marker by a sentence', () => {
    expect(sourceLabel(source('a', { kind: 'run', label: 'ruler-32k-dynamic', seed: 42 }), t)).toBe('ruler-32k-dynamic · seed 42')
    expect(sourceLabel(source('a', { label: 'Longformer' }), t)).toBe('Longformer')
    expect(sourceLabel(source('a', { kind: 'none', label: '' }), t)).toBe('No run or literature')
  })

  it('gives the meta line of each kind: a run\'s numbers and place, its status when it has no numbers, a source\'s verification and coverage', () => {
    expect(sourceMeta(source('a', { kind: 'run', metrics: { accuracy: 0.814, peak_gb: 37.9, third: 1 }, host: 'local' }), t)).toBe('accuracy 0.814 · peak_gb 37.9 · Local')
    expect(sourceMeta(source('a', { kind: 'run', metrics: {}, status: 'completed', host: 'lab-a100' }), t)).toBe('Completed · lab-a100')
    expect(sourceMeta(source('a', { kind: 'run', status: 'failed' }), t)).toBe('Failed')
    expect(sourceMeta(source('a', { kind: 'run' }), t)).toBe('')
    expect(sourceMeta(source('a', { kind: 'expected-run', status: 'queued', host: 'lab-a100' }), t)).toBe('Queued · lab-a100')
    expect(sourceMeta(source('a', { verified: true, coverage: 'full-text' }), t)).toBe('Verified · Full text')
    expect(sourceMeta(source('a', { verified: false, coverage: 'abstract' }), t)).toBe('Not verified · Abstract only')
    expect(sourceMeta(source('a'), t)).toBe('Not verified')
    expect(sourceMeta(source('a', { coverage: 'metadata', verified: true }), t)).toBe('Verified · Metadata only')
    expect(sourceMeta(source('a', { kind: 'file', coverage: 'abstract' }), t)).toBe('Abstract only')
    expect(sourceMeta(source('a', { kind: 'file', coverage: 'data' }), t)).toBe('')
    expect(sourceMeta(source('a', { kind: 'file' }), t)).toBe('')
    expect(sourceMeta(source('a', { kind: 'none' }), t)).toBe('Nothing cited, nothing under way')
  })

  it('says where a claim is written: the first file, with the others counted, or that no file carries it', () => {
    const file = (path: string) => ({ id: path as never, path, revision: 1, stale: false })
    expect(cardWhere({ files: [] })).toBe('')
    expect(cardWhere({ files: [file('paper/main.tex'), file('paper/fig.pdf')] })).toBe('paper/main.tex')
    expect(whereText({ files: [] }, t)).toBe('Not in any file yet')
    expect(whereText({ files: [file('paper/main.tex')] }, t)).toBe('paper/main.tex')
    expect(whereText({ files: [file('paper/main.tex'), file('a'), file('b')] }, t)).toBe('paper/main.tex and 2 more')
  })

  it('words a citation by where it points and the revision cited', () => {
    expect(citationMeta(link('s', { locator: { page: 3 }, revision: 2 }), t)).toBe('p. 3 · rev. 2')
    expect(citationMeta(link('s'), t)).toBe('rev. 1')
  })
})

describe('what supports a claim', () => {
  const sources = index([source('r', { kind: 'run' }), source('l'), source('x', { kind: 'expected-run' }), source('n', { kind: 'none' })])

  it('groups the citations by source in the order the claim first cites them and skips a source the page does not hold', () => {
    const items = supportOf(claim('c', { links: [link('l', { quote: 'q1' }), link('r'), link('l', { quote: 'q2' }), link('gone')] }), sources)
    expect(items.map(item => [item.source.id, item.links.map(entry => entry.quote)])).toEqual([['l', ['q1', 'q2']], ['r', [undefined]]])
  })

  it('lists the runs a claim waits for and not the marker', () => {
    expect(expectedRuns(claim('c', { expected: ['x', 'n', 'gone'] }), sources).map(item => item.id)).toEqual(['x'])
  })
})

describe('what would invalidate a claim', () => {
  const sources = index([
    source('r1', { kind: 'run' }), source('r2', { kind: 'run' }), source('l1', { label: 'Longformer' }), source('l2', { label: 'BigBird', changed: true }),
    source('f1', { kind: 'file' }),
  ])
  const file = (path: string) => ({ id: path as never, path, revision: 1, stale: false })

  it('says what a contradicted claim stays until it is revised, and that a claim with no source rests on nothing', () => {
    expect(invalidationLines(claim('c', { status: 'contradicted', links: [link('r1')] }), sources, t)).toEqual([en.egInvalidateContradicted])
    expect(invalidationLines(claim('c', { status: 'missing' }), sources, t)).toEqual([en.egInvalidateNone])
    expect(invalidationLines(claim('c', { links: [link('gone')] }), sources, t)).toEqual([en.egInvalidateNone])
  })

  it('counts the runs, literature and files a claim rests on, names the files that would be marked with it, and the sources that already changed', () => {
    const rests = invalidationLines(claim('c', { links: [link('r1'), link('r2'), link('l1'), link('f1')], files: [file('paper/main.tex'), file('paper/b.tex')] }), sources, t)
    expect(rests).toEqual([
      'It rests on 2 runs, 1 literature item, 1 file. If any of them changes, this conclusion is marked for re-checking.',
      'The files that carry it are marked too: paper/main.tex, paper/b.tex.',
    ])
    const stale = invalidationLines(claim('c', { status: 'stale', links: [link('r1'), link('l2', { outdated: true })] }), sources, t)
    expect(stale).toEqual([
      'It rests on 1 run, 1 literature item. If any of them changes, this conclusion is marked for re-checking.',
      'Already flagged: BigBird changed after it was cited.',
    ])
    expect(invalidationLines(claim('c', { links: [link('l1')] }), sources, translate(zh)))
      .toEqual(['它依赖 1 篇文献。其中任何一项变化，这条结论都会被标为待复核。'])
  })
})

describe('the suggested next step', () => {
  const sources = index([source('r1', { kind: 'run' }), source('r2', { kind: 'run' }), source('x', { kind: 'expected-run' }), source('n', { kind: 'none' })])
  it('follows the claim status and what it cites or waits for', () => {
    expect(nextStepKey(claim('c', { status: 'contradicted' }), sources)).toBe('egNextRevise')
    expect(nextStepKey(claim('c', { status: 'stale', links: [link('r1')] }), sources)).toBe('egNextStale')
    expect(nextStepKey(claim('c', { status: 'missing', expected: ['n'] }), sources)).toBe('egNextMissing')
    expect(nextStepKey(claim('c', { status: 'missing', expected: ['x'] }), sources)).toBe('egNextWait')
    expect(nextStepKey(claim('c', { status: 'proposed', links: [link('r1')] }), sources)).toBe('egNextJudge')
    expect(nextStepKey(claim('c', { status: 'proposed', expected: ['x'] }), sources)).toBe('egNextWait')
    expect(nextStepKey(claim('c', { status: 'proposed', expected: ['n'] }), sources)).toBe('egNextTest')
    expect(nextStepKey(claim('c', { links: [link('r1'), link('r1')] }), sources)).toBe('egNextSingle')
    expect(nextStepKey(claim('c', { links: [link('r1'), link('r2')] }), sources)).toBe('egNextOk')
  })
})
