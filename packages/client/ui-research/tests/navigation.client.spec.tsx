// @vitest-environment jsdom
/** The environment form must preserve project identity and backend command fields. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { ResearchView, WorkbenchProps } from '../src/client/contract.ts'
import { EnvironmentForm } from '../src/client/EnvironmentForm.tsx'
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
  const view: ResearchView = { snapshot, tasks: [] }
  return {
    t,
    useResearch: (selector: (v: ResearchView) => unknown) => selector(view),
    useFocus: () => ({ claim: null }),
    create: vi.fn().mockResolvedValue(project), run: vi.fn().mockResolvedValue({ message: '' }),
    openConversation: vi.fn().mockResolvedValue(undefined),
    focusClaim: vi.fn(), refresh: vi.fn(),
  } as unknown as WorkbenchProps
}

/** A promise the test settles by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve: (value: T) => void = () => {}
  let reject: (reason: Error) => void = () => {}
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

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
