// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import type { ResearchCommand, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { MapView } from '../src/client/KnowledgeMap.tsx'
import type { WorkbenchProps } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'
import { translate } from './fixtures/translate.ts'

afterEach(cleanup)
const t = translate(zh)
const project = newProject({ root: '/research/map', title: 'Map study', brief: '' }, 'workspace' as WorkspaceId)
const props = (run: (request: ResearchCommand) => Promise<ResearchResponse>) =>
  ({ t, run: vi.fn(run), project }) as WorkbenchProps & { project: typeof project }
async function settle(): Promise<void> { await act(async () => { await Promise.resolve() }) }

it('asks the map plugin and says that the map is not built', async () => {
  const mapProps = props(async () => ({ message: 'Map', mapView: { built: false } }))
  const view = render(<MapView {...mapProps} />)
  expect(view.getByRole('status').textContent).toBe(zh.kgLoading)
  await settle()
  expect(mapProps.run).toHaveBeenCalledWith({ action: 'map-view', projectId: project.id })
  expect(view.getByRole('heading', { name: zh.kmNotBuiltTitle })).toBeTruthy()
  expect(view.getByText(zh.kmNotBuiltBody)).toBeTruthy()
  expect(view.queryByRole('status')).toBeNull()
})

it('shows why the map could not be read: a plugin that went off, an empty answer, or a refusal that is not an error', async () => {
  const off = render(<MapView {...props(async () => { throw new Error('Domain map plugin is disabled.') })} />)
  await settle()
  expect(off.getByRole('alert').textContent).toContain('Domain map plugin is disabled.')
  expect(off.queryByText(zh.kmNotBuiltTitle)).toBeNull()
  off.unmount()
  const empty = render(<MapView {...props(async () => ({ message: 'Map' }))} />)
  await settle()
  expect(empty.getByRole('alert').textContent).toContain(zh.kgNoResponse)
  empty.unmount()
  const plain = render(<MapView {...props(async () => { throw 'plain refusal' })} />)
  await settle()
  expect(plain.getByRole('alert').textContent).toContain('plain refusal')
})

it('drops the answer of a read that another research has overtaken', async () => {
  const slow = Promise.withResolvers<ResearchResponse>()
  const view = render(<MapView {...props(() => slow.promise)} />)
  const other = { ...project, id: 'other' as typeof project.id }
  view.rerender(<MapView {...props(async () => ({ message: 'Map', mapView: { built: false } }))} project={other} />)
  await settle()
  expect(view.getByRole('heading', { name: zh.kmNotBuiltTitle })).toBeTruthy()
  const failing = Promise.withResolvers<ResearchResponse>()
  const second = render(<MapView {...props(() => failing.promise)} />)
  second.rerender(<MapView {...props(async () => ({ message: 'Map', mapView: { built: false } }))} project={other} />)
  await settle()
  failing.reject(new Error('Overtaken failure'))
  slow.resolve({ message: 'late' })
  await settle()
  expect(second.queryByRole('alert')).toBeNull()
  expect(view.queryByRole('alert')).toBeNull()
})
