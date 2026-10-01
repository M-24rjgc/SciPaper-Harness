import { describe, expect, it } from 'vitest'
import type { MemoryLesson, ProjectId } from '@deepseek-ai/dsh-research-workbench/types'
import {
  CARD_GAP, CHIP_GAP, CHIP_HEIGHT, GROUP_GAP, KINDS, NEXT_HEIGHT, RESEARCH_HEIGHT, SHOWN_PER_KIND, carriedCount, chipKind, kindTitle,
  lessonText, memoryLayout, nextMeta, researchMeta, switchDetail,
} from '../src/client/memoryValues.ts'
import { en, zh } from '../src/client/locales.ts'
import { environment, experiment, everyKind as on, list, page, paper, research, venue } from './fixtures/memory.ts'
import { translate } from './fixtures/translate.tsx'

const t = translate(en)

describe('memoryLayout', () => {
  it('places each research level with the middle of its own items and draws a line from each to the items it left', () => {
    const layout = memoryLayout(page({
      researches: [research('a')],
      literature: list([paper('Longformer', ['a'])]),
      runs: list([experiment('ruler', 'a')]),
    }), t)
    const first = CHIP_HEIGHT / 2
    const second = CHIP_HEIGHT + GROUP_GAP + CHIP_HEIGHT / 2
    expect(layout.chips.map(chip => [chip.id, chip.kind, chip.top, chip.center, chip.carried])).toEqual([
      ['literature:0', 'literature', 0, first, true], ['runs:1', 'runs', CHIP_HEIGHT + GROUP_GAP, second, true],
    ])
    const middle = (first + second) / 2
    expect(layout.researches).toEqual([{ research: research('a'), top: Math.max(middle - RESEARCH_HEIGHT / 2, 0), center: Math.max(middle - RESEARCH_HEIGHT / 2, 0) + RESEARCH_HEIGHT / 2 }])
    expect(layout.next.center).toBe(layout.next.top + NEXT_HEIGHT / 2)
    expect(layout.sourceEdges).toEqual([
      { researchId: 'a', chipId: 'literature:0', from: layout.researches[0]!.center, to: first },
      { researchId: 'a', chipId: 'runs:1', from: layout.researches[0]!.center, to: second },
    ])
    expect(layout.carryEdges).toEqual([
      { chipId: 'literature:0', from: first, to: layout.next.center }, { chipId: 'runs:1', from: second, to: layout.next.center },
    ])
    expect(layout.height).toBe(Math.max(RESEARCH_HEIGHT, NEXT_HEIGHT, 2 * CHIP_HEIGHT + GROUP_GAP))
  })

  it('stacks the chips of one kind with a small gap and of different kinds with a larger one, skipping a kind that holds nothing', () => {
    const layout = memoryLayout(page({
      researches: [research('a')],
      literature: list([paper('One', ['a']), paper('Two', ['a'])]),
      environments: list([environment('lab', ['a'])]),
    }), t)
    expect(layout.chips.map(chip => chip.top)).toEqual([0, CHIP_HEIGHT + CHIP_GAP, 2 * CHIP_HEIGHT + CHIP_GAP + GROUP_GAP])
    expect(layout.height).toBe(3 * CHIP_HEIGHT + CHIP_GAP + GROUP_GAP)
  })

  it('pushes a research down only as far as the card above requires, and puts one without items where the cards above end', () => {
    const layout = memoryLayout(page({
      researches: [research('a'), research('b'), research('c')],
      literature: list([paper('Shared', ['a', 'b']), paper('Only b', ['b'])]),
    }), t)
    const [a, b, c] = layout.researches
    expect(a!.top).toBe(0)
    expect(b!.top).toBe(RESEARCH_HEIGHT + CARD_GAP)
    expect(c!.top).toBe(b!.top + RESEARCH_HEIGHT + CARD_GAP)
    expect(layout.height).toBe(c!.top + RESEARCH_HEIGHT)
    expect(layout.sourceEdges.map(edge => [edge.researchId, edge.chipId])).toEqual([['a', 'literature:0'], ['b', 'literature:0'], ['b', 'literature:1']])
  })

  it('draws the first items of a kind and one chip for the rest, which comes from all the researches of the rest', () => {
    const many = Array.from({ length: SHOWN_PER_KIND + 3 }, (_, at) => paper(`Paper ${at}`, [at < SHOWN_PER_KIND ? 'a' : at === SHOWN_PER_KIND ? 'b' : 'c']))
    const layout = memoryLayout(page({ researches: [research('a'), research('b'), research('c')], literature: list(many, 120) }), t)
    expect(layout.chips).toHaveLength(SHOWN_PER_KIND + 1)
    expect(layout.chips.at(-1)).toMatchObject({ kind: 'literature', label: '+115 more', title: '+115 more', researches: ['b', 'c'] })
    expect(memoryLayout(page({ researches: [research('a')], literature: list(many.slice(0, SHOWN_PER_KIND)) }), t).chips).toHaveLength(SHOWN_PER_KIND)
  })

  it('draws no line for a kind that is switched off, and centres the next research on what it carries', () => {
    const base = {
      researches: [research('a')], literature: list([paper('One', ['a'])]), runs: list([experiment('ruler', 'a')]),
    }
    const some = memoryLayout(page({ ...base, carry: { ...on, literature: false } }), t)
    expect(some.chips.map(chip => chip.carried)).toEqual([false, true])
    expect(some.carryEdges.map(edge => edge.chipId)).toEqual(['runs:1'])
    expect(some.next.center).toBe(Math.max(some.chips[1]!.center, NEXT_HEIGHT / 2))
    const none = memoryLayout(page({ ...base, carry: { literature: false, runs: false, environments: false, writing: false } }), t)
    expect(none.carryEdges).toEqual([])
    expect(none.next.center).toBe(Math.max((none.chips[0]!.center + none.chips[1]!.center) / 2, NEXT_HEIGHT / 2))
  })

  it('lays out researches that left no items, and nothing at all for an empty page', () => {
    const bare = memoryLayout(page({ researches: [research('a'), research('b')] }), t)
    expect(bare).toMatchObject({ chips: [], sourceEdges: [], carryEdges: [], next: { top: 0 }, height: 2 * RESEARCH_HEIGHT + CARD_GAP })
    expect(memoryLayout(page(), t)).toEqual({
      height: NEXT_HEIGHT, researches: [], chips: [], next: { top: 0, center: NEXT_HEIGHT / 2 }, sourceEdges: [], carryEdges: [],
    })
  })

  it('names and describes every chip from what the record holds', () => {
    const layout = memoryLayout(page({
      researches: [research('a')],
      literature: list([paper('Longformer', ['a'], { doi: '10.1/long' }), paper('Reformer', ['a'])]),
      runs: list([experiment('ruler', 'a')]),
      environments: list([
        environment('lab', ['a'], { target: 'ssh', host: 'gpu', kind: 'existing', python: '/usr/bin/python3', requirements: ['torch', 'numpy'] }),
        environment('no-host', ['a'], { target: 'ssh', kind: 'existing' }),
        environment('uv', ['a']),
        environment('conda', ['a'], { kind: 'conda', python: '/opt/conda/bin/python' }),
      ]),
      writing: list([venue('aaai', ['a'], 'AAAI 2026'), venue('neurips', ['a'])]),
    }), t)
    expect(layout.chips.map(chip => [chip.kind, chip.label, chip.title])).toEqual([
      ['literature', 'Longformer', 'Longformer\n10.1/long'],
      ['literature', 'Reformer', 'Reformer'],
      ['runs', 'ruler', 'ruler\naccuracy 0.9 · loss 0.1 · f1 0.8\n{python} train.py'],
      ['environments', 'gpu · SSH', 'gpu · SSH\n/usr/bin/python3\ntorch, numpy'],
      ['environments', 'no-host · SSH', 'no-host · SSH'],
      ['environments', 'uv · this computer', 'uv · this computer'],
      ['environments', 'conda', 'conda\n/opt/conda/bin/python'],
      ['writing', 'AAAI 2026', 'AAAI 2026\naaai'],
      ['writing', 'neurips', 'neurips'],
    ])
  })
})

describe('words', () => {
  it('names a kind for its switch and for its chip, in the reader\'s language', () => {
    expect(KINDS.map(kind => kindTitle(kind, t))).toEqual(['Literature', 'Finished experiments', 'Environments', 'Writing preferences'])
    expect(KINDS.map(kind => chipKind(kind, t))).toEqual(['Paper', 'Run', 'Env', 'Venue'])
    expect(KINDS.map(kind => kindTitle(kind, translate(zh)))).toEqual(['文献库', '已完成的实验', '实验环境', '写作偏好'])
  })

  it('counts what the next research carries from the kinds that are on, and says when that is nothing', () => {
    const memory = page({ literature: list([paper('One', ['a'])], 31), runs: list([experiment('r', 'a')]), environments: list([environment('uv', ['a'])]) })
    expect(carriedCount(memory)).toBe(33)
    expect(nextMeta(memory, t)).toBe('Carries 33 items')
    expect(nextMeta({ ...memory, carry: { ...on, literature: false, runs: false } }, t)).toBe('Carries 1 item')
    expect(nextMeta({ ...memory, carry: { ...on, literature: false, runs: false, environments: false } }, t)).toBe('Carries nothing yet')
    expect(nextMeta(page(), translate(zh))).toBe('暂时什么也不带')
  })

  it('says what a research imported and finished and which venue it writes for, and nothing for a bare record', () => {
    expect(researchMeta(research('a', { literature: 31, runs: 2, venue: 'AAAI 2026' }), t)).toBe('31 papers · 2 experiments · AAAI 2026')
    expect(researchMeta(research('a', { literature: 1, runs: 1 }), t)).toBe('1 paper · 1 experiment')
    expect(researchMeta(research('a', { venue: 'neurips' }), t)).toBe('neurips')
    expect(researchMeta(research('a'), t)).toBe('')
    expect(researchMeta(research('a', { literature: 2 }), translate(zh))).toBe('2 篇文献')
  })

  it('words each switch from how much of the kind there is and where it came from', () => {
    const memory = page({
      researches: [research('a', { literature: 2 }), research('b', { literature: 1 }), research('c')],
      literature: list([paper('Shared', ['a', 'b']), paper('Alone', ['a'])], 3),
      runs: list([experiment('ruler', 'a')]),
      environments: list([
        environment('uv', ['a']), environment('lab', ['a'], { target: 'ssh', host: 'gpu' }),
        environment('conda', ['a'], { kind: 'conda' }), environment('extra', ['a'], { kind: 'existing' }),
      ]),
      writing: list([venue('aaai', ['a'], 'AAAI 2026'), venue('neurips', ['b'])]),
    })
    expect(switchDetail('literature', memory, t)).toBe('3 papers from 2 researches, merged by title. 1 used in more than one research.')
    expect(switchDetail('literature', page({ researches: [research('a', { literature: 1 })], literature: list([paper('Alone', ['a'])]) }), t))
      .toBe('1 paper from 1 research, merged by title.')
    expect(switchDetail('runs', memory, t)).toBe('1 experiment, each with its command and recorded metrics. The record does not mark baselines, so none is called one.')
    expect(switchDetail('environments', memory, t)).toBe('4 environments: uv · this computer, gpu · SSH, conda and 1 more.')
    expect(switchDetail('writing', memory, t)).toBe('2 venues: AAAI 2026, neurips.')
    expect(switchDetail('writing', page({ writing: list([venue('aaai', ['a'])]) }), t)).toBe('1 venue: aaai.')
    for (const kind of KINDS) expect(switchDetail(kind, page(), t)).toBe('Nothing recorded yet.')
    expect(switchDetail('environments', memory, translate(zh))).toBe('4 个环境：uv · 本机、gpu · SSH、conda等 1 项。')
  })

  it('words a lesson in the record\'s own terms, with the research and the day', () => {
    const memory = page({ researches: [research('a')] })
    const day = '2026-08-04T12:00:00Z'
    const when = `${new Date(day).getMonth() + 1}/${new Date(day).getDate()}`
    const failed: MemoryLesson = { research: 'a' as ProjectId, at: day, kind: 'failed-run', name: 'train', reason: 'CUDA out of memory', exitCode: 1 }
    expect(lessonText(failed, memory, t)).toEqual({ kind: 'failed-run', text: 'Run train failed: CUDA out of memory', why: '', from: `Research a · ${when}` })
    expect(lessonText({ ...failed, reason: '' }, memory, t).text).toBe('Run train failed: exit code 1')
    const decided: MemoryLesson = {
      research: 'a' as ProjectId, at: day, kind: 'decision', question: 'Which dataset?', answer: 'RULER', rationale: 'standard', by: 'user',
    }
    expect(lessonText(decided, memory, t)).toEqual({ kind: 'decision', text: 'Which dataset? → RULER', why: 'Why: standard', from: `Research a · ${when}` })
    expect(lessonText({ ...decided, rationale: '' }, memory, t).why).toBe('')
    expect(lessonText(failed, memory, translate(zh)).text).toBe('实验「train」失败：CUDA out of memory')
  })
})
