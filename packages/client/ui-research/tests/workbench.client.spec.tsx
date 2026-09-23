// @vitest-environment jsdom

/**
 * The full workbench panel and the smaller pieces around it. Every command it
 * emits is handed to the validator the service parses commands with, so a
 * button that builds a request the service would refuse fails here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type {
  ArtifactId, CheckReport, EnvironmentId, EvidenceId, ResearchCommand, ResearchProject, ResearchResponse, ResearchTask,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchBrand, Workbench } from '../src/client/Workbench.tsx'
import { ContextCards } from '../src/client/ContextCards.tsx'
import { ResearchProjects } from '../src/client/ProjectEntry.tsx'
import { sessionProject, type ResearchFocus, type ResearchView, type WorkbenchProps } from '../src/client/contract.ts'
import { modeShortKey, projectFileAddress, standingText, type Translate } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as Translate

function fixture(): ResearchProject {
  const project = newProject({ root: '/research/sparse', title: 'Sparse attention', brief: 'Does it hold?', mode: 'paper-first' }, 'w' as WorkspaceId)
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

interface Harness {
  props: WorkbenchProps
  commands: ResearchCommand[]
  created: unknown[]
  calls: string[]
  view: ResearchView
}

function harness(
  projects: ResearchProject[], focus: ResearchFocus = { claimId: null }, respond?: (command: ResearchCommand) => ResearchResponse,
): Harness {
  const commands: ResearchCommand[] = []
  const created: unknown[] = []
  const calls: string[] = []
  const view: ResearchView = { snapshot: { projects, preferences: {}, components: [] }, tasks: [], busy: false, error: '', response: null }
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
    openConversation: (id: string) => { calls.push(`open:${id}`); return Promise.resolve() },
    focusClaim: (id: string | null) => { calls.push(`claim:${String(id)}`) },
    install: (component: string) => { calls.push(`install:${component}`); return Promise.resolve() },
    command: (session: string, line: string) => { calls.push(`command:${session}:${line}`); return Promise.resolve() },
    openFile: () => {},
    expand: () => {},
    configure: () => Promise.resolve(),
    pickDirectory: () => Promise.resolve(null),
  } as unknown as WorkbenchProps
  return { props, commands, created, calls, view }
}

const settle = async (): Promise<void> => { await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }) }

describe('the workbench panel', () => {
  it('offers a first project when there is none, and creates one with or without a mode', async () => {
    const empty = harness([])
    const ui = render(<Workbench {...empty.props} />)
    expect(ui.getByText(zh.noProjects)).toBeTruthy()
    fireEvent.click(ui.getAllByRole('button', { name: zh.newProject })[1]!)
    fireEvent.change(ui.getByLabelText(zh.title), { target: { value: 'New' } })
    fireEvent.change(ui.getByLabelText(zh.directory), { target: { value: '/research/new' } })
    fireEvent.change(ui.getByLabelText(zh.brief), { target: { value: 'b' } })
    fireEvent.submit(ui.getByRole('button', { name: zh.create }).closest('form')!)
    await settle()
    fireEvent.click(ui.getAllByRole('button', { name: zh.newProject })[0]!)
    fireEvent.change(ui.getByLabelText(zh.mode), { target: { value: 'free' } })
    fireEvent.change(ui.getByLabelText(zh.autonomy), { target: { value: 'automatic' } })
    fireEvent.submit(ui.getByRole('button', { name: zh.create }).closest('form')!)
    await settle()
    expect(empty.created).toEqual([
      { title: 'New', root: '/research/new', brief: 'b', autonomy: 'checkpoints' },
      { title: '', root: '', brief: '', mode: 'free', autonomy: 'automatic' },
    ])
    fireEvent.click(ui.getAllByRole('button', { name: zh.newProject })[0]!)
    fireEvent.click(ui.getByRole('button', { name: zh.cancel }))
    expect(ui.queryByRole('button', { name: zh.create })).toBeNull()
  })

  it('shows the overview with the project status, runs no pipeline without a session, and exports', async () => {
    const project = fixture()
    const other = newProject({ root: '/research/other', title: 'Other', brief: '' }, 'w' as WorkspaceId)
    const h = harness([project, other])
    h.view.error = 'something failed'
    h.view.tasks = [{ id: 't', kind: 'k', status: 'running', message: 'working', createdAt: '' } satisfies ResearchTask]
    const check: CheckReport = { clean: false, scope: 'all', phases: [], checkedAt: '', findings: [
      { check: 'cite', severity: 'error', message: 'Missing key', file: 'paper/main.tex', line: 3 },
      { check: 'review', severity: 'warning', message: 'No review', file: 'reviews/review.md' },
      { check: 'stale', severity: 'warning', message: 'Stale thing' },
    ] }
    h.view.response = { message: 'Checked', path: 'exports/x.zip', content: 'details', check }
    const ui = render(<Workbench {...h.props} />)
    expect(ui.getByRole('alert').textContent).toBe('something failed')
    expect(ui.getByText('Does it hold?')).toBeTruthy()
    expect(ui.queryByRole('button', { name: zh.pipelineRun })).toBeNull()
    expect(ui.getByText('Missing key — paper/main.tex:3')).toBeTruthy()
    expect(ui.getByText('No review — reviews/review.md')).toBeTruthy()
    expect(ui.getByText('Stale thing')).toBeTruthy()
    fireEvent.change(ui.getAllByRole('combobox')[2]!, { target: { value: 'automatic' } })
    fireEvent.click(ui.getByRole('button', { name: zh.exportPaper }))
    fireEvent.click(ui.getByRole('button', { name: zh.refresh }))
    await settle()
    expect(h.commands).toEqual([
      { action: 'set-autonomy', projectId: project.id, autonomy: 'automatic' },
      { action: 'export', projectId: project.id },
    ])
    // Without a bound session there is no conversation to switch the access preset in.
    expect(h.calls).toEqual(['refresh'])
    fireEvent.change(ui.getByLabelText(zh.projects), { target: { value: other.id } })
    expect(ui.getByRole('heading', { name: 'Other' })).toBeTruthy()
    cleanup()
    h.view.response = { message: 'Clean', check: { clean: true, scope: 'all', phases: [], checkedAt: '', findings: [] } }
    project.sessionId = 'session-p'
    const bound = render(<Workbench {...h.props} />)
    expect(bound.getByText(new RegExp(`^${zh.checkClean} · `))).toBeTruthy()
    fireEvent.click(bound.getByRole('button', { name: zh.openConversation }))
    fireEvent.click(bound.getByRole('button', { name: zh.pipelineRun }))
    expect(h.calls.slice(-2)).toEqual(['open:session-p', expect.stringMatching(/^command:session-p:\/goal /)])
  })

  it('imports and searches sources, previews a snapshot in place, and imports a found reference', async () => {
    const project = fixture()
    const item = { id: '10.1/x', provider: 'crossref' as const, title: 'Found paper', authors: ['A', 'B'], year: 2024, doi: '10.1/x', url: 'https://doi.org/10.1/x', abstract: 'About', bibtex: '' }
    const h = harness([project], { claimId: null, projectId: project.id, panel: 'sources' })
    h.view.response = { message: 'found', literature: [item, { ...item, id: 'no-doi', title: 'No DOI', doi: undefined }] }
    project.evidence.push({
      ...project.evidence[0]!, id: 'ref' as EvidenceId, title: 'Open paper', kind: 'literature', path: '.research/sources/ref/reference.json',
      originalPath: undefined, fullTextPath: '.research/sources/ref/fulltext.pdf', coverage: 'full-text', stale: false,
    })
    const ui = render(<Workbench {...h.props} />)
    fireEvent.change(ui.getByLabelText(zh.sourcePaths), { target: { value: 'data/a.csv\n\n notes.md ' } })
    fireEvent.submit(ui.getByRole('button', { name: zh.importSources }).closest('form')!)
    fireEvent.change(ui.getByLabelText(zh.query), { target: { value: 'sparse' } })
    fireEvent.submit(ui.getByRole('button', { name: zh.search }).closest('form')!)
    fireEvent.change(ui.getByLabelText(zh.source), { target: { value: 'arxiv' } })
    fireEvent.submit(ui.getByRole('button', { name: zh.search }).closest('form')!)
    fireEvent.click(ui.getAllByRole('button', { name: zh.importReference })[0]!)
    expect(ui.getByText('https://doi.org/10.1/x')).toBeTruthy()
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
    cleanup()
    const bare = newProject({ root: '/r', title: 'Bare', brief: '' }, 'w' as WorkspaceId)
    expect(render(<Workbench {...harness([bare], { claimId: null, panel: 'sources' }).props} />).getByText(zh.emptySources)).toBeTruthy()
  })

  it('edits, saves, adopts, compiles, previews and reviews project files', async () => {
    const project = fixture()
    const h = harness([project], { claimId: null, projectId: project.id, panel: 'artifacts', artifactId: 'main' })
    const ui = render(<Workbench {...h.props} />)
    await settle()
    const editor = ui.getByLabelText(zh.content) as HTMLTextAreaElement
    expect(editor.value).toBe('file text')
    fireEvent.change(editor, { target: { value: 'edited' } })
    expect(ui.getByText(zh.unsaved)).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: zh.save }))
    await settle()
    fireEvent.click(ui.getByRole('button', { name: zh.registerChanges }))
    await settle()
    fireEvent.click(ui.getByRole('button', { name: zh.visualReview }))
    fireEvent.submit(ui.getAllByRole('button', { name: zh.compile }).at(-1)!.closest('form')!)
    fireEvent.click(ui.getByRole('button', { name: zh.preview }))
    expect(ui.getByTitle(zh.preview).hasAttribute('sandbox')).toBe(false)
    fireEvent.click(ui.getByRole('button', { name: zh.close }))
    expect(ui.queryByTitle(zh.preview)).toBeNull()
    fireEvent.click(ui.getByRole('button', { name: zh.preview }))
    expect(ui.getByText('Legible')).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: zh.openConversation }))
    fireEvent.change(ui.getByLabelText(zh.imagePrompt), { target: { value: 'a picture' } })
    fireEvent.submit(ui.getByRole('button', { name: zh.generate }).closest('form')!)
    await settle()
    expect(h.commands.map(command => command.action)).toEqual([
      'read-artifact', 'save-artifact', 'register-artifact', 'read-artifact', 'visual-review', 'compile', 'generate-image',
    ])
    expect(h.calls).toContain('open:review-session')
    fireEvent.change(ui.getByLabelText(zh.chooseFile), { target: { value: 'code' } })
    await settle()
    fireEvent.click(ui.getByRole('button', { name: zh.preview }))
    expect(ui.getByTitle(zh.preview).getAttribute('sandbox')).toBe('')
    fireEvent.click(ui.getByRole('button', { name: zh.newArtifact }))
    fireEvent.change(ui.getByLabelText(zh.path), { target: { value: 'notes/new.md' } })
    fireEvent.change(ui.getByLabelText(zh.artifactKind), { target: { value: 'supplement' } })
    fireEvent.change(ui.getByLabelText(zh.chooseFile), { target: { value: 'ghost' } })
    fireEvent.click(ui.getByRole('button', { name: zh.save }))
    await settle()
    expect(h.commands.at(-1)).toMatchObject({ action: 'save-artifact', path: 'notes/new.md', kind: 'supplement', expectedRevision: 0 })
  })

  it('debounces draw.io autosaves into one save at a time, the latest winning', async () => {
    const project = fixture()
    let release: () => void = () => {}
    const saves: string[] = []
    const h = harness([project], { claimId: null, projectId: project.id, panel: 'artifacts', artifactId: 'arch' }, (command) => {
      if (command.action === 'save-artifact') saves.push(command.content)
      return { message: '', content: command.action === 'read-artifact' ? '<mxfile/>' : undefined }
    })
    const slow = { ...h.props, run: (command: ResearchCommand) => command.action === 'save-artifact'
      ? new Promise<ResearchResponse>((resolve) => { release = () => { resolve(h.props.run(command)) } })
      : h.props.run(command) } as unknown as WorkbenchProps
    const ui = render(<Workbench {...slow} />)
    await settle()
    const frame = ui.getByTitle(zh.diagram) as HTMLIFrameElement
    const post = (data: unknown, source: unknown = frame.contentWindow): void => {
      act(() => { window.dispatchEvent(new MessageEvent('message', { data, source: source as Window })) })
    }
    post(JSON.stringify({ event: 'init' }))
    expect(ui.queryByRole('button', { name: zh.install })).toBeNull()
    post('{broken', frame.contentWindow)
    post(JSON.stringify(7))
    post(JSON.stringify({ event: 'save' }))
    post(JSON.stringify({ event: 'save', xml: 'x' }), window)
    vi.useFakeTimers()
    post(JSON.stringify({ event: 'autosave', xml: 'first' }))
    post(JSON.stringify({ event: 'autosave', xml: 'second' }))
    act(() => { vi.advanceTimersByTime(1500) })
    // One save in flight; the next ones queue behind it and only the latest is written.
    post({ event: 'save', xml: 'third' })
    post({ event: 'save', xml: 'fourth' })
    vi.useRealTimers()
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
    const h = harness([project], { claimId: null, projectId: project.id, panel: 'artifacts', artifactId: 'arch' })
    const late = { ...h.props, run: (command: ResearchCommand) => command.action === 'read-artifact'
      ? new Promise<ResearchResponse>((resolve) => { answer = resolve })
      : h.props.run(command) } as unknown as WorkbenchProps
    const ui = render(<Workbench {...late} />)
    ui.unmount()
    await act(async () => { answer({ message: '', content: 'too late' }); await Promise.resolve() })
    const saves: string[] = []
    const again = harness([project], { claimId: null, projectId: project.id, panel: 'artifacts', artifactId: 'arch' }, (command) => {
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

  it('offers to install the editor until it answers, and survives a refused save', async () => {
    const project = fixture()
    const h = harness([project], { claimId: null, projectId: project.id, panel: 'artifacts', artifactId: 'arch' })
    const refusing = { ...h.props, run: (command: ResearchCommand) => command.action === 'save-artifact' ? Promise.reject(new Error('conflict')) : h.props.run(command) } as unknown as WorkbenchProps
    const ui = render(<Workbench {...refusing} />)
    await settle()
    fireEvent.click(ui.getByRole('button', { name: zh.install }))
    expect(h.calls).toContain('install:drawio')
    const frame = ui.getByTitle(zh.diagram) as HTMLIFrameElement
    act(() => { window.dispatchEvent(new MessageEvent('message', { data: { event: 'save', xml: 'x' }, source: frame.contentWindow as Window })) })
    await settle()
    expect(ui.getByTitle(zh.diagram)).toBeTruthy()
  })

  it('submits an experiment with a valid argument vector only, and acts on existing runs', async () => {
    const project = fixture()
    const h = harness([project], { claimId: null, projectId: project.id, panel: 'experiments' })
    const ui = render(<Workbench {...h.props} />)
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
    expect(h.commands[0]).toMatchObject({ action: 'experiment', spec: { argv: ['{python}', 'code/train.py'], gpuIds: ['0', '1'], environmentId: 'env', codeArtifactIds: [] } })
    for (const name of [zh.inspect, zh.stop, zh.logs]) fireEvent.click(ui.getByRole('button', { name }))
    expect(h.commands.slice(1).map(command => command.action)).toEqual(['experiment-refresh', 'experiment-cancel', 'experiment-logs'])
    cleanup()
    const bare = newProject({ root: '/r', title: 'Bare', brief: '' }, 'w' as WorkspaceId)
    expect(render(<Workbench {...harness([bare], { claimId: null, panel: 'experiments' }).props} />).getByText(zh.noExperiments)).toBeTruthy()
  })

  it('names the product in the native sidebar', () => {
    expect(render(<ResearchBrand t={t as never} />).container.textContent).toBe(zh.name)
  })

  it('opens a file that has no text, loads an empty diagram as a blank drawing, and absorbs refusals', async () => {
    const project = fixture()
    project.evidence.push({ ...project.evidence[0]!, id: 'fresh' as EvidenceId, title: 'fresh.csv', stale: false })
    const h = harness([project], { claimId: null, projectId: project.id, panel: 'artifacts', artifactId: 'arch' }, () => ({ message: '' }))
    const refusing = { ...h.props, refresh: () => Promise.reject(new Error('offline')) } as unknown as WorkbenchProps
    const ui = render(<Workbench {...refusing} />)
    await settle()
    fireEvent.click(ui.getByRole('button', { name: zh.refresh }))
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

  it('lists claims to open, and shows settings and tasks', () => {
    const project = fixture()
    const h = harness([project], { claimId: null, projectId: project.id, panel: 'claims' })
    h.view.tasks = [{ id: 'done', kind: 'k', status: 'completed', message: 'finished', createdAt: '' }]
    const ui = render(<Workbench {...h.props} />)
    fireEvent.click(ui.getByRole('button', { name: /It holds/ }))
    expect(h.calls).toEqual(['claim:claim'])
    expect(ui.getByText('finished')).toBeTruthy()
    for (const tab of [zh.workflow, zh.sources, zh.artifacts, zh.experiments, zh.claims]) fireEvent.click(ui.getByRole('button', { name: tab }))
    cleanup()
    const settings = render(<Workbench {...harness([project], { claimId: null, projectId: project.id, panel: 'settings' }).props} />)
    expect(settings.getByText(zh.settingsSubtitle)).toBeTruthy()
  })
})

describe('the context cards beside a conversation', () => {
  it('links the newest claim to its sources and the newest figure to its editor', () => {
    const project = fixture()
    project.claims.push({ id: 'c2', text: 'Newest', kind: 'literature', state: 'supported', artifactIds: [], evidence: [
      { evidenceId: 'data' as EvidenceId, revision: 2, locator: { page: 4 }, quote: 'q' },
      { evidenceId: 'data' as EvidenceId, revision: 2, locator: {}, quote: 'q' },
      { evidenceId: 'gone' as EvidenceId, revision: 1, locator: {}, quote: 'q' },
    ] })
    const calls: string[] = []
    const props = { ...harness([project]).props, focusClaim: (id: string) => { calls.push(id) }, expand: (_id: string, panel: string, artifact: string) => { calls.push(`${panel}:${artifact}`) } } as unknown as WorkbenchProps
    const ui = render(<ContextCards {...props} project={project} />)
    fireEvent.click(ui.getByRole('button', { name: 'Newest' }))
    fireEvent.click(ui.getByRole('button', { name: 'results.csv · 第 4 页' }))
    fireEvent.click(ui.getByRole('button', { name: 'results.csv' }))
    fireEvent.click(ui.getByRole('button', { name: zh.openEditor }))
    expect(calls).toEqual(['c2', 'c2', 'c2', 'artifacts:arch'])
    cleanup()
    project.artifacts.push({ ...project.artifacts[0]!, id: 'png' as ArtifactId, path: 'figures/plot.png', kind: 'figure' })
    project.claims.push({ id: 'c3', text: 'Bare', kind: 'hypothesis', state: 'proposed', evidence: [], artifactIds: [] })
    const second = render(<ContextCards {...props} project={project} />)
    expect(second.getByRole('img').getAttribute('src')).toContain('plot.png')
    expect(second.getByText(zh.claimNoSources)).toBeTruthy()
    cleanup()
    const empty = newProject({ root: '/r', title: 'E', brief: '' }, 'w' as WorkspaceId)
    expect(render(<ContextCards {...props} project={empty} />).container.textContent).toBe('')
  })
})

describe('the project list in the sidebar', () => {
  it('opens a bound project, binds an unbound one, and absorbs refusals', async () => {
    const bound = fixture()
    bound.sessionId = 'session-b'
    const unbound = newProject({ root: '/research/u', title: 'Unbound', brief: '' }, 'w' as WorkspaceId)
    bound.updatedAt = '2026-09-20T00:00:00.000Z'
    unbound.updatedAt = '2026-09-22T00:00:00.000Z'
    const h = harness([bound, unbound])
    expect(render(<ResearchProjects {...h.props} wide={false} />).container.textContent).toBe('')
    const ui = render(<ResearchProjects {...h.props} wide />)
    // The project worked on most recently comes first.
    expect(ui.getAllByRole('button').map(button => button.textContent)).toEqual([expect.stringMatching(/^Unbound/), expect.stringMatching(/^Sparse attention/)])
    fireEvent.click(ui.getByRole('button', { name: /Sparse attention/ }))
    fireEvent.click(ui.getByRole('button', { name: /Unbound/ }))
    await settle()
    expect(h.calls).toContain('open:session-b')
    expect(h.created).toEqual([{ root: '/research/u', title: 'Unbound', brief: '' }])
    cleanup()
    const rebound = { ...fixture(), sessionId: 'session-new' }
    const binding = { ...h.props, create: () => Promise.resolve(rebound) } as unknown as WorkbenchProps
    fireEvent.click(render(<ResearchProjects {...binding} wide />).getByRole('button', { name: /Unbound/ }))
    await settle()
    expect(h.calls).toContain('open:session-new')
    cleanup()
    const expanded: string[] = []
    const sessionless = {
      ...h.props, create: () => Promise.resolve(unbound), expand: (id: string) => { expanded.push(id) },
    } as unknown as WorkbenchProps
    fireEvent.click(render(<ResearchProjects {...sessionless} wide />).getByRole('button', { name: /Unbound/ }))
    await settle()
    expect(expanded).toEqual([unbound.id])
    cleanup()
    const refusing = { ...h.props, create: () => Promise.reject(new Error('no')), openConversation: () => Promise.reject(new Error('no')) } as unknown as WorkbenchProps
    const failing = render(<ResearchProjects {...refusing} wide />)
    fireEvent.click(failing.getByRole('button', { name: /Unbound/ }))
    fireEvent.click(failing.getByRole('button', { name: /Sparse attention/ }))
    await settle()
    expect(failing.getByText('Unbound')).toBeTruthy()
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

  it('names modes and where a project stands', () => {
    expect([undefined, 'paper-first', 'from-results', 'free'].map(mode => modeShortKey(mode as never)))
      .toEqual(['modeUnset', 'modeShortPaperFirst', 'modeShortFromResults', 'modeShortFree'])
    const project = newProject({ root: '/r', title: 'T', brief: '', mode: 'from-results' }, 'w' as WorkspaceId)
    expect(standingText(project, t)).toBe(zh.modeShortFromResults)
    project.lastCheck = { clean: true, scope: 'all', checkedAt: '', findings: [], phases: [{ id: 'ingest', done: true, missing: [] }] }
    expect(standingText(project, t)).toBe(`${zh.modeShortFromResults} · ${zh.checkClean}`)
    project.lastCheck.phases.push({ id: 'write', done: false, missing: [] })
    expect(standingText(project, t)).toBe(`${zh.modeShortFromResults} · ${zh.phase_write} 1/2`)
  })
})
