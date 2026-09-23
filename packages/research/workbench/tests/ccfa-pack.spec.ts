import { beforeAll, describe, expect, it } from 'vitest'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { ModeRegistry } from '../src/modes.ts'

// The shipped CCFA pack. Its gates are Python; tests/ccfa_gates_test.py runs them.
let registry: ModeRegistry
beforeAll(async () => { registry = await ModeRegistry.load([join(import.meta.dirname, '../runtime/modes')], { warn: (...args: unknown[]) => { throw new Error(args.join(' ')) } }) })

describe('the CCFA pack', () => {
  it('runs each upstream suggested route through its specialist stages, with open left free', () => {
    const phases = (route: string) => registry.resolve({ mode: 'ccfa', route }).phases.map(phase => phase.id)
    expect(phases('full-paper')).toEqual(['scaffold', 'idea', 'literature', 'design', 'experiments', 'writing', 'visuals', 'integrity', 'review', 'submission'])
    expect(phases('manuscript-improvement')).toEqual(['scaffold', 'diagnose', 'writing', 'integrity', 'review', 'submission'])
    expect(phases('post-review-response')).toEqual(['scaffold', 'ledger', 'response', 'revision', 'submission'])
    expect(phases('open')).toEqual([])
    expect(registry.resolve({ mode: 'ccfa' }).route).toBe('full-paper')
    const checkpoints = registry.resolve({ mode: 'ccfa', route: 'full-paper' }).phases.filter(phase => phase.checkpoint).map(phase => phase.id)
    expect(checkpoints).toEqual(['experiments'])
  })

  it('checks the CCFA contracts on the routes that write them, and none on the open route', () => {
    const gates = (route: string) => registry.resolve({ mode: 'ccfa', route }).gates.map(gate => gate.id)
    expect(gates('full-paper')).toEqual(['ccfa-yaml', 'review-report', 'submission-checks', 'path-privacy'])
    expect(gates('post-review-response')).toEqual(['ccfa-yaml', 'revision-ledger', 'submission-checks', 'path-privacy'])
    expect(gates('open')).toEqual([])
  })

  it('preloads both preflights before the orchestrator and ships all sixteen specialist skills', () => {
    const pack = registry.get('ccfa')!
    expect(pack.preload).toEqual(['ccf-humanization', 'ccf-common'])
    expect(pack.entry).toBe('ccf-pipeline-orchestrator')
    expect(pack.skills.map(skill => skill.name)).toEqual([
      'ccf-common', 'ccf-experiment-designer', 'ccf-humanization', 'ccf-idea-optimizer', 'ccf-idea-reviewer', 'ccf-integrity-auditor',
      'ccf-literature-monitor', 'ccf-literature-searcher', 'ccf-paper-reviewer', 'ccf-paper-to-exemplar', 'ccf-paper-writer',
      'ccf-pipeline-orchestrator', 'ccf-project-scaffolder', 'ccf-rebuttal-writer', 'ccf-submission-checker', 'ccf-visual-composer',
    ])
  })

  it('ships every gate, script and upstream text it names, with its licence and notice', async () => {
    const pack = registry.get('ccfa')!
    for (const item of [...pack.gates, ...pack.scripts]) await expect(access(join(pack.directory, item.script))).resolves.toBeUndefined()
    for (const skill of pack.skills) await expect(access(join(skill.directory, 'references', 'upstream.md'))).resolves.toBeUndefined()
    for (const file of ['LICENSE', 'NOTICE.md', 'upstream/ccf-project-scaffolder/assets/ccfa.yaml']) {
      await expect(access(join(pack.directory, file))).resolves.toBeUndefined()
    }
    expect(pack.scripts.map(script => script.id)).toEqual(['prose-quality', 'validate-comparison', 'pdf-to-card', 'plot-recipe'])
    expect(pack.source).toMatchObject({ license: 'MIT', repo: expect.stringContaining('CCFA-Skills') as unknown })
  })
})
