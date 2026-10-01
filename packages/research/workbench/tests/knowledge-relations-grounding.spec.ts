import { describe, expect, it } from 'vitest'
import {
  RELATION_GROUNDING_RULE, RELATION_RULES, acronymDefinitions, describeLocator, findMentions, foldText, groundQuote, groundRun,
  isCapitalAcronym, nameKey, nameKeys, runEvidence, settingKey, settingKeys, tokenize,
  type GroundingEnd, type QuoteRequest, type RunRequest,
} from '../src/knowledge-relations-grounding.ts'
import type { EvidenceChunk, EvidenceId, EvidenceRecord, ExperimentId, ExperimentRecord, SourceLocator } from '../src/types.ts'

function record(id: string, chunks: [SourceLocator, string][], extra: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: id as EvidenceId, title: `Paper ${id}`, kind: 'literature', path: `.research/sources/${id}/reference.json`, sha256: 'x', revision: 1,
    importedAt: '2026-10-01T00:00:00.000Z', chunks: chunks.map(([locator, text]): EvidenceChunk => ({ locator, text })), coverage: 'full-text',
    verified: true, stale: false, ...extra,
  }
}
const end = (names: string[], extra: Partial<GroundingEnd> = {}): GroundingEnd => ({ kind: 'method', names, introducedBy: [], records: [], ...extra })
const request = (overrides: Partial<QuoteRequest>): QuoteRequest => ({
  kind: 'evaluated-on', from: end(['MoBA']), to: end(['RULER'], { kind: 'dataset' }), evidence: undefined, revision: 1, quote: '', strict: true, ...overrides,
})
const refusal = (result: ReturnType<typeof groundQuote>): string => result.ok ? 'ok' : result.code
/** The refusal's message, or an empty string for a ground that holds. */
const said = (result: { ok: true } | { ok: false; message: string }): string => result.ok ? '' : result.message
const SOFT_HYPHEN = String.fromCharCode(0xAD)
const NO_BREAK = String.fromCharCode(0xA0)

describe('folding text for quotation search', () => {
  it('ignores ligatures, case, spacing, dashes, soft hyphens, accents and Markdown marks, and straightens quotes', () => {
    expect(foldText(`Eﬃcient  pro-\ncess “needle” ‘a’ **bold** _x_ \`y\` # Café${SOFT_HYPHEN}–—`)).toBe('efficientprocess"needle"\'a\'boldxycafe')
    expect(foldText('ＢＥＲＴ，ok')).toBe('bert,ok')
  })
})

describe('tokens and name keys', () => {
  it('splits words at case changes, keeps plural acronyms whole and gives CJK characters one token each', () => {
    expect(tokenize('withFlashAttention-2 QAFactEval FP16FlashAttention FLOPs LLMs 块稀疏').map(token => token.key)).toEqual([
      'with', 'flash', 'attention', '2', 'qa', 'fact', 'eval', 'fp16', 'flash', 'attention', 'flop', 'llm', '块', '稀', '疏',
    ])
    expect(tokenize('RULER Ruler é').map(token => [token.key, token.upper, token.start, token.end])).toEqual([
      ['ruler', true, 0, 5], ['ruler', false, 6, 11], ['e', false, 12, 13],
    ])
  })

  it('makes one key of case, spacing, hyphenation and conservative plural variants', () => {
    expect(nameKey('Block-Sparse Attentions')).toBe(nameKey('blocksparse attention'))
    expect(['studies', 'classes', 'boxes', 'news', 'analysis', 'corpus', 'bias', 'models', 'gas'].map(nameKey)).toEqual([
      'study', 'class', 'box', 'news', 'analysis', 'corpus', 'bias', 'model', 'gas',
    ])
    expect(nameKey('MoE')).not.toBe(nameKey('mixture of experts'))
    expect(nameKey('—')).toBe('')
  })

  it('treats short all-capital names as acronyms that only capitals spell', () => {
    expect(['TRUE', 'QA', 'NSA2', 'F1', 'MoBA', 'TRUE benchmark', 'ABCDEFG', '12'].map(isCapitalAcronym)).toEqual([true, true, true, false, false, false, false, false])
    expect([...nameKeys(['TRUE', 'True', 'LED', ''])]).toEqual([['true', false], ['led', true]])
    const tokens = tokenize('it is true that LED led to TRUE results')
    expect(findMentions(tokens, 'true', true)).toEqual([{ first: 7, last: 8 }])
    expect(findMentions(tokens, 'led', false).length).toBe(2)
    expect(findMentions(tokens, '')).toEqual([])
    expect(findMentions(tokenize('Long former'), 'longformer')).toEqual([{ first: 0, last: 2 }])
  })
})

describe('acronyms a source defines', () => {
  it('finds both orders, ignores parentheses that define nothing, and lists each definition once', () => {
    const text = 'We introduce Mixture of Block Attention (MoBA), applying Mixture of Experts (MoE; Shazeer). QAGS (Question Answering and Generation '
      + 'for Summarization) is a metric. Longformer (Beltagy et al., 2020) and (MoBA) again: Mixture of Block Attention (MoBA). BERT (bidirectional) '
      + 'pro-\ncessing (a (nested) one) and (unclosed'
    expect(acronymDefinitions(text)).toEqual([
      { short: 'MoBA', long: 'Mixture of Block Attention' },
      { short: 'MoE', long: 'Mixture of Experts' },
      { short: 'QAGS', long: 'Question Answering and Generation for Summarization' },
    ])
    expect(acronymDefinitions(`${'x'.repeat(10)} (${'y'.repeat(130)})`)).toEqual([])
    expect(acronymDefinitions('the needle-in-a-haystack (NIAH) test')).toEqual([{ short: 'NIAH', long: 'needle-in-a-haystack' }])
    expect(acronymDefinitions('(MB) starts the text')).toEqual([])
    expect(acronymDefinitions('a Gated Recurrent Unit (G.R.U) cell')).toEqual([{ short: 'G.R.U', long: 'Gated Recurrent Unit' }])
    expect(acronymDefinitions('a Transformer (TF) model')).toEqual([])
  })
})

describe('settings and locators', () => {
  it('finds a context length under its other spellings and groups by the K form', () => {
    expect(settingKeys('32K')).toEqual(['32k', '32768', '32000'])
    expect(settingKeys('65536')).toEqual(['65536', '64k'])
    expect(settingKeys('1000')).toEqual(['1000'])
    expect(settingKeys('zero-shot')).toEqual(['zeroshot'])
    expect([settingKey('32768'), settingKey('32,768'), settingKey('zero-shot')]).toEqual(['32k', '32k', 'zeroshot'])
  })

  it('describes each kind of locator', () => {
    expect([{ page: 3 }, { line: 2 }, { paragraph: 4 }, { key: 'abstract' }, { key: 'title' }, {}].map(describeLocator))
      .toEqual(['page 3', 'line 2', 'paragraph 4', 'the abstract', 'the title', 'the text'])
  })
})

describe('quotation grounds', () => {
  const moba = record('moba', [
    [{ key: 'abstract' }, 'MoBA is evaluated on RULER in the provider abstract.'],
    [{ page: 1 }, `We introduce Mixture of Block Attention (MoBA), a novel architecture.\nIn the longest bench-\nmark, RULER, MoBA${NO_BREAK}achieves 0.78 at 128K.`],
    [{ page: 2 }, 'MoBA does not outperform full attention here. Full attention is outperformed by MoBA on the second task. MoBA is compared\nwith'],
    [{ page: 3 }, 'full attention on long documents.'],
    [{ key: 'bibtex' }, '@misc{moba, title={MoBA RULER evaluation results}}'],
  ])

  it('refuses sources it cannot quote', () => {
    expect(refusal(groundQuote(request({ quote: 'x' })))).toBe('unknown-source')
    expect(refusal(groundQuote(request({ evidence: { ...moba, stale: true }, quote: 'x' })))).toBe('source-stale')
    expect(refusal(groundQuote(request({ evidence: moba, revision: 2, quote: 'x' })))).toBe('revision-changed')
    expect(refusal(groundQuote(request({ evidence: { ...moba, kind: 'experiment' }, quote: 'x' })))).toBe('not-quotable')
    expect(refusal(groundQuote(request({ evidence: moba, quote: 'word '.repeat(120) })))).toBe('quote-too-long')
  })

  it('refuses a quotation the revision does not hold, saying where it parts from the source', () => {
    const result = groundQuote(request({ evidence: moba, quote: 'In the longest benchmark, RULER, MoBA achieves 0.99 at 128K.' }))
    expect(result).toMatchObject({ ok: false, code: 'quote-not-found' })
    expect(result.ok ? '' : result.message).toContain('Its start matches page 1 up to "…hmark, RULER, MoBA achieves 0."; there the source continues "78 at 128K.…" where the quotation has "99 at 128K.…".')
    const unrelated = groundQuote(request({ evidence: moba, quote: 'Entirely unrelated words here' }))
    expect([refusal(unrelated), said(unrelated)]).toEqual(['quote-not-found', expect.stringContaining('No part of it occurs')])
    expect(refusal(groundQuote(request({ evidence: moba, quote: '— —' })))).toBe('quote-not-found')
    expect(refusal(groundQuote(request({ evidence: moba, quote: 'MoBA RULER evaluation results' })))).toBe('quote-not-found')
  })

  it('accepts a quotation across a page break and keeps the source\'s words', () => {
    const result = groundQuote(request({ kind: 'compares-with', to: end(['full attention']), evidence: moba, quote: 'MoBA is compared with full attention', locator: { page: 9 } }))
    expect(result).toEqual({ ok: true, locator: { page: 2 }, quote: 'MoBA is compared with full attention', locatorCorrected: true, warnings: [] })
  })

  it('prefers the pages over the provider abstract and refuses the abstract alone when the record has full text', () => {
    expect(groundQuote(request({ evidence: moba, quote: 'In the longest benchmark, RULER, MoBA achieves 0.78 at 128K', locator: { page: 1 }, setting: '128K' })))
      .toEqual({ ok: true, locator: { page: 1 }, quote: 'In the longest benchmark, RULER, MoBA achieves 0.78 at 128K', locatorCorrected: false, warnings: [] })
    expect(refusal(groundQuote(request({ evidence: moba, quote: 'MoBA is evaluated on RULER in the provider abstract.' })))).toBe('abstract-only')
    const lenient = groundQuote(request({ evidence: moba, quote: 'MoBA is evaluated on RULER in the provider abstract.', strict: false }))
    expect(lenient).toMatchObject({ ok: true, locator: { key: 'abstract' }, warnings: [expect.stringContaining('only in the provider\'s abstract')] })
    expect(groundQuote(request({ evidence: { ...moba, coverage: 'abstract' }, quote: 'MoBA is evaluated on RULER in the provider abstract.' }))).toMatchObject({ ok: true })
  })

  it('needs four words, the two ends on separate words, and the setting in the quotation', () => {
    expect(refusal(groundQuote(request({ evidence: moba, quote: 'RULER, MoBA achieves' })))).toBe('quote-too-short')
    const nsa = groundQuote(request({ evidence: moba, from: end(['NSA'], { introducedBy: [{ evidenceId: 'other', relation: 'r' }] }), quote: 'In the longest benchmark, RULER, MoBA achieves' }))
    expect([refusal(nsa), said(nsa)]).toEqual(['missing-mention', expect.stringContaining('does not name "NSA" by its name, an alias or an acronym the source defines, or as "we"')])
    const longbench = groundQuote(request({ evidence: moba, to: end(['LongBench'], { kind: 'dataset' }), quote: 'In the longest benchmark, RULER, MoBA achieves' }))
    expect([refusal(longbench), said(longbench)]).toEqual(['missing-mention', expect.stringContaining('does not name "LongBench" by its name')])
    expect(refusal(groundQuote(request({ evidence: moba, from: end(['MoBA RULER']), quote: 'In the longest benchmark, RULER, MoBA achieves' })))).toBe('missing-mention')
    expect(refusal(groundQuote(request({ evidence: moba, quote: 'In the longest benchmark, RULER, MoBA achieves 0.78', setting: '64K' })))).toBe('setting-not-quoted')
    expect(groundQuote(request({ evidence: moba, quote: 'In the longest benchmark, RULER, MoBA achieves 0.78', setting: '64K', strict: false })))
      .toMatchObject({ ok: true, warnings: [expect.stringContaining('The setting "64K" does not occur')] })
  })

  it('names an end by an acronym the record defines', () => {
    const result = groundQuote(request({ from: end(['Mixture of Block Attention']), evidence: moba, quote: 'In the longest benchmark, RULER, MoBA achieves 0.78' }))
    expect(result.ok).toBe(true)
    const reverse = groundQuote(request({ kind: 'is-a', from: end(['MoBA']), to: end(['architecture']), evidence: moba, quote: 'We introduce Mixture of Block Attention (MoBA), a novel architecture' }))
    expect(reverse.ok).toBe(true)
  })

  it('needs the cue of the kind, not negated, and the improving method before the cue or after it in the passive', () => {
    const page2 = { evidence: moba, from: end(['MoBA']), to: end(['full attention']) }
    expect(refusal(groundQuote(request({ ...page2, kind: 'improves-on', quote: 'MoBA does not outperform full attention here.' })))).toBe('negated')
    expect(groundQuote(request({ ...page2, kind: 'improves-on', quote: 'Full attention is outperformed by MoBA on the second task.' })).ok).toBe(true)
    expect(refusal(groundQuote(request({ ...page2, kind: 'improves-on', from: end(['full attention']), to: end(['MoBA']), quote: 'Full attention is outperformed by MoBA on the second task.' })))).toBe('wrong-direction')
    expect(refusal(groundQuote(request({ ...page2, kind: 'is-a', quote: 'Full attention is outperformed by MoBA on the second task.' })))).toBe('missing-cue')
    expect(groundQuote(request({ ...page2, kind: 'is-a', quote: 'Full attention is outperformed by MoBA on the second task.', strict: false })))
      .toMatchObject({ ok: true, warnings: [expect.stringContaining('must say how the two relate')] })
    expect(RELATION_RULES['applied-to'].cue).toBeUndefined()
    // A letter whose lower case is longer (İ) keeps the cue's position in step with the words.
    const turkish = record('t', [[{ page: 1 }, 'İzmir Attention is a kind of sparse attention.']])
    expect(groundQuote(request({ kind: 'is-a', evidence: turkish, from: end(['İzmir Attention']), to: end(['sparse attention']), quote: 'İzmir Attention is a kind of sparse attention.' })).ok).toBe(true)
  })

  it('reads Chinese cues, their negation and the passive 被', () => {
    const note = record('note', [[{ line: 1 }, '动态选块优于固定分块。固定分块被动态选块超过。动态选块并不优于全注意力。动态选块不仅优于固定分块。']], { kind: 'file', coverage: 'full-text' })
    const ends = { evidence: note, kind: 'improves-on' as const, from: end(['动态选块']), to: end(['固定分块']) }
    expect(groundQuote(request({ ...ends, quote: '动态选块优于固定分块。' })).ok).toBe(true)
    expect(groundQuote(request({ ...ends, quote: '固定分块被动态选块超过。' })).ok).toBe(true)
    expect(refusal(groundQuote(request({ ...ends, from: end(['固定分块']), to: end(['动态选块']), quote: '固定分块被动态选块超过。' })))).toBe('wrong-direction')
    expect(refusal(groundQuote(request({ ...ends, to: end(['全注意力']), quote: '动态选块并不优于全注意力。' })))).toBe('negated')
    expect(groundQuote(request({ ...ends, quote: '动态选块不仅优于固定分块。' })).ok).toBe(true)
  })

  it('lets a self-reference name the entity the quoted paper introduces, and only that paper', () => {
    const paper = record('nsa', [[{ page: 2 }, 'We evaluate our method on LongBench. NSA is evaluated by others.']])
    const nsa = end(['NSA'], { introducedBy: [{ evidenceId: 'nsa', relation: 'introduces:paper:nsa>method:nsa' }] })
    const longbench = end(['LongBench'], { kind: 'dataset' })
    expect(groundQuote(request({ evidence: paper, from: nsa, to: longbench, quote: 'We evaluate our method on LongBench.' })))
      .toMatchObject({ ok: true, via: 'introduces:paper:nsa>method:nsa' })
    expect(refusal(groundQuote(request({ evidence: paper, from: end(['NSA']), to: longbench, quote: 'We evaluate our method on LongBench.' })))).toBe('missing-mention')
    const both = groundQuote(request({ kind: 'compares-with', evidence: paper, from: end(['LongBench'], { introducedBy: [{ evidenceId: 'nsa', relation: 'x' }] }), to: nsa, quote: 'We evaluate our method on LongBench.' }))
    expect(refusal(both)).toBe('missing-cue')
    const toSelf = groundQuote(request({ kind: 'applied-to', evidence: paper, from: end(['LongBench']), to: nsa, quote: 'We evaluate our method on LongBench.' }))
    expect(toSelf).toMatchObject({ ok: true, via: 'introduces:paper:nsa>method:nsa' })
  })

  it('takes an introduction only from the paper itself, naming what it introduces', () => {
    const paper = record('moba', moba.chunks.map(chunk => [chunk.locator, chunk.text]))
    const ends = { kind: 'introduces' as const, evidence: paper, from: end(['MoBA paper'], { kind: 'paper', records: ['moba'] }) }
    expect(groundQuote(request({ ...ends, to: end(['MoBA']), quote: 'We introduce Mixture of Block Attention (MoBA), a novel architecture.' })).ok).toBe(true)
    expect(refusal(groundQuote(request({ ...ends, from: end(['Other'], { kind: 'paper', records: ['other'] }), to: end(['MoBA']), quote: 'We introduce Mixture of Block Attention (MoBA), a novel architecture.' })))).toBe('foreign-source')
    expect(refusal(groundQuote(request({ ...ends, to: end(['NSA']), quote: 'We introduce Mixture of Block Attention (MoBA), a novel architecture.' })))).toBe('missing-mention')
  })
})

describe('run grounds', () => {
  const run = (id: string, name: string, status: ExperimentRecord['status'], collected: boolean, metrics: Record<string, number>, argv: string[] = []): ExperimentRecord => ({
    id: id as ExperimentId, spec: { environmentId: 'env' as ExperimentRecord['spec']['environmentId'], name, argv, cwd: '.', seed: 42, maxSeconds: 60, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json' },
    status, createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics, message: '', snapshotPath: '', collected,
  })
  const runs = [
    run('dyn', 'ruler-32k-dynamic', 'completed', true, { accuracy: 0.8, relative_flops: 0.26 }, ['--context', '32768']),
    run('full', 'ruler-32k-full', 'completed', true, { accuracy: 0.82 }),
    run('other', 'other-full', 'completed', true, { loss: 1 }),
    run('stale', 'ruler-32k-stale', 'completed', true, {}),
    run('queued', 'ruler-queued', 'queued', false, {}),
    run('lost', 'ruler-lost', 'completed', true, {}),
  ]
  const results = (id: string, stale = false): EvidenceRecord => record(`r-${id}`, [], { kind: 'experiment', path: `.research/runs/${id}/metrics.json`, stale })
  const evidence = [results('dyn'), results('full'), results('other'), results('stale', true), results('queued')]
  const base = (overrides: Partial<RunRequest>): RunRequest => ({
    kind: 'evaluated-on', from: end(['dynamic block selection']), to: end(['RULER'], { kind: 'dataset' }), runs, evidence, runId: 'dyn', fromLabel: 'dynamic', toLabel: 'ruler', ...overrides,
  })
  const code = (result: ReturnType<typeof groundRun>): string => result.ok ? 'ok' : result.code

  it('finds the record a run\'s results became', () => {
    expect(runEvidence({ id: 'dyn' as ExperimentId }, evidence)?.id).toBe('r-dyn')
    expect(runEvidence({ id: 'none' as ExperimentId }, evidence)).toBeUndefined()
  })

  it('needs a completed run with collected, current results', () => {
    expect(code(groundRun(base({ runId: 'missing' })))).toBe('unknown-run')
    expect(code(groundRun(base({ runId: 'queued' })))).toBe('run-not-collected')
    expect(said(groundRun(base({ runId: 'queued' })))).toContain('is queued and its results are not collected')
    expect([code(groundRun(base({ runId: 'lost' }))), said(groundRun(base({ runId: 'lost' })))]).toEqual(['run-not-collected', expect.stringContaining('is completed;')])
    expect(code(groundRun(base({ runId: 'stale', fromLabel: 'stale' })))).toBe('source-stale')
  })

  it('needs words of the run that name each end, and a setting among them', () => {
    expect(groundRun(base({ setting: '32K' }))).toEqual({ ok: true, run: { runId: 'dyn', evidenceId: 'r-dyn', revision: 1 } })
    expect(groundRun(base({ setting: '32768' })).ok).toBe(true)
    expect(code(groundRun(base({ setting: '64K' })))).toBe('setting-not-quoted')
    expect(code(groundRun(base({ fromLabel: 'full' })))).toBe('run-label')
    expect(code(groundRun(base({ fromLabel: 'context' })))).toBe('run-label')
    expect(code(groundRun(base({ toLabel: 'dynamic' })))).toBe('run-label')
    expect(code(groundRun(base({ fromLabel: '' })))).toBe('run-label')
    expect(groundRun(base({ kind: 'applied-to', to: end(['ruler'], { kind: 'task' }) })).ok).toBe(true)
    expect(code(groundRun(base({ from: end(['dynamic data']), fromLabel: 'data' })))).toBe('run-label')
  })

  it('needs a recorded metric for measured-by', () => {
    const measured = (toLabel: string, metric: string): ReturnType<typeof groundRun> => groundRun(base({ kind: 'measured-by', to: end([metric], { kind: 'metric' }), toLabel }))
    expect(measured('relative_flops', 'relative FLOPs').ok).toBe(true)
    expect(code(measured('perplexity', 'perplexity'))).toBe('run-metric')
    expect(code(measured('accuracy', 'F1'))).toBe('run-metric')
    expect(groundRun(base({ kind: 'measured-by', runId: 'lost', fromLabel: 'lost', from: end(['lost']), to: end(['accuracy'], { kind: 'metric' }), toLabel: 'accuracy' }))).toMatchObject({ code: 'run-not-collected' })
    const empty = groundRun({ ...base({ kind: 'measured-by', to: end(['accuracy'], { kind: 'metric' }), toLabel: 'accuracy' }), runs: [run('dyn', 'ruler-32k-dynamic', 'completed', true, {})] })
    expect([code(empty), said(empty)]).toEqual(['run-metric', expect.stringContaining('recorded no metrics')])
  })

  it('needs the baseline\'s run, collected, named and sharing a metric, for compares-with', () => {
    const compare = (overrides: Partial<RunRequest>): ReturnType<typeof groundRun> =>
      groundRun(base({ kind: 'compares-with', to: end(['full attention']), toLabel: 'full', ...overrides }))
    expect(code(compare({}))).toBe('run-baseline')
    expect(code(compare({ baselineRunId: 'queued' }))).toBe('run-not-collected')
    expect(code(compare({ baselineRunId: 'full', toLabel: 'ruler' }))).toBe('run-label')
    expect(code(compare({ baselineRunId: 'other' }))).toBe('run-baseline')
    expect(code(compare({ baselineRunId: 'dyn', to: end(['dynamic']), toLabel: 'dynamic' }))).toBe('run-baseline')
    expect(compare({ baselineRunId: 'full' })).toEqual({
      ok: true, run: { runId: 'dyn', evidenceId: 'r-dyn', revision: 1 }, baseline: { runId: 'full', evidenceId: 'r-full', revision: 1 },
    })
  })
})

describe('the rule as the agent reads it', () => {
  it('states the quotation, cue, abstract, run and rejection rules', () => {
    for (const phrase of ['at least 4 words', 'outperformed by', 'provider abstract alone is refused', 'baseline\'s run', 'until the person restores it']) {
      expect(RELATION_GROUNDING_RULE).toContain(phrase)
    }
  })
})
