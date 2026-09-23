import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { format } from 'node:util'
import { globMatcher, runChecks } from '../src/checks.ts'
import { GENERAL_MODE, loadPack, ModeRegistry, parseSkillFile } from '../src/modes.ts'
import { newProject } from '../src/project.ts'
import type { CheckFinding, ResearchProject } from '../src/types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'research modes '))
  roots.push(root)
  return root
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

const GENERAL = 'id: general\norder: 0\nname: { en: General, zh: 通用 }\nsummary: { en: s, zh: s }\n'
/** A logger that keeps each formatted warning. */
const collect = (into: string[]) => ({ warn: (pattern: string, ...args: unknown[]) => { into.push(format(pattern, ...args)) } })
const quiet = { warn: () => {} }
const skill = (name: string, extra = '') => `---\nname: ${name}\ndescription: What ${name} does.\n${extra}---\n\nBody of ${name}.\n`

/** A pack exercising every condition kind, two routes, gates and skills. */
const DEMO = `
id: demo
order: 5
name: { en: Demo, zh: 演示 }
summary: { en: A demo pack, zh: 演示包 }
source: { repo: https://example.org/demo, version: 1.0.0, license: MIT }
entry: lead
preload: [first]
routes:
  - id: short
    name: { en: Short, zh: 短 }
    summary: { en: Quick, zh: 快 }
  - id: long
    name: { en: Long, zh: 长 }
    summary: { en: Thorough, zh: 全 }
defaultRoute: short
phases:
  - id: notes
    label: { en: Notes, zh: 笔记 }
    requires:
      - when: { file: "notes/*.md", min: 2 }
      - when: [{ file: "**/story.json" }, { file: "{idea,brief}.md" }]
        message: Write the story
  - id: counts
    label: { en: Counts, zh: 计数 }
    routes: [long]
    checkpoint: true
    checks: [lint]
    requires:
      - when: { sections: 2 }
      - when: { figures: 2 }
      - when: { bibEntries: 3 }
  - id: results
    label: { en: Results, zh: 结果 }
    checks: [cite]
    requires:
      - when: manuscript
      - when: runsCollected
      - when: dataEvidence
      - when: resultsOrData
      - when: reviewCurrent
  - id: all
    label: { en: All, zh: 全部 }
    checks: all
gates:
  - id: lint
    script: gates/lint.py
  - id: long-only
    script: gates/long.py
    routes: [long]
scripts:
  - id: build
    script: scripts/build.py
    description: Assemble the paper
`

async function packs(extra: Record<string, string> = {}): Promise<string> {
  const root = await temp()
  await write(join(root, 'general', 'mode.yml'), GENERAL)
  await write(join(root, 'demo', 'mode.yml'), DEMO)
  await write(join(root, 'demo', 'skills', 'lead', 'SKILL.md'), skill('lead', 'whenToUse: Always first.\n'))
  await write(join(root, 'demo', 'skills', 'first', 'SKILL.md'), skill('first'))
  await write(join(root, 'demo', 'skills', 'notes.txt'), 'not a skill folder')
  for (const [path, content] of Object.entries(extra)) await write(join(root, path), content)
  return root
}

describe('mode packs load from directories of data', () => {
  it('loads packs in display order with their skills, routes and summaries', async () => {
    const warnings: string[] = []
    const registry = await ModeRegistry.load([await packs(), join(tmpdir(), 'no-such-root-for-research-modes')], collect(warnings))
    expect(warnings).toEqual([])
    expect(registry.list().map(pack => pack.id)).toEqual([GENERAL_MODE, 'demo'])
    const demo = registry.get('demo')!
    expect(demo.skills.map(item => [item.name, item.whenToUse])).toEqual([['first', undefined], ['lead', 'Always first.']])
    expect(demo.skills[0]?.directory.endsWith(join('demo', 'skills', 'first'))).toBe(true)
    expect(registry.summaries()[1]).toMatchObject({
      id: 'demo', entry: 'lead', preload: ['first'], defaultRoute: 'short',
      phases: [{ id: 'notes', checkpoint: false, skills: [] }, { id: 'counts', routes: ['long'], checkpoint: true }, { id: 'results' }, { id: 'all' }],
    })
    expect(registry.summaries()[0]).toEqual({ id: 'general', order: 0, name: { en: 'General', zh: '通用' }, summary: { en: 's', zh: 's' }, preload: [], routes: [], phases: [] })
    expect(registry.get('nope')).toBeUndefined()
  })

  it('chooses routes and resolves a project to the phases and gates of its route', async () => {
    const registry = await ModeRegistry.load([await packs()], quiet)
    expect(registry.choose('demo')).toEqual({ mode: 'demo', route: 'short' })
    expect(registry.choose('demo', 'long')).toEqual({ mode: 'demo', route: 'long' })
    expect(registry.choose('general')).toEqual({ mode: 'general' })
    expect(() => registry.choose('demo', 'sideways')).toThrow(/Mode demo has no route sideways; its routes: short, long/)
    expect(() => registry.choose('general', 'short')).toThrow(/Mode general has no routes/)
    expect(() => registry.choose('ghost')).toThrow(/Unknown mode ghost/)
    const short = registry.resolve({ mode: 'demo', route: 'short' })
    expect([short.phases.map(phase => phase.id), short.gates.map(gate => gate.id)]).toEqual([['notes', 'results', 'all'], ['lint']])
    const long = registry.resolve({ mode: 'demo', route: 'long' })
    expect([long.phases.map(phase => phase.id), long.gates.map(gate => gate.id)]).toEqual([['notes', 'counts', 'results', 'all'], ['lint', 'long-only']])
    // A route the pack no longer has falls back to its default; a pack that is gone falls back to general.
    expect(registry.resolve({ mode: 'demo', route: 'removed' }).route).toBe('short')
    expect(registry.resolve({ mode: 'ghost', route: 'x' })).toMatchObject({ pack: { id: 'general' }, missing: 'ghost', phases: [] })
    expect('missing' in registry.resolve({ mode: 'general' })).toBe(false)
  })

  it('skips a broken pack with a warning, keeps the rest, and requires the general pack', async () => {
    const broken = await packs({
      'bad-yaml/mode.yml': 'id: [unclosed',
      'no-manifest/readme.md': 'nothing here',
      'twin/mode.yml': GENERAL.replace('id: general', 'id: demo'),
      'misnamed/mode.yml': GENERAL.replace('id: general', 'id: misnamed').replace('order: 0', 'order: 9'),
      'misnamed/skills/right/SKILL.md': skill('wrong'),
      'plain/mode.yml': GENERAL.replace('id: general', 'id: plain'),
      'plain/skills/bare/SKILL.md': 'no frontmatter',
    })
    const warnings: string[] = []
    const registry = await ModeRegistry.load([broken], collect(warnings))
    expect(registry.list().map(pack => pack.id)).toEqual(['general', 'demo'])
    const joined = warnings.join('\n')
    expect(joined).toMatch(/bad-yaml skipped/)
    expect(joined).toMatch(/no-manifest skipped/)
    expect(joined).toMatch(/twin skipped: another pack already has id demo/)
    expect(joined).toMatch(/misnamed skipped: skills\/right\/SKILL\.md is named wrong/)
    expect(joined).toMatch(/plain skipped: SKILL\.md must start with a --- frontmatter block/)
    const empty = await temp()
    await expect(ModeRegistry.load([empty], quiet)).rejects.toThrow(/general mode pack is missing/)
  })

  it('reports every inconsistency in a manifest at once', async () => {
    const root = await temp()
    await write(join(root, 'mode.yml'), `
id: odd
order: 1
name: { en: Odd, zh: 怪 }
summary: { en: s, zh: s }
entry: absent
preload: [missing]
routes:
  - { id: a, name: { en: A, zh: A }, summary: { en: A, zh: A } }
  - { id: a, name: { en: A, zh: A }, summary: { en: A, zh: A } }
defaultRoute: z
phases:
  - { id: p, label: { en: P, zh: P }, routes: [nowhere], checks: [ghost] }
  - { id: q, label: { en: Q, zh: Q } }
  - { id: q, label: { en: Q, zh: Q } }
gates:
  - { id: cite, script: gates/cite.py }
  - { id: g, script: gates/g.py }
  - { id: g, script: gates/g.py }
scripts:
  - { id: s, script: s.py }
  - { id: s, script: s.py }
`)
    await expect(loadPack(root)).rejects.toThrow([
      'duplicate route a', 'duplicate gate g', 'duplicate script s', 'defaultRoute must name one of the routes',
      'gate cite shadows a base check', 'skill absent is not in skills/', 'skill missing is not in skills/',
      'p names unknown route nowhere', 'phase p names unknown check ghost', 'duplicate phase on route a q',
    ].join('; '))
    await write(join(root, 'mode.yml'), `${GENERAL.replace('id: general', 'id: lone')}defaultRoute: x\n`)
    await expect(loadPack(root)).rejects.toThrow('defaultRoute needs routes')
    await write(join(root, 'mode.yml'), `${GENERAL}surprise: true\n`)
    await expect(loadPack(root)).rejects.toThrow(/surprise/)
  })

  it('reads skill frontmatter and body', () => {
    expect(parseSkillFile('---\r\nname: a-b\r\ndescription: Does a thing.\r\nextra: ignored\r\n---\r\nBody')).toEqual({
      frontmatter: { name: 'a-b', description: 'Does a thing.' }, body: 'Body',
    })
    expect(() => parseSkillFile('---\nname: Bad Name\ndescription: x\n---\n')).toThrow(/lowercase words/)
  })
})

describe('mode phases and gates in the check report', () => {
  async function project(route: string): Promise<{ registry: ModeRegistry; p: ResearchProject }> {
    const registry = await ModeRegistry.load([await packs()], quiet)
    const root = await temp()
    await write(join(root, 'paper', 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\section{A}\n\\section{B}\n\\cite{k}\n\\bibliography{refs}\n\\end{document}\n')
    await write(join(root, 'paper', 'refs.bib'), '@article{k, author={A}, title={T}, year={2020}, journal={J}}\n@misc{m, author={B}, title={U}, year={2021}, url={u}}')
    return { registry, p: newProject({ root, title: 'Demo', brief: '', mode: 'demo', route }, 'w' as WorkspaceId) }
  }

  it('evaluates every kind of requirement with default and custom messages', async () => {
    const { registry, p } = await project('long')
    const report = await runChecks(p, 100000, 'all', registry.resolve(p), async () => [])
    const missing = Object.fromEntries(report.phases.map(phase => [phase.id, phase.missing]))
    expect(missing.notes).toEqual(['No file matching notes/*.md', 'Write the story'])
    expect(missing.counts).toEqual(['No figures in the paper yet', 'Fewer than 3 bibliography entries (2)'])
    expect(missing.results).toEqual(['No completed, collected experiment run', 'No data evidence: import the measured results', 'No collected results to report', 'No current review'])
    expect(report).toMatchObject({ mode: 'demo', route: 'long', clean: false })
    await write(join(p.root, 'notes', 'a.md'), 'a')
    const one = await runChecks(p, 100000, 'notes', registry.resolve(p), async () => [])
    expect(one.phases[0]?.missing).toEqual(['Fewer than 2 files matching notes/*.md (1)', 'Write the story'])
    await write(join(p.root, 'notes', 'b.md'), 'b')
    await write(join(p.root, 'deep', 'er', 'story.json'), '{}')
    const notes = await runChecks(p, 100000, 'notes', registry.resolve(p), async () => [])
    expect(notes).toMatchObject({ clean: true, findings: [] })
    expect((await runChecks(p, 100000, 'counts', registry.resolve(p), async () => [])).phases[1]?.missing).not.toContain('Fewer than 2 sections')
    // Measured data alone satisfies resultsOrData; a collected run satisfies runsCollected.
    p.evidence.push({ id: 'd' as never, title: 'd', kind: 'file', path: 'd', sha256: 'h', revision: 1, importedAt: '', chunks: [], coverage: 'data', verified: true, stale: false })
    const withData = await runChecks(p, 100000, 'results', registry.resolve(p), async () => [])
    expect(withData.phases.find(phase => phase.id === 'results')?.missing).toEqual(['No completed, collected experiment run', 'No current review'])
    p.experiments.push({ id: 'r' as never, spec: { argv: [] } as never, status: 'completed', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: {}, message: '', snapshotPath: '', collected: true })
    const withRun = await runChecks(p, 100000, 'results', registry.resolve(p), async () => [])
    expect(withRun.phases.find(phase => phase.id === 'results')?.missing).toEqual(['No current review'])
  })

  it('runs the gates a scope calls for and folds their findings into the report', async () => {
    const { registry, p } = await project('long')
    const mode = registry.resolve(p)
    const ran: string[] = []
    const finding = (message: string): CheckFinding => ({ check: 'ignored', severity: 'error', message, file: 'x.tex', line: 2 })
    const gate = async (script: { id: string }): Promise<CheckFinding[]> => {
      ran.push(script.id)
      if (script.id === 'long-only') throw new Error('python exploded')
      return Array.from({ length: 27 }, (_, index) => finding(`issue ${index}`))
    }
    const all = await runChecks(p, 100000, undefined, mode, gate)
    expect(ran).toEqual(['lint', 'long-only'])
    const lint = all.findings.filter(item => item.check === 'lint')
    expect(lint).toHaveLength(26)
    expect(lint[0]).toEqual({ check: 'lint', severity: 'error', message: 'issue 0', file: 'x.tex', line: 2 })
    expect(lint.at(-1)?.message).toBe('…and 2 more findings')
    expect(all.findings.find(item => item.check === 'long-only')?.message).toBe('The gate failed to run: python exploded')
    expect(all.phases.find(phase => phase.id === 'counts')?.missing[0]).toBe('26 error(s) in lint')
    expect(all.phases.find(phase => phase.id === 'all')?.missing[0]).toMatch(/error\(s\) in .*lint.*long-only|error\(s\) in .*long-only.*lint/)

    ran.length = 0
    const counts = await runChecks(p, 100000, 'counts', mode, gate)
    expect(ran).toEqual(['lint'])
    expect(counts.findings.every(item => item.check === 'lint')).toBe(true)
    ran.length = 0
    await runChecks(p, 100000, 'results', mode, gate)
    expect(ran).toEqual([])
    await runChecks(p, 100000, 'all', mode, gate)
    expect(ran).toEqual(['lint', 'long-only'])
    ran.length = 0
    const single = await runChecks(p, 100000, 'long-only', mode, gate)
    expect(ran).toEqual(['long-only'])
    expect(single).toMatchObject({ clean: false, findings: [{ check: 'long-only' }] })
    ran.length = 0
    await runChecks(p, 100000, 'cite', mode, gate)
    expect(ran).toEqual([])
    const unrunnable = await runChecks(p, 100000, 'lint', mode)
    expect(unrunnable.findings).toEqual([{ check: 'lint', severity: 'error', message: 'This gate could not run here' }])
  })
})

describe('glob patterns in phase requirements', () => {
  it('matches names at any depth without a slash, and paths with one', () => {
    const cases: [string, string, boolean][] = [
      ['story.json', 'deep/in/story.json', true],
      ['story.json', 'story.json.bak', false],
      ['{idea,brief}*.md', 'notes/Idea-v2.md', true],
      ['{idea,brief}*.md', 'notes/plan.md', false],
      ['notes/*.md', 'notes/a.md', true],
      ['notes/*.md', 'notes/sub/a.md', false],
      ['**/figures/*.pdf', 'figures/a.pdf', true],
      ['**/figures/*.pdf', 'x/y/figures/a.pdf', true],
      ['paper/**', 'paper/a/b.tex', true],
      ['draft?.tex', 'draft1.tex', true],
      ['draft?.tex', 'draft10.tex', false],
      ['a{b', 'a{b', true],
      ['a+b.(x)', 'a+b.(x)', true],
    ]
    for (const [glob, path, expected] of cases) expect([glob, path, globMatcher(glob)(path)]).toEqual([glob, path, expected])
  })
})
