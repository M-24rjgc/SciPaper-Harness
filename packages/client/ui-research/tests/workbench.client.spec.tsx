// @vitest-environment jsdom

/**
 * The full workbench panel and the project list beside the conversation. Every
 * command it emits is handed to the validator the service parses commands with,
 * so a button that builds a request the service would refuse fails here. Every
 * control keeps its own progress and its own failure line, so the tests hold
 * one control's work open or refuse it and look at that control and its
 * neighbours.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type {
  ArtifactId, CheckReport, EnvironmentId, EvidenceId, ResearchCommand, ResearchProject, ResearchResponse,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchBrand, Workbench } from '../src/client/Workbench.tsx'
import { ResearchProjects } from '../src/client/ProjectEntry.tsx'
import {
  sessionProject, useModes, type ClaimFocus, type ResearchFocus, type ResearchView, type WorkbenchProps,
} from '../src/client/contract.ts'
import {
  chosenMode, modeChoice, modeName, modePhases, packText, parseModeChoice, projectFileAddress, standingText, type Translate,
} from '../src/client/format.ts'
import { en, zh } from '../src/client/locales.ts'
import { MODES } from './fixtures/modes.ts'
import { standingOf } from './fixtures/standing.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as Translate

/** The line a refused action leaves under its control. */
const failed = (reason: string): string => t('actionFailed', { reason })

function fixture(): ResearchProject {
  const project = newProject({ root: '/research/sparse', title: 'Sparse attention', brief: 'Does it hold?', mode: 'spark-to-paper', route: 'proposal' }, 'w' as WorkspaceId)
  const base = { revision: 1, sha256: 's', evidence: [], claimIds: [], inputArtifacts: [], stale: false, updatedAt: '', author: 'agent' as const }
  project.artifacts.push(
    { ...base, id: 'main' as ArtifactId, path: 'paper/main.tex', kind: 'manuscript' },
    { ...base, id: 'arch' as ArtifactId, path: 'figures/arch.drawio', kind: 'diagram', stale: true },
    { ...base, id: 'code' as ArtifactId, path: 'code/train.py', kind: 'code' },
  )
  project.evidence.push({ id: 'data' as EvidenceId, title: 'results.csv', kind: 'file', path: '.research/sources/data/1.csv', originalPath: '/research/sparse/data/results.csv', sha256: 's', revision: 2, importedAt: '', chunks: [], coverage: 'data', verified: true, stale: true })
  project.environments.push({ id: 'env' as EnvironmentId, name: 'local', kind: 'uv', target: 'local', python: 'py', requirements: [], fingerprint: 'f', status: 'ready', details: '', isDefault: true })
  project.compilations.push({ artifactId: 'main' as ArtifactId, artifactRevision: 1, inputDigest: 'd', engine: 'pdflatex', status: 'completed', pdfPath: '.research/build/main.pdf', logPath: 'l', diagnostics: ['Overfull \\hbox'], createdAt: 'c1' })
  project.visualReviews.push({ artifactId: 'main' as ArtifactId, artifactRevision: 1, status: 'reviewed', sessionId: 'review-session', findings: 'Legible', createdAt: 'v1' })
  project.claims.push({ id: 'claim', text: 'It holds', kind: 'hypothesis', state: 'proposed', evidence: [], artifactIds: [] })
  project.experiments.push({ id: 'run' as never, spec: { name: 'train', seed: 1 } as never, status: 'completed', createdAt: '', updatedAt: '', directory: '', inputRevision: 1, environmentFingerprint: '', metrics: { acc: 0.8 }, message: 'done', snapshotPath: '', collected: true })
  return project
}

/** A command's answer, a refusal as a rejected promise, or nothing for the default answer. */
type Respond = (command: ResearchCommand) => ResearchResponse | Promise<ResearchResponse> | undefined

interface Harness {
  props: WorkbenchProps
  commands: ResearchCommand[]
  created: unknown[]
  calls: string[]
  focused: (ClaimFocus | null)[]
  view: ResearchView
}

function harness(projects: ResearchProject[], focus: ResearchFocus = { claim: null }, respond?: Respond): Harness {
  const commands: ResearchCommand[] = []
  const created: unknown[] = []
  const calls: string[] = []
  const focused: (ClaimFocus | null)[] = []
  const view: ResearchView = { snapshot: { projects, preferences: {}, components: [], modes: MODES }, tasks: [], response: null }
  const props = {
    t,
    useResearch: (select: (value: ResearchView) => unknown) => select(view),
    useFocus: (select: (value: ResearchFocus) => unknown) => select(focus),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
    run: (command: ResearchCommand) => {
      commands.push(command)
      expect(commandSchema.parse(command)).toBeTruthy()
      return Promise.resolve(respond?.(command) ?? { message: '', content: command.action === 'read-artifact' ? 'file text' : undefined, project: projects[0] })
    },
    create: (request: unknown) => { created.push(request); return Promise.resolve(projects[0]) },
    refresh: () => { calls.push('refresh'); return Promise.resolve() },
    openConversation: (id: string, workspaceId: string) => { calls.push(`open:${id}@${workspaceId}`); return Promise.resolve() },
    focusClaim: (claim: ClaimFocus | null) => { focused.push(claim) },
    install: (component: string) => { calls.push(`install:${component}`); return Promise.resolve() },
    openFile: () => {},
    openFiles: () => {},
    expand: () => {},
    configure: () => Promise.resolve(),
    pickDirectory: () => Promise.resolve(null),
    // The board's own reads are covered with it; here they never answer.
    board: () => new Promise(() => {}),
  } as unknown as WorkbenchProps
  return { props, commands, created, calls, focused, view }
}

const settle = async (): Promise<void> => { await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }) }

describe('the workbench panel', () => {
  it('offers a first project when there is none, and creates one in the general mode or a chosen route', async () => {
    const empty = harness([])
    const ui = render(<Workbench {...empty.props} />)
    expect(ui.getByText(zh.noProjects)).toBeTruthy()
    fireEvent.click(ui.getAllByRole('button', { name: zh.newProject })[1]!)
    // Every installed mode is offered: one without routes as itself, a pack with routes once per route, under its name.
    const mode = ui.getByLabelText(zh.mode)
    expect(within(mode).getAllByRole('option').map(option => [option.textContent, option.getAttribute('title')])).toEqual([
      ['通用', '全部工具，不走流水线'],
      ['spark-to-paper · 从提案开始', '结果先留空'],
      ['spark-to-paper · 从实测结果开始', '数字追溯到数据'],
    ])
    expect(within(mode).getByRole('group', { name: 'spark-to-paper' })).toBeTruthy()
    fireEvent.change(ui.getByLabelText(zh.title), { target: { value: 'New' } })
    fireEvent.change(ui.getByLabelText(zh.directory), { target: { value: '/research/new' } })
    fireEvent.change(ui.getByLabelText(zh.brief), { target: { value: 'b' } })
    fireEvent.submit(ui.getByRole('button', { name: zh.create }).closest('form')!)
    await settle()
    expect(ui.queryByRole('button', { name: zh.create })).toBeNull()
    fireEvent.click(ui.getAllByRole('button', { name: zh.newProject })[0]!)
    fireEvent.change(ui.getByLabelText(zh.mode), { target: { value: 'spark-to-paper/data' } })
    fireEvent.change(ui.getByLabelText(zh.autonomy), { target: { value: 'automatic' } })
    fireEvent.submit(ui.getByRole('button', { name: zh.create }).closest('form')!)
    await settle()
    expect(empty.created).toEqual([
      { title: 'New', root: '/research/new', brief: 'b', mode: 'general', autonomy: 'checkpoints' },
      { title: '', root: '', brief: '', mode: 'spark-to-paper', route: 'data', autonomy: 'automatic' },
    ])
  })

  it('holds the create button while a project is created, and keeps the form with the reason when it is refused', async () => {
    const h = harness([])
    let refuse: (reason: Error) => void = () => {}
    const refusing = { ...h.props, create: () => new Promise((_resolve, reject) => { refuse = reject }) } as unknown as WorkbenchProps
    const ui = render(<Workbench {...refusing} />)
    fireEvent.click(ui.getAllByRole('button', { name: zh.newProject })[0]!)
    fireEvent.change(ui.getByLabelText(zh.title), { target: { value: 'New' } })
    fireEvent.submit(ui.getByRole('button', { name: zh.create }).closest('form')!)
    expect(ui.getByRole('button', { name: zh.create })).toHaveProperty('disabled', true)
    await settle()
    await act(async () => { refuse(new Error('the folder is not writable')); await Promise.resolve() })
    await settle()
    expect(ui.getByRole('alert').textContent).toBe(failed('the folder is not writable'))
    expect((ui.getByLabelText(zh.title) as HTMLInputElement).value).toBe('New')
    expect(ui.getByRole('button', { name: zh.create })).toHaveProperty('disabled', false)
    // Asking for a new project again forgets how the last attempt ended.
    fireEvent.click(ui.getAllByRole('button', { name: zh.newProject })[0]!)
    expect(ui.queryByRole('alert')).toBeNull()
    fireEvent.click(ui.getByRole('button', { name: zh.cancel }))
    expect(ui.queryByRole('button', { name: zh.create })).toBeNull()
  })

  it('offers a first project while the record has not arrived yet', () => {
    const loading = harness([])
    loading.view.snapshot = null
    const ui = render(<Workbench {...loading.props} />)
    expect(ui.getByText(zh.noProjects)).toBeTruthy()
    expect(within(ui.getByLabelText(zh.projects)).getAllByRole('option').map(option => option.textContent)).toEqual([zh.projects])
  })

  it('shows the overview with the project status and the last result, and exports without holding up a refresh', async () => {
    const project = fixture()
    const other = newProject({ root: '/research/other', title: 'Other', brief: '' }, 'w' as WorkspaceId)
    let finishExport: () => void = () => {}
    const h = harness([project, other], { claim: null }, command => command.action === 'export'
      ? new Promise<ResearchResponse>((resolve) => { finishExport = () => { resolve({ message: 'Exported' }) } })
      : undefined)
    h.view.tasks = [
      { id: 't', kind: 'k', status: 'running', message: 'working', createdAt: '' },
      { id: 'u', kind: 'k', status: 'completed', message: 'finished', createdAt: '' },
    ]
    const check: CheckReport = { clean: false, scope: 'all', gatesRun: [], phases: [], checkedAt: '', findings: [
      { check: 'cite', severity: 'error', message: 'Missing key', file: 'paper/main.tex', line: 3 },
      { check: 'review', severity: 'warning', message: 'No review', file: 'reviews/review.md' },
      { check: 'stale', severity: 'warning', message: 'Stale thing' },
    ] }
    h.view.response = { message: 'Checked', path: 'exports/x.zip', content: 'details', check }
    const ui = render(<Workbench {...h.props} />)
    expect(ui.getByRole('heading', { name: 'Sparse attention' })).toBeTruthy()
    expect(ui.getByText('Does it hold?')).toBeTruthy()
    expect(ui.getByText(`${zh.tasks} · 1 ${zh.running}`)).toBeTruthy()
    expect(ui.getByText('finished')).toBeTruthy()
    expect(ui.getByText(`${zh.findings} · ${t('checkErrors', { n: 1 })} · ${t('checkWarnings', { n: 2 })}`)).toBeTruthy()
    expect(ui.getByText('Missing key — paper/main.tex:3')).toBeTruthy()
    expect(ui.getByText('No review — reviews/review.md')).toBeTruthy()
    expect(ui.getByText('Stale thing')).toBeTruthy()
    expect(ui.getByText('exports/x.zip')).toBeTruthy()
    expect(ui.getByText('details')).toBeTruthy()
    // Without a conversation of its own the project offers none to open.
    expect(ui.queryByRole('button', { name: zh.openConversation })).toBeNull()
    // The autonomy is named here and changed in the composer.
    expect(ui.getByText('检查点（在输入框下方更改）')).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: zh.exportPaper }))
    expect(ui.getByRole('button', { name: zh.exportPaper })).toHaveProperty('disabled', true)
    expect(ui.getByRole('button', { name: zh.refresh })).toHaveProperty('disabled', false)
    fireEvent.click(ui.getByRole('button', { name: zh.refresh }))
    await settle()
    expect(h.calls).toEqual(['refresh'])
    await act(async () => { finishExport(); await Promise.resolve() })
    await settle()
    expect(ui.getByRole('button', { name: zh.exportPaper })).toHaveProperty('disabled', false)
    expect(h.commands).toEqual([{ action: 'export', projectId: project.id }])
    fireEvent.change(ui.getByLabelText(zh.projects), { target: { value: other.id } })
    expect(ui.getByRole('heading', { name: 'Other' })).toBeTruthy()
  })

  it('opens the project\'s own conversation, and says why a refresh failed', async () => {
    const project = { ...fixture(), sessionId: 'session-p' }
    const h = harness([project])
    h.view.response = { message: 'Clean', check: { clean: true, scope: 'all', gatesRun: [], phases: [], checkedAt: '', findings: [] } }
    const refusing = { ...h.props, refresh: () => Promise.reject(new Error('offline')) } as unknown as WorkbenchProps
    const ui = render(<Workbench {...refusing} />)
    expect(ui.getByText(new RegExp(`^${zh.checkClean} · `))).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: zh.openConversation }))
    fireEvent.click(ui.getByRole('button', { name: zh.refresh }))
    await settle()
    expect(h.calls).toEqual(['open:session-p@w'])
    expect(ui.getByRole('alert').textContent).toBe(failed('offline'))
  })

  it('imports and searches sources, previews a snapshot in place, and imports a found reference', async () => {
    const project = fixture()
    const item = { id: '10.1/x', provider: 'crossref' as const, title: 'Found paper', authors: ['A', 'B'], year: 2024, doi: '10.1/x', url: 'https://doi.org/10.1/x', abstract: 'About', bibtex: '' }
    const h = harness([project], { claim: null, projectId: project.id, panel: 'sources' }, command => command.action === 'import'
      ? Promise.reject(new Error('data/a.csv is missing'))
      : undefined)
    h.view.response = { message: 'found', literature: [item, { ...item, id: 'no-doi', title: 'No DOI', doi: undefined }] }
    project.evidence.push({
      ...project.evidence[0]!, id: 'ref' as EvidenceId, title: 'Open paper', kind: 'literature', path: '.research/sources/ref/reference.json',
      originalPath: undefined, fullTextPath: '.research/sources/ref/fulltext.pdf', coverage: 'full-text', stale: false,
    })
    const ui = render(<Workbench {...h.props} />)
    const importForm = ui.getByRole('button', { name: zh.importSources }).closest('form')!
    fireEvent.change(ui.getByLabelText(zh.sourcePaths), { target: { value: 'data/a.csv\n\n notes.md ' } })
    fireEvent.submit(importForm)
    fireEvent.change(ui.getByLabelText(zh.query), { target: { value: 'sparse' } })
    fireEvent.submit(ui.getByRole('button', { name: zh.search }).closest('form')!)
    fireEvent.change(ui.getByLabelText(zh.source), { target: { value: 'arxiv' } })
    fireEvent.submit(ui.getByRole('button', { name: zh.search }).closest('form')!)
    fireEvent.click(ui.getAllByRole('button', { name: zh.importReference })[0]!)
    expect(ui.getByText('https://doi.org/10.1/x')).toBeTruthy()
    expect(ui.getByText(zh.stale)).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: zh.refreshSource }))
    fireEvent.click(ui.getAllByRole('button', { name: zh.claimOpenSource })[0]!)
    const frame = ui.getByTitle(zh.preview)
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('src')).toContain(encodeURIComponent(project.evidence[0]!.path))
    fireEvent.click(ui.getByRole('button', { name: zh.close }))
    expect(ui.queryByTitle(zh.preview)).toBeNull()
    fireEvent.click(ui.getByRole('button', { name: zh.fullText }))
    expect(ui.getByTitle(zh.preview).getAttribute('src')).toContain(encodeURIComponent('.research/sources/ref/fulltext.pdf'))
    fireEvent.click(ui.getByRole('button', { name: zh.close }))
    await settle()
    expect(h.commands.map(command => command.action)).toEqual(['import', 'search-evidence', 'literature-search', 'literature-import', 'refresh-evidence'])
    expect(h.commands[0]).toMatchObject({ paths: ['data/a.csv', 'notes.md'] })
    // The refused import says why under its own form; the searches beside it went ahead.
    expect(within(importForm).getByRole('alert').textContent).toBe(failed('data/a.csv is missing'))
    expect(ui.getAllByRole('alert')).toHaveLength(1)
    expect(ui.getByRole('button', { name: zh.importSources })).toHaveProperty('disabled', false)
    cleanup()
    const bare = harness([newProject({ root: '/r', title: 'Bare', brief: '' }, 'w' as WorkspaceId)], { claim: null, panel: 'sources' })
    bare.view.response = { message: 'Imported' }
    const empty = render(<Workbench {...bare.props} />)
    expect(empty.getByText(zh.emptySources)).toBeTruthy()
    expect(empty.queryByRole('button', { name: zh.importReference })).toBeNull()
  })

  it('edits, saves, adopts, compiles, previews and reviews project files', async () => {
    const project = fixture()
    project.visualReviews.push({ artifactId: 'code' as ArtifactId, artifactRevision: 1, status: 'rendered', findings: 'Pages rendered', createdAt: 'v2' })
    const h = harness([project], { claim: null, projectId: project.id, panel: 'artifacts', artifactId: 'main' })
    const ui = render(<Workbench {...h.props} />)
    await settle()
    const editor = ui.getByLabelText(zh.content) as HTMLTextAreaElement
    expect(editor.value).toBe('file text')
    expect(ui.getByText(`paper/main.tex · ${zh.revision} 1 · ${zh.current}`)).toBeTruthy()
    expect(ui.getByText('Overfull \\hbox')).toBeTruthy()
    // Nothing is saved before something was typed.
    expect(ui.getByRole('button', { name: zh.save })).toHaveProperty('disabled', true)
    fireEvent.change(editor, { target: { value: 'edited' } })
    expect(ui.getByText(zh.unsaved)).toBeTruthy()
    expect(ui.getByLabelText(zh.chooseFile)).toHaveProperty('disabled', true)
    expect(ui.getByRole('button', { name: zh.newArtifact })).toHaveProperty('disabled', true)
    fireEvent.click(ui.getByRole('button', { name: zh.save }))
    expect(ui.getByRole('button', { name: zh.saving })).toHaveProperty('disabled', true)
    await settle()
    expect(ui.queryByText(zh.unsaved)).toBeNull()
    expect(ui.getByRole('button', { name: zh.save })).toHaveProperty('disabled', true)
    fireEvent.click(ui.getByRole('button', { name: zh.registerChanges }))
    await settle()
    fireEvent.click(ui.getByRole('button', { name: zh.visualReview }))
    fireEvent.submit(ui.getAllByRole('button', { name: zh.compile }).at(-1)!.closest('form')!)
    fireEvent.click(ui.getByRole('button', { name: zh.preview }))
    // The compiled PDF opens in the browser's own viewer, which cannot run sandboxed.
    expect(ui.getByTitle(zh.preview).getAttribute('src')).toContain(encodeURIComponent('.research/build/main.pdf'))
    expect(ui.getByTitle(zh.preview).hasAttribute('sandbox')).toBe(false)
    fireEvent.click(ui.getByRole('button', { name: zh.close }))
    expect(ui.queryByTitle(zh.preview)).toBeNull()
    expect(ui.getByText('Legible')).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: zh.openConversation }))
    fireEvent.change(ui.getByLabelText(zh.imagePrompt), { target: { value: 'a picture' } })
    fireEvent.submit(ui.getByRole('button', { name: zh.generate }).closest('form')!)
    await settle()
    expect(h.commands.map(command => command.action)).toEqual([
      'read-artifact', 'save-artifact', 'register-artifact', 'read-artifact', 'visual-review', 'compile', 'generate-image',
    ])
    expect(h.commands[1]).toMatchObject({ path: 'paper/main.tex', kind: 'manuscript', content: 'edited', expectedRevision: 1 })
    expect(h.commands[6]).toMatchObject({ prompt: 'a picture', path: 'figures/illustration.png' })
    expect(h.calls).toEqual(['open:review-session@w'])
    // A file with no compiled PDF previews as itself, framed without scripts; its review names no conversation.
    fireEvent.change(ui.getByLabelText(zh.chooseFile), { target: { value: 'code' } })
    await settle()
    expect(ui.queryByRole('button', { name: zh.compile })).toBeNull()
    expect(ui.getByText('Pages rendered')).toBeTruthy()
    expect(ui.queryByRole('button', { name: zh.openConversation })).toBeNull()
    fireEvent.click(ui.getByRole('button', { name: zh.preview }))
    expect(ui.getByTitle(zh.preview).getAttribute('sandbox')).toBe('')
    fireEvent.click(ui.getByRole('button', { name: zh.newArtifact }))
    expect(ui.queryByTitle(zh.preview)).toBeNull()
    expect((ui.getByLabelText(zh.path) as HTMLInputElement).value).toBe('paper/main.tex')
    fireEvent.change(ui.getByLabelText(zh.chooseFile), { target: { value: 'ghost' } })
    fireEvent.change(ui.getByLabelText(zh.path), { target: { value: 'notes/new.md' } })
    fireEvent.change(ui.getByLabelText(zh.artifactKind), { target: { value: 'supplement' } })
    expect(ui.getByRole('button', { name: zh.save })).toHaveProperty('disabled', true)
    fireEvent.change(ui.getByLabelText(zh.content), { target: { value: 'notes' } })
    fireEvent.click(ui.getByRole('button', { name: zh.save }))
    await settle()
    expect(h.commands.at(-1)).toEqual({
      action: 'save-artifact', projectId: project.id, path: 'notes/new.md', kind: 'supplement', content: 'notes',
      expectedRevision: 0, evidence: [], claimIds: [], inputArtifacts: [],
    })
  })

  it('shows a binary file without an editor and never saves it', async () => {
    const project = fixture()
    project.artifacts.push({ ...project.artifacts[0]!, id: 'flow' as ArtifactId, path: 'figures/flow.png', kind: 'diagram' })
    const h = harness([project], { claim: null, projectId: project.id, panel: 'artifacts', artifactId: 'flow' }, command =>
      command.action === 'read-artifact' && command.artifactId === 'flow' ? { message: '', content: '', binary: true } : undefined)
    const ui = render(<Workbench {...h.props} />)
    await settle()
    expect(ui.getByText(zh.binaryFile)).toBeTruthy()
    expect(ui.queryByLabelText(zh.content)).toBeNull()
    expect(ui.queryByTitle(zh.diagram)).toBeNull()
    expect(ui.queryByRole('button', { name: zh.diagram })).toBeNull()
    expect(ui.getByRole('button', { name: zh.save })).toHaveProperty('disabled', true)
    fireEvent.click(ui.getByRole('button', { name: zh.preview }))
    expect(ui.getByTitle(zh.preview).getAttribute('src')).toContain(encodeURIComponent('figures/flow.png'))
    // A new file and the next text file are editable again.
    fireEvent.click(ui.getByRole('button', { name: zh.newArtifact }))
    expect(ui.queryByText(zh.binaryFile)).toBeNull()
    fireEvent.change(ui.getByLabelText(zh.chooseFile), { target: { value: 'main' } })
    await settle()
    fireEvent.change(ui.getByLabelText(zh.content), { target: { value: 'x' } })
    expect(ui.getByRole('button', { name: zh.save })).toHaveProperty('disabled', false)
    expect(h.commands.map(command => command.action)).toEqual(['read-artifact', 'read-artifact'])
  })

  it('says why a file could not be opened, compiled or illustrated, beside the control that asked', async () => {
    const project = fixture()
    const refusals: Partial<Record<ResearchCommand['action'], string>> = { 'read-artifact': 'the file is locked', compile: 'xelatex is not installed', 'generate-image': 'no image model' }
    const h = harness([project], { claim: null, projectId: project.id, panel: 'artifacts', artifactId: 'main' }, (command) => {
      const reason = refusals[command.action]
      return reason === undefined ? undefined : Promise.reject(new Error(reason))
    })
    const ui = render(<Workbench {...h.props} />)
    await settle()
    expect(ui.getByRole('alert').textContent).toBe(failed('the file is locked'))
    expect((ui.getByLabelText(zh.content) as HTMLTextAreaElement).value).toBe('')
    delete refusals['read-artifact']
    fireEvent.change(ui.getByLabelText(zh.chooseFile), { target: { value: 'main' } })
    await settle()
    expect(ui.queryByRole('alert')).toBeNull()
    const compileForm = ui.getAllByRole('button', { name: zh.compile }).at(-1)!.closest('form')!
    fireEvent.submit(compileForm)
    const illustrationForm = ui.getByRole('button', { name: zh.generate }).closest('form')!
    fireEvent.change(ui.getByLabelText(zh.imagePrompt), { target: { value: 'a picture' } })
    fireEvent.submit(illustrationForm)
    await settle()
    expect(within(compileForm).getByRole('alert').textContent).toBe(failed('xelatex is not installed'))
    expect(within(illustrationForm).getByRole('alert').textContent).toBe(failed('no image model'))
    expect(ui.getAllByRole('alert')).toHaveLength(2)
  })

  it('debounces draw.io autosaves into one save at a time, the latest winning', async () => {
    const project = fixture()
    let release: () => void = () => {}
    const saves: string[] = []
    const h = harness([project], { claim: null, projectId: project.id, panel: 'artifacts', artifactId: 'arch' }, (command) => {
      if (command.action === 'save-artifact') saves.push(command.content)
      return { message: '', content: command.action === 'read-artifact' ? '<mxfile/>' : undefined }
    })
    const slow = { ...h.props, run: (command: ResearchCommand) => command.action === 'save-artifact'
      ? new Promise<ResearchResponse>((resolve) => { release = () => { resolve(h.props.run(command)) } })
      : h.props.run(command) } as unknown as WorkbenchProps
    const ui = render(<Workbench {...slow} />)
    await settle()
    expect(ui.getByText(`figures/arch.drawio · ${zh.revision} 1 · ${zh.stale}`)).toBeTruthy()
    expect(ui.getByRole('option', { name: '↻ figures/arch.drawio' })).toBeTruthy()
    const frame = ui.getByTitle(zh.diagram) as HTMLIFrameElement
    const post = (data: unknown, source: unknown = frame.contentWindow): void => {
      act(() => { window.dispatchEvent(new MessageEvent('message', { data, source: source as Window })) })
    }
    post(JSON.stringify({ event: 'init' }))
    expect(ui.queryByRole('button', { name: zh.install })).toBeNull()
    post('{broken', frame.contentWindow)
    post(JSON.stringify(null))
    post(JSON.stringify(7))
    post(JSON.stringify({ xml: 'no event' }))
    post(JSON.stringify({ event: 'save' }))
    post(JSON.stringify({ event: 'save', xml: 5 }))
    post(JSON.stringify({ event: 'save', xml: 'x' }), window)
    vi.useFakeTimers()
    post(JSON.stringify({ event: 'autosave', xml: 'first' }))
    post(JSON.stringify({ event: 'autosave', xml: 'second' }))
    act(() => { vi.advanceTimersByTime(1500) })
    // One save in flight; the next ones queue behind it and only the latest is written.
    post({ event: 'save', xml: 'third' })
    post({ event: 'save', xml: 'fourth' })
    vi.useRealTimers()
    await settle()
    await act(async () => { release(); await Promise.resolve() })
    await settle()
    await act(async () => { release(); await Promise.resolve() })
    await settle()
    expect(saves).toEqual(['second', 'fourth'])
    fireEvent.click(ui.getByRole('button', { name: zh.editSource }))
    expect(ui.getByLabelText(zh.content)).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: zh.diagram }))
    ui.unmount()
  })

  it('drops a file read that lands after the editor moved on, and ignores other editor messages carrying XML', async () => {
    const project = fixture()
    let answer: (value: ResearchResponse) => void = () => {}
    const h = harness([project], { claim: null, projectId: project.id, panel: 'artifacts', artifactId: 'arch' })
    const late = { ...h.props, run: (command: ResearchCommand) => command.action === 'read-artifact'
      ? new Promise<ResearchResponse>((resolve) => { answer = resolve })
      : h.props.run(command) } as unknown as WorkbenchProps
    const ui = render(<Workbench {...late} />)
    await settle()
    ui.unmount()
    await act(async () => { answer({ message: '', content: 'too late' }); await Promise.resolve() })
    const saves: string[] = []
    const again = harness([project], { claim: null, projectId: project.id, panel: 'artifacts', artifactId: 'arch' }, (command) => {
      if (command.action === 'save-artifact') saves.push(command.content)
      return { message: '', content: command.action === 'read-artifact' ? '<mxfile/>' : undefined }
    })
    const view = render(<Workbench {...again.props} />)
    await settle()
    const frame = view.getByTitle(zh.diagram) as HTMLIFrameElement
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { event: 'export', xml: '<svg/>' }, source: frame.contentWindow as Window })) })
    await settle()
    expect(saves).toEqual([])
  })

  it('offers to install the editor until it answers, and shows a refused install or save under it', async () => {
    const project = fixture()
    let failInstall: (reason: Error) => void = () => {}
    let refusals = 1
    const h = harness([project], { claim: null, projectId: project.id, panel: 'artifacts', artifactId: 'arch' }, (command) => {
      if (command.action !== 'save-artifact' || refusals === 0) return undefined
      refusals -= 1
      return Promise.reject(new Error('conflict'))
    })
    const installing = {
      ...h.props,
      install: (component: string) => { h.calls.push(`install:${component}`); return new Promise((_resolve, reject) => { failInstall = reject }) },
    } as unknown as WorkbenchProps
    const ui = render(<Workbench {...installing} />)
    await settle()
    fireEvent.click(ui.getByRole('button', { name: zh.install }))
    expect(ui.getByRole('button', { name: zh.install })).toHaveProperty('disabled', true)
    await settle()
    await act(async () => { failInstall(new Error('network down')); await Promise.resolve() })
    await settle()
    expect(h.calls).toEqual(['install:drawio'])
    expect(ui.getByRole('alert').textContent).toBe(failed('network down'))
    expect(ui.getByRole('button', { name: zh.install })).toHaveProperty('disabled', false)
    cleanup()
    const editor = render(<Workbench {...h.props} />)
    await settle()
    const frame = editor.getByTitle(zh.diagram) as HTMLIFrameElement
    const save = (xml: string): void => {
      act(() => { window.dispatchEvent(new MessageEvent('message', { data: { event: 'save', xml }, source: frame.contentWindow as Window })) })
    }
    save('<mxfile>refused</mxfile>')
    await settle()
    expect(editor.getByRole('alert').textContent).toBe(failed('conflict'))
    // The next edit tries again, and a write that lands clears the line.
    save('<mxfile>kept</mxfile>')
    await settle()
    expect(editor.queryByRole('alert')).toBeNull()
    expect(h.commands.filter(command => command.action === 'save-artifact')).toHaveLength(2)
  })

  it('submits an experiment by hand below the board, with a valid argument vector only', async () => {
    const project = fixture()
    let refusals = 1
    const h = harness([project], { claim: null, projectId: project.id, panel: 'experiments' }, (command) => {
      if (command.action !== 'experiment' || refusals === 0) return undefined
      refusals -= 1
      return Promise.reject(new Error('GPU busy'))
    })
    const ui = render(<Workbench {...h.props} />)
    expect(ui.getByText(zh.boardManualRun)).toBeTruthy()
    const form = ui.getByRole('button', { name: zh.submitExperiment }).closest('form')!
    fireEvent.change(ui.getByLabelText(zh.experimentName), { target: { value: 'train' } })
    fireEvent.change(ui.getByLabelText(zh.argv), { target: { value: 'not json' } })
    fireEvent.submit(form)
    fireEvent.change(ui.getByLabelText(zh.argv), { target: { value: '[1, 2]' } })
    fireEvent.submit(form)
    expect(h.commands).toEqual([])
    fireEvent.change(ui.getByLabelText(zh.argv), { target: { value: '["{python}", "code/train.py"]' } })
    fireEvent.change(ui.getByLabelText(zh.gpuIds), { target: { value: '0, 1' } })
    fireEvent.submit(form)
    await settle()
    expect(within(form).getByRole('alert').textContent).toBe(failed('GPU busy'))
    // A refused submission is retried as the same request; a submission that went through makes the next one new.
    fireEvent.submit(form)
    await settle()
    expect(within(form).queryByRole('alert')).toBeNull()
    fireEvent.submit(form)
    await settle()
    expect(h.commands[0]).toMatchObject({ action: 'experiment', spec: { argv: ['{python}', 'code/train.py'], gpuIds: ['0', '1'], environmentId: 'env', codeArtifactIds: [] } })
    const requests = h.commands.map(command => command.action === 'experiment' ? command.requestId : '')
    expect(requests).toHaveLength(3)
    expect(requests[1]).toBe(requests[0])
    expect(requests[2]).not.toBe(requests[1])
    cleanup()
    const bare = newProject({ root: '/r', title: 'Bare', brief: '' }, 'w' as WorkspaceId)
    expect(render(<Workbench {...harness([bare], { claim: null, panel: 'experiments' }).props} />).getByText(zh.boardEmpty)).toBeTruthy()
  })

  it('names the product in the native sidebar', () => {
    expect(render(<ResearchBrand t={t as never} />).container.textContent).toBe(zh.name)
  })

  it('opens a file that has no text, and loads an empty diagram as a blank drawing', async () => {
    const project = fixture()
    project.evidence.push({ ...project.evidence[0]!, id: 'fresh' as EvidenceId, title: 'fresh.csv', stale: false })
    const h = harness([project], { claim: null, projectId: project.id, panel: 'artifacts', artifactId: 'arch' }, () => ({ message: '' }))
    const ui = render(<Workbench {...h.props} />)
    await settle()
    const frame = ui.getByTitle(zh.diagram) as HTMLIFrameElement
    const posted: unknown[] = []
    const view = frame.contentWindow!
    view.postMessage = ((message: unknown) => { posted.push(message) }) as typeof view.postMessage
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'init' }), source: frame.contentWindow as Window })) })
    expect(String(posted[0])).toContain('Architecture')
    fireEvent.click(ui.getByRole('button', { name: zh.editSource }))
    fireEvent.change(ui.getByLabelText(zh.chooseFile), { target: { value: 'main' } })
    await settle()
    expect((ui.getByLabelText(zh.content) as HTMLTextAreaElement).value).toBe('')
    fireEvent.click(ui.getByRole('button', { name: zh.experiments }))
    expect(ui.getByRole('option', { name: /fresh\.csv/ })).toBeTruthy()
  })

  it('opens the figure gallery as one of the project\'s tabs', () => {
    const project = fixture()
    const h = harness([project])
    const searches: unknown[] = []
    const searchFigures = (request: unknown): Promise<never> => { searches.push(request); return new Promise(() => {}) }
    const props = { ...h.props, searchFigures } as unknown as WorkbenchProps
    const ui = render(<Workbench {...props} />)
    fireEvent.click(ui.getByRole('button', { name: zh.gallery }))
    expect(ui.getByRole('button', { name: zh.gallery }).getAttribute('aria-current')).toBe('page')
    expect(ui.getByText(zh.galleryIntro)).toBeTruthy()
    expect(searches).toEqual([{ action: 'find-reference-figures', projectId: project.id, limit: 24, offset: 0 }])
  })

  it('opens a claim of this project over the frame, and shows the settings', () => {
    const project = fixture()
    const h = harness([project], { claim: null, projectId: project.id, panel: 'claims' })
    const ui = render(<Workbench {...h.props} />)
    fireEvent.click(ui.getByRole('button', { name: /It holds/ }))
    expect(h.focused).toEqual([{ projectId: project.id, claimId: 'claim' }])
    for (const tab of [zh.workflow, zh.sources, zh.artifacts, zh.experiments, zh.claims]) fireEvent.click(ui.getByRole('button', { name: tab }))
    expect(ui.getByRole('button', { name: /It holds/ })).toBeTruthy()
    cleanup()
    const settings = render(<Workbench {...harness([project], { claim: null, projectId: project.id, panel: 'settings' }).props} />)
    expect(settings.getByText(zh.settingsSubtitle)).toBeTruthy()
  })
})

describe('the project list in the sidebar', () => {
  it('opens a bound project, binds an unbound one, and says why opening failed', async () => {
    const bound = fixture()
    bound.sessionId = 'session-b'
    const unbound = newProject({ root: '/research/u', title: 'Unbound', brief: '' }, 'u' as WorkspaceId)
    bound.updatedAt = '2026-09-20T00:00:00.000Z'
    unbound.updatedAt = '2026-09-22T00:00:00.000Z'
    const h = harness([bound, unbound])
    expect(render(<ResearchProjects {...h.props} wide={false} />).container.textContent).toBe('')
    const ui = render(<ResearchProjects {...h.props} wide />)
    // The project worked on most recently comes first.
    expect(ui.getAllByRole('button').map(button => button.textContent)).toEqual([expect.stringMatching(/^Unbound/) as unknown, expect.stringMatching(/^Sparse attention/) as unknown])
    fireEvent.click(ui.getByRole('button', { name: /Sparse attention/ }))
    fireEvent.click(ui.getByRole('button', { name: /Unbound/ }))
    await settle()
    expect(h.calls).toContain('open:session-b@w')
    expect(h.created).toEqual([{ root: '/research/u', title: 'Unbound', brief: '' }])
    cleanup()
    const rebound = { ...unbound, sessionId: 'session-new' }
    const binding = { ...h.props, create: () => Promise.resolve(rebound) } as unknown as WorkbenchProps
    fireEvent.click(render(<ResearchProjects {...binding} wide />).getByRole('button', { name: /Unbound/ }))
    await settle()
    expect(h.calls).toContain('open:session-new@u')
    cleanup()
    const expanded: string[] = []
    const sessionless = {
      ...h.props, create: () => Promise.resolve(unbound), expand: (id: string) => { expanded.push(id) },
    } as unknown as WorkbenchProps
    fireEvent.click(render(<ResearchProjects {...sessionless} wide />).getByRole('button', { name: /Unbound/ }))
    await settle()
    expect(expanded).toEqual([unbound.id])
    cleanup()
    const refusing = {
      ...h.props, create: () => Promise.reject(new Error('folder is gone')), openConversation: () => Promise.reject(new Error('session list unavailable')),
    } as unknown as WorkbenchProps
    const failing = render(<ResearchProjects {...refusing} wide />)
    fireEvent.click(failing.getByRole('button', { name: /Unbound/ }))
    await settle()
    expect(failing.getByRole('alert').textContent).toBe(failed('folder is gone'))
    fireEvent.click(failing.getByRole('button', { name: /Sparse attention/ }))
    await settle()
    expect(failing.getByRole('alert').textContent).toBe(failed('session list unavailable'))
    cleanup()
    // An example, however recent, lists after the person's own researches, and says it is one.
    const example = { ...newProject({ root: '/home/demo/x', title: 'Shipped example', brief: '' }, 'x' as WorkspaceId), example: true, updatedAt: '2026-09-30T00:00:00.000Z' }
    const listed = render(<ResearchProjects {...harness([example, bound, unbound]).props} wide />)
    expect(listed.getAllByRole('button').map(button => button.textContent)).toEqual([
      expect.stringMatching(/^Unbound/) as unknown,
      expect.stringMatching(/^Sparse attention/) as unknown,
      expect.stringMatching(/^Shipped example/) as unknown,
    ])
    expect(listed.getByRole('button', { name: /Shipped example/ }).textContent).toContain(zh.exampleTag)
    cleanup()
    expect(render(<ResearchProjects {...harness([]).props} wide />).getByText(zh.heroNoHistory)).toBeTruthy()
    cleanup()
    const loading = harness([])
    loading.view.snapshot = null
    expect(render(<ResearchProjects {...loading.props} wide />).getByText(zh.heroNoHistory)).toBeTruthy()
  })
})

describe('matching a session to its project, and the helpers the surfaces share', () => {
  it('prefers the bound project, then the innermost folder containing the session', () => {
    const outer = { root: 'C:\\Research', sessionId: 'x' }
    const inner = { root: 'C:\\Research\\Paper\\', sessionId: undefined }
    const posix = { root: '/data/Paper' }
    expect(sessionProject([outer, inner], 'x')).toBe(outer)
    expect(sessionProject([outer, inner], 'y', { y: 'c:/research/paper/sections' })).toBe(inner)
    expect(sessionProject([outer, inner], 'y', { y: 'D:/elsewhere' })).toBeUndefined()
    expect(sessionProject([posix], 'y', { y: '/data/paper' })).toBeUndefined()
    expect(sessionProject([posix], 'y', { y: '/data/Paper' })).toBe(posix)
    expect(sessionProject([posix], 'y')).toBeUndefined()
    expect(sessionProject(undefined, 'y', { y: '/data' })).toBeUndefined()
  })

  it('addresses project files for the native sidebar, drive, POSIX and UNC alike', () => {
    expect(projectFileAddress('C:\\Research\\p\\', '.\\paper\\main.pdf')).toBe('dsh-resource://file/absolute/C:/Research/p/paper/main.pdf')
    expect(projectFileAddress('/home/me/p', 'figures/a b#1.png')).toBe('dsh-resource://file/absolute/home/me/p/figures/a%20b%231.png')
    expect(projectFileAddress('\\\\server\\share\\p', 'x.pdf')).toBe('dsh-resource://file/absolute//server/share/p/x.pdf')
  })

  it('names modes, routes and phases in the interface language, and where a project stands', () => {
    const english = ((key: string) => (en as Record<string, string>)[key] ?? key) as Translate
    expect([packText({ en: 'Plan', zh: '规划' }, t), packText({ en: 'Plan', zh: '规划' }, english)]).toEqual(['规划', 'Plan'])
    expect([modeName(MODES, 'general', t), modeName(MODES, 'general', english), modeName(MODES, 'retired', t)]).toEqual(['通用', 'General', 'retired'])
    expect(modePhases(MODES, { mode: 'general' })).toEqual([])
    expect(modePhases(MODES, { mode: 'retired' })).toEqual([])
    expect(modePhases(MODES, { mode: 'spark-to-paper' })).toEqual(['plan', 'cite', 'experiments'])
    expect(modePhases(MODES, { mode: 'spark-to-paper', route: 'data' })).toEqual(['data', 'plan', 'cite'])
    expect(modePhases([{ ...MODES[1]!, defaultRoute: undefined }], { mode: 'spark-to-paper' })).toEqual(['plan', 'cite'])
    expect([modeChoice('general'), modeChoice('spark-to-paper', 'data')]).toEqual(['general', 'spark-to-paper/data'])
    expect([parseModeChoice('general'), parseModeChoice('spark-to-paper/data')]).toEqual([{ mode: 'general' }, { mode: 'spark-to-paper', route: 'data' }])
    const form = (value?: string): FormData => { const data = new FormData(); if (value !== undefined) data.set('mode', value); return data }
    expect([chosenMode(form('spark-to-paper/idea')), chosenMode(form('')), chosenMode(form())]).toEqual([{ mode: 'spark-to-paper', route: 'idea' }, {}, {}])

    const project = newProject({ root: '/r', title: 'T', brief: '', mode: 'spark-to-paper', route: 'data' }, 'w' as WorkspaceId)
    expect(standingText(project, MODES, t)).toBe('spark-to-paper')
    project.standing = standingOf([['data', 'done']], { finished: true })
    expect(standingText(project, MODES, t)).toBe(`spark-to-paper · ${zh.standingFinished}`)
    project.standing = standingOf([['data', 'done'], ['plan', 'current']])
    expect(standingText(project, MODES, t)).toBe('spark-to-paper · 规划 1/2')
    expect(useModes(harness([]).props)).toBe(MODES)
    const loading = harness([])
    loading.view.snapshot = null
    expect(useModes(loading.props)).toEqual([])
  })
})
