// @vitest-environment jsdom

/**
 * The research tool calls in the conversation. Every call reads as one row in
 * the reader's language, the raw call behind its disclosure, and a failure in
 * place; a research check reads as a card that says whether it passed and what
 * it found, opens the files it names in the right sidebar, and keeps the
 * check's own words behind 详细信息. The calls and results are the ones the
 * research host writes; the record only names things and gives the folder.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, type RenderResult } from '@testing-library/react'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { CheckReport, ResearchProject, ResearchSnapshot } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchCheckCard, ResearchToolCard, type ResearchToolProps } from '../src/client/ResearchToolView.tsx'
import type { ResearchView } from '../src/client/contract.ts'
import { en, zh } from '../src/client/locales.ts'
import { MODES } from './fixtures/modes.ts'
import { standingOf } from './fixtures/standing.ts'

afterEach(() => { cleanup() })

const SESSION = 'session-summary'
const ROOT = 'C:\\research\\summary'

/** A dictionary lookup that interpolates `{name}` the way the locale seat does. */
function lookup(dictionary: Record<string, string>): ResearchToolProps['t'] {
  return (key: string, params?: Record<string, unknown>) => {
    const template = dictionary[key] ?? key
    return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
  }
}

/** The long-summary study in spark-to-paper from measured results; its standing names the checks its last check found. */
function study(): ResearchProject {
  const record = newProject({ root: ROOT, title: '长文摘要一致性评测', brief: '', mode: 'spark-to-paper', route: 'data' }, 'workspace' as WorkspaceId)
  record.standing = standingOf([['data', 'done'], ['plan', 'done'], ['cite', 'current']], {
    issues: [
      { check: 'cite', label: { en: 'Citations', zh: '引用' }, errors: 2, warnings: 0, findings: [] },
      { check: 'placeholders', label: { en: 'Placeholders', zh: '占位内容' }, errors: 2, warnings: 0, findings: [] },
      { check: 'review-report', label: { en: 'Review report', zh: '评审报告' }, errors: 1, warnings: 0, findings: [] },
    ],
  })
  return record
}

const SNAPSHOT: ResearchSnapshot = { projects: [study()], preferences: {}, components: [], modes: MODES }

let seq = 0
function settled(name: string, args: unknown, content: ToolResultNode['content'], over: Partial<ToolResultNode> = {}): ToolResultNode {
  seq++
  return {
    kind: 'tool-result', seq, time: 2_000, callId: `call-${seq}`, call: { name, argsRaw: JSON.stringify(args) }, callTime: 1_000,
    content, isError: false, subCalls: [], ...over,
  }
}
/** A call the tool answered with its JSON value, the way every research tool renders its result. */
function answered(name: string, args: unknown, value: unknown): ToolResultNode {
  return settled(name, args, [{ type: 'text', text: JSON.stringify(value) }])
}
/** A call whose execute threw, as the tool registry records it. */
function failed(name: string, args: unknown, message: string): ToolResultNode {
  return settled(name, args, [{ type: 'text', text: `Error: ${message}` }], { isError: true, error: { name: 'ToolError', code: 'execution_failed' } })
}
function stopped(name: string, args: unknown): ToolResultNode {
  return settled(name, args, [], { isError: true, error: { name: 'ToolError', code: 'interrupted' } })
}
function running(name: string, argsRaw: string): StartedToolCall {
  return { phase: 'start', callId: 'call-running', name, argsRaw, turn: 1, step: 1, time: 1_000, subCalls: [] }
}
function report(over: Partial<CheckReport>): CheckReport {
  return { clean: true, scope: 'all', mode: 'spark-to-paper', route: 'data', gatesRun: [], phases: [], findings: [], checkedAt: '2026-09-26T08:00:00.000Z', ...over }
}

interface Seat {
  /** The record the card reads; `null` before the first snapshot arrives. */
  snapshot?: ResearchSnapshot | null
  /** The conversation's working directory, as the tool layer passes it. */
  cwd?: string
  /** Opening a file throws, as it does while no conversation sidebar is mounted. */
  openFails?: boolean
  dictionary?: Record<string, string>
}

function props(block: ResearchToolProps['block'], seat: Seat = {}): { props: ResearchToolProps; opened: [string, string][] } {
  const opened: [string, string][] = []
  const view: ResearchView = { snapshot: seat.snapshot === undefined ? SNAPSHOT : seat.snapshot, tasks: [] }
  const toolName = 'kind' in block ? block.call?.name ?? 'research_check' : block.name
  return {
    opened,
    props: {
      callId: block.callId, toolName, block, cwd: seat.cwd, sessionId: SESSION,
      openFile: () => {}, loadImage: () => Promise.resolve(''),
      t: lookup(seat.dictionary ?? zh),
      useToolCallArgumentsPartial: () => '',
      useResearch: (select: (value: ResearchView) => unknown) => select(view),
      openProjectFile: (root: string, path: string) => {
        opened.push([root, path])
        if (seat.openFails === true) throw new Error('No conversation sidebar is mounted to show it')
      },
    } as unknown as ResearchToolProps,
  }
}

/** The study's conversation is bound to it, so the record knows which research a card is in. */
SNAPSHOT.projects[0]!.sessionId = SESSION

/** The visible text of a row, one part per element, the way a reader meets them. */
function parts(element: Element | null): string[] {
  return [...element?.querySelectorAll('span') ?? []].map(span => span.textContent ?? '').filter(text => text !== '')
}

const settle = async (): Promise<void> => { await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }) }

describe('a research tool call', () => {
  it('updates a preparing call from the call-local argument hook', () => {
    const block = { phase: 'preparing' as const, callId: 'preparing', name: 'research_evidence', turn: 1, step: 1, time: 1000, subCalls: [] }
    let partial = '{"action":"import","paths":["data/'
    const face = { ...props(block).props, useToolCallArgumentsPartial: () => partial }
    const view = render(<ResearchToolCard {...face} />)
    const row = view.getByRole('button')
    fireEvent.click(row)
    expect(view.container.textContent).toContain(partial)
    partial = '{"action":"import","paths":["data/notes.md"]}'
    view.rerender(<ResearchToolCard {...face} />)
    expect(view.container.textContent).toContain('导入 1 个文件')
  })

  it('reads as the tool\'s name and what the call did, with the raw call behind the row', () => {
    const block = answered('research_evidence', { action: 'import', paths: ['data/results/consistency.csv', 'data/results/by_length.csv', 'data/notes.md'] },
      { message: 'Sources imported with immutable snapshots' })
    const view = render(<ResearchToolCard {...props(block).props} />)
    const row = view.getByRole('button')
    expect(parts(row)).toEqual(['研究资料', '导入 3 个文件'])
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(view.container.textContent).not.toContain('immutable snapshots')

    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(zh.toolArguments)).toBeTruthy()
    expect(view.getByText(zh.toolResult)).toBeTruthy()
    const [args, result] = [...view.container.querySelectorAll('pre')].map(pre => pre.textContent)
    expect(args).toContain('"data/notes.md"')
    expect(result).toBe('{\n  "message": "Sources imported with immutable snapshots"\n}')
    fireEvent.click(row)
    expect(view.container.querySelector('pre')).toBeNull()
  })

  it('names a mode and its route as the installed pack does, and in English for an English reader', () => {
    const block = answered('research_project', { action: 'set-mode', mode: 'spark-to-paper', route: 'data', reason: '评测已经做完' },
      { message: 'Mode spark-to-paper (data): data → plan → cite → write → refine → review → figures → latex → submission' })
    const chinese = render(<ResearchToolCard {...props(block).props} />)
    expect(parts(chinese.getByRole('button'))).toEqual(['研究记录', '设定模式：spark-to-paper · 从实测结果开始'])
    cleanup()
    const english = render(<ResearchToolCard {...props(block, { dictionary: en }).props} />)
    expect(parts(english.getByRole('button'))).toEqual(['Research record', 'Set the mode: spark-to-paper · From measured results'])
    cleanup()
    // Before the record arrives, the mode and route go by their ids.
    const early = render(<ResearchToolCard {...props(block, { snapshot: null }).props} />)
    expect(parts(early.getByRole('button'))).toEqual(['研究记录', '设定模式：spark-to-paper · data'])
  })

  it('shows a failure in place, in the host\'s words', () => {
    const block = failed('research_artifact', { action: 'save-artifact', path: 'paper/main.tex', kind: 'manuscript', content: '' }, 'This is an example research and is read-only')
    const view = render(<ResearchToolCard {...props(block).props} />)
    expect(parts(view.getByRole('button'))).toEqual(['研究文件', '保存：paper/main.tex'])
    expect(view.getByRole('status').textContent).toBe('没能完成：This is an example research and is read-only')
    expect(view.container.querySelector('[data-state="error"]')).not.toBeNull()
  })

  it('says a stopped call stopped, and a running one is in progress, before its arguments are whole', () => {
    const halted = render(<ResearchToolCard {...props(stopped('research_experiment', { action: 'experiment-wait', runIds: ['r-1', 'r-2'], timeoutSeconds: 1800 })).props} />)
    expect(parts(halted.container.querySelector('[data-disclosure-row]'))).toEqual(['实验运行', '等待 2 个运行结束', '已中止'])
    // Nothing came back, but the arguments still open.
    expect(halted.getByRole('button')).toBeTruthy()
    cleanup()

    const moving = render(<ResearchToolCard {...props(running('research_evidence', '{"action":"literature-imp')).props} />)
    const row = moving.container.querySelector('[data-disclosure-row]')!
    expect(parts(row)).toEqual(['研究资料', '进行中'])
    expect(moving.container.querySelector('[data-state="running"]')).not.toBeNull()
    fireEvent.click(row)
    expect(moving.container.querySelector('pre')?.textContent).toBe('{"action":"literature-imp')
    cleanup()

    // A call that has not written a byte yet has nothing to open.
    const blank = render(<ResearchToolCard {...props(running('research_board', '')).props} />)
    expect(blank.queryByRole('button')).toBeNull()
    expect(parts(blank.container)).toEqual(['实验看板', '进行中'])
  })

  it('says an action this build does not know by its id, and a research tool it does not know by its wire name', () => {
    const unknown = render(<ResearchToolCard {...props(answered('research_evidence', { action: 'deduplicate' }, { message: 'Nothing to merge' })).props} />)
    expect(parts(unknown.getByRole('button'))).toEqual(['研究资料', '执行 deduplicate'])
    cleanup()
    const stranger = render(<ResearchToolCard {...props(answered('research_sources', { action: 'import' }, { message: 'ok' })).props} />)
    expect(parts(stranger.getByRole('button'))).toEqual(['research_sources'])
    cleanup()
    // A result whose call fell outside the loaded window shows the result alone.
    const orphan = { ...answered('research_task', {}, { id: 'job-1', status: 'completed' }), call: null }
    const lone = render(<ResearchToolCard {...props(orphan).props} toolName="research_task" />)
    expect(parts(lone.getByRole('button'))).toEqual(['后台操作'])
    fireEvent.click(lone.getByRole('button'))
    expect([...lone.container.querySelectorAll('pre')].map(pre => pre.textContent)).toEqual(['{\n  "id": "job-1",\n  "status": "completed"\n}'])
  })
})

describe('a research check', () => {
  it('reads as passed with the verified mark when clean, naming its scope by the phase', () => {
    const block = answered('research_check', { scope: 'cite' }, { message: 'Clean', check: report({ scope: 'cite', phases: [{ id: 'cite', done: true, missing: [], unmet: [] }] }) })
    const view = render(<ResearchCheckCard {...props(block).props} />)
    const card = view.container.querySelector('[data-tool="research_check"]')!
    expect(card.getAttribute('data-clean')).toBe('true')
    expect(parts(card)).toEqual(['研究检查', '引用', '通过'])
    // The verified ✓ stands in the leading place, and nothing was found to list or explain.
    expect(card.querySelector('svg')).not.toBeNull()
    expect(view.queryByText(zh.issueDetails)).toBeNull()
    expect(view.queryByRole('list')).toBeNull()
  })

  it('reads as not passed with its errors, lists the groups it found with their files, and keeps the check\'s words behind Details', async () => {
    const check = report({
      clean: false, scope: 'cite',
      phases: [{ id: 'cite', done: false, missing: ['2 error(s) in cite'], unmet: ['errors:cite'] }],
      findings: [
        { check: 'cite', severity: 'error', message: 'Citation key laban2022summac is not in the bibliography', file: 'sections/related_work.tex', line: 14 },
        { check: 'cite', severity: 'error', message: 'Bibliography entry fabbri2021qafacteval has no year', file: 'refs.bib' },
      ],
    })
    const { props: seat, opened } = props(answered('research_check', { scope: 'cite' }, { message: 'Not done yet: fix the errors and check again', check }))
    const view = render(<ResearchCheckCard {...seat} />)
    const head = view.container.querySelector('[data-tool="research_check"] > div')!
    expect(parts(head)).toEqual(['研究检查', '引用', '未通过', '2 个错误'])
    expect(view.container.querySelector('[data-tool="research_check"]')!.getAttribute('data-clean')).toBe('false')

    const [group] = view.getAllByRole('listitem')
    expect(group!.textContent).toBe('引用 · 2 个错误sections/related_work.tex:14')
    const file = view.getByRole('button', { name: 'sections/related_work.tex:14' })
    expect(file.getAttribute('title')).toBe('打开 sections/related_work.tex')
    fireEvent.click(file)
    await settle()
    expect(opened).toEqual([[ROOT, 'sections/related_work.tex']])

    const details = view.getByText(zh.issueDetails).closest('details')!
    expect(details.textContent).toContain('Citation key laban2022summac is not in the bibliography sections/related_work.tex:14')
    expect(details.textContent).toContain('Bibliography entry fabbri2021qafacteval has no year refs.bib')
    expect(details.textContent).toContain('引用：2 error(s) in cite')
  })

  it('lists at most three groups, errors first, named by the standing or by their ids', () => {
    const check = report({
      clean: false, mode: 'ccfa', route: 'full-paper', gatesRun: ['review-report', 'submission-checks'],
      phases: [{ id: 'writing', done: false, missing: ['3 error(s) in placeholders'], unmet: ['errors:placeholders'] }],
      findings: [
        { check: 'placeholders', severity: 'error', message: 'Placeholder remains: \\tbd{ablation}', file: 'paper/main.tex', line: 92 },
        { check: 'placeholders', severity: 'error', message: 'Placeholder remains: \\tbd{answer both questions}', file: 'paper/main.tex', line: 98 },
        { check: 'review-report', severity: 'error', message: 'No review report yet: review the paper with ccf-paper-reviewer' },
        { check: 'submission-checks', severity: 'error', message: 'No submission check record yet: run ccf-submission-checker' },
        { check: 'figures', severity: 'warning', message: 'Diagram figures/architecture.drawio is not included in the paper', file: 'figures/architecture.drawio' },
      ],
    })
    const view = render(<ResearchCheckCard {...props(answered('research_check', {}, { message: 'Not done yet: fix the errors and check again', check })).props} />)
    expect(parts(view.container.querySelector('[data-tool="research_check"] > div'))).toEqual(['研究检查', '全部', '未通过', '4 个错误', '1 个提醒'])
    expect(view.getAllByRole('listitem').map(item => item.textContent)).toEqual([
      '占位内容 · 2 个错误paper/main.tex:92',
      '评审报告 · 1 个错误',
      'submission-checks · 1 个错误',
    ])
    // The fourth group waits in the details with every finding, and a phase of a mode that is not installed goes by its id.
    const details = view.getByText(zh.issueDetails).closest('details')!
    expect(details.textContent).toContain('Diagram figures/architecture.drawio is not included in the paper figures/architecture.drawio')
    expect(details.textContent).toContain('writing：3 error(s) in placeholders')
  })

  it('says why a check that found no error did not pass', () => {
    const plan = report({ clean: false, scope: 'plan', phases: [{ id: 'plan', done: false, missing: ['Write the paper plan into blueprint.json'], unmet: ['blueprint'] }] })
    const phase = render(<ResearchCheckCard {...props(answered('research_check', { scope: 'plan' }, { message: 'Not done yet', check: plan })).props} />)
    expect(parts(phase.container.querySelector('[data-tool="research_check"] > div'))).toEqual(['研究检查', '规划', '未通过', '1 项要求未满足'])
    expect(phase.getByText(zh.issueDetails).closest('details')!.textContent).toContain('规划：Write the paper plan into blueprint.json')
    cleanup()

    const whole = report({ clean: false, phases: [
      { id: 'data', done: true, missing: [], unmet: [] },
      { id: 'plan', done: false, missing: ['Not checked yet'], unmet: [] },
      { id: 'cite', done: false, missing: ['Not checked yet'], unmet: [] },
    ], findings: [{ check: 'figures', severity: 'warning', message: 'Figure 2 has no caption', file: 'sections/method.tex', line: 40 }] })
    const paper = render(<ResearchCheckCard {...props(answered('research_check', {}, { message: 'Not done yet', check: whole })).props} />)
    expect(parts(paper.container.querySelector('[data-tool="research_check"] > div'))).toEqual(['研究检查', '全部', '未通过', '1 个提醒', '2 个阶段未完成'])
    cleanup()

    const one = report({ clean: false, phases: [{ id: 'cite', done: false, missing: [], unmet: [] }] })
    const single = render(<ResearchCheckCard {...props(answered('research_check', {}, { message: 'Not done yet', check: one })).props} />)
    expect(parts(single.container.querySelector('[data-tool="research_check"] > div'))).toEqual(['研究检查', '全部', '未通过', '1 个阶段未完成'])
    cleanup()

    const many = report({ clean: false, scope: 'plan', phases: [{ id: 'plan', done: false, missing: ['Write the plan', 'Apply a venue template'], unmet: [] }] })
    const requirements = render(<ResearchCheckCard {...props(answered('research_check', { scope: 'plan' }, { message: 'Not done yet', check: many })).props} />)
    expect(parts(requirements.container.querySelector('[data-tool="research_check"] > div'))).toEqual(['研究检查', '规划', '未通过', '2 项要求未满足'])
  })

  it('passes with its warnings, the green ✓ still meaning nothing blocks', () => {
    const check = report({ findings: [{ check: 'prose', severity: 'warning', message: 'Sentence over 60 words', file: 'sections/method.tex', line: 7 }] })
    const view = render(<ResearchCheckCard {...props(answered('research_check', {}, { message: 'Clean', check })).props} />)
    expect(parts(view.container.querySelector('[data-tool="research_check"] > div'))).toEqual(['研究检查', '全部', '通过', '1 个提醒'])
    expect(view.getAllByRole('listitem').map(item => item.textContent)).toEqual(['prose · 1 个提醒sections/method.tex:7'])
  })

  it('shows a file as text while the card does not know the research folder, and names what it can by id', () => {
    const check = report({ clean: false, scope: 'cite', findings: [{ check: 'cite', severity: 'error', message: 'Citation key smith2020 is not in the bibliography', file: 'refs.bib' }] })
    const view = render(<ResearchCheckCard {...props(answered('research_check', { scope: 'cite' }, { message: 'Not done yet', check }), { snapshot: null }).props} />)
    expect(parts(view.container.querySelector('[data-tool="research_check"] > div'))).toEqual(['研究检查', 'cite', '未通过', '1 个错误'])
    expect(view.getAllByRole('listitem').map(item => item.textContent)).toEqual(['cite · 1 个错误refs.bib'])
    expect(view.queryByRole('button', { name: 'refs.bib' })).toBeNull()
  })

  it('finds its research from the conversation\'s folder when the record has not bound the conversation', async () => {
    const snapshot: ResearchSnapshot = { ...SNAPSHOT, projects: [{ ...study(), sessionId: undefined }] }
    const check = report({ clean: false, scope: 'cite', findings: [{ check: 'cite', severity: 'error', message: 'Citation key smith2020 is not in the bibliography', file: 'refs.bib' }] })
    const { props: seat, opened } = props(answered('research_check', { scope: 'cite' }, { message: 'Not done yet', check }), { snapshot, cwd: ROOT })
    const view = render(<ResearchCheckCard {...seat} />)
    fireEvent.click(view.getByRole('button', { name: 'refs.bib' }))
    await settle()
    expect(opened).toEqual([[ROOT, 'refs.bib']])
  })

  it('says so in place when the file cannot be opened', async () => {
    const check = report({ clean: false, scope: 'cite', findings: [{ check: 'cite', severity: 'error', message: 'Citation key smith2020 is not in the bibliography', file: 'refs.bib' }] })
    const view = render(<ResearchCheckCard {...props(answered('research_check', { scope: 'cite' }, { message: 'Not done yet', check }), { openFails: true }).props} />)
    fireEvent.click(view.getByRole('button', { name: 'refs.bib' }))
    await settle()
    expect(view.getByRole('alert').textContent).toBe('没能完成：No conversation sidebar is mounted to show it')
  })

  it('says it is checking before the report comes back, naming the scope once the call names one', () => {
    const scoped = render(<ResearchCheckCard {...props(running('research_check', '{"scope":"cite"}')).props} />)
    const card = scoped.container.querySelector('[data-tool="research_check"]')!
    expect(card.getAttribute('data-state')).toBe('running')
    expect(card.getAttribute('data-clean')).toBeNull()
    expect(parts(card.firstElementChild)).toEqual(['研究检查', '引用', '正在检查…'])
    cleanup()
    const partial = render(<ResearchCheckCard {...props(running('research_check', '{"sco')).props} />)
    expect(parts(partial.container.querySelector('[data-tool="research_check"] > div'))).toEqual(['研究检查', '正在检查…'])
    cleanup()
    // Before the record arrives the scope goes by its id.
    const early = render(<ResearchCheckCard {...props(running('research_check', '{"scope":"cite"}'), { snapshot: null }).props} />)
    expect(parts(early.container.querySelector('[data-tool="research_check"] > div'))).toEqual(['研究检查', 'cite', '正在检查…'])
  })

  it('names the phases of a report that did not say its mode by the research\'s own mode', () => {
    const older = { clean: true, scope: 'plan', phases: [{ id: 'plan', done: true, missing: [] }], findings: [], checkedAt: '2026-09-25T08:56:10.670Z' }
    const view = render(<ResearchCheckCard {...props(answered('research_check', { scope: 'plan' }, { message: 'Clean', check: older })).props} />)
    expect(parts(view.container.querySelector('[data-tool="research_check"] > div'))).toEqual(['研究检查', '规划', '通过'])
  })

  it('shows the files of a report from before missing files were dropped as text, since they may never have existed', () => {
    const older = {
      clean: false, scope: 'all', mode: 'ccfa', route: 'full-paper', phases: [],
      findings: [{ check: 'submission-checks', severity: 'error', message: 'No submission check record yet: run ccf-submission-checker', file: 'submission/checks.md' }],
      checkedAt: '2026-09-25T08:56:57.092Z',
    }
    const view = render(<ResearchCheckCard {...props(answered('research_check', {}, { message: 'Not done yet', check: older })).props} />)
    expect(view.getAllByRole('listitem').map(item => item.textContent)).toEqual(['submission-checks · 1 个错误submission/checks.md'])
    expect(view.queryByRole('button', { name: 'submission/checks.md' })).toBeNull()
  })

  it('shows a failed check\'s reason in place, and a stopped one as stopped', () => {
    const refused = failed('research_check', {}, 'No research project contains this working directory; create one with research_project action create')
    const view: RenderResult = render(<ResearchCheckCard {...props(refused).props} />)
    expect(parts(view.container.querySelector('[data-tool="research_check"] > div'))).toEqual(['研究检查', '全部'])
    expect(view.getByRole('status').textContent).toBe('没能完成：No research project contains this working directory; create one with research_project action create')
    cleanup()
    const halted = render(<ResearchCheckCard {...props(stopped('research_check', { scope: 'figures' })).props} />)
    expect(parts(halted.container.querySelector('[data-tool="research_check"] > div'))).toEqual(['研究检查', 'figures', '已中止'])
  })

  it('reads a result that is not a report as an ordinary research row', () => {
    const view = render(<ResearchCheckCard {...props(settled('research_check', { scope: 'cite' }, [{ type: 'text', text: 'Clean' }])).props} />)
    expect(view.container.querySelector('[data-tool="research_check"]')?.getAttribute('data-state')).toBe('ok')
    expect(view.container.querySelector('section')).toBeNull()
    expect(parts(view.getByRole('button'))).toEqual(['研究检查', '引用'])
  })
})
