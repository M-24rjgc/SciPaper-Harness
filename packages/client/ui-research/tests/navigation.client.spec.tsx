// @vitest-environment jsdom
/** Navigation and forms must preserve project identity and backend command fields. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ResearchView, WorkbenchProps } from '../src/client/contract.ts'
import { EnvironmentForm } from '../src/client/EnvironmentForm.tsx'
import { ResearchProjectEntry } from '../src/client/ProjectEntry.tsx'
import { Workbench } from '../src/client/Workbench.tsx'
import { ResearchStarters } from '../src/client/Hero.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const project = newProject({ title: '研究乙', root: '/research/b', brief: 'test' }, 'b' as WorkspaceId)
const other = newProject({ title: '研究甲', root: '/research/a', mode: 'paper-first', brief: 'test' }, 'a' as WorkspaceId)
function props() {
  const view: ResearchView = { snapshot: { projects: [other, project], preferences: {}, components: [] }, tasks: [], busy: false, error: '', response: null }
  return {
    t: (key: keyof typeof zh, values?: Record<string, string | number>) =>
      zh[key].replace(/\{(\w+)\}/g, (_, k: string) => String(values?.[k] ?? k)),
    useResearch: (selector: (v: ResearchView) => unknown) => selector(view),
    useFocus: () => ({ claimId: null, projectId: project.id, panel: 'artifacts' }),
    create: vi.fn().mockResolvedValue(project), run: vi.fn().mockResolvedValue({ message: '' }),
    expand: vi.fn(), pickDirectory: vi.fn().mockResolvedValue('/research/b'), focusClaim: vi.fn(), refresh: vi.fn(),
  } as unknown as WorkbenchProps
}
it('shows all entry cards without a session binding', () => {
  const p = props()
  render(<ResearchStarters {...p} />)
  expect(document.body.textContent).toContain(zh.heroCardMaterials)
  expect(document.body.textContent).toContain(zh.heroCardIdea)
  expect(document.body.textContent).toContain(zh.heroCardResume)
})
it('opens files for the project selected by navigation, not the first snapshot row', () => {
  const p = props()
  const ui = render(<Workbench {...p} />)
  expect((ui.getByLabelText(zh.projects) as HTMLSelectElement).value).toBe(project.id)
  expect(ui.getByRole('button', { name: zh.artifacts }).getAttribute('aria-current')).toBe('page')
})
it('creates a project from a typed folder without starting unrequested model work', async () => {
  const p = props()
  const ui = render(<ResearchProjectEntry {...p} />)
  fireEvent.click(ui.getByRole('button', { name: zh.newProjectDirectory }))
  fireEvent.change(ui.getByLabelText(zh.title), { target: { value: '研究乙' } })
  fireEvent.change(ui.getByLabelText(zh.directory), { target: { value: '/research/b' } })
  fireEvent.change(ui.getByLabelText(zh.brief), { target: { value: '检验研究问题' } })
  fireEvent.click(ui.getByRole('button', { name: zh.create }))
  await waitFor(() => { expect(p.expand).toHaveBeenCalledWith(project.id, 'workflow') })
  expect(p.create).toHaveBeenCalledWith({ title: '研究乙', root: '/research/b', brief: '检验研究问题', autonomy: 'checkpoints' })
  expect(p.run).not.toHaveBeenCalled()
})
it('preserves SSH targeting and never installs packages in an existing interpreter', async () => {
  const p = props()
  const ui = render(<EnvironmentForm {...p} />)
  fireEvent.click(ui.getByRole('button', { name: zh.newEnvironment }))
  fireEvent.change(ui.getByLabelText(zh.projects), { target: { value: project.id } })
  fireEvent.change(ui.getByLabelText(zh.environmentName), { target: { value: 'lab' } })
  fireEvent.change(ui.getByLabelText(zh.environmentKind), { target: { value: 'existing' } })
  fireEvent.change(ui.getByLabelText(zh.target), { target: { value: 'ssh' } })
  fireEvent.change(ui.getByLabelText(zh.python), { target: { value: '/opt/venv/bin/python' } })
  fireEvent.change(ui.getByLabelText(zh.sshHost), { target: { value: 'lab-gpu' } })
  fireEvent.change(ui.getByLabelText(zh.remoteRoot), { target: { value: '/data/research/b' } })
  expect(ui.queryByLabelText(zh.requirements)).toBeNull()
  fireEvent.click(ui.getByRole('button', { name: zh.addEnvironment }))
  await waitFor(() => { expect(p.run).toHaveBeenCalledWith({ action: 'environment', projectId: project.id, environment: { name: 'lab', kind: 'existing', target: 'ssh', python: '/opt/venv/bin/python', requirements: [], sshHost: 'lab-gpu', remoteRoot: '/data/research/b', isDefault: true } }) })
})
it('keeps entered environment settings and exposes a failed request', async () => {
  const p = props()
  vi.mocked(p.run).mockRejectedValue(new Error('SSH unavailable'))
  const ui = render(<EnvironmentForm {...p} />)
  fireEvent.click(ui.getByRole('button', { name: zh.newEnvironment }))
  fireEvent.change(ui.getByLabelText(zh.environmentName), { target: { value: 'default' } })
  fireEvent.click(ui.getByRole('button', { name: zh.addEnvironment }))
  await waitFor(() => { expect(ui.getByRole('alert').textContent).toContain('SSH unavailable') })
  expect((ui.getByLabelText(zh.environmentName) as HTMLInputElement).value).toBe('default')
})

it('waits for the background environment result and preserves the form on failure', async () => {
  const p = props()
  const view = p.useResearch(s => s)
  vi.mocked(p.run).mockResolvedValue({ message: 'Queued', jobId: 'environment-job' })
  const ui = render(<EnvironmentForm {...p} />)
  fireEvent.click(ui.getByRole('button', { name: zh.newEnvironment }))
  fireEvent.change(ui.getByLabelText(zh.environmentName), { target: { value: 'lab' } })
  fireEvent.click(ui.getByRole('button', { name: zh.addEnvironment }))
  await waitFor(() => { expect((ui.getByRole('button', { name: zh.addEnvironment }) as HTMLButtonElement).disabled).toBe(true) })
  view.tasks = [{ id: 'environment-job', kind: 'environment', status: 'failed', message: 'Interpreter not found', createdAt: new Date().toISOString() }]
  ui.rerender(<EnvironmentForm {...p} />)
  expect(ui.getByRole('alert').textContent).toContain('Interpreter not found')
  expect((ui.getByLabelText(zh.environmentName) as HTMLInputElement).value).toBe('lab')
  expect((ui.getByRole('button', { name: zh.addEnvironment }) as HTMLButtonElement).disabled).toBe(false)
})

it('closes when the background environment task completes, and ignores a submit once the project list is gone', async () => {
  const p = props()
  const view = p.useResearch(s => s)
  vi.mocked(p.run).mockResolvedValue({ message: 'Queued', jobId: 'environment-job' })
  const ui = render(<EnvironmentForm {...p} />)
  fireEvent.click(ui.getByRole('button', { name: zh.newEnvironment }))
  fireEvent.change(ui.getByLabelText(zh.environmentName), { target: { value: 'lab' } })
  fireEvent.click(ui.getByRole('button', { name: zh.addEnvironment }))
  await waitFor(() => { expect(ui.getByRole('status').textContent).toBe(zh.running) })
  view.tasks = [{ id: 'environment-job', kind: 'environment', status: 'completed', message: 'ready', createdAt: new Date().toISOString() }]
  ui.rerender(<EnvironmentForm {...p} />)
  expect(ui.queryByRole('button', { name: zh.addEnvironment })).toBeNull()
  vi.mocked(p.run).mockClear()
  fireEvent.click(ui.getByRole('button', { name: zh.newEnvironment }))
  view.snapshot = { projects: [], preferences: {}, components: [] }
  ui.rerender(<EnvironmentForm {...p} />)
  fireEvent.submit(ui.getByRole('button', { name: zh.addEnvironment }).closest('form')!)
  expect(p.run).not.toHaveBeenCalled()
})
