// @vitest-environment jsdom

/**
 * The research formatters read against both shipped dictionaries, so every
 * sentence is checked for the placeholders it promises in English and in
 * Chinese. The values that carry real structure — a content digest, a chunk
 * locator, the stored path of a source — come from the service's own import
 * rather than from a hand-written record.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { importEvidence } from '@deepseek-ai/dsh-research-workbench/src/artifacts.ts'
import { newExperiment } from '@deepseek-ai/dsh-research-workbench/src/experiments.ts'
import type {
  EnvironmentId, EnvironmentRecord, EvidenceRecord, ExperimentRecord, ResearchProject, SourceLocator,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  appendedDraft, checkedText, dateText, digestText, durationText, elapsedOf, galleryImageUrl, locatorText, modeName,
  modePhases, momentText, packText, projectFileAddress, researchFileUrl, standingText,
} from '../src/client/format.ts'
import type { Translate } from '../src/client/format.ts'
import { en, zh } from '../src/client/locales.ts'
import type { ResearchKey } from '../src/client/locales.ts'
import { MODES } from './fixtures/modes.ts'
import { standingOf } from './fixtures/standing.ts'

const LIMIT = 100_000
/** Any origin: `researchFileUrl` returns a site-relative address. */
const ORIGIN = 'https://workbench.invalid'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** The framework's own lookup-and-interpolate (dsh-client-locale), bound to one dictionary. */
function bind(dict: Record<ResearchKey, string>): Translate {
  return (key, params) => {
    const template = dict[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
  }
}

const tEn = bind(en)
const tZh = bind(zh)

/** One source imported by the service's own extraction, with the project holding it. */
async function importedSource(): Promise<{ project: ResearchProject; evidence: EvidenceRecord }> {
  const root = await mkdtemp(join(tmpdir(), 'research-format-'))
  roots.push(root)
  const project = newProject({ root, title: 'Sparse attention scaling study', mode: 'spark-to-paper', route: 'data', brief: '块稀疏能否在 1/4 FLOPs 下保住长上下文准确率' }, 'workspace' as WorkspaceId)
  await mkdir(join(root, 'inbox'), { recursive: true })
  const source = join(root, 'inbox', 'notes.md')
  await writeFile(source, '# 实验记录\n\n块稀疏在 1/4 FLOPs 下的长上下文准确率。\n', 'utf8')
  // Markdown is chunked by line count and never reaches the Python extractor,
  // so this import runs without a component manager.
  const components = undefined as unknown as Parameters<typeof importEvidence>[2]
  const evidence = await importEvidence(project, source, components, new AbortController().signal, LIMIT)
  return { project, evidence }
}

describe('elapsed time reads in the two largest units that still carry information', () => {
  it('names hours and the minutes past the hour once an hour has passed', () => {
    const ms = (60 + 5) * 60_000 + 30_000
    expect(durationText(ms, tEn)).toBe('1 h 5 min')
    expect(durationText(ms, tZh)).toBe('1 小时 5 分')
  })

  it('drops the hour and names minutes and seconds below it', () => {
    expect(durationText(125_000, tEn)).toBe('2 min 5 s')
    expect(durationText(125_000, tZh)).toBe('2 分 5 秒')
  })

  it('names seconds alone under a minute', () => {
    expect(durationText(45_400, tEn)).toBe('45 s')
    expect(durationText(45_400, tZh)).toBe('45 秒')
  })

  it('reads an unstarted or backwards run as no elapsed time', () => {
    expect(durationText(0, tEn)).toBe('0 s')
    expect(durationText(-9_000, tEn)).toBe('0 s')
    expect(durationText(-9_000, tZh)).toBe('0 秒')
  })
})

describe('a locator states as much of the position as the source recorded', () => {
  it('joins every stated part in both locales', () => {
    const locator: SourceLocator = { page: 3, paragraph: 2, line: 7, key: 'vaswani2017' }
    expect(locatorText(locator, tEn)).toBe('p. 3 para. 2 line 7 vaswani2017')
    expect(locatorText(locator, tZh)).toBe('第 3 页 第 2 段 第 7 行 vaswani2017')
  })

  it('says nothing for a locator that states nothing', () => {
    expect(locatorText({}, tEn)).toBe('')
    expect(locatorText({}, tZh)).toBe('')
  })

  it('names only the line for the chunk the extraction produced', async () => {
    const { evidence } = await importedSource()
    const locator = evidence.chunks[0]!.locator
    expect(locator).toEqual({ line: 1 })
    expect(locatorText(locator, tEn)).toBe('line 1')
    expect(locatorText(locator, tZh)).toBe('第 1 行')
  })
})

describe('a recorded moment reads on the reader\'s own calendar and clock', () => {
  // Built from local fields so the expected month, day and clock hold in any time zone.
  const morning = new Date(2026, 2, 9, 9, 7).toISOString()
  const afternoon = new Date(2026, 10, 24, 14, 30).toISOString()

  it('gives the calendar date without a clock', () => {
    expect(dateText(morning, tEn)).toBe('3/9')
    expect(dateText(morning, tZh)).toBe('3 月 9 日')
    expect(dateText(afternoon, tEn)).toBe('11/24')
    expect(dateText(afternoon, tZh)).toBe('11 月 24 日')
  })

  it('pads the clock to two digits on both sides of the colon', () => {
    expect(momentText(morning, tEn)).toBe('3/9 09:07')
    expect(momentText(morning, tZh)).toBe('3 月 9 日 09:07')
    expect(momentText(afternoon, tEn)).toBe('11/24 14:30')
    expect(momentText(afternoon, tZh)).toBe('11 月 24 日 14:30')
  })

  it('hands back a timestamp it cannot parse, rather than a broken date', () => {
    expect(dateText('sometime last Tuesday', tEn)).toBe('sometime last Tuesday')
    expect(dateText('', tZh)).toBe('')
    expect(momentText('sometime last Tuesday', tEn)).toBe('sometime last Tuesday')
    expect(momentText('2026-13-42T99:99', tZh)).toBe('2026-13-42T99:99')
  })

  it('reads the import stamp the service wrote', async () => {
    const { evidence } = await importedSource()
    expect(momentText(evidence.importedAt, tZh)).toMatch(/^\d{1,2} 月 \d{1,2} 日 \d{2}:\d{2}$/)
    expect(momentText(evidence.importedAt, tEn)).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/)
    expect(momentText(evidence.importedAt, tEn)).toContain(dateText(evidence.importedAt, tEn))
  })
})

describe('a digest stays comparable by eye on one line', () => {
  it('returns a digest already that short unchanged', () => {
    expect(digestText('abc123')).toBe('abc123')
    expect(digestText('0123456789')).toBe('0123456789')
  })

  it('elides the middle of the real digest the import recorded', async () => {
    const { evidence } = await importedSource()
    expect(evidence.sha256).toHaveLength(64)
    const short = digestText(evidence.sha256)
    expect(short).toMatch(/^[0-9a-f]{6}…[0-9a-f]{4}$/)
    expect(evidence.sha256.startsWith(short.slice(0, 6))).toBe(true)
    expect(evidence.sha256.endsWith(short.slice(-4))).toBe(true)
    expect(digestText('01234567890')).toBe('012345…7890')
  })
})

describe('the research file route reaches the stored snapshot', () => {
  it('addresses the immutable copy the import produced, with no page', async () => {
    const { project, evidence } = await importedSource()
    expect(evidence.path.startsWith('.research/sources/')).toBe(true)
    const address = researchFileUrl(project.id, evidence.path)
    const url = new URL(address, ORIGIN)
    expect(url.pathname).toBe('/api/research/file')
    expect(url.searchParams.get('projectId')).toBe(project.id)
    expect(url.searchParams.get('path')).toBe(evidence.path)
    expect(url.hash).toBe('')
    // The separators inside the path stay inside the parameter.
    expect(address).toContain('%2F')
  })

  it('carries the page a locator stated into the PDF viewer', async () => {
    const { project, evidence } = await importedSource()
    const url = new URL(researchFileUrl(project.id, evidence.path, 4), ORIGIN)
    expect(url.searchParams.get('path')).toBe(evidence.path)
    expect(url.hash).toBe('#page=4')
  })

  it('percent-encodes a path the reader could never type into a query', () => {
    const path = 'paper/第一章 综述.md'
    const address = researchFileUrl('proj 1/2', path)
    expect(address).not.toContain(' ')
    expect(address).toContain('%20')
    const url = new URL(address, ORIGIN)
    expect(url.searchParams.get('projectId')).toBe('proj 1/2')
    expect(url.searchParams.get('path')).toBe(path)
  })
})

describe('other addresses the research surfaces open', () => {
  it('reach a project file in the native sidebar through the conversation on screen, from a drive, POSIX or UNC root', () => {
    expect(projectFileAddress('s 1', 'C:\\Research\\p\\', '.\\paper\\main.pdf')).toBe('dsh-resource://file/session/s%201/C:/Research/p/paper/main.pdf')
    expect(projectFileAddress('s1', '/home/me/p//', './figures/a b#1.png')).toBe('dsh-resource://file/session/s1//home/me/p/figures/a%20b%231.png')
    expect(projectFileAddress('s1', '\\\\server\\share\\p', 'x.pdf')).toBe('dsh-resource://file/session/s1///server/share/p/x.pdf')
  })

  it('reach one gallery figure through the host route, whatever its id holds', () => {
    const url = new URL(galleryImageUrl('neurips2024-19&size=full'), ORIGIN)
    expect(url.pathname).toBe('/api/research/gallery/image')
    expect(url.searchParams.get('id')).toBe('neurips2024-19&size=full')
    expect([...url.searchParams.keys()]).toEqual(['id'])
  })
})

describe('a run is timed by the supervisor\'s own clock', () => {
  const NOW = Date.parse('2026-09-25T12:00:00.000Z')
  const at = (secondsBeforeNow: number): string => new Date(NOW - secondsBeforeNow * 1000).toISOString()
  const environment: EnvironmentRecord = {
    id: 'env-local' as EnvironmentId, name: 'local', kind: 'uv', target: 'local', python: 'python', requirements: [],
    fingerprint: 'f', status: 'ready', details: '', isDefault: true,
  }
  /** A run as the service records it on submission: queued, not yet started. */
  function submitted(): ExperimentRecord {
    const project = newProject({ root: join(tmpdir(), 'research-runs'), title: 'Runs', brief: '' }, 'workspace' as WorkspaceId)
    project.environments.push(environment)
    return newExperiment(project, {
      environmentId: environment.id, name: 'baseline', argv: ['{python}', 'code/train.py'], cwd: '.', seed: 1, maxSeconds: 600,
      gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json',
    }, 'run-1')
  }
  afterEach(() => { vi.useRealTimers() })

  it('has no elapsed time before the supervisor starts it, or when its start stamp does not parse', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const run = submitted()
    expect(run.status).toBe('queued')
    expect(elapsedOf(run)).toBeUndefined()
    expect(elapsedOf({ ...run, status: 'running', startedAt: 'not a time' })).toBeUndefined()
  })

  it('measures a run still occupying the supervisor to now, and keeps counting', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const running = { ...submitted(), status: 'running' as const, startedAt: at(90), updatedAt: at(30) }
    expect(elapsedOf(running)).toBe(90_000)
    expect(elapsedOf({ ...running, status: 'unknown' })).toBe(90_000)
    vi.setSystemTime(NOW + 10_000)
    expect(elapsedOf(running)).toBe(100_000)
  })

  it('stops a finished run at the moment it reported finishing', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const done = { ...submitted(), status: 'completed' as const, startedAt: at(600), finishedAt: at(60), updatedAt: at(5) }
    expect(elapsedOf(done)).toBe(540_000)
    vi.setSystemTime(NOW + 3_600_000)
    expect(elapsedOf(done)).toBe(540_000)
  })

  it('stops an interrupted run the supervisor never stamped at the observation that found it stopped', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const interrupted = { ...submitted(), status: 'interrupted' as const, startedAt: at(300), updatedAt: at(120) }
    expect(elapsedOf(interrupted)).toBe(180_000)
    // A finishing stamp that does not parse is no better than none.
    expect(elapsedOf({ ...interrupted, finishedAt: 'garbled' })).toBe(180_000)
    // With no readable observation either, the run is measured to now.
    expect(elapsedOf({ ...interrupted, updatedAt: '' })).toBe(300_000)
  })

  it('never reads a negative time when the stamps disagree', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    expect(elapsedOf({ ...submitted(), status: 'failed', startedAt: at(10), finishedAt: at(20) })).toBe(0)
  })
})

describe('modes, routes and phases read in the interface language', () => {
  it('names a pack by its own text in each language, and a pack no longer installed by its id', () => {
    expect([packText({ en: 'Plan', zh: '规划' }, tEn), packText({ en: 'Plan', zh: '规划' }, tZh)]).toEqual(['Plan', '规划'])
    expect([modeName(MODES, 'general', tEn), modeName(MODES, 'general', tZh), modeName(MODES, 'retired', tZh)]).toEqual(['General', '通用', 'retired'])
  })

  it('lists the phases on the project route, the pack default route when none is recorded, and none without a pack', () => {
    expect(modePhases(MODES, { mode: 'general' })).toEqual([])
    expect(modePhases(MODES, { mode: 'retired', route: 'data' })).toEqual([])
    expect(modePhases(MODES, { mode: 'spark-to-paper' })).toEqual(['plan', 'cite', 'experiments'])
    expect(modePhases(MODES, { mode: 'spark-to-paper', route: 'data' })).toEqual(['data', 'plan', 'cite'])
    // A pack without a default route keeps only the phases every route has.
    expect(modePhases([{ ...MODES[1]!, defaultRoute: undefined }], { mode: 'spark-to-paper' })).toEqual(['plan', 'cite'])
  })

})

describe('where a project stands reads from the standing the host derived', () => {
  const project = (standing?: ResearchProject['standing']): ResearchProject => ({
    ...newProject({ root: '/research/sparse', title: 'Sparse', brief: '', mode: 'spark-to-paper', route: 'proposal' }, 'workspace' as WorkspaceId),
    ...(standing ? { standing } : {}),
  })

  it('names only the mode without a standing, or in a mode without phases', () => {
    expect(standingText(project(), MODES, tZh)).toBe('spark-to-paper')
    expect(standingText(project(standingOf([])), MODES, tZh)).toBe('spark-to-paper')
    expect(standingText({ ...project(standingOf([])), mode: 'general', route: undefined }, MODES, tEn)).toBe('General')
  })

  it('names the current phase and how many are done', () => {
    const standing = standingOf([['plan', 'done'], ['cite', 'current'], ['experiments', 'pending']])
    expect(standingText(project(standing), MODES, tZh)).toBe('spark-to-paper · 引用 1/3')
    expect(standingText(project(standing), MODES, tEn)).toBe('spark-to-paper · Citations 1/3')
  })

  it('says a finished paper is finished', () => {
    const standing = standingOf([['plan', 'done'], ['cite', 'done']], { finished: true })
    expect(standingText(project(standing), MODES, tZh)).toBe('spark-to-paper · 已完成 ✓')
    expect(standingText(project(standing), MODES, tEn)).toBe('spark-to-paper · Finished ✓')
  })

  it('says a phase is deferred once nothing before it still waits', () => {
    const late = standingOf([['plan', 'done'], ['experiments', 'deferred'], ['submission', 'current']])
    expect(standingText(project(late), MODES, tZh)).toBe('spark-to-paper · 实验已推迟')
    expect(standingText(project(late), MODES, tEn)).toBe('spark-to-paper · Experiments deferred')
    expect(standingText(project(standingOf([['plan', 'done'], ['experiments', 'deferred']])), MODES, tZh)).toBe('spark-to-paper · 实验已推迟')
    // Work still to do before the deferred phase comes first.
    const early = standingOf([['plan', 'current'], ['experiments', 'deferred']])
    expect(standingText(project(early), MODES, tZh)).toBe('spark-to-paper · 规划 0/2')
  })

  it('asks for another check once every phase is done but the paper is not finished', () => {
    const standing = standingOf([['plan', 'done'], ['cite', 'done']], { changedSinceCheck: true })
    expect(standingText(project(standing), MODES, tZh)).toBe('spark-to-paper · 待复查')
    expect(standingText(project(standing), MODES, tEn)).toBe('spark-to-paper · Check again')
  })
})

describe('when the last check ran, as the reader counts it', () => {
  const NOW = Date.parse('2026-09-25T12:00:00.000Z')
  const ago = (ms: number): string => new Date(NOW - ms).toISOString()

  it('reads just now, then minutes, then hours, then the date and time', () => {
    expect([checkedText(ago(30_000), NOW, tZh), checkedText(ago(30_000), NOW, tEn)]).toEqual(['刚刚检查过', 'Checked just now'])
    // A check stamped a little ahead of this clock is still just now.
    expect(checkedText(ago(-5_000), NOW, tEn)).toBe('Checked just now')
    expect([checkedText(ago(5 * 60_000), NOW, tZh), checkedText(ago(59 * 60_000), NOW, tEn)]).toEqual(['检查于 5 分钟前', 'Checked 59 min ago'])
    expect([checkedText(ago(3 * 3_600_000), NOW, tZh), checkedText(ago(23 * 3_600_000 + 59 * 60_000), NOW, tEn)]).toEqual(['检查于 3 小时前', 'Checked 23 h ago'])
    const older = ago(2 * 86_400_000)
    expect(checkedText(older, NOW, tZh)).toBe(`检查于 ${momentText(older, tZh)}`)
    expect(checkedText(older, NOW, tEn)).toBe(`Checked ${momentText(older, tEn)}`)
    expect(checkedText('not a time', NOW, tEn)).toBe('Checked not a time')
  })
})

describe('a suggested sentence joins the composer draft without replacing it', () => {
  const sentence = tZh('runPlotDraft', { name: 'baseline', seed: 1 })

  it('fills an empty draft, or one holding only whitespace, with the sentence alone', () => {
    expect(sentence).toBe('用 baseline（种子 1）的结果画一张图，放进论文。')
    expect(appendedDraft('', sentence)).toBe(sentence)
    expect(appendedDraft('  \n\t', sentence)).toBe(sentence)
  })

  it('puts the sentence on its own line after what was typed, keeping the typed words as they are', () => {
    expect(appendedDraft('  先对比两种稀疏模式。', sentence)).toBe(`  先对比两种稀疏模式。\n${sentence}`)
    expect(appendedDraft('先对比两种稀疏模式。\n\n  ', sentence)).toBe(`先对比两种稀疏模式。\n${sentence}`)
    const english = tEn('runPlotDraft', { name: 'ablation', seed: 7 })
    expect(appendedDraft(appendedDraft('Compare both patterns.', sentence), english)).toBe(`Compare both patterns.\n${sentence}\n${english}`)
  })
})
