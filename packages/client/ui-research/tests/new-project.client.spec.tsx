// @vitest-environment jsdom

/** Creating a research project from a browser or native desktop composer. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
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
const WORKSPACE = 'workspace' as WorkspaceId
const roots: string[] = []
afterEach(async () => {
  cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const t = (key: string, params?: Record<string, unknown>): string => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}
const failed = (reason: string): string => t('actionFailed', { reason })

interface Recorder {
  created: CreateProjectRequest[]
  commands: ResearchCommand[]
  picked: string | null
  draft: string
  existing?: ResearchProject
  directories: Record<string, string>
  failCreate?: boolean
  opened: [string, string][]
  expanded: [string, string | undefined][]
  boundSession?: string
}

function recorder(over: Partial<Recorder> = {}): Recorder {
  return { created: [], commands: [], picked: '/tmp/sparse-attention', draft: '', directories: {}, opened: [], expanded: [], ...over }
}

function propsFor(log: Recorder): WorkbenchProps & SessionSeatProps & NewProjectOwnerProps {
  const snapshot = { projects: log.existing ? [log.existing] : [], preferences: {}, components: [], modes: MODES }
  const view = { snapshot, tasks: [], response: null }
  return {
    sessionId: SESSION,
    t,
    useResearch: (select: (value: typeof view) => unknown) => select(view),
    useInput: (select: (state: { draft: string }) => string) => select({ draft: log.draft }),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select(log.directories),
    pickDirectory: () => Promise.resolve(log.picked),
    create: (request: CreateProjectRequest) => {
      log.created.push(request)
      if (log.failCreate) return Promise.reject(new Error('the folder is not writable'))
      const created = newProject(request, WORKSPACE)
      if (log.boundSession !== undefined) created.sessionId = log.boundSession
      return Promise.resolve(created)
    },
    run: (command: ResearchCommand) => { log.commands.push(command); return Promise.resolve({ message: '' }) },
    expand: (projectId: string, panel?: string) => { log.expanded.push([projectId, panel]) },
    openConversation: (sessionId: string, workspaceId: string) => { log.opened.push([sessionId, workspaceId]); return Promise.resolve() },
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

/** Let the work a press started run its first step. */
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('starting a project from the composer', () => {
  it('keeps the draft as the brief, creates with the chosen mode and autonomy, starts nothing, and opens the project conversation in its workspace', async () => {
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
    expect(log.opened).toEqual([['session-project', WORKSPACE]])
    expect(log.expanded).toEqual([])
  })

  it('starts in the general mode by default, with checkpoint autonomy, and shows an unbound project on its workflow page', async () => {
    const log = recorder()
    const view = render(<ResearchNewProject {...propsFor(log)} />)
    openForm(view)
    submitForm(view, '/research/default')
    await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
    expect(log.created).toEqual([{ title: 'Sparse attention', root: '/research/default', brief: '', mode: 'general', autonomy: 'checkpoints' }])
    expect(log.expanded).toEqual([[expect.any(String) as unknown, 'workflow']])
    expect(log.opened).toEqual([])
  })

  it('fills a native-picked directory without creating until confirmation, and holds the picker off while it is open', async () => {
    const log = recorder()
    const picking = deferred<string | null>()
    const view = render(<ResearchNewProject {...propsFor(log)} pickDirectory={() => picking.promise} />)
    openForm(view)
    fireEvent.click(view.getByRole('button', { name: zh.pickDirectory }))
    expect(view.getByRole('button', { name: zh.pickDirectory })).toHaveProperty('disabled', true)
    // The rest of the form stays usable while the picker is up.
    expect(view.getByRole('button', { name: zh.create })).toHaveProperty('disabled', false)
    await act(async () => { picking.resolve('C:\\Research\\project'); await picking.promise })
    await waitFor(() => { expect(view.getByLabelText(zh.directory)).toHaveProperty('value', 'C:\\Research\\project') })
    expect(view.getByRole('button', { name: zh.pickDirectory })).toHaveProperty('disabled', false)
    expect(log.created).toEqual([])
    fireEvent.click(view.getByRole('button', { name: zh.cancel }))
    expect(view.queryByRole('dialog')).toBeNull()
    expect(log.commands).toEqual([])
  })

  it('says why the native picker failed beside it, and still accepts a typed directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'research-browser-new-'))
    roots.push(root)
    const log = recorder()
    const view = render(<ResearchNewProject {...propsFor(log)} pickDirectory={() => Promise.reject(new Error('native picker unavailable'))} />)
    openForm(view)
    fireEvent.click(view.getByRole('button', { name: zh.pickDirectory }))
    expect((await view.findByRole('alert')).textContent).toBe(failed('native picker unavailable'))
    expect(view.getByRole('button', { name: zh.pickDirectory })).toHaveProperty('disabled', false)
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
    await waitFor(() => { expect(view.getByRole('button', { name: zh.pickDirectory })).toHaveProperty('disabled', false) })
    expect(view.getByLabelText(zh.directory)).toHaveProperty('value', '/research/existing')
    expect(view.queryByRole('alert')).toBeNull()
    expect(log.created).toEqual([])
  })

  it('shows a rejected create in the form, leaves it open for correction, and forgets the failure when the form is opened afresh', async () => {
    const log = recorder({ failCreate: true })
    const view = render(<ResearchNewProject {...propsFor(log)} />)
    openForm(view)
    submitForm(view, '/research/refused')
    expect((await view.findByRole('alert')).textContent).toBe(failed('the folder is not writable'))
    expect(view.getByRole('dialog')).toBeTruthy()
    expect(view.getByRole('button', { name: zh.create })).toHaveProperty('disabled', false)
    expect(log.commands).toEqual([])
    fireEvent.click(view.getByRole('button', { name: zh.cancel }))
    openForm(view)
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('keeps the form open with the reason when the new project conversation cannot be shown', async () => {
    const log = recorder({ boundSession: 'session-project' })
    const view = render(<ResearchNewProject {...propsFor(log)} openConversation={() => Promise.reject(new Error('session list unavailable'))} />)
    openForm(view)
    submitForm(view, '/research/unlisted')
    expect((await view.findByRole('alert')).textContent).toBe(failed('session list unavailable'))
    expect(view.getByRole('dialog')).toBeTruthy()
    expect(log.created).toHaveLength(1)
  })

  it('holds off both the create button and the entry while project creation is pending', async () => {
    const creating = deferred<ResearchProject>()
    const view = render(<ResearchNewProject {...propsFor(recorder())} create={() => creating.promise} />)
    openForm(view)
    submitForm(view, '/research/pending')
    expect(view.getByRole('button', { name: zh.newProjectBusy })).toHaveProperty('disabled', true)
    expect(view.getByRole('button', { name: zh.newProjectDirectory })).toHaveProperty('disabled', true)
    await act(async () => { creating.resolve(newProject({ title: 'Pending', root: '/research/pending', brief: '' }, WORKSPACE)); await creating.promise })
    await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
    expect(view.getByRole('button', { name: zh.newProjectDirectory })).toHaveProperty('disabled', false)
  })

  it('ignores a second submission of the same form while the first is in flight', async () => {
    const creating = deferred<ResearchProject>()
    let calls = 0
    const create = (): Promise<ResearchProject> => { calls += 1; return creating.promise }
    const view = render(<ResearchNewProject {...propsFor(recorder())} create={create} />)
    openForm(view)
    submitForm(view, '/research/twice')
    fireEvent.submit(view.getByRole('button', { name: zh.newProjectBusy }).closest('form')!)
    await settle()
    expect(calls).toBe(1)
    await act(async () => { creating.resolve(newProject({ title: 'Twice', root: '/research/twice', brief: '' }, WORKSPACE)); await creating.promise })
    await waitFor(() => { expect(view.queryByRole('dialog')).toBeNull() })
    expect(calls).toBe(1)
  })

  it('is absent in a conversation that works in a project, bound or by its folder, and available in an unattached one', () => {
    const project = newProject({ root: '/research/project', title: 'Sparse attention', brief: '' }, WORKSPACE)
    project.sessionId = SESSION
    const view = render(<ResearchNewProject {...propsFor(recorder({ existing: project }))} />)
    expect(view.queryByRole('button')).toBeNull()
    project.sessionId = 'another-session'
    view.rerender(<ResearchNewProject {...propsFor(recorder({ existing: project, directories: { [SESSION]: '/research/project/paper' } }))} />)
    expect(view.queryByRole('button')).toBeNull()
    view.rerender(<ResearchNewProject {...propsFor(recorder({ existing: project }))} />)
    expect(view.getByRole('button', { name: zh.newProjectDirectory })).toBeTruthy()
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
