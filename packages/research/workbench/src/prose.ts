/**
 * The prose check, in English and Chinese: phrases that mark text as
 * machine-written, defensive or throat-clearing framing, stacked hedges,
 * formulaic enumerations, em-dash overuse and promotional words. It merges
 * spark-to-paper's AI-tell list (ts-paper-write's draft_lint.py) with CCFA's
 * prose guardrails (ccf-paper-writer's check_prose_quality.py). Every finding
 * is a warning: whether a phrase earns its place is the writer's judgement.
 */

/** A phrase to reconsider, where it starts in the text and why. */
export interface ProseFinding {
  offset: number
  message: string
}

/** Phrases that almost always stand for something plainer. */
const TELLS = new RegExp([
  String.raw`\bit is (?:worth|important to) (?:not(?:e|ing)|mention(?:ing)?|emphasi[sz]ing)(?: that)?\b`,
  String.raw`\bit should be (?:noted|emphasized) that\b`,
  String.raw`\bwe would like to (?:note|emphasize|highlight) that\b`,
  String.raw`\bplays? an? (?:crucial|key|vital|pivotal|critical|central|significant) role\b`,
  String.raw`\b(?:serves as )?a testament to\b`,
  String.raw`\b(?:rich|intricate)\s+tapestry\b|\btapestry of\b`,
  String.raw`\bdelv(?:e|es|ing) into\b`,
  String.raw`\b(?:in|within) the realm of\b`,
  String.raw`\bever-(?:evolving|changing|growing)\b`,
  String.raw`\bin today'?s (?:world|era|landscape|rapidly evolving)\b`,
  String.raw`\bnavigat(?:e|es|ing) the (?:landscape|complexit\w*|intricac\w*)`,
  String.raw`\bparadigm shift\b|\bgame[- ]chang(?:er|ing)\b`,
  String.raw`\bit goes without saying\b|\bas a matter of fact\b|\bwhen it comes to\b|\bat the end of the day\b|\bwith that being said\b`,
  String.raw`\bthis section will discuss\b|\bwe now turn our attention to\b`,
  String.raw`\bin order to\b`,
  '值得(?:注意|强调|一提)的是|需要(?:强调|指出|说明)的是|不言而喻|毋庸置疑',
].join('|'), 'gi')

/** Framing that argues with an imagined reviewer instead of stating the result (CCFA's categories). */
const DEFENSIVE: [string, RegExp][] = [
  ['answers an imagined reviewer', /\b(?:to\s+)?(?:address|avoid|preempt|pre-empt|anticipate)\s+(?:any\s+|potential\s+|possible\s+)?reviewers?['’]?\s+(?:concerns?|criticism|objections?|questions?)\b|(?:为(?:了)?避免|为回应|为打消|考虑到)审稿人[^。！？\n]{0,24}(?:质疑|担忧|顾虑)/gi],
  ['apologises for the contribution', /\bwe\s+(?:merely|only)\s+(?:offer|propose|provide)\b|\b(?:merely|just)\s+(?:a\s+)?(?:simple|incremental|minor)\s+(?:extension|improvement|modification)\b|(?:尽管|虽然)[^。！？\n]{0,30}(?:只是|仅仅是)(?:一个)?(?:简单|微小|增量)/gi],
  ['defines the scope by denial', /\bwe\s+(?:do not|don't)\s+(?:claim|intend|aim|seek)\s+to\b|\b(?:our|the)\s+(?:goal|aim|intention)\s+is\s+not\s+to\b|我们(?:并不|并非|不)(?:试图|旨在|声称)/gi],
  ['is a generic disclaimer', /\bnot\s+without\s+(?:its\s+)?limitations\b|\bas\s+with\s+any\s+(?:method|model|approach)\b|\b(?:cannot|do\s+not)\s+guarantee\s+(?:universal|general|all)\b|并非没有局限|任何方法都有局限/gi],
  ['is an empty assurance', /\b(?:to\s+ensure|we\s+(?:carefully\s+)?ensure)\s+(?:the\s+|a\s+)?(?:fair(?:ness)?\s+and\s+rigor(?:ous)?|rigor(?:ous)?\s+and\s+fair(?:ness)?)\b|\bto\s+avoid\s+(?:any\s+|possible\s+)?misunderstanding\b|(?:为确保|为了保证)(?:论文|研究|实验|评估)的?(?:严谨性|科学性)|为避免(?:可能的)?误解/gi],
  ['stacks hedges', /\b(?:may|might|could)\s+(?:potentially|possibly|perhaps)\b|\b(?:seems?|appears?)\s+to\s+(?:potentially|possibly)\b|或许可能|可能潜在地|似乎可能表明/gi],
]

/** Words a reviewer reads as promotion unless the evidence earns them. */
const PROMOTIONAL = ['delve', 'tapestry', 'pivotal', 'crucial', 'foster', 'showcase', 'testament', 'leverage', 'realm', 'embark', 'underscore',
  'multifaceted', 'nuanced', 'comprehensive', 'robust', 'intricate', 'cornerstone', 'paradigm', 'synergy', 'holistic', 'streamline',
  'cutting-edge', 'groundbreaking', 'unprecedented', 'seamless']
/** More em dashes than this in a paper reads as a tic. */
const EM_DASH_LIMIT = 3

/** Blank out what is not authored prose — comments, math, code, citations and command names — keeping every offset. */
export function proseOnly(tex: string): string {
  const blank = (match: string): string => match.replace(/[^\n]/g, ' ')
  const environments = 'verbatim|lstlisting|minted|equation\\*?|align\\*?|gather\\*?|multline\\*?|displaymath|tabular\\*?|tikzpicture|algorithmic'
  return tex
    .replace(/(?<!\\)%[^\n]*/g, blank)
    .replace(new RegExp(`\\\\begin\\{(${environments})\\}[\\s\\S]*?\\\\end\\{\\1\\}`, 'g'), blank)
    .replace(/\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]*(?<!\\)\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g, blank)
    .replace(/\\[A-Za-z]+\*?(?:\[[^\]]*\])*(?=\{)|\\[A-Za-z]+\*?/g, blank)
}

/**
 * Find prose worth reconsidering in a paper's LaTeX.
 * @param tex - the flattened paper.
 * @returns findings with the offset each starts at; summaries (em dashes, promotional words) point at their first occurrence.
 */
export function proseFindings(tex: string): ProseFinding[] {
  const prose = proseOnly(tex)
  const findings: ProseFinding[] = []
  for (const match of prose.matchAll(TELLS)) {
    findings.push({ offset: match.index, message: `"${match[0]}" reads as machine-written filler: say the point directly` })
  }
  for (const [why, pattern] of DEFENSIVE) {
    for (const match of prose.matchAll(pattern)) findings.push({ offset: match.index, message: `"${match[0]}" ${why}: state the supported result instead` })
  }
  for (const match of prose.matchAll(/\bnot only\b[^.;!?]{0,140}\bbut also\b/gi)) {
    findings.push({ offset: match.index, message: '"not only … but also" is a formulaic contrast: keep it only where the contrast carries the argument' })
  }
  const sequence = /\bfirst(?:ly)?\b[\s\S]{0,300}\bsecond(?:ly)?\b[\s\S]{0,300}\bthird(?:ly)?\b/i.exec(prose)
  if (sequence) findings.push({ offset: sequence.index, message: 'A firstly/secondly/thirdly run: check that the enumeration follows the argument, not a template' })
  const dashes = [...prose.matchAll(/—|(?<!-)---(?!-)/g)]
  if (dashes.length > EM_DASH_LIMIT) {
    findings.push({ offset: (dashes[0] as RegExpExecArray).index, message: `${dashes.length} em dashes: more than ${EM_DASH_LIMIT} in a paper reads as a tic; most want a comma, a colon or a new sentence` })
  }
  const counts = PROMOTIONAL.map(word => ({ word, hits: [...prose.matchAll(new RegExp(`\\b${word}\\b`, 'gi'))] })).filter(item => item.hits.length > 0)
  if (counts.length > 0) {
    const first = Math.min(...counts.map(item => (item.hits[0] as RegExpExecArray).index))
    findings.push({ offset: first, message: `Promotional words to earn with evidence or cut: ${counts.map(item => `${item.word} ×${item.hits.length}`).join(', ')}` })
  }
  return findings.sort((a, b) => a.offset - b.offset)
}
