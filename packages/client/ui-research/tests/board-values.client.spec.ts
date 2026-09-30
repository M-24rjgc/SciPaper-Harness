/**
 * What the experiment board derives from the record: the runs a value
 * follows, what it shows, the sections collectors add, and chart points.
 */
import { describe, expect, it } from 'vitest'
import type { BoardSpec, ExperimentRecord } from '@deepseek-ai/dsh-research-workbench/types'
import {
  fieldPoints, followedRuns, gigabytes, latestRun, mergedSections, nameMatches, numberText, shownValue, ticks, watchedKeys, xKey,
} from '../src/client/boardValues.ts'
import type { Translate } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as Translate

function run(id: string, name: string, status: ExperimentRecord['status'], metrics: Record<string, number> = {}, extra: Partial<ExperimentRecord> = {}): ExperimentRecord {
  return {
    id: id as never, status, metrics, createdAt: `2026-09-24T10:00:0${id.length}.000Z`, updatedAt: '', directory: '', inputRevision: 1,
    environmentFingerprint: '', message: '', snapshotPath: '', collected: true,
    spec: { name, seed: id.length, environmentId: 'e' as never, argv: [], cwd: '.', maxSeconds: 60, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'm' },
    ...extra,
  }
}

describe('the runs a board value follows', () => {
  const project = { experiments: [run('a', 'main', 'completed'), run('bb', 'main', 'completed'), run('ccc', 'other', 'running')] }

  it('are the run with that id, else every run of that name and seed', () => {
    expect(followedRuns(project, { run: 'ccc' }).map(item => item.id)).toEqual(['ccc'])
    expect(followedRuns(project, { run: 'main' }).map(item => item.id)).toEqual(['a', 'bb'])
    expect(followedRuns(project, { run: 'main', seed: 1 }).map(item => item.id)).toEqual(['a'])
    expect(followedRuns(project, {})).toEqual([])
    expect(latestRun(project, { run: 'main' })?.id).toBe('bb')
    expect(nameMatches('main*', 'main/x')).toBe(true)
    expect(nameMatches('m.in', 'main')).toBe(false)
  })
})

describe('what a board value shows', () => {
  const experiments = [
    run('a', 'seeds', 'completed', { acc: 0.8 }), run('bb', 'seeds', 'completed', { acc: 0.9 }), run('ccc', 'seeds', 'running'),
    run('dddd', 'single', 'completed', { acc: 0.5, loss: 1 }),
    run('eeeee', 'going', 'running', {}, { progress: { values: {}, fraction: 0.42, at: '' } }), run('ffffff', 'waiting', 'queued'),
    run('ggggggg', 'broke', 'failed'), run('hhhhhhhh', 'lost', 'interrupted'), run('iiiiiiiii', 'stopped', 'cancelled'),
  ]
  const shown = (cell: Parameters<typeof shownValue>[1]) => shownValue({ experiments }, cell, t)

  it('draws fixed values as given, scaled and toned', () => {
    for (const empty of [undefined, null, '']) expect(shown(empty)).toEqual({ text: '—', state: 'empty' })
    expect(shown('n/a')).toEqual({ text: 'n/a', state: 'value' })
    expect(shown(3)).toEqual({ text: '3', state: 'value' })
    expect(shown({ sub: 'none yet' })).toEqual({ text: '—', sub: 'none yet', state: 'empty' })
    expect(shown({ value: 'text', tone: 'muted' })).toEqual({ text: 'text', sub: undefined, tone: 'muted', state: 'value' })
    expect(shown({ value: 0.912, scale: 100, digits: 1, unit: '%', target: 90 })).toMatchObject({ text: '91.2%', tone: 'good' })
    expect(shown({ value: 2, target: 1, better: 'lower' })).toMatchObject({ text: '2', tone: 'warning' })
    expect(shown({ value: 0.5, target: 1, better: 'lower', tone: 'bad' })).toMatchObject({ tone: 'good' })
    expect(shown({ value: 0.5, tone: 'bad' })).toMatchObject({ tone: 'bad' })
  })

  it('follows a run: its mean over finished seeds, where the others stand, or why there is no number', () => {
    expect(shown({ run: 'seeds', metric: 'acc', scale: 100, digits: 1 })).toEqual({
      text: '85.0', sub: `± 7.1 · ${t('boardSeeds', { n: 2 })} · ${t('boardDoneOf', { done: 2, total: 3 })}`, tone: undefined, state: 'value',
    })
    expect(shown({ run: 'single', metric: 'acc', sub: 'one seed', target: 0.6 })).toEqual({ text: '0.5', sub: 'one seed', tone: 'warning', state: 'value' })
    expect(shown({ run: 'single', metric: 'loss' })).toMatchObject({ text: '1', sub: undefined })
    expect(shown({ run: 'nobody', metric: 'acc' })).toEqual({ text: zh.boardNotRun, state: 'pending', tone: 'muted' })
    expect(shown({ run: 'going', metric: 'acc' })).toEqual({ text: zh.runRunning, sub: '42%', state: 'running' })
    expect(shown({ run: 'waiting', metric: 'acc' })).toEqual({ text: zh.runRunning, sub: undefined, state: 'running' })
    expect(shown({ run: 'single' })).toEqual({ text: zh.completed, state: 'value', tone: 'good' })
    expect(shown({ run: 'single', metric: 'f1' })).toEqual({ text: '—', sub: t('boardNoMetric', { metric: 'f1' }), state: 'missing', tone: 'muted' })
    expect(shown({ run: 'broke', metric: 'acc' })).toEqual({ text: zh.failed, state: 'failed', tone: 'bad' })
    expect(shown({ run: 'lost' })).toMatchObject({ text: zh.failed })
    expect(shown({ run: 'stopped', metric: 'acc' })).toEqual({ text: zh.cancelled, state: 'failed', tone: 'muted' })
  })

  it('writes numbers in the digits asked for, else in four significant digits', () => {
    expect(numberText(0.123456)).toBe('0.1235')
    expect(numberText(12)).toBe('12')
    expect(numberText(1.25, 1)).toBe('1.3')
    expect(gigabytes(3 * 1024 ** 3)).toBe('3.0')
  })
})

describe('what collectors add, and what charts plot', () => {
  it('fills a board section by id and appends the others', () => {
    const spec: BoardSpec = { collectors: [], sections: [{ id: 'q', title: 'Queue', blocks: [{ type: 'text', text: 'mine' }] }] }
    const sections = mergedSections(spec, {
      a: { at: '', ms: 1, stats: [], alerts: [], sections: [{ id: 'q', title: 'Theirs', blocks: [{ type: 'log', text: 'x' }] }, { id: 'extra', title: 'Extra', blocks: [] }] },
    })
    expect(sections.map(section => [section.id, section.title, section.blocks.map(block => block.type)])).toEqual([['q', 'Queue', ['text', 'log']], ['extra', 'Extra', []]])
    expect(spec.sections[0]?.blocks).toHaveLength(1)
  })

  it('plots a field against the preferred axis, the first epoch-like field, or the line number', () => {
    const rows = [{ step: 10, loss: 2, progress: 0.1, time: 5 }, { step: 20, loss: 1, acc: 0.5 }]
    expect(xKey(rows)).toBe('step')
    expect(xKey(rows, 'loss')).toBe('loss')
    expect(xKey(rows, 'missing')).toBe('step')
    expect(xKey([{ loss: 1 }])).toBeUndefined()
    expect(fieldPoints(rows, 'loss', 'step')).toEqual([[10, 2], [20, 1]])
    expect(fieldPoints(rows, 'acc', undefined)).toEqual([[2, 0.5]])
    expect(fieldPoints([{ loss: 1 }], 'loss', 'step')).toEqual([])
    expect(watchedKeys(rows, 'step', 5)).toEqual(['loss', 'acc'])
    expect(watchedKeys(rows, 'step', 1)).toEqual(['loss'])
  })

  it('puts round ticks across a range', () => {
    expect(ticks(0, 1, 4)).toEqual([0, 0.25, 0.5, 0.75, 1])
    expect(ticks(0.12, 0.87, 4)).toEqual([0.2, 0.4, 0.6, 0.8])
    expect(ticks(3, 3, 4)).toEqual([3])
    expect(ticks(0, 700, 4)).toEqual([0, 200, 400, 600])
  })
})
