// @vitest-environment jsdom

/** Creating a research project from a browser or native desktop composer. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { CreateProjectRequest, ResearchCommand, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchNewProject, type NewProjectOwnerProps } from '../src/client/NewProject.tsx'
import type { SessionSeatProps, WorkbenchProps } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'
import { MODES } from './fixtures/modes.ts'

const SESSION = 'session-new'
const roots: string[] = []
afterEach(async () => {
  cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface Recorder {
  created: CreateProjectRequest[]
  commands: ResearchCommand[]
  picked: string | null
  draft: string
  existing?: ResearchProject
  failCreate?: boolean
  opened: string[]
  expanded: string[]
  boundSession?: string
}

function recorder(over: Partial<Recorder> = {}): Recorder {
  return { created: [], commands: [], picked: '/tmp/sparse-attention', draft: '', opened: [], expanded: [], ...over }
}

function propsFor(log: Recorder): WorkbenchProps & SessionSeatProps & NewProjectOwnerProps {
  const view = { snapshot: { projects: log.existing ? [log.existing] : [], preferences: {}, components: [], modes: MODES }, tasks: [], busy: false, error: '', response: null }
  return {
    sessionId: SESSION,
    t: (key: string) => (zh as Record<string, string>)[key] ?? key,
    useResearch: (select: (value: typeof view) => unknown) => select(view),
    useInput: (select: (state: { draft: string }) => string) => select({ draft: log.draft }),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
    pickDirectory: () => Promise.resolve(log.picked),
    create: (request: CreateProjectRequest) => {
      log.created.push(request)
      if (log.failCreate) return Promise.reject(new Error('the folder is not writable'))
      const created = newProject(request, 'workspace' as WorkspaceId)
      if (log.boundSession !== undefined) created.sessionId = log.boundSession
      return Promise.resolve(created)
    },
    run: (command: ResearchCommand) => { log.commands.push(command); return Promise.resolve({ message: '' }) },
    expand: (projectId: string) => { log.expanded.push(projectId) },
    openConversation: (sessionId: string) => { log.opened.push(sessionId); return Promise.resolve() },
  } as unknown as WorkbenchProps & SessionSeatProps & NewProjectOwnerProps
}

function openForm(view: ReturnType<typeof render>): void {
  fireEvent.click(view.getByRole('button', { name: zh.newProjectDirectory }))
}

function submitForm(view: ReturnType<typeof render>, root: string): void {
  fireEvent.change(view.getByLabelText(zh.title), { target: { value: 'Sparse attention' } })
  fireEvent.change(view.getByLabelText(zh.directory), { target: { value: root } })
  fireEvent.submit(view.getByRole('button', { name: zh.create }).closest('form')!)
}

describe('starting a project from the composer', () => {
  it('keeps the draft as the brief, creates with the chosen mode and autonomy, starts nothing, and opens the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-new-'))
    roots.push(root)
    const log = recorder({ draft: '  块稀疏能否保住长上下文准确率  ', boundSession: 'session-project' })
    const view = render(<ResearchNewProject {...propsFor(log)} />)
    openForm(view)
    expect(log.created).toEqual([])
    expect(view.getByLabelText(zh.brief)).toHaveProperty('value', '块稀疏能否保住长上下文准确率')
    fireEvent.change(view.getByLabelText(zh.mode), { target: { value: 'spark-to-paper/data' } })
    fireEvent.change(view.getByLabelText(zh.autonomy), { target: { value: 'automatic' } })
    submitForm(view, root)
    await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
    expect(log.created).toEqual([{ title: 'Sparse attention', root, brief: '块稀疏能否保住长上下文准确率', mode: 'spark-to-paper', route: 'data', autonomy: 'automatic' }])
    // Creating a project sends nothing to the model: the conversation does the work.
    expect(log.commands).toEqual([])
    expect(log.opened).toEqual(['session-project'])
  })

  it('starts in the general mode by default, with checkpoint autonomy, and shows an unbound project in the workbench', async () => {
    const log = recorder()
    const view = render(<ResearchNewProject {...propsFor(log)} />)
    openForm(view)
    submitForm(view, '/research/default')
    await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
    expect(log.created).toEqual([{ title: 'Sparse attention', root: '/research/default', brief: '', mode: 'general', autonomy: 'checkpoints' }])
    expect(log.expanded).toHaveLength(1)
  })

  it('fills a native-picked directory without creating until confirmation', async () => {
    const log = recorder({ picked: 'C:\\Research\\project' })
    const view = render(<ResearchNewProject {...propsFor(log)} />)
    openForm(view)
    fireEvent.click(view.getByRole('button', { name: zh.pickDirectory }))
    await waitFor(() => { expect(view.getByLabelText(zh.directory)).toHaveProperty('value', log.picked) })
    expect(log.created).toEqual([])
    fireEvent.click(view.getByRole('button', { name: zh.cancel }))
    expect(log.commands).toEqual([])
  })

  it('allows typing the directory when a remote browser has no native picker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-browser-new-'))
    roots.push(root)
    const log = recorder()
    const base = propsFor(log)
    const view = render(<ResearchNewProject {...base} pickDirectory={() => Promise.reject(new Error('native picker unavailable'))} />)
    openForm(view)
    fireEvent.click(view.getByRole('button', { name: zh.pickDirectory }))
    expect((await view.findByRole('alert')).textContent).toContain('native picker unavailable')
    submitForm(view, root)
    await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
    expect(log.created[0]?.root).toBe(root)
  })

  it('retains the entered directory when the native picker is dismissed', async () => {
    const log = recorder({ picked: null })
    const view = render(<ResearchNewProject {...propsFor(log)} />)
    openForm(view)
    fireEvent.change(view.getByLabelText(zh.directory), { target: { value: '/research/existing' } })
    fireEvent.click(view.getByRole('button', { name: zh.pickDirectory }))
    await waitFor(() => { expect(view.getByLabelText(zh.directory)).toHaveProperty('value', '/research/existing') })
    expect(log.created).toEqual([])
  })

  it('shows a rejected create and leaves the form available for correction', async () => {
    const log = recorder({ failCreate: true })
    const view = render(<ResearchNewProject {...propsFor(log)} />)
    openForm(view)
    submitForm(view, '/research/refused')
    expect((await view.findByRole('alert')).textContent).toContain('the folder is not writable')
    expect(view.getByRole('button', { name: zh.create })).toHaveProperty('disabled', false)
    expect(log.commands).toEqual([])
  })

  it('disables another submission while project creation is pending', async () => {
    let resolveCreate: (project: ResearchProject) => void = () => {}
    const log = recorder()
    const base = propsFor(log)
    const view = render(<ResearchNewProject {...base} create={() => new Promise((resolve) => { resolveCreate = resolve })} />)
    openForm(view)
    submitForm(view, '/research/pending')
    expect(view.getByRole('button', { name: zh.newProjectBusy })).toHaveProperty('disabled', true)
    resolveCreate(newProject({ title: 'Pending', root: '/research/pending', brief: '' }, 'workspace' as WorkspaceId))
    await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
  })

  it('is absent for its own project but available in an unattached conversation', () => {
    const project = newProject({ root: '/research/project', title: 'Sparse attention', brief: '' }, 'workspace' as WorkspaceId)
    project.sessionId = SESSION
    const view = render(<ResearchNewProject {...propsFor(recorder({ existing: project }))} />)
    expect(view.queryByRole('button')).toBeNull()
    project.sessionId = 'another-session'
    view.rerender(<ResearchNewProject {...propsFor(recorder({ existing: project }))} />)
    expect(view.getByRole('button', { name: zh.newProjectDirectory })).toBeTruthy()
  })

  it('ignores a second submission of the same form while the first is in flight', async () => {
    let resolveCreate: (project: ResearchProject) => void = () => {}
    const log = recorder()
    const base = propsFor(log)
    let calls = 0
    const create = (): Promise<ResearchProject> => { calls += 1; return new Promise((resolve) => { resolveCreate = resolve }) }
    const view = render(<ResearchNewProject {...base} create={create} />)
    openForm(view)
    submitForm(view, '/research/twice')
    fireEvent.submit(view.getByRole('button', { name: zh.newProjectBusy }).closest('form')!)
    expect(calls).toBe(1)
    resolveCreate(newProject({ title: 'Twice', root: '/research/twice', brief: '' }, 'workspace' as WorkspaceId))
    await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
  })

  it('still opens when the stylesheet ships no class for the dialog', async () => {
    vi.resetModules()
    vi.doMock('../src/client/ProjectEntry.module.css', () => ({ default: {} }))
    const { ResearchNewProject: Unstyled } = await import('../src/client/NewProject.tsx')
    const view = render(<Unstyled {...propsFor(recorder())} />)
    fireEvent.click(view.getByRole('button', { name: zh.newProjectDirectory }))
    expect(view.getByRole('dialog')).toBeTruthy()
    vi.doUnmock('../src/client/ProjectEntry.module.css')
  })
})
