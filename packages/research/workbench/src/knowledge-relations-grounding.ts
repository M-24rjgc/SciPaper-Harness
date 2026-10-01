/**
 * How one typed relation of a project's relation graph is grounded in the
 * project's own record: a quotation that occurs in one revision of an evidence
 * record, or completed project runs. Citation records, the third kind of
 * ground, are matched in knowledge-relations.ts. This module also owns the
 * text matching that the relation queries reuse: folding text for quotation
 * search, tokens and entity-name keys for mentions, and source-defined
 * acronyms. The rule, its strictness and the measurements behind it are in the
 * Agent Note .agents/notes/proposed/feature/2026-10-01-knowledge-graph-relations.md.
 */
import type { EvidenceChunk, EvidenceRecord, ExperimentRecord, SourceLocator } from './types.ts'

/** Kinds of relation-graph nodes. A paper is always one of the project's literature records. */
export const ENTITY_KINDS = ['method', 'task', 'dataset', 'metric', 'paper'] as const
/** A relation-graph node kind. */
export type EntityKind = typeof ENTITY_KINDS[number]

/** Kinds of directed relation, each read as `from <kind> to`. */
export const RELATION_KINDS = [
  'cites', 'introduces', 'is-a', 'extends', 'improves-on', 'compares-with', 'applied-to', 'evaluated-on', 'measured-by',
] as const
/** A directed relation kind. */
export type RelationKind = typeof RELATION_KINDS[number]

/** What a relation can rest on: a quotation of a source, project runs, or a provider's citation record. */
export type GroundKind = 'quote' | 'run' | 'citation'

/** Cue patterns of one relation kind, matched on the lower-cased quotation. */
export interface Cue {
  /** Patterns of Latin-script sources; `\b` marks word edges. */
  latin: RegExp
  /** Patterns of Chinese sources. */
  zh: RegExp
  /** Plain words naming the cue in a refusal. */
  examples: string
}

/** The node kinds a relation kind joins, what can ground it, and what its quotation must say. */
export interface RelationRule {
  from: readonly EntityKind[]
  to: readonly EntityKind[]
  /** Both ends must be of one kind (`is-a`). */
  sameKind: boolean
  grounds: readonly GroundKind[]
  /** Words a quotation must contain for this kind; absent when naming both ends is enough. */
  cue?: Cue | undefined
  /** The `from` end must be named before an active cue and after a passive one (`improves-on`). */
  directed: boolean
  /** A ground may carry a setting such as a context length (`evaluated-on`). */
  setting: boolean
}

const METHODS = ['method'] as const
const NAMED = ['method', 'task', 'dataset', 'metric'] as const

/** One global pattern matching any of the given ones. */
function anyOf(...patterns: RegExp[]): RegExp {
  return new RegExp(patterns.map(pattern => pattern.source).join('|'), 'g')
}

const IMPROVES = [
  /\boutperform|\bsurpass|\bexceed|\bbeat(?:s|ing)?\b|\bsuperior to\b|\bgains? over\b|\badvantage over\b|\bahead of\b/,
  /\bbetter\b(?:\s+\S+){0,4}?\s+than\b|\bimprov(?:e|es|ed|ing|ement|ements) (?:on|over|upon)\b/,
]
const IMPROVES_ZH = /优于|超过|超越|胜过|好于|强于|领先于|击败/

/** The rule of each relation kind. */
export const RELATION_RULES: Readonly<Record<RelationKind, RelationRule>> = Object.freeze({
  'cites': { from: ['paper'], to: ['paper'], sameKind: false, grounds: ['citation'], directed: false, setting: false },
  'introduces': {
    from: ['paper'], to: NAMED, sameKind: false, grounds: ['quote'], directed: false, setting: false,
    cue: {
      latin: anyOf(
        /\b(?:propos|introduc|present|develop|design|creat|construct|releas|build|built|collect|curat|coin|dub)/,
        /\b(?:term(?:ed)?|call(?:ed)?|named?|novel|new)\b|\brefer(?:s|red)? to (?:this|it|our|the)\b[^.]{0,40}?\bas\b/,
      ),
      zh: anyOf(/提出|引入|推出|设计|构建|发布|收集|命名|称为|介绍|新的/),
      examples: 'propose, introduce, present, develop, release',
    },
  },
  'is-a': {
    from: NAMED, to: NAMED, sameKind: true, grounds: ['quote'], directed: false, setting: false,
    cue: {
      latin: anyOf(
        /\b(?:is|are|was|were) (?:a|an|one|another)\b/,
        /\b(?:a|an) (?:type|kind|class|family|form|variant|instance|example|member|category) of\b/,
        /\bsuch as\b|\be\.g\.|\binclud(?:e|es|ing)\b|\bamong\b|, (?:a|an) |\bas (?:a|an)\b|\bvariants?\b|\bspecial case|\bexemplif/,
      ),
      zh: anyOf(/是一种|是一类|属于|之一|的一种|例如|比如|诸如|包括|变体/),
      examples: 'is a, a kind of, such as, including, a variant of',
    },
  },
  'extends': {
    from: METHODS, to: METHODS, sameKind: false, grounds: ['quote'], directed: false, setting: false,
    cue: {
      latin: anyOf(
        /\bextend|\bextension\b|\bbuil(?:d|ds|t|ding) (?:on|upon)\b|\bbased on\b|\binspired by\b|\bfollow(?:s|ing)?\b/,
        /\bgenerali[sz]|\badapt|\bvariant\b|\bborrow|\bprinciples? of\b|\bmodification of\b|\bsuccessor/,
      ),
      zh: anyOf(/扩展|基于|建立在|借鉴|沿用|改进自|推广|变体|继承/),
      examples: 'extends, builds on, based on, a variant of',
    },
  },
  'improves-on': {
    from: METHODS, to: METHODS, sameKind: false, grounds: ['quote'], directed: true, setting: false,
    cue: { latin: anyOf(...IMPROVES), zh: anyOf(IMPROVES_ZH), examples: 'outperforms, surpasses, better than, improves on' },
  },
  'compares-with': {
    from: METHODS, to: METHODS, sameKind: false, grounds: ['quote', 'run'], directed: false, setting: false,
    cue: {
      latin: anyOf(/\bcompar|\bbaselines?\b|\bversus\b|\bvs\b|\bagainst\b|\brelative to\b|\bin contrast to\b|\bcontrast/, ...IMPROVES),
      zh: anyOf(/对比|比较|相比|基线|对照/, IMPROVES_ZH),
      examples: 'compared with, baseline, versus, against',
    },
  },
  'applied-to': { from: METHODS, to: ['task'], sameKind: false, grounds: ['quote', 'run'], directed: false, setting: false },
  'evaluated-on': {
    from: METHODS, to: ['dataset'], sameKind: false, grounds: ['quote', 'run'], directed: false, setting: true,
    cue: {
      latin: anyOf(
        /\bevaluat|\bbenchmark|\bexperiment|\btest(?:s|ed|ing)?\b|\bresults?\b|\bscor(?:e|es|ed|ing)\b|\bachiev|\bperform|\baccura/,
        /\breport|\bmeasur|\bassess|\bvalidat|\bdemonstrat|\bstate[ -]of[ -]the[ -]art\b|\bleaderboard|\bf1\b|\brouge\b|\bauc\b/,
        ...IMPROVES,
      ),
      zh: anyOf(/评测|评估|测试|实验|结果|基准|准确率|得分|表现|测评/, IMPROVES_ZH),
      examples: 'evaluate, benchmark, results on, achieves, accuracy',
    },
  },
  'measured-by': {
    from: ['method', 'task', 'dataset'], to: ['metric'], sameKind: false, grounds: ['quote', 'run'], directed: false, setting: false,
  },
})

/** Why a ground does not support a relation; each refusal also carries a message saying what to change. */
export type GroundingCode =
  | 'unknown-source' | 'source-stale' | 'revision-changed' | 'not-quotable' | 'quote-too-short' | 'quote-too-long'
  | 'quote-not-found' | 'abstract-only' | 'foreign-source' | 'missing-mention' | 'missing-cue' | 'negated' | 'wrong-direction'
  | 'setting-not-quoted' | 'unknown-run' | 'run-not-collected' | 'run-label' | 'run-metric' | 'run-baseline'

/** Longest quotation kept, in UTF-16 code units after whitespace is collapsed. */
export const MAX_QUOTE_LENGTH = 500
/** Least content a quotation carries: Latin words, with two CJK characters counting as one word. */
export const MIN_QUOTE_WORDS = 4
/** Longest setting label, such as `32K` or `zero-shot`. */
export const MAX_SETTING_LENGTH = 40

// ── Folding text for quotation search ───────────────────────────────────────

const SINGLE_QUOTES = new Set(['‘', '’', '‚', '‛', '′', 'ʼ'])
const DOUBLE_QUOTES = new Set(['“', '”', '„', '‟', '″'])
/** Characters quotation search ignores: whitespace, combining marks, dashes, format characters and Markdown emphasis. */
const DROPPED = /[\s\p{M}\p{Pd}\p{Cf}−*_`#]/u
/** Folded code points seen so far: at most one entry per code point, and research text uses few. */
const foldedPoints = new Map<string, string>()

/** The folded form of one code point: compatibility-decomposed, lower-cased, without the characters search ignores. */
function foldPoint(point: string): string {
  const cached = foldedPoints.get(point)
  if (cached !== undefined) return cached
  let out = ''
  for (const unit of point.normalize('NFKD').toLowerCase()) {
    if (DROPPED.test(unit)) continue
    out += SINGLE_QUOTES.has(unit) ? '\'' : DOUBLE_QUOTES.has(unit) ? '"' : unit
  }
  foldedPoints.set(point, out)
  return out
}

/**
 * Text as quotation search compares it: compatibility-decomposed (ligatures
 * and full-width forms become plain letters), lower-cased, without combining
 * marks, and without whitespace, dashes, soft hyphens, zero-width characters
 * and the Markdown marks `*`, `_`, `` ` `` and `#`. Typographic quotes become
 * straight ones. PDF line-break hyphenation, missing or inserted spaces and
 * ligatures therefore do not keep a quotation from matching.
 * @param text - source or quotation text.
 * @returns the folded text.
 */
export function foldText(text: string): string {
  return Array.from(text, foldPoint).join('')
}

/**
 * Folded chunk texts and the acronyms each chunk defines, by chunk object: one
 * proposal call checks many quotations against the same records. A chunk's
 * text is never changed in place (a new revision is a new record), so an entry
 * stays valid for as long as the chunk object lives.
 */
const foldedChunks = new WeakMap<EvidenceChunk, string>()
const chunkDefinitions = new WeakMap<EvidenceChunk, AcronymDefinition[]>()

function foldedChunk(chunk: EvidenceChunk): string {
  let folded = foldedChunks.get(chunk)
  if (folded === undefined) {
    folded = foldText(chunk.text)
    foldedChunks.set(chunk, folded)
  }
  return folded
}

function definitionsOf(chunk: EvidenceChunk): AcronymDefinition[] {
  let found = chunkDefinitions.get(chunk)
  if (found === undefined) {
    found = acronymDefinitions(chunk.text)
    chunkDefinitions.set(chunk, found)
  }
  return found
}

/** Folded text with, for each UTF-16 unit, where its code point starts and ends in the source. */
interface FoldedSpans { text: string; starts: number[]; ends: number[] }

function foldWithSpans(source: string): FoldedSpans {
  const parts: string[] = []
  const starts: number[] = [], ends: number[] = []
  let at = 0
  for (const point of source) {
    const out = foldPoint(point)
    for (let unit = 0; unit < out.length; unit++) {
      starts.push(at)
      ends.push(at + point.length)
    }
    parts.push(out)
    at += point.length
  }
  return { text: parts.join(''), starts, ends }
}

/** PDF line-break hyphenation: a lower-case letter, a hyphen at the end of a line, and the word's lower-case remainder. */
const LINE_BREAK_HYPHEN = /(\p{Ll})[\p{Pd}\p{Cf}][^\S\n]*\n\s*(?=\p{Ll})/gu

/** The source's own words for a span, line-break hyphenation joined and whitespace collapsed; folding it gives back the folded span. */
function excerpt(source: string, start: number, end: number): string {
  return source.slice(start, end).replace(LINE_BREAK_HYPHEN, '$1').replace(/\s+/g, ' ').trim()
}

// ── Tokens and entity-name keys ─────────────────────────────────────────────

const CJK_POINT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const WORD_POINT = /[\p{L}\p{N}\p{M}]/u
const UPPER = /^\p{Lu}$/u
const LOWER = /^\p{Ll}$/u
/** Words ending in s that are not plurals, kept whole by {@link singular}. */
const NOT_PLURAL = new Set([
  'news', 'series', 'species', 'physics', 'mathematics', 'economics', 'linguistics', 'statistics', 'analytics', 'genomics',
  'robotics', 'semantics', 'pragmatics', 'graphics', 'ethics', 'lens', 'bias', 'alias', 'atlas', 'canvas', 'does', 'goes',
  'whereas', 'perhaps', 'always', 'towards', 'besides', 'sometimes', 'nevertheless', 'means', 'yes',
])

/**
 * A conservative singular: only lower-case ASCII words of four letters or more
 * lose a plural ending, and words ending in ss, us or is, or listed in
 * {@link NOT_PLURAL}, stay whole.
 */
function singular(word: string): string {
  if (word.length < 4 || !/^[a-z]+$/.test(word) || NOT_PLURAL.has(word) || /(?:ss|us|is)$/.test(word)) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (/(?:sses|xes|ches|shes|zes)$/.test(word)) return word.slice(0, -2)
  return word.endsWith('s') ? word.slice(0, -1) : word
}

/** One word of a text, or one CJK character, with its place in the text. */
export interface Token {
  /** Folded and singular: `Transformers` and `transformer` share the key `transformer`. */
  key: string
  start: number
  end: number
  /** The word is written in capitals (`RULER`, `LED`), so an all-capital acronym may name it. */
  upper: boolean
}

/** 0 for a separator, 1 for a letter, digit or mark of a word, 2 for a CJK character. */
function classify(point: string): 0 | 1 | 2 {
  const code = point.codePointAt(0) as number
  if (code < 128) return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ? 1 : 0
  if (CJK_POINT.test(point)) return 2
  return WORD_POINT.test(point) ? 1 : 0
}

/**
 * Where a word splits at case changes: `withFlashAttention` → with|Flash|Attention,
 * `QAFactEval` → QA|Fact|Eval, `FP16FlashAttention` → FP16|Flash|Attention. A
 * plural acronym stays whole: `FLOPs` and `LLMs` are one word each.
 */
function camelCuts(points: readonly string[]): number[] {
  const cuts = [0]
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1] as string, current = points[i] as string, next = points[i + 1]
    const rise = (LOWER.test(previous) || DIGIT.test(previous)) && UPPER.test(current)
    const plural = next === 's' && points[i + 2] === undefined
    const acronymEnd = UPPER.test(previous) && UPPER.test(current) && next !== undefined && LOWER.test(next) && !plural
    if (rise || acronymEnd) cuts.push(i)
  }
  return cuts
}

const DIGIT = /^\p{Nd}$/u

function wordKey(word: string): string {
  return singular(word.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase())
}

/**
 * The words of a text: runs of letters and digits split at case changes, and
 * each CJK character on its own. PDF text that lost its spaces
 * (`withFlashAttention-2`) or gained some (`Q AFACT EVAL`) still yields words
 * whose keys concatenate to the intended name.
 * @param text - any text.
 * @returns the tokens in order.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let run: string[] = []
  let runStart = 0
  let at = 0
  const flush = (): void => {
    const cuts = camelCuts(run)
    let offset = runStart
    cuts.forEach((cut, i) => {
      const piece = run.slice(cut, cuts[i + 1] ?? run.length).join('')
      const upper = /\p{Lu}/u.test(piece) && !/\p{Ll}/u.test(piece)
      tokens.push({ key: wordKey(piece), start: offset, end: offset + piece.length, upper })
      offset += piece.length
    })
    run = []
  }
  for (const point of text) {
    const kind = classify(point)
    if (kind === 1) {
      if (run.length === 0) runStart = at
      run.push(point)
    } else {
      if (run.length > 0) flush()
      if (kind === 2) tokens.push({ key: point, start: at, end: at + point.length, upper: false })
    }
    at += point.length
  }
  if (run.length > 0) flush()
  return tokens
}

/**
 * Whether a name is a short all-capital acronym (`TRUE`, `LED`, `NSA`, `QA`),
 * which names only words written in capitals, so `TRUE` is not found in
 * `true` and `LED` not in `led to`. Mixed-case names such as `MoBA` match in
 * any case.
 * @param name - an entity name or alias.
 * @returns true for one word of two to six capitals and digits with at least two capitals.
 */
export function isCapitalAcronym(name: string): boolean {
  const word = name.trim()
  return /^[\p{Lu}\p{Nd}]{2,6}$/u.test(word) && (word.match(/\p{Lu}/gu) ?? []).length >= 2
}

/**
 * The key two names share when they differ only in case, spacing, hyphenation,
 * accents or a plural ending: `Block-Sparse Attention`, `block sparse
 * attentions` and `blocksparse attention` are one key. Acronyms are not
 * expanded: `MoE` and `mixture of experts` have different keys.
 * @param name - an entity name or alias.
 * @returns the concatenated token keys; empty when the name has no letters or digits.
 */
export function nameKey(name: string): string {
  return tokenize(name).map(token => token.key).join('')
}

/** A run of tokens whose keys concatenate to a name key. */
export interface Mention {
  /** Index of the first token. */
  first: number
  /** Index after the last token. */
  last: number
}

/**
 * Where token runs spell a name key: every run of whole tokens whose keys
 * concatenate to it.
 * @param tokens - the text's tokens.
 * @param key - a {@link nameKey}.
 * @param capitals - only runs of words written in capitals count, for a {@link isCapitalAcronym} name.
 * @returns the runs in text order; none for an empty key.
 */
export function findMentions(tokens: readonly Token[], key: string, capitals = false): Mention[] {
  const found: Mention[] = []
  if (key === '') return found
  for (let first = 0; first < tokens.length; first++) {
    let joined = ''
    for (let last = first; last < tokens.length; last++) {
      const token = tokens[last] as Token
      if (capitals && !token.upper) break
      joined += token.key
      if (joined === key) { found.push({ first, last: last + 1 }); break }
      if (!key.startsWith(joined)) break
    }
  }
  return found
}

/**
 * The keys a set of names is found by, each marked when only capitals may spell
 * it; a key some name spells in mixed case matches in any case.
 * @param names - names and aliases.
 * @returns key → whether only words in capitals count.
 */
export function nameKeys(names: readonly string[]): Map<string, boolean> {
  const keys = new Map<string, boolean>()
  for (const name of names) {
    const key = nameKey(name)
    if (key !== '') keys.set(key, (keys.get(key) ?? true) && isCapitalAcronym(name))
  }
  return keys
}

// ── Acronyms a source defines ───────────────────────────────────────────────

/** An abbreviation and its expansion as one source states them. */
export interface AcronymDefinition {
  short: string
  long: string
}

const ALNUM = /[\p{L}\p{N}]/u

/**
 * Schwartz and Hearst's match of a short form inside a candidate long form:
 * each character of the short form, from the last, occurs in order in the
 * long form, the first one at the start of a word.
 */
function longFormFor(short: string, candidate: string): string | undefined {
  let s = short.length - 1
  let l = candidate.length - 1
  while (s >= 0) {
    const c = (short[s] as string).toLowerCase()
    if (!ALNUM.test(c)) { s--; continue }
    while (l >= 0 && ((candidate[l] as string).toLowerCase() !== c || (s === 0 && l > 0 && ALNUM.test(candidate[l - 1] as string)))) l--
    if (l < 0) return undefined
    l--
    s--
  }
  const long = candidate.slice(candidate.lastIndexOf(' ', l) + 1).trim()
  return long.split(/[\s\p{Pd}]+/u).length > 1 ? long : undefined
}

/** Short forms are one word of two to ten characters with a capital letter, as in `MoBA`, `NIAH` or `QAGS`. */
function isShortForm(word: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}\-.]{1,9}$/u.test(word) && /\p{Lu}/u.test(word)
}

/**
 * The abbreviations a text defines in the forms `long form (SF)` and `SF (long
 * form)`, after Schwartz and Hearst (2003): `Mixture of Block Attention (MoBA)`
 * defines MoBA. A definition found in an evidence record lets a quotation of
 * that record name an entity by either form.
 * @param text - a source passage.
 * @returns the definitions in text order, without duplicates.
 */
export function acronymDefinitions(text: string): AcronymDefinition[] {
  const found = new Map<string, AcronymDefinition>()
  const flat = text.replace(LINE_BREAK_HYPHEN, '$1').replace(/\s+/g, ' ')
  for (let open = flat.indexOf('('); open >= 0; open = flat.indexOf('(', open + 1)) {
    const close = flat.indexOf(')', open + 1)
    if (close < 0) break
    const inside = flat.slice(open + 1, close)
    if (inside.includes('(') || inside.length > 120) continue
    const first = (inside.split(/[;,]/)[0] as string).trim()
    const before = (flat.slice(Math.max(0, open - 160), open).split(/[()]/).at(-1) as string).trim()
    const words = before.split(' ')
    let definition: AcronymDefinition | undefined
    if (isShortForm(first)) {
      const long = longFormFor(first, words.slice(-Math.min(first.length + 5, first.length * 2)).join(' '))
      if (long !== undefined) definition = { short: first, long }
    } else {
      const previous = words.at(-1) as string
      const long = isShortForm(previous) && first.includes(' ') ? longFormFor(previous, first) : undefined
      if (long !== undefined) definition = { short: previous, long }
    }
    if (definition !== undefined) found.set(`${nameKey(definition.short)}|${nameKey(definition.long)}`, definition)
  }
  return [...found.values()]
}

// ── Mentions of the two ends ────────────────────────────────────────────────

/** A paper that introduces an entity, by an active `introduces` relation. */
export interface Introduction {
  /** One of the paper's literature records. */
  evidenceId: string
  /** The `introduces` relation. */
  relation: string
}

/** One end of a proposed relation as the grounding check reads it. */
export interface GroundingEnd {
  kind: EntityKind
  /** The canonical name, then the aliases. */
  names: readonly string[]
  /** The papers that introduce this entity; in a quotation of one of them, `we`, `our method` or `本文` names it. */
  introducedBy: readonly Introduction[]
  /** A paper's own literature records; empty for other kinds. */
  records: readonly string[]
}

/** Self-references, as key sequences: `we`, `our`, `this paper`, `本文` … */
const SELF_REFERENCES: readonly (readonly string[])[] = [
  ['we'], ['our'], ['ours'], ['this', 'paper'], ['this', 'work'], ['this', 'study'], ['the', 'proposed'],
  ['我', '们'], ['本', '文'], ['本', '研', '究'], ['本', '方', '法'],
]

function selfReferences(tokens: readonly Token[]): Mention[] {
  const found: Mention[] = []
  tokens.forEach((_, first) => {
    for (const sequence of SELF_REFERENCES) {
      if (sequence.every((key, k) => tokens[first + k]?.key === key)) found.push({ first, last: first + sequence.length })
    }
  })
  return found
}

/** Every key an end may be named by in a record: its names, and the other form of each acronym the record defines for one of them. */
function namesIn(end: GroundingEnd, definitions: readonly AcronymDefinition[]): Map<string, boolean> {
  const keys = nameKeys(end.names)
  for (const { short, long } of definitions) {
    const shortKey = nameKey(short), longKey = nameKey(long)
    if (keys.has(longKey) && !keys.has(shortKey)) keys.set(shortKey, isCapitalAcronym(short))
    else if (keys.has(shortKey) && !keys.has(longKey)) keys.set(longKey, false)
  }
  return keys
}

/** The runs of tokens that name an end in a record. */
function spans(keys: Map<string, boolean>, tokens: readonly Token[]): Mention[] {
  return [...keys].flatMap(([key, capitals]) => findMentions(tokens, key, capitals))
}

function overlaps(a: Mention, b: Mention): boolean { return a.first < b.last && b.first < a.last }

/** One way the quotation names both ends: the spans naming `from`, and the introduction a self-reference relied on. */
interface Reading { subjects: Mention[]; via?: string | undefined }

// ── Cues ────────────────────────────────────────────────────────────────────

/** A cue occurrence in the excerpt: its span, whether it reads passive (`outperformed by`), whether it is negated, and its script. */
interface CueHit { start: number; end: number; passive: boolean; negated: boolean; zh: boolean }

const NEGATION = /\b(?:not|no|never|cannot|unable to|fail(?:s|ed)? to|neither|nor)\s+(?:[^\s,;.]+\s+){0,2}$|n't\s+(?:[^\s,;.]+\s+){0,2}$/
const NEGATION_ZH = /[不未没无]|并非/
const NOT_ONLY_ZH = /不仅|不只|不但/

/** Lower-case each code point whose lower case has the same length, so positions match the excerpt's tokens. */
function lowerInPlace(text: string): string {
  return Array.from(text, (point) => {
    const lower = point.toLowerCase()
    return lower.length === point.length ? lower : point
  }).join('')
}

function cueHits(cue: Cue, text: string): CueHit[] {
  const plain = lowerInPlace(text)
  const hits: CueHit[] = []
  for (const match of plain.matchAll(cue.latin)) {
    // A cue pattern may match a word's stem (`outperform`); its end is the end of the word (`outperformed`), where a passive `by` follows.
    const start = match.index, stem = start + match[0].length
    const end = stem + (/^\p{L}*/u.exec(plain.slice(stem)) as RegExpExecArray)[0].length
    const negated = NEGATION.test(plain.slice(Math.max(0, start - 40), start))
    hits.push({ start, end, zh: false, passive: /^\s*by\b/.test(plain.slice(end)), negated })
  }
  for (const match of plain.matchAll(cue.zh)) {
    const start = match.index
    const before = plain.slice(Math.max(0, start - 3), start)
    const negated = NEGATION_ZH.test(before) && !NOT_ONLY_ZH.test(before)
    hits.push({ start, end: start + match[0].length, zh: true, passive: false, negated })
  }
  return hits.sort((a, b) => a.start - b.start)
}

// ── Quotation grounding ─────────────────────────────────────────────────────

/** A quotation offered as the ground of a relation. */
export interface QuoteRequest {
  kind: RelationKind
  from: GroundingEnd
  to: GroundingEnd
  evidence: EvidenceRecord | undefined
  /** The revision the quotation was taken from. */
  revision: number
  quote: string
  /** Where the proposer found it; the check corrects it when the quotation is elsewhere. */
  locator?: SourceLocator | undefined
  setting?: string | undefined
  /**
   * True for the agent: every rule refuses. False for a person, who is the
   * authority on what a passage says: the quotation must still occur in the
   * cited revision and hold four words, but a missing name, cue, direction or
   * setting, and a match in a provider abstract only, are kept as warnings.
   */
  strict: boolean
}

/** A refusal: why, in the proposer's terms, and what would be accepted. */
export interface GroundingRefusal {
  ok: false
  code: GroundingCode
  message: string
}

/** A quotation that grounds the relation, in the source's own words. */
export interface QuoteGrounding {
  ok: true
  locator: SourceLocator
  /** The matched passage as the source has it, whitespace collapsed. */
  quote: string
  /** The proposer's locator did not hold the quotation and was replaced. */
  locatorCorrected: boolean
  /** The `introduces` relation a self-reference relied on; the ground lapses when that relation stops being active. */
  via?: string | undefined
  /** Rules a person's quotation did not meet; always empty for the agent. */
  warnings: string[]
}

/** Where a quotation was found: the chunk's locator, whether that chunk is the provider abstract, and the source's words. */
interface Found { locator: SourceLocator; abstract: boolean; excerpt: string }

/** Chunks a quotation may come from: never the BibTeX entry. */
function quotable(chunk: EvidenceChunk): boolean { return chunk.locator.key !== 'bibtex' }

function sameLocator(a: SourceLocator, b: SourceLocator): boolean {
  return a.page === b.page && a.paragraph === b.paragraph && a.line === b.line && a.key === b.key
}

function locate(chunk: EvidenceChunk, start: number, length: number): Found {
  const spans = foldWithSpans(chunk.text)
  return {
    locator: chunk.locator, abstract: chunk.locator.key === 'abstract',
    excerpt: excerpt(chunk.text, spans.starts[start] as number, spans.ends[start + length - 1] as number),
  }
}

/**
 * Every place a folded quotation occurs in a record's quotable chunks, the
 * proposer's locator first, then page and line text, then the provider's
 * abstract and title. A quotation that crosses from one chunk into the next is
 * found too, at the first of the two, when no single chunk holds it.
 */
function occurrences(record: EvidenceRecord, query: string, locator: SourceLocator | undefined): Found[] {
  const chunks = record.chunks.filter(quotable)
  const rank = (chunk: EvidenceChunk): number => {
    if (locator !== undefined && sameLocator(chunk.locator, locator)) return 0
    return chunk.locator.key === undefined ? 1 : 2
  }
  const found: Found[] = []
  for (const chunk of [...chunks].sort((a, b) => rank(a) - rank(b))) {
    const at = foldedChunk(chunk).indexOf(query)
    if (at >= 0) found.push(locate(chunk, at, query.length))
  }
  for (let index = 0; found.length === 0 && index + 1 < chunks.length; index++) {
    const first = chunks[index] as EvidenceChunk
    const joined = { text: `${first.text}\n${(chunks[index + 1] as EvidenceChunk).text}`, locator: first.locator }
    const at = foldText(joined.text).indexOf(query)
    if (at >= 0) found.push(locate(joined, at, query.length))
  }
  return found
}

/** The longest start of the quotation found anywhere, and what the source says after it, for a refusal. */
function closest(record: EvidenceRecord, quote: string): string {
  const chunks = record.chunks.filter(quotable)
  const folded = chunks.map(foldedChunk)
  const query = foldWithSpans(quote)
  const holder = (length: number): number => folded.findIndex(text => text.includes(query.text.slice(0, length)))
  let low = 0, high = query.text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (holder(middle) >= 0) low = middle
    else high = middle - 1
  }
  if (low < 8) return 'No part of it occurs in this revision.'
  const index = holder(low)
  const chunk = chunks[index] as EvidenceChunk
  const spans = foldWithSpans(chunk.text)
  const sourceEnd = spans.ends[(folded[index] as string).indexOf(query.text.slice(0, low)) + low - 1] as number
  const quoteEnd = query.ends[low - 1] as number
  const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()
  return `Its start matches ${describeLocator(chunk.locator)} up to "…${flat(quote.slice(Math.max(0, quoteEnd - 30), quoteEnd))}"; `
    + `there the source continues "${excerpt(chunk.text, sourceEnd, Math.min(chunk.text.length, sourceEnd + 80))}…" `
    + `where the quotation has "${flat(quote.slice(quoteEnd, quoteEnd + 60))}…".`
}

/**
 * A locator as the agent and the person read it: `page 3`, `line 12`, `the abstract`.
 * @param locator - a chunk's locator.
 * @returns the description.
 */
export function describeLocator(locator: SourceLocator): string {
  if (locator.page !== undefined) return `page ${locator.page}`
  if (locator.line !== undefined) return `line ${locator.line}`
  if (locator.paragraph !== undefined) return `paragraph ${locator.paragraph}`
  return locator.key === undefined ? 'the text' : `the ${locator.key}`
}

/** Latin words, the pieces of one word split at case changes counting once, with two CJK characters counting as one word. */
function words(tokens: readonly Token[]): number {
  let latin = 0, cjk = 0
  tokens.forEach((token, at) => {
    if (CJK_POINT.test(token.key)) cjk++
    else if (tokens[at - 1]?.end !== token.start) latin++
  })
  return latin + cjk / 2
}

function refuse(code: GroundingCode, message: string): GroundingRefusal { return { ok: false, code, message } }

/** The first name of an end, quoted, for messages. */
function label(end: GroundingEnd): string { return `"${end.names[0] as string}"` }

/**
 * The variant keys a setting is found by: `32K` is also found as 32768 or
 * 32,768, and `32768` also as 32K.
 * @param setting - a setting label.
 * @returns its key variants, the label's own key first.
 */
export function settingKeys(setting: string): string[] {
  const key = nameKey(setting)
  const thousands = /^(\d+)k$/.exec(key)
  if (thousands) return [key, String(Number(thousands[1]) * 1024), String(Number(thousands[1]) * 1000)]
  const number = /^\d+$/.test(key) ? Number(key) : NaN
  if (number >= 1024 && number % 1024 === 0) return [key, `${number / 1024}k`]
  return [key]
}

/**
 * The key settings are grouped by: a context length of 32768 or 32,768 groups with 32K.
 * @param setting - a setting label.
 * @returns the grouping key.
 */
export function settingKey(setting: string): string {
  const keys = settingKeys(setting)
  return keys.find(key => /^\d+k$/.test(key)) ?? keys[0] as string
}

/**
 * The readings in which the excerpt names both ends on separate words: pairs
 * naming both by name first, then pairs where one end is a self-reference of
 * the paper that introduces it.
 */
function readings(request: QuoteRequest, record: EvidenceRecord, tokens: readonly Token[]): Reading[] | GroundingRefusal {
  const definitions = record.chunks.filter(quotable).flatMap(definitionsOf)
  const named = (end: GroundingEnd): Mention[] => spans(namesIn(end, definitions), tokens)
  if (request.kind === 'introduces') {
    if (!request.from.records.includes(record.id)) {
      return refuse('foreign-source', `A paper introduces something in its own words: quote ${label(request.from)} itself, not another source.`)
    }
    if (named(request.to).length > 0) return [{ subjects: [] }]
    return refuse('missing-mention', `The quotation does not name ${label(request.to)}; quote the sentence where the paper introduces it by name.`)
  }
  const self = selfReferences(tokens)
  const side = (end: GroundingEnd): { named: Mention[]; self: Mention[]; via: string | undefined } => {
    const via = end.introducedBy.find(item => item.evidenceId === record.id)?.relation
    return { named: named(end), self: via === undefined ? [] : self, via }
  }
  const from = side(request.from), to = side(request.to)
  const pairs = (fromSpans: Mention[], toSpans: Mention[]): Mention[] => fromSpans.filter(a => toSpans.some(b => !overlaps(a, b)))
  const found: Reading[] = [
    { subjects: pairs(from.named, to.named) },
    { subjects: pairs(from.self, to.named), via: from.via },
    { subjects: pairs(from.named, to.self), via: to.via },
  ].filter(reading => reading.subjects.length > 0)
  if (found.length > 0) return found
  const missing = from.named.length + from.self.length === 0 ? request.from : request.to
  const selfNote = missing.introducedBy.length > 0 ? ', or as "we" or "our method" in a quotation of the paper that introduces it' : ''
  return refuse('missing-mention', `The quotation does not name ${label(missing)} by its name, an alias or an acronym the source defines${selfNote}; `
    + `quote a passage that names both ${label(request.from)} and ${label(request.to)}.`)
}

/** Check the cue, its negation and its direction for one reading; undefined when they hold. */
function cueProblem(request: QuoteRequest, text: string, tokens: readonly Token[], reading: Reading): GroundingRefusal | undefined {
  const rule = RELATION_RULES[request.kind]
  if (rule.cue === undefined) return undefined
  const hits = cueHits(rule.cue, text)
  if (hits.length === 0) {
    return refuse('missing-cue', `A quotation for ${request.kind} must say how the two relate (${rule.cue.examples}); this one does not.`)
  }
  const live = hits.filter(hit => !hit.negated)
  if (live.length === 0) return refuse('negated', `The quotation negates the ${request.kind} relation ("not", "fails to" or similar before it).`)
  if (!rule.directed) return undefined
  const starts = reading.subjects.map(mention => (tokens[mention.first] as Token).start)
  const holds = live.some((hit) => {
    if (!hit.zh) return hit.passive ? starts.some(start => start >= hit.end) : starts.some(start => start < hit.start)
    const bei = text.lastIndexOf('被', hit.start)
    return starts.some(start => start > bei && start < hit.start)
  })
  return holds ? undefined : refuse(
    'wrong-direction',
    `The quotation reads the other way round: for ${label(request.from)} improves on ${label(request.to)}, `
    + `${label(request.from)} is the one that outperforms (named before "outperforms", or after "outperformed by").`,
  )
}

/**
 * Check a quotation as the ground of one relation. It must occur, after
 * folding ({@link foldText}), in a quotable chunk of the cited revision of the
 * record, or across two neighbouring chunks; the stored quotation is then the
 * source's own words. A literature record with full text must hold it in its
 * pages, not only in the provider's abstract. The source's words, not the
 * proposer's, must then name both ends on separate words, by name, alias or
 * an acronym the record defines; in a quotation of the paper that introduces
 * one end, `we`, `our` or `this paper` may name that end. `introduces` takes a
 * quotation of the paper itself naming what it introduces. Kinds with a cue
 * need one of their cue words not negated just before it, and `improves-on`
 * needs its `from` end named before the cue, or after it in the passive. A
 * setting must occur in the quotation too.
 * @param request - the relation's kind and ends, the record and the quotation.
 * @returns the grounding with the source's words and its locator, or the refusal.
 */
export function groundQuote(request: QuoteRequest): QuoteGrounding | GroundingRefusal {
  const record = request.evidence
  if (record === undefined) return refuse('unknown-source', 'No evidence record of this project has that id.')
  if (record.stale) return refuse('source-stale', `"${record.title}" is recorded stale; refresh it before quoting it.`)
  if (record.revision !== request.revision) {
    return refuse('revision-changed', `"${record.title}" is at revision ${record.revision} now, not ${request.revision}; quote the current revision.`)
  }
  if (record.kind === 'experiment') return refuse('not-quotable', 'A run\'s collected metrics ground a relation as a run, not as a quotation.')
  if (request.quote.replace(/\s+/g, ' ').trim().length > MAX_QUOTE_LENGTH) {
    return refuse('quote-too-long', `Quote at most ${MAX_QUOTE_LENGTH} characters: the sentence that states the relation, not the passage around it.`)
  }
  const query = foldText(request.quote)
  const found = query === '' ? [] : occurrences(record, query, request.locator)
  const best = found.find(item => !item.abstract) ?? found[0]
  if (best === undefined) {
    return refuse('quote-not-found', `The quotation does not occur in revision ${record.revision} of "${record.title}". ${closest(record, request.quote)}`)
  }
  const tokens = tokenize(best.excerpt)
  if (words(tokens) < MIN_QUOTE_WORDS) {
    return refuse('quote-too-short', `Quote at least ${MIN_QUOTE_WORDS} words (or ${MIN_QUOTE_WORDS * 2} CJK characters) that state the relation.`)
  }
  const warnings: string[] = []
  const lenient = (problem: GroundingRefusal | undefined): GroundingRefusal | undefined => {
    if (problem === undefined || request.strict) return problem
    warnings.push(problem.message)
    return undefined
  }
  const result: QuoteGrounding = {
    ok: true, locator: best.locator, quote: best.excerpt, warnings,
    locatorCorrected: request.locator !== undefined && !sameLocator(request.locator, best.locator),
  }
  const problems: (GroundingRefusal | undefined)[] = []
  if (record.kind === 'literature' && record.coverage === 'full-text' && best.abstract) {
    problems.push(refuse('abstract-only', `The quotation occurs only in the provider's abstract of "${record.title}", not in its full text; `
      + 'quote the full text, since a provider abstract can belong to another work.'))
  }
  const read = readings(request, record, tokens)
  if (Array.isArray(read)) {
    const checks = read.map(reading => cueProblem(request, best.excerpt, tokens, reading))
    const holding = read.find((_, at) => checks[at] === undefined)
    if (holding === undefined) problems.push(checks[0])
    else if (holding.via !== undefined) result.via = holding.via
  } else problems.push(read)
  if (request.setting !== undefined && !settingKeys(request.setting).some(key => findMentions(tokens, key).length > 0)) {
    problems.push(refuse('setting-not-quoted', `The setting "${request.setting}" does not occur in the quotation; quote the passage that states it.`))
  }
  for (const problem of problems) {
    const refusal = lenient(problem)
    if (refusal !== undefined) return refusal
  }
  return result
}

// ── Run grounding ───────────────────────────────────────────────────────────

/** Project runs offered as the ground of a relation. */
export interface RunRequest {
  kind: RelationKind
  from: GroundingEnd
  to: GroundingEnd
  runs: readonly ExperimentRecord[]
  evidence: readonly EvidenceRecord[]
  runId: string
  /** The word of the run's name or command that names the `from` end, such as `dynamic` in `ruler-32k-dynamic`. */
  fromLabel: string
  /** The word naming the `to` end; for measured-by, the metric's key in the run's metrics. */
  toLabel: string
  /** For compares-with: the run of the `to` end, which must share a metric with the first. */
  baselineRunId?: string | undefined
  setting?: string | undefined
}

/** A run of the project, with the record its collected metrics became. */
export interface RunGround {
  runId: string
  evidenceId: string
  revision: number
}

/** Runs that ground the relation. */
export interface RunGrounding {
  ok: true
  run: RunGround
  baseline?: RunGround | undefined
}

/**
 * The record a run's collected metrics became, matched by its path the way
 * the ledger matches it.
 * @param run - the run.
 * @param evidence - the project's evidence records.
 * @returns the record, or undefined while the run's results are not collected.
 */
export function runEvidence(run: Pick<ExperimentRecord, 'id'>, evidence: readonly EvidenceRecord[]): EvidenceRecord | undefined {
  return evidence.find(record => record.kind === 'experiment' && record.path.includes(`/runs/${run.id}/`))
}

/** The words of a run's name and command, whole and split at case changes, each context length also under its other spellings. */
function runWords(run: ExperimentRecord): Set<string> {
  const keys = new Set<string>()
  for (const text of [run.spec.name, ...run.spec.argv]) {
    for (const token of tokenize(text)) for (const key of settingKeys(token.key)) keys.add(key)
    for (const piece of text.split(/[^\p{L}\p{N}]+/u)) keys.add(nameKey(piece))
  }
  keys.delete('')
  return keys
}

/** Words too general to name an entity on their own in a run's name. */
const GENERAL = new Set(['the', 'and', 'for', 'with', 'from', 'based', 'model', 'method', 'approach', 'task', 'dataset', 'data', 'metric', 'run', 'test', 'eval'])

/** Whether a label names an end: it is one of its name keys, or a content word of one of its names. */
function labelNames(label: string, end: GroundingEnd): boolean {
  const key = nameKey(label)
  return key !== '' && end.names.some(name => nameKey(name) === key
    || (key.length >= 3 && !GENERAL.has(key) && tokenize(name).some(token => token.key === key)))
}

function collectedRun(request: RunRequest, runId: string): { run: ExperimentRecord; ground: RunGround } | GroundingRefusal {
  const run = request.runs.find(item => item.id === runId)
  if (run === undefined) return refuse('unknown-run', `No run of this project has the id ${runId}.`)
  const record = runEvidence(run, request.evidence)
  if (run.status !== 'completed' || !run.collected || record === undefined) {
    return refuse('run-not-collected', `Run ${run.spec.name} (seed ${run.spec.seed}) is ${run.status}${run.collected ? '' : ' and its results are not collected'}; `
      + 'only a completed run with collected results grounds a relation.')
  }
  if (record.stale) return refuse('source-stale', `The results of run ${run.spec.name} are recorded stale: an input changed since it ran.`)
  return { run, ground: { runId: run.id, evidenceId: record.id, revision: record.revision } }
}

function runName(run: ExperimentRecord): string { return `${run.spec.name} (seed ${run.spec.seed})` }

function labelProblem(labelText: string, run: ExperimentRecord, end: GroundingEnd): GroundingRefusal | undefined {
  if (runWords(run).has(nameKey(labelText)) && labelNames(labelText, end)) return undefined
  return refuse('run-label', `"${labelText}" must be a word of the name or command of run ${runName(run)} that names ${label(end)}.`)
}

/**
 * Check project runs as the ground of one relation. The run must be completed
 * with its results collected and not stale. `fromLabel` must be a word of the
 * run's name or command that names the `from` end (one of its name keys, or a
 * content word of one of its names), and so must `toLabel` for the `to` end,
 * except that for measured-by `toLabel` is a metric the run recorded. For
 * compares-with the `to` label is a word of the baseline run, which must be
 * collected too and share a metric with the run. A setting must be a word of
 * the run's name or command.
 * @param request - the relation's kind and ends, the runs and the labels.
 * @returns the grounding with the runs' metrics records, or the refusal.
 */
export function groundRun(request: RunRequest): RunGrounding | GroundingRefusal {
  const first = collectedRun(request, request.runId)
  if (!('run' in first)) return first
  const problem = labelProblem(request.fromLabel, first.run, request.from)
  if (problem !== undefined) return problem
  if (request.setting !== undefined && !settingKeys(request.setting).some(key => runWords(first.run).has(key))) {
    return refuse('setting-not-quoted', `The setting "${request.setting}" is not a word of the name or command of run ${runName(first.run)}.`)
  }
  if (request.kind === 'measured-by') {
    const metrics = Object.keys(first.run.metrics)
    const recorded = metrics.some(key => nameKey(key) === nameKey(request.toLabel))
    if (recorded && labelNames(request.toLabel, request.to)) return { ok: true, run: first.ground }
    return refuse('run-metric', `Run ${runName(first.run)} recorded ${metrics.join(', ') || 'no metrics'}; name the one that is ${label(request.to)}.`)
  }
  if (request.kind !== 'compares-with') return labelProblem(request.toLabel, first.run, request.to) ?? { ok: true, run: first.ground }
  if (request.baselineRunId === undefined) return refuse('run-baseline', 'A comparison grounded in runs names the baseline\'s run as baselineRunId.')
  const second = collectedRun(request, request.baselineRunId)
  if (!('run' in second)) return second
  const baselineProblem = labelProblem(request.toLabel, second.run, request.to)
  if (baselineProblem !== undefined) return baselineProblem
  const shared = Object.keys(first.run.metrics).some(key => Object.keys(second.run.metrics).some(other => nameKey(other) === nameKey(key)))
  if (shared && first.run.id !== second.run.id) return { ok: true, run: first.ground, baseline: second.ground }
  return refuse('run-baseline', `Runs ${runName(first.run)} and ${runName(second.run)} must be two runs that recorded a common metric.`)
}

/** The grounding rule as the agent reads it, for the relation tool's description. */
export const RELATION_GROUNDING_RULE = [
  'Every relation needs a ground; a relation without one is refused.',
  'A quote ground is copied from the current revision of one of the project\'s evidence records (spacing, hyphenation, ligatures and letter case may differ):',
  'one or two sentences, at least 4 words and at most 500 characters, that themselves name both ends by name, alias, or an acronym the source defines;',
  'in a quote of the paper that introduces an end, "we", "our" or "this paper" may stand for that end.',
  'introduces is quoted from the paper itself and names what it introduces.',
  'is-a, extends, improves-on, compares-with and evaluated-on need a word that states the relation',
  '(is a / such as; extends / builds on / based on; outperforms / better than; compared with / baseline; evaluated / results / accuracy).',
  'improves-on is refused when negated or reversed: the improving method is named before "outperforms" or after "outperformed by".',
  'A setting such as 32K must occur in the quote.',
  'A literature record with full text is quoted from its pages: its provider abstract alone is refused, because providers sometimes attach another work\'s abstract.',
  'A run ground names a completed run with collected results and the word of its name or command that names each end',
  '(for measured-by, one of its recorded metrics; for compares-with, a word of the baseline\'s run).',
  'cites edges come only from OpenAlex or Crossref citation records.',
  'A relation or ground the person rejected stays rejected until the person restores it.',
].join(' ')
