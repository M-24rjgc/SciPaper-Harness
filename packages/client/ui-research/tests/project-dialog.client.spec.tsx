// @vitest-environment jsdom
/** Explicit project creation, confirmation boundaries and history assignment. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import type { ResearchCommand, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ProjectDialog, JoinProjectDialog } from '../src/client/ProjectDialog.tsx'
import { zh } from '../src/client/locales.ts'
import { translate } from './fixtures/translate.tsx'

afterEach(cleanup)
const t = translate(zh)
const project = newProject({ title: '文献比较', root: '/research/comparison', brief: '' }, 'w-comparison' as WorkspaceId)
function operations() {
  return {
    run: vi.fn(async (_request: ResearchCommand): Promise<ResearchResponse> => ({ message: 'created', sessionId: 'created-session' })),
    chooseFolder: vi.fn(async () => ({ kind: 'picked' as const, path: '/chosen/project' })),
    openResult: vi.fn(async (_result: ResearchResponse) => {}),
    onClose: vi.fn(),
  }
}
async function settle(): Promise<void> { await act(async () => { await Promise.resolve() }) }

it('opens and cancels without creating anything, and derives a child location from the project name', async () => {
  const props = operations()
  const view = render(<ProjectDialog {...props} t={t} home={'C:\\Research'} />)
  fireEvent.change(view.getByLabelText(zh.projectName), { target: { value: '文献比较' } })
  expect((view.getByLabelText(zh.projectLocation) as HTMLInputElement).value).toBe('C:\\Research/文献比较')
  fireEvent.click(view.getByRole('button', { name: zh.cancel }))
  await settle()
  expect(props.onClose).toHaveBeenCalledOnce()
  expect(props.run).not.toHaveBeenCalled()
})

it('keeps edits and errors visible, confirms populated folders only for the path inspected, and opens the successful result', async () => {
  const props = operations()
  props.run.mockRejectedValueOnce(new Error('Folder unavailable'))
    .mockResolvedValueOnce({ message: 'files', outcome: 'needs-confirm' })
    .mockResolvedValueOnce({ message: 'files', outcome: 'needs-confirm' })
  const view = render(<ProjectDialog {...props} t={t} home="/research" />)
  fireEvent.change(view.getByLabelText(zh.projectName), { target: { value: 'study' } })
  fireEvent.click(view.getByRole('button', { name: zh.projectCreate }))
  await settle()
  expect(view.getByRole('alert').textContent).toContain('Folder unavailable')
  expect(props.onClose).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: zh.projectCreate }))
  await settle()
  expect(view.getByRole('status').textContent).toBe(zh.projectNonEmpty)
  fireEvent.change(view.getByLabelText(zh.projectLocation), { target: { value: '/other/study' } })
  expect(view.queryByRole('status')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: zh.projectCreate }))
  await settle()
  expect(props.run).toHaveBeenLastCalledWith({ action: 'create-project', title: 'study', root: '/other/study' })
  fireEvent.click(view.getByRole('button', { name: zh.projectUseFolder }))
  await settle()
  expect(props.run).toHaveBeenLastCalledWith({ action: 'create-project', title: 'study', root: '/other/study', confirmNonEmpty: true })
  expect(props.openResult).toHaveBeenCalledWith({ message: 'created', sessionId: 'created-session' })
  expect(props.onClose).toHaveBeenCalledOnce()
})

it('shows an existing project before opening it and carries the source conversation identity', async () => {
  const props = operations()
  props.run.mockResolvedValueOnce({ message: 'exists', outcome: 'existing', project })
  const view = render(<ProjectDialog {...props} t={t} home="/research" sourceSessionId="ordinary" />)
  fireEvent.change(view.getByLabelText(zh.projectName), { target: { value: 'study' } })
  fireEvent.click(view.getByRole('button', { name: zh.projectPick }))
  await settle()
  fireEvent.click(view.getByRole('button', { name: zh.projectCreate }))
  await settle()
  expect(props.openResult).not.toHaveBeenCalled()
  expect(view.getByRole('status').textContent).toContain(project.title)
  fireEvent.click(view.getByRole('button', { name: zh.projectOpen }))
  await settle()
  expect(props.run).toHaveBeenLastCalledWith({ action: 'create-project', title: 'study', root: '/chosen/project', sessionId: 'ordinary', confirmNonEmpty: true })
  expect(props.onClose).toHaveBeenCalledOnce()
})

it('holds the form during creation and assigns an ordinary conversation only to an explicitly chosen project', async () => {
  const props = operations()
  let finish!: (value: ResearchResponse) => void
  props.run.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  const view = render(<JoinProjectDialog {...props} t={t} projects={[project, { ...project, id: 'example' as typeof project.id, title: 'Example', example: true }]} sessionId="ordinary" />)
  expect(view.queryByLabelText('Example')).toBeNull()
  fireEvent.click(view.getByRole('radio', { name: project.title }))
  fireEvent.click(view.getByRole('button', { name: zh.projectJoin }))
  await settle()
  fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: zh.cancel }))
  expect(props.onClose).not.toHaveBeenCalled()
  expect(props.run).toHaveBeenCalledWith({ action: 'join-project', projectId: project.id, sessionId: 'ordinary' })
  await act(async () => { finish({ message: 'joined', sessionId: 'continued' }) })
  expect(props.openResult).toHaveBeenCalledWith({ message: 'joined', sessionId: 'continued' })
  expect(props.onClose).toHaveBeenCalledOnce()
})
