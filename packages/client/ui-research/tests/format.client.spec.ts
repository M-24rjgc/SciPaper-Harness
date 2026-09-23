// @vitest-environment jsdom

/**
 * The research formatters read against both shipped dictionaries, so every
 * sentence is checked for the placeholders it promises in English and in
 * Chinese. The values that carry real structure — a content digest, a chunk
 * locator, the stored path of a source — come from the service's own import
 * rather than from a hand-written record.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { importEvidence } from '@deepseek-ai/dsh-research-workbench/src/artifacts.ts'
import type { EvidenceRecord, ResearchProject, SourceLocator } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { dateText, digestText, durationText, locatorText, momentText, researchFileUrl } from '../src/client/format.ts'
import type { Translate } from '../src/client/format.ts'
import { en, zh } from '../src/client/locales.ts'
import type { ResearchKey } from '../src/client/locales.ts'

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
  const project = newProject({ root, title: 'Sparse attention scaling study', mode: 'from-results', brief: '块稀疏能否在 1/4 FLOPs 下保住长上下文准确率' }, 'workspace' as WorkspaceId)
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
