import { describe, expect, it } from 'vitest'
import { proseFindings, proseOnly } from '../src/prose.ts'

describe('the prose check', () => {
  it('finds machine-written tells, defensive framing and formulaic contrasts in English and Chinese, in text order', () => {
    const tex = [
      'It is worth noting that attention plays a crucial role here.',
      'To address potential reviewer concerns, we merely propose a simple extension.',
      'We do not claim to solve everything; our method is not without limitations and may potentially fail.',
      'To ensure fairness and rigor we avoid any misunderstanding.',
      'The model is not only fast but also accurate.',
      '值得注意的是，为了避免审稿人的质疑，我们并不试图覆盖所有情况，或许可能有例外。',
    ].join('\n')
    const messages = proseFindings(tex).map(finding => finding.message)
    expect(messages).toEqual(expect.arrayContaining([
      '"It is worth noting that" reads as machine-written filler: say the point directly',
      '"plays a crucial role" reads as machine-written filler: say the point directly',
      expect.stringMatching(/^"To address potential reviewer concerns" answers an imagined reviewer/) as unknown,
      expect.stringMatching(/^"we merely propose" apologises for the contribution/) as unknown,
      expect.stringMatching(/^"We do not claim to" defines the scope by denial/) as unknown,
      expect.stringMatching(/^"not without limitations" is a generic disclaimer/) as unknown,
      expect.stringMatching(/^"may potentially" stacks hedges/) as unknown,
      expect.stringMatching(/^"To ensure fairness and rigor" is an empty assurance/) as unknown,
      expect.stringMatching(/^"not only … but also" is a formulaic contrast/) as unknown,
      '"值得注意的是" reads as machine-written filler: say the point directly',
      expect.stringMatching(/^"为了避免审稿人的质疑" answers an imagined reviewer/) as unknown,
      expect.stringMatching(/^"我们并不试图" defines the scope by denial/) as unknown,
      expect.stringMatching(/^"或许可能" stacks hedges/) as unknown,
      'Promotional words to earn with evidence or cut: crucial ×1',
    ]))
    const offsets = proseFindings(tex).map(finding => finding.offset)
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
  })

  it('counts em dashes and promotional words once each, and notices firstly/secondly/thirdly runs', () => {
    const tex = 'A robust — and comprehensive — pipeline --- robust again --- and more. Firstly we plan. Secondly we write. Thirdly we check.'
    const messages = proseFindings(tex).map(finding => finding.message)
    expect(messages).toEqual(expect.arrayContaining([
      '4 em dashes: more than 3 in a paper reads as a tic; most want a comma, a colon or a new sentence',
      'Promotional words to earn with evidence or cut: comprehensive ×1, robust ×2',
      'A firstly/secondly/thirdly run: check that the enumeration follows the argument, not a template',
    ]))
    expect(proseFindings('Three — dashes — are — fine.')).toEqual([])
  })

  it('reads only authored prose: comments, math, code, tables and command names are blanked in place', () => {
    const tex = '% it is worth noting that\n$\\text{in order to}$ \\begin{equation}delve into\\end{equation} \\cite{robust2020} \\textbf{Plain} words.'
    const prose = proseOnly(tex)
    expect(prose).toHaveLength(tex.length)
    expect(prose).not.toMatch(/worth|order|delve|textbf/)
    expect(prose).toContain('{Plain} words.')
    expect(proseFindings(tex)).toEqual([])
  })
})
