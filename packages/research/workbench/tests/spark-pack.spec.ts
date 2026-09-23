import { beforeAll, describe, expect, it } from 'vitest'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { ModeRegistry } from '../src/modes.ts'

// The shipped spark-to-paper pack. Its gates are Python; tests/spark_gates_test.py runs them.
let registry: ModeRegistry
beforeAll(async () => { registry = await ModeRegistry.load([join(import.meta.dirname, '../runtime/modes')], { warn: (...args: unknown[]) => { throw new Error(args.join(' ')) } }) })

describe('the spark-to-paper pack', () => {
  it('follows the upstream stage chain on each route, with experiments after the first compiled draft', () => {
    const phases = (route: string) => registry.resolve({ mode: 'spark-to-paper', route }).phases.map(phase => phase.id)
    const chain = ['plan', 'cite', 'write', 'refine', 'review', 'figures', 'latex']
    expect(phases('idea')).toEqual(['story', ...chain, 'experiments', 'submission'])
    expect(phases('proposal')).toEqual([...chain, 'experiments', 'submission'])
    expect(phases('data')).toEqual(['data', ...chain, 'submission'])
    const experiments = registry.resolve({ mode: 'spark-to-paper', route: 'proposal' }).phases.find(phase => phase.id === 'experiments')
    expect(experiments?.checkpoint).toBe(true)
  })

  it('runs the story gate only on the idea route and every other upstream gate on all routes', () => {
    const gates = (route: string) => registry.resolve({ mode: 'spark-to-paper', route }).gates.map(gate => gate.id)
    const shared = ['template-lint', 'blueprint-lint', 'citations-bib', 'citations-lint', 'draft-lint', 'vector-figures', 'figure-critique']
    expect(gates('idea')).toEqual(['story-lint', ...shared])
    expect(gates('data')).toEqual(shared)
  })

  it('ships every gate and script file its manifest names, with its upstream licence and notice', async () => {
    const pack = registry.get('spark-to-paper')!
    for (const item of [...pack.gates, ...pack.scripts]) await expect(access(join(pack.directory, item.script))).resolves.toBeUndefined()
    for (const file of ['LICENSE', 'NOTICE.md']) await expect(access(join(pack.directory, file))).resolves.toBeUndefined()
    expect(pack.scripts.map(script => script.id)).toEqual([
      'blueprint-fix', 'assemble-paper', 'reflow-sections', 'plot-results', 'consistency-check', 'recompute-results', 'scan-code',
    ])
    expect(pack.source).toMatchObject({ license: 'MIT', repo: expect.stringContaining('spark-to-paper-skills') as unknown })
  })
})
