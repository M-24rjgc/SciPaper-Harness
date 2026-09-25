/**
 * What the research tool cards read from a logged call. The calls and results
 * below are the ones the research host writes (`tools.ts`, and the example
 * generator's scripted calls): a result is the tool's JSON value as one text
 * block, a failure the registry's `Error: …` text. The record only names
 * things, so a call reads the same with or without it, less well named.
 */
import { describe, expect, it } from 'vitest'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { registerResearchTools } from '@deepseek-ai/dsh-research-workbench/src/tools.ts'
import type { CheckReport, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  actionPhrase, callArgs, callArgsRaw, callState, checkName, checkView, failureReason, familyName, phaseName, readable,
  RESEARCH_TOOLS, resultText, scopeName, type NameContext,
} from '../src/client/toolCallValues.ts'
import { en, zh } from '../src/client/locales.ts'
import { MODES } from './fixtures/modes.ts'
import { standingOf } from './fixtures/standing.ts'

/** A dictionary lookup that interpolates `{name}` the way the locale seat does. */
function lookup(dictionary: Record<string, string>): NameContext['t'] {
  return (key, params) => {
    const template = dictionary[key] ?? key
    return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
  }
}
const t = lookup(zh)

/** The long-summary study, in spark-to-paper from measured results, with the labels its last check left in the standing. */
function project(): ResearchProject {
  const record = newProject({ root: 'C:\\research\\summary', title: '长文摘要一致性评测', brief: '', mode: 'spark-to-paper', route: 'data' }, 'workspace' as WorkspaceId)
  record.standing = standingOf([['data', 'done'], ['plan', 'done'], ['cite', 'current']], {
    issues: [{ check: 'review-report', label: { en: 'Review report', zh: '评审报告' }, errors: 1, warnings: 0, findings: [] }],
  })
  return record
}

const NAMED: NameContext = { t, modes: MODES, project: project() }
const BARE: NameContext = { t, modes: [], project: undefined }

let seq = 0
function settled(name: string, args: unknown, content: ToolResultNode['content'], over: Partial<ToolResultNode> = {}): ToolResultNode {
  seq++
  return {
    kind: 'tool-result', seq, time: 2_000, callId: `call-${seq}`, call: { name, argsRaw: JSON.stringify(args) }, callTime: 1_000,
    content, isError: false, subCalls: [], ...over,
  }
}
function answered(name: string, args: unknown, value: unknown): ToolResultNode {
  return settled(name, args, [{ type: 'text', text: JSON.stringify(value) }])
}
function running(name: string, argsRaw: string): RunningToolCall {
  return { callId: 'call-running', name, argsRaw, turn: 1, step: 1, time: 1_000, subCalls: [] }
}
function report(over: Partial<CheckReport>): CheckReport {
  return { clean: true, scope: 'all', mode: 'spark-to-paper', route: 'data', gatesRun: [], phases: [], findings: [], checkedAt: '2026-09-25T08:56:57.092Z', ...over }
}

describe('a logged research call', () => {
  it('stands where its result says: running, answered, failed, or stopped', () => {
    expect(callState(running('research_check', '{"scope":"ci'))).toBe('running')
    expect(callState(answered('research_check', {}, { message: 'Clean' }))).toBe('ok')
    expect(callState(settled('research_check', {}, [{ type: 'text', text: 'Error: Research project not found' }], { isError: true, error: { name: 'ToolError', code: 'execution_failed' } }))).toBe('error')
    expect(callState(settled('research_check', {}, [], { isError: true, error: { name: 'ToolError', code: 'interrupted' } }))).toBe('stopped')
  })

  it('reads its arguments only once they are a whole JSON object', () => {
    expect(callArgs(running('research_evidence', '{"action":"import","paths":["data/'))).toBeUndefined()
    expect(callArgs(running('research_evidence', '["import"]'))).toBeUndefined()
    expect(callArgs(running('research_evidence', 'null'))).toBeUndefined()
    expect(callArgs(answered('research_evidence', { action: 'import', paths: ['data/notes.md'] }, { message: 'ok' }))).toEqual({ action: 'import', paths: ['data/notes.md'] })
    // A result whose call fell outside the loaded window has no arguments.
    const orphan = { ...answered('research_evidence', {}, { message: 'ok' }), call: null }
    expect(callArgsRaw(orphan)).toBe('')
    expect(callArgs(orphan)).toBeUndefined()
  })

  it('reads its result as text, a failure without content as its error, and nothing while it runs', () => {
    expect(resultText(running('research_board', '{}'))).toBe('')
    expect(resultText(answered('research_board', { action: 'board-get' }, { message: 'Board: 2 section(s), 1 collector(s)' })))
      .toBe('{"message":"Board: 2 section(s), 1 collector(s)"}')
    expect(resultText(settled('research_media', {}, [{ type: 'text', text: 'first' }, { type: 'reasoning', text: 'second' }])))
      .toBe('first\n{\n  "type": "reasoning",\n  "text": "second"\n}')
    expect(resultText(settled('research_media', {}, [], { isError: true, error: { name: 'ToolError', code: 'sandbox_denied' } }))).toBe('ToolError: sandbox_denied')
    expect(resultText(settled('research_media', {}, []))).toBe('')
  })

  it('lays JSON out for reading and leaves prose as written', () => {
    expect(readable('{"message":"Decision recorded"}')).toBe('{\n  "message": "Decision recorded"\n}')
    expect(readable('Error: The tool session does not belong to this research project')).toBe('Error: The tool session does not belong to this research project')
  })

  it('gives a failure in the host\'s words, without the registry\'s Error prefix', () => {
    const refused = settled('research_artifact', {}, [{ type: 'text', text: 'Error: This is an example research and is read-only' }], { isError: true })
    expect(failureReason(refused)).toBe('This is an example research and is read-only')
    expect(failureReason(settled('research_artifact', {}, [], { isError: true, error: { name: 'ToolError', code: 'denied' } }))).toBe('ToolError: denied')
  })
})

describe('names on a research card', () => {
  it('names each research tool, and keeps the wire name of one this build does not know', () => {
    expect(RESEARCH_TOOLS).toEqual([
      'research_project', 'research_check', 'research_evidence', 'research_artifact', 'research_environment',
      'research_experiment', 'research_board', 'research_media', 'research_knowledge', 'research_task',
    ])
    expect(RESEARCH_TOOLS.map(tool => familyName(tool, t))).toEqual([
      '研究记录', '研究检查', '研究资料', '研究文件', '实验环境', '实验运行', '实验看板', '配图', '知识图谱', '后台操作',
    ])
    expect(familyName('research_sources', t)).toBe('research_sources')
    expect(familyName('research_evidence', lookup(en))).toBe('Sources')
  })

  it('names a scope all, a phase by its pack, a check by the standing, and anything else by its id', () => {
    expect(scopeName('all', 'spark-to-paper', NAMED)).toBe('全部')
    expect(scopeName('cite', 'spark-to-paper', NAMED)).toBe('引用')
    expect(scopeName('cite', 'spark-to-paper', { ...NAMED, t: lookup(en) })).toBe('Citations')
    expect(scopeName('review-report', 'spark-to-paper', NAMED)).toBe('评审报告')
    expect(scopeName('figures', 'spark-to-paper', NAMED)).toBe('figures')
    // Under a mode that is not installed, a phase goes by its id.
    expect(scopeName('cite', 'ccfa', NAMED)).toBe('cite')
    expect(scopeName('cite', 'spark-to-paper', BARE)).toBe('cite')
    expect(checkName('review-report', NAMED)).toBe('评审报告')
    expect(checkName('review-report', BARE)).toBe('review-report')
    expect(checkName('review-report', { ...NAMED, project: { ...project(), standing: undefined } })).toBe('review-report')
    expect(phaseName('plan', 'spark-to-paper', NAMED)).toBe('规划')
    expect(phaseName('plan', undefined, NAMED)).toBe('plan')
  })
})

describe('what one research call did', () => {
  /** Each action with arguments the way the assistant writes them, and what its row says. */
  const CALLS: [string, Record<string, unknown>, string][] = [
    ['research_project', { action: 'current' }, '读取研究现状'],
    ['research_project', { action: 'create', title: '长文摘要一致性评测' }, '建立研究：长文摘要一致性评测'],
    ['research_project', { action: 'create' }, '建立研究'],
    ['research_project', { action: 'list' }, '列出全部研究'],
    ['research_project', { action: 'modes' }, '查看可用模式'],
    ['research_project', { action: 'set-mode', mode: 'spark-to-paper', route: 'data', reason: '评测已经做完' }, '设定模式：spark-to-paper · 从实测结果开始'],
    ['research_project', { action: 'set-mode', mode: 'spark-to-paper' }, '设定模式：spark-to-paper'],
    ['research_project', { action: 'set-mode', mode: 'spark-to-paper', route: 'sprint' }, '设定模式：spark-to-paper · sprint'],
    ['research_project', { action: 'set-mode', mode: 'ccfa', route: 'full-paper' }, '设定模式：ccfa · full-paper'],
    ['research_project', { action: 'set-mode' }, '设定模式'],
    ['research_project', { action: 'set-autonomy', autonomy: 'automatic' }, '设定自主程度：全自动'],
    ['research_project', { action: 'set-autonomy', autonomy: 'checkpoints' }, '设定自主程度：检查点'],
    ['research_project', { action: 'set-autonomy', autonomy: 'sometimes' }, '设定自主程度'],
    ['research_project', { action: 'record-decision', question: '模式与路线\n（第二行不显示）', answer: 'spark-to-paper · data' }, '记录决策：模式与路线'],
    ['research_project', { action: 'rename', title: '长文摘要一致性' }, '重命名研究：长文摘要一致性'],
    ['research_check', { scope: 'cite' }, '引用'],
    ['research_check', {}, '全部'],
    ['research_evidence', { action: 'import', paths: ['data/results/consistency.csv', 'data/results/by_length.csv', 'data/notes.md'] }, '导入 3 个文件'],
    ['research_evidence', { action: 'import', paths: ['results.facts.json'] }, '导入 1 个文件'],
    ['research_evidence', { action: 'import', paths: 'results.facts.json' }, '导入 0 个文件'],
    ['research_evidence', { action: 'refresh-evidence', evidenceId: 'e-1' }, '检查原文件'],
    ['research_evidence', { action: 'search-evidence', query: 'block 固定 聚合 4K' }, '检索资料：block 固定 聚合 4K'],
    ['research_evidence', { action: 'claim', claim: { id: 'dynamic-advantage-fades', text: '动态选块相对固定分块的优势，在 32K 以上会消失。' } }, '登记论点：动态选块相对固定分块的优势，在 32K 以上会消失。'],
    ['research_evidence', { action: 'claim', claim: 'dynamic-advantage-fades' }, '登记论点'],
    ['research_evidence', { action: 'literature-search', provider: 'openalex', query: 'block sparse attention' }, '检索文献：block sparse attention'],
    ['research_evidence', { action: 'literature-import', item: { id: 'https://openalex.org/W3015468748', title: 'Longformer: The Long-Document Transformer' } }, '核实并导入文献：Longformer: The Long-Document Transformer'],
    ['research_artifact', { action: 'save-artifact', path: 'paper/main.tex', kind: 'manuscript', content: '\\documentclass{article}' }, '保存：paper/main.tex'],
    ['research_artifact', { action: 'register-artifact', path: 'figures/accuracy_vs_flops.pdf', kind: 'figure' }, '登记：figures/accuracy_vs_flops.pdf'],
    ['research_artifact', { action: 'read-artifact', artifactId: 'a-1' }, '读取文件'],
    ['research_artifact', { action: 'list-venues', query: 'neurips' }, '查找投稿模板：neurips'],
    ['research_artifact', { action: 'apply-template', venue: 'aaai', stage: 'review' }, '套用会议模板：aaai'],
    ['research_artifact', { action: 'import-template', paths: ['C:\\templates\\acl.sty', 'C:\\templates\\acl.bst'] }, '导入 2 个模板文件'],
    ['research_artifact', { action: 'compile', path: 'paper/main.tex', engine: 'pdflatex' }, '编译 PDF：paper/main.tex'],
    ['research_artifact', { action: 'compile', engine: 'xelatex' }, '编译 PDF'],
    ['research_artifact', { action: 'render-pages', maxPages: 8 }, '渲染页面图'],
    ['research_artifact', { action: 'run-script', script: 'plot-results', args: ['--script', 'code/plot_overall.py'] }, '运行脚本：plot-results'],
    ['research_artifact', { action: 'export' }, '导出投稿包'],
    ['research_environment', { action: 'environment', environment: { name: 'local-uv', kind: 'uv', target: 'local', python: '' } }, '准备实验环境：local-uv'],
    ['research_experiment', { action: 'experiment', requestId: '95be721e', spec: { name: 'ruler-32k-full', seed: 42 } }, '提交实验：ruler-32k-full'],
    ['research_experiment', { action: 'experiment-refresh', runId: 'r-1' }, '刷新运行状态'],
    ['research_experiment', { action: 'experiment-cancel', runId: 'r-1' }, '停止运行'],
    ['research_experiment', { action: 'experiment-dismiss', runId: 'r-1' }, '移除状态待确认的运行'],
    ['research_experiment', { action: 'experiment-logs', runId: 'r-1' }, '查看运行日志'],
    ['research_experiment', { action: 'experiment-wait', runIds: ['r-1', 'r-2', 'r-3', 'r-4'], timeoutSeconds: 120 }, '等待 4 个运行结束'],
    ['research_board', { action: 'board-get' }, '读取看板布局'],
    ['research_board', { action: 'board-update', board: { sections: [] } }, '更新看板布局'],
    ['research_board', { action: 'board-refresh' }, '立即读取看板'],
    ['research_media', { action: 'visual-review', artifactId: 'a-1' }, '视觉检查'],
    ['research_media', { action: 'complete-visual-review', artifactId: 'a-1' }, '记录视觉检查结果'],
    ['research_media', { action: 'generate-image', path: 'figures/overview-draft.png', prompt: 'method overview' }, '生成图片：figures/overview-draft.png'],
    ['research_media', { action: 'find-reference-figures', query: 'retrieval augmented agent memory' }, '检索配图灵感：retrieval augmented agent memory'],
    ['research_media', { action: 'find-reference-figures', pattern: 'pipeline' }, '检索配图灵感'],
    ['research_media', { action: 'fetch-reference-figures', galleryIds: ['neurips2024-19', 'iclr2025-4'], arxivIds: ['2406.01234'], label: 'method-overview' }, '保存 3 张参考图'],
    ['research_media', { action: 'fetch-reference-figures', arxivIds: ['2406.01234'] }, '保存 1 张参考图'],
    ['research_media', { action: 'audit-svg', path: 'figures/architecture.svg' }, '检查 SVG 图：figures/architecture.svg'],
    ['research_media', { action: 'export-figure', path: 'figures/architecture.svg' }, '导出矢量图：figures/architecture.svg'],
    ['research_knowledge', { action: 'graph-status' }, '查看图谱状态'],
    ['research_knowledge', { action: 'recall', query: 'block-sparse attention at long context', topK: 5 }, '召回相近模式：block-sparse attention at long context'],
    ['research_knowledge', { action: 'novelty' }, '新颖性比对'],
    ['research_knowledge', { action: 'build-graph', papers: 'corpus.jsonl', domain: 'hci' }, '用语料构建图谱'],
    ['research_knowledge', { action: 'name-patterns' }, '为模式命名'],
    ['research_task', { jobId: '6f1c' }, '查询后台操作'],
  ]

  it.each(CALLS)('%s %j reads as its own phrase', (tool, args, phrase) => {
    expect(actionPhrase(tool, args, NAMED)).toBe(phrase)
  })

  it('has a card for every research tool the host registers, and a phrase for every action its definitions declare', () => {
    const tools: { name: string; parameters: { properties?: Record<string, { enum?: string[] }> } }[] = []
    const host = { on: () => () => {}, tools: { register: (tool: (typeof tools)[number]) => { tools.push(tool) } } }
    registerResearchTools(host as never, {} as never)
    expect(tools.map(tool => tool.name).sort()).toEqual([...RESEARCH_TOOLS].sort())
    const phrased = new Set(CALLS.map(([tool, args]) => `${tool}:${typeof args.action === 'string' ? args.action : ''}`))
    for (const tool of tools) {
      for (const action of tool.parameters.properties?.action?.enum ?? ['']) {
        expect(phrased, `${tool.name} ${action}`).toContain(`${tool.name}:${action}`)
        expect(actionPhrase(tool.name, action === '' ? {} : { action }, NAMED), `${tool.name} ${action}`).not.toMatch(/^执行 /)
      }
    }
  })

  it('says an action this build does not know by its id, and nothing before the call names one', () => {
    expect(actionPhrase('research_evidence', { action: 'deduplicate' }, NAMED)).toBe('执行 deduplicate')
    expect(actionPhrase('research_evidence', { action: 'constructor' }, NAMED)).toBe('执行 constructor')
    expect(actionPhrase('research_evidence', {}, NAMED)).toBeUndefined()
    expect(actionPhrase('research_evidence', undefined, NAMED)).toBeUndefined()
    expect(actionPhrase('research_sources', { action: 'import' }, NAMED)).toBeUndefined()
    // English reads the same way.
    expect(actionPhrase('research_evidence', { action: 'import', paths: ['a.csv', 'b.csv'] }, { ...NAMED, t: lookup(en) })).toBe('Import 2 files')
    expect(actionPhrase('research_artifact', { action: 'save-artifact', path: 'refs.bib' }, { ...NAMED, t: lookup(en) })).toBe('Save: refs.bib')
  })
})

describe('the report a research check returned', () => {
  /** The example CCFA study's full check, as the host now writes it (findings of missing files already dropped). */
  const FULL = report({
    clean: false, mode: 'ccfa', route: 'full-paper', gatesRun: ['review-report', 'submission-checks'],
    phases: [
      { id: 'experiments', done: true, missing: [], unmet: [] },
      { id: 'writing', done: false, missing: ['3 error(s) in placeholders'], unmet: ['errors:placeholders'] },
      { id: 'review', done: false, missing: ['1 error(s) in review-report', 'Review the paper (ccf-paper-reviewer)'], unmet: ['report', 'errors:review-report'] },
    ],
    findings: [
      { check: 'placeholders', severity: 'error', message: 'Placeholder remains: \\tbd{answer both questions once the 64K runs are in}', file: 'paper/main.tex', line: 98 },
      { check: 'review-report', severity: 'error', message: 'No review report yet: review the paper with ccf-paper-reviewer' },
      { check: 'placeholders', severity: 'error', message: 'Placeholder remains: 4 empty result cell(s) "--" in a table', file: 'paper/main.tex', line: 83 },
      { check: 'figures', severity: 'warning', message: 'Diagram figures/architecture.drawio is not included in the paper', file: 'figures/architecture.drawio' },
      { check: 'review-report', severity: 'warning', message: 'The review ledger names no revision', file: 'reviews/ledger.md', line: 3 },
    ],
  })

  it('counts and groups what it found by check, groups with errors first, each with the first file it names', () => {
    const view = checkView(answered('research_check', {}, { message: 'Not done yet: fix the errors and check again', check: FULL }))!
    expect(view).toMatchObject({ clean: false, scope: 'all', mode: 'ccfa', errors: 3, warnings: 2, filesExist: true })
    expect(view.groups).toEqual([
      { check: 'placeholders', errors: 2, warnings: 0, file: 'paper/main.tex', line: 98 },
      { check: 'review-report', errors: 1, warnings: 1, file: 'reviews/ledger.md', line: 3 },
      { check: 'figures', errors: 0, warnings: 1, file: 'figures/architecture.drawio', line: undefined },
    ])
    // Errors were found, so no other reason is given.
    expect(view.open).toBeUndefined()
    expect(view.findings).toHaveLength(5)
    // Scope all covers every phase; only the unfinished ones say what they lack.
    expect(view.missing).toEqual([
      { phase: 'writing', lines: ['3 error(s) in placeholders'] },
      { phase: 'review', lines: ['1 error(s) in review-report', 'Review the paper (ccf-paper-reviewer)'] },
    ])
  })

  it('says why a check that found no error did not pass: the checked phase\'s requirements, or the paper\'s open phases', () => {
    const plan = report({ clean: false, scope: 'plan', phases: [
      { id: 'data', done: true, missing: [], unmet: [] },
      { id: 'plan', done: false, missing: ['Write the paper plan into blueprint.json', 'Apply a venue template'], unmet: ['blueprint', 'template'] },
    ] })
    const planView = checkView(answered('research_check', { scope: 'plan' }, { message: 'Not done yet', check: plan }))!
    expect(planView.open).toEqual({ kind: 'requirements', n: 2 })
    expect(planView.missing).toEqual([{ phase: 'plan', lines: ['Write the paper plan into blueprint.json', 'Apply a venue template'] }])

    const whole = report({ clean: false, phases: [
      { id: 'data', done: true, missing: [], unmet: [] },
      { id: 'plan', done: false, missing: [], unmet: [] },
      { id: 'cite', done: false, missing: ['Not checked yet'], unmet: [] },
    ] })
    const wholeView = checkView(answered('research_check', {}, { message: 'Not done yet', check: whole }))!
    expect(wholeView.open).toEqual({ kind: 'phases', n: 2 })
    expect(wholeView.missing).toEqual([{ phase: 'cite', lines: ['Not checked yet'] }])

    // A single check covers no phase, and a report that states no reason gets none.
    const single = checkView(answered('research_check', { scope: 'placeholders' }, { message: 'Not done yet', check: report({ clean: false, scope: 'placeholders', phases: whole.phases }) }))!
    expect(single.open).toBeUndefined()
    expect(single.missing).toEqual([])
    const passed = checkView(answered('research_check', { scope: 'cite' }, { message: 'Clean', check: report({ scope: 'cite', phases: [{ id: 'cite', done: true, missing: [], unmet: [] }] }) }))!
    expect(passed).toMatchObject({ clean: true, errors: 0, warnings: 0, groups: [], missing: [] })
    expect(passed.open).toBeUndefined()
  })

  it('reads a report written before the check recorded its gates and keys, whose files may not have existed', () => {
    const older = {
      clean: false, scope: 'all', mode: 'ccfa', route: 'full-paper',
      phases: [{ id: 'scaffold', done: true, missing: [] }, { id: 'submission', done: false, missing: ['1 error(s) in submission-checks'] }],
      findings: [{ check: 'submission-checks', severity: 'error', message: 'No submission check record yet', file: 'submission/checks.md' }],
      checkedAt: '2026-09-25T08:56:57.092Z',
    }
    expect(checkView(answered('research_check', {}, { message: 'Not done yet', check: older }))).toMatchObject({
      clean: false, scope: 'all', filesExist: false,
      groups: [{ check: 'submission-checks', errors: 1, warnings: 0, file: 'submission/checks.md' }],
      missing: [{ phase: 'submission', lines: ['1 error(s) in submission-checks'] }],
    })
    const unnamed = { clean: true, scope: 'idea', phases: [{ id: 'idea', done: true, missing: [] }], findings: [], checkedAt: '2026-09-25T08:56:10.670Z' }
    expect(checkView(answered('research_check', { scope: 'idea' }, { message: 'Clean', check: unnamed }))?.mode).toBeUndefined()
  })

  it('leaves out entries that are not findings or phases, and reads a result that is no report as none', () => {
    const odd = {
      clean: false, scope: 'review', mode: 'spark-to-paper',
      findings: [
        { check: 'review', severity: 'error', message: 'No review yet', file: 7, line: '3' },
        { check: 'review', severity: 'fatal', message: 'An unknown severity reads as a warning' },
        { check: 'review', message: 42 },
        { severity: 'error', message: 'no check' },
        'Placeholder remains',
        null,
      ],
      phases: [{ id: 'review', done: 'no', missing: ['Review the paper', 7] }, { done: true }, 'review'],
    }
    const view = checkView(answered('research_check', { scope: 'review' }, { message: 'Not done yet', check: odd }))!
    expect(view.findings).toEqual([
      { check: 'review', severity: 'error', message: 'No review yet' },
      { check: 'review', severity: 'warning', message: 'An unknown severity reads as a warning' },
    ])
    expect(view.missing).toEqual([{ phase: 'review', lines: ['Review the paper'] }])
    expect(checkView(answered('research_check', {}, { message: 'Clean', check: { clean: true, scope: 'all', findings: 'none', phases: {} } }))).toMatchObject({ findings: [], missing: [] })

    for (const value of [
      { message: 'Clean' },
      { message: 'Clean', check: 'clean' },
      { message: 'Clean', check: { clean: 'yes', scope: 'all' } },
      { message: 'Clean', check: { clean: true, scope: 3 } },
      ['Clean'],
    ]) expect(checkView(answered('research_check', {}, value))).toBeUndefined()
    expect(checkView(settled('research_check', {}, [{ type: 'text', text: 'Clean' }]))).toBeUndefined()
  })
})
