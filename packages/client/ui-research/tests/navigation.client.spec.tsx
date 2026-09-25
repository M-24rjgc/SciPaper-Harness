// @vitest-environment jsdom
/** Navigation and forms must preserve project identity and backend command fields. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ResearchProject, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ResearchView, WorkbenchProps } from '../src/client/contract.ts'
import { EnvironmentForm } from '../src/client/EnvironmentForm.tsx'
import { ResearchProjectEntry } from '../src/client/ProjectEntry.tsx'
import { Workbench } from '../src/client/Workbench.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const project = newProject({ title: '研究乙', root: '/research/b', brief: 'test' }, 'b' as WorkspaceId)
const other = newProject({ title: '研究甲', root: '/research/a', mode: 'spark-to-paper', brief: 'test' }, 'a' as WorkspaceId)
const t = (key: keyof typeof zh, values?: Record<string, string | number>): string =>
  zh[key].replace(/\{(\w+)\}/g, (_, k: string) => String(values?.[k] ?? k))
/** The line a refused action leaves under its control. */
const failed = (reason: string): string => t('actionFailed', { reason })

function props() {
  const snapshot = { projects: [other, project], preferences: {}, components: [], modes: [] }
  const view: ResearchView = { snapshot, tasks: [], response: null }
  return {
    t,
    useResearch: (selector: (v: ResearchView) => unknown) => selector(view),
    useFocus: () => ({ claim: null, projectId: project.id, panel: 'artifacts' }),
    create: vi.fn().mockResolvedValue(project), run: vi.fn().mockResolvedValue({ message: '' }),
    openConversation: vi.fn().mockResolvedValue(undefined),
    expand: vi.fn(), pickDirectory: vi.fn().mockResolvedValue('/research/b'), focusClaim: vi.fn(), refresh: vi.fn(),
  } as unknown as WorkbenchProps
}

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

it('opens files for the project selected by navigation, not the first snapshot row', () => {
  const p = props()
  const ui = render(<Workbench {...p} />)
  expect((ui.getByLabelText(zh.projects) as HTMLSelectElement).value).toBe(project.id)
  expect(ui.getByRole('button', { name: zh.artifacts }).getAttribute('aria-current')).toBe('page')
})

describe('the new project dialog', () => {
  const openDialog = (ui: ReturnType<typeof render>): void => { fireEvent.click(ui.getByRole('button', { name: zh.newProjectDirectory })) }
  const fill = (ui: ReturnType<typeof render>, root: string): void => {
    fireEvent.change(ui.getByLabelText(zh.title), { target: { value: '研究乙' } })
    fireEvent.change(ui.getByLabelText(zh.directory), { target: { value: root } })
  }

  it('creates a project from a typed folder without starting unrequested model work', async () => {
    const p = props()
    const ui = render(<ResearchProjectEntry {...p} />)
    const entry = ui.getByRole('button', { name: zh.newProjectDirectory })
    expect(entry.textContent).toBe(zh.newProjectDirectory)
    openDialog(ui)
    fill(ui, ' /research/b ')
    fireEvent.change(ui.getByLabelText(zh.brief), { target: { value: '检验研究问题' } })
    fireEvent.click(ui.getByRole('button', { name: zh.create }))
    await waitFor(() => { expect(p.expand).toHaveBeenCalledWith(project.id, 'workflow') })
    expect(p.create).toHaveBeenCalledWith({ title: '研究乙', root: '/research/b', brief: '检验研究问题', autonomy: 'checkpoints' })
    expect(p.run).not.toHaveBeenCalled()
    expect(p.openConversation).not.toHaveBeenCalled()
    await waitFor(() => { expect(ui.queryByRole('dialog')).toBeNull() })
  })

  it('shows the conversation a new project was bound to, in the project\'s own folder', async () => {
    const p = props()
    vi.mocked(p.create).mockResolvedValue({ ...project, sessionId: 'session-new' })
    const ui = render(<ResearchProjectEntry {...p} />)
    openDialog(ui)
    fill(ui, '/research/b')
    fireEvent.change(ui.getByLabelText(zh.autonomy), { target: { value: 'automatic' } })
    fireEvent.click(ui.getByRole('button', { name: zh.create }))
    await waitFor(() => { expect(ui.queryByRole('dialog')).toBeNull() })
    expect(p.create).toHaveBeenCalledWith({ title: '研究乙', root: '/research/b', brief: '', autonomy: 'automatic' })
    expect(p.openConversation).toHaveBeenCalledWith('session-new', project.workspaceId)
    expect(p.expand).not.toHaveBeenCalled()
  })

  it('fills the folder from the host picker, keeps it when the picker is dismissed, and says why a pick failed', async () => {
    const p = props()
    const picking = deferred<string | null>()
    vi.mocked(p.pickDirectory).mockReturnValueOnce(picking.promise).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('no picker on this host'))
    const ui = render(<ResearchProjectEntry {...p} />)
    openDialog(ui)
    const folder = ui.getByLabelText(zh.directory) as HTMLInputElement
    fireEvent.click(ui.getByRole('button', { name: zh.pickDirectory }))
    expect(ui.getByRole('button', { name: zh.pickDirectory })).toHaveProperty('disabled', true)
    await act(async () => { picking.resolve('/research/picked'); await picking.promise })
    await waitFor(() => { expect(folder.value).toBe('/research/picked') })
    expect(ui.getByRole('button', { name: zh.pickDirectory })).toHaveProperty('disabled', false)
    fireEvent.click(ui.getByRole('button', { name: zh.pickDirectory }))
    await waitFor(() => { expect(p.pickDirectory).toHaveBeenCalledTimes(2) })
    expect(folder.value).toBe('/research/picked')
    fireEvent.click(ui.getByRole('button', { name: zh.pickDirectory }))
    expect((await ui.findByRole('alert')).textContent).toBe(failed('no picker on this host'))
    expect(folder.value).toBe('/research/picked')
    // Opening the dialog afresh forgets the failed pick.
    fireEvent.click(ui.getByRole('button', { name: zh.cancel }))
    openDialog(ui)
    expect(ui.queryByRole('alert')).toBeNull()
  })

  it('keeps the dialog open with the reason when creation is refused, and forgets it when reopened', async () => {
    const p = props()
    vi.mocked(p.create).mockRejectedValue(new Error('the folder is not writable'))
    const ui = render(<ResearchProjectEntry {...p} />)
    openDialog(ui)
    fill(ui, '/research/refused')
    fireEvent.click(ui.getByRole('button', { name: zh.create }))
    expect((await ui.findByRole('alert')).textContent).toBe(failed('the folder is not writable'))
    expect(ui.getByRole('dialog')).toBeTruthy()
    expect((ui.getByLabelText(zh.directory) as HTMLInputElement).value).toBe('/research/refused')
    expect(ui.getByRole('button', { name: zh.create })).toHaveProperty('disabled', false)
    // Cancelling puts the keyboard back on the button that opened the dialog.
    fireEvent.click(ui.getByRole('button', { name: zh.cancel }))
    expect(ui.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(ui.getByRole('button', { name: zh.newProjectDirectory }))
    openDialog(ui)
    expect(ui.queryByRole('alert')).toBeNull()
  })

  it('holds both buttons while the project is set up, and ignores a second submission', async () => {
    const p = props()
    const creating = deferred<ResearchProject>()
    vi.mocked(p.create).mockReturnValue(creating.promise)
    const ui = render(<ResearchProjectEntry {...p} />)
    openDialog(ui)
    fill(ui, '/research/pending')
    fireEvent.click(ui.getByRole('button', { name: zh.create }))
    expect(ui.getByRole('button', { name: zh.newProjectBusy })).toHaveProperty('disabled', true)
    expect(ui.getByRole('button', { name: zh.newProjectDirectory })).toHaveProperty('disabled', true)
    fireEvent.submit(ui.getByRole('button', { name: zh.newProjectBusy }).closest('form')!)
    await act(async () => { creating.resolve(project); await creating.promise })
    await waitFor(() => { expect(ui.queryByRole('dialog')).toBeNull() })
    expect(ui.getByRole('button', { name: zh.newProjectDirectory })).toHaveProperty('disabled', false)
    expect(p.create).toHaveBeenCalledTimes(1)
  })

  it('starts from the composer draft when it opens beside the composer', () => {
    const p = props()
    const ui = render(<ResearchProjectEntry {...p} composerDraft="是否成立？" />)
    const entry = ui.getByRole('button', { name: zh.newProjectDirectory })
    expect(entry.textContent).toBe('')
    expect(entry.getAttribute('title')).toBe(zh.newProjectHint)
    openDialog(ui)
    expect((ui.getByLabelText(zh.brief) as HTMLTextAreaElement).value).toBe('是否成立？')
  })

  it('finishes quietly when the entry is gone before the project is set up', async () => {
    const p = props()
    const creating = deferred<ResearchProject>()
    vi.mocked(p.create).mockReturnValue(creating.promise)
    const ui = render(<ResearchProjectEntry {...p} />)
    openDialog(ui)
    fill(ui, '/research/b')
    fireEvent.click(ui.getByRole('button', { name: zh.create }))
    ui.unmount()
    await act(async () => { creating.resolve(project); await creating.promise })
    await waitFor(() => { expect(p.expand).toHaveBeenCalledWith(project.id, 'workflow') })
  })

  it('still opens when the stylesheet ships no class for the dialog', async () => {
    vi.resetModules()
    vi.doMock('../src/client/ProjectEntry.module.css', () => ({ default: {} }))
    const { ResearchProjectEntry: Unstyled } = await import('../src/client/ProjectEntry.tsx')
    const ui = render(<Unstyled {...props()} />)
    openDialog(ui)
    expect(ui.getByRole('dialog').className.split(' ')).toHaveLength(1)
    vi.doUnmock('../src/client/ProjectEntry.module.css')
  })
})

describe('the environment form', () => {
  it('preserves SSH targeting and never installs packages in an existing interpreter', async () => {
    const p = props()
    const ui = render(<EnvironmentForm {...p} />)
    fireEvent.click(ui.getByRole('button', { name: zh.newEnvironment }))
    fireEvent.change(ui.getByLabelText(zh.projects), { target: { value: project.id } })
    fireEvent.change(ui.getByLabelText(zh.environmentName), { target: { value: 'lab' } })
    fireEvent.change(ui.getByLabelText(zh.environmentKind), { target: { value: 'existing' } })
    fireEvent.change(ui.getByLabelText(zh.target), { target: { value: 'ssh' } })
    expect((ui.getByLabelText(zh.python) as HTMLInputElement).value).toBe('')
    fireEvent.change(ui.getByLabelText(zh.python), { target: { value: '/opt/venv/bin/python' } })
    fireEvent.change(ui.getByLabelText(zh.sshHost), { target: { value: 'lab-gpu' } })
    fireEvent.change(ui.getByLabelText(zh.remoteRoot), { target: { value: '/data/research/b' } })
    expect(ui.queryByLabelText(zh.requirements)).toBeNull()
    fireEvent.click(ui.getByRole('button', { name: zh.addEnvironment }))
    await waitFor(() => { expect(p.run).toHaveBeenCalledWith({ action: 'environment', projectId: project.id, environment: { name: 'lab', kind: 'existing', target: 'ssh', python: '/opt/venv/bin/python', requirements: [], sshHost: 'lab-gpu', remoteRoot: '/data/research/b', isDefault: true } }) })
  })

  it('locks the listed requirements of a managed local environment', async () => {
    const p = props()
    const ui = render(<EnvironmentForm {...p} />)
    fireEvent.click(ui.getByRole('button', { name: zh.newEnvironment }))
    const kinds = Array.from((ui.getByLabelText(zh.environmentKind) as HTMLSelectElement).options)
    expect(kinds.map(option => option.textContent)).toEqual([zh.managed, zh.existing, zh.conda])
    expect((ui.getByLabelText(zh.python) as HTMLInputElement).value).toBe('3.12')
    fireEvent.change(ui.getByLabelText(zh.environmentName), { target: { value: 'uv' } })
    fireEvent.change(ui.getByLabelText(zh.requirements), { target: { value: 'numpy\n\n torch==2.4 ' } })
    fireEvent.click(ui.getByLabelText(zh.defaultEnvironment))
    fireEvent.click(ui.getByRole('button', { name: zh.addEnvironment }))
    await waitFor(() => { expect(p.run).toHaveBeenCalledWith({ action: 'environment', projectId: other.id, environment: { name: 'uv', kind: 'uv', target: 'local', python: '3.12', requirements: ['numpy', 'torch==2.4'], isDefault: false } }) })
  })

  it('waits while the environment is prepared, then closes', async () => {
    const p = props()
    const preparing = deferred<ResearchResponse>()
    vi.mocked(p.run).mockReturnValue(preparing.promise)
    const ui = render(<EnvironmentForm {...p} />)
    const toggle = ui.getByRole('button', { name: zh.newEnvironment })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.change(ui.getByLabelText(zh.environmentName), { target: { value: 'lab' } })
    fireEvent.click(ui.getByRole('button', { name: zh.addEnvironment }))
    await waitFor(() => { expect(ui.getByRole('status').textContent).toBe(zh.running) })
    expect(ui.getByRole('button', { name: zh.addEnvironment })).toHaveProperty('disabled', true)
    await act(async () => { preparing.resolve({ message: 'ready' }); await preparing.promise })
    await waitFor(() => { expect(ui.queryByRole('button', { name: zh.addEnvironment })).toBeNull() })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps entered environment settings and says why the preparation failed', async () => {
    const p = props()
    vi.mocked(p.run).mockRejectedValue(new Error('Interpreter not found'))
    const ui = render(<EnvironmentForm {...p} />)
    fireEvent.click(ui.getByRole('button', { name: zh.newEnvironment }))
    fireEvent.change(ui.getByLabelText(zh.environmentName), { target: { value: 'default' } })
    fireEvent.click(ui.getByRole('button', { name: zh.addEnvironment }))
    expect((await ui.findByRole('alert')).textContent).toBe(failed('Interpreter not found'))
    expect((ui.getByLabelText(zh.environmentName) as HTMLInputElement).value).toBe('default')
    expect(ui.queryByRole('status')).toBeNull()
    expect(ui.getByRole('button', { name: zh.addEnvironment })).toHaveProperty('disabled', false)
  })

  it('offers nothing to add before a project exists, and ignores a submit once the project list is gone', () => {
    const p = props()
    const view = p.useResearch(s => s)
    const ui = render(<EnvironmentForm {...p} />)
    fireEvent.click(ui.getByRole('button', { name: zh.newEnvironment }))
    view.snapshot = { projects: [], preferences: {}, components: [], modes: [] }
    ui.rerender(<EnvironmentForm {...p} />)
    expect(ui.getByRole('button', { name: zh.newEnvironment })).toHaveProperty('disabled', true)
    fireEvent.submit(ui.getByRole('button', { name: zh.addEnvironment }).closest('form')!)
    expect(p.run).not.toHaveBeenCalled()
    cleanup()
    view.snapshot = null
    expect(render(<EnvironmentForm {...p} />).getByRole('button', { name: zh.newEnvironment })).toHaveProperty('disabled', true)
  })
})
