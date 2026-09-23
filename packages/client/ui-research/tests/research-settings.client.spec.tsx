// @vitest-environment jsdom

/**
 * The settings page against the backend's own contract: every preference
 * object the form emits is parsed by `preferencesSchema`, and the project
 * whose environments the page lists is the one `newProject` produces.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { preferencesSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type {
  ComponentStatus, EnvironmentId, EnvironmentRecord, ResearchPreferences, ResearchProject, ResearchSnapshot,
} from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ResearchSettingsSection } from '../src/client/ResearchSettings.tsx'
import type { ResearchView, WorkbenchProps } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'

/** What the page asked the plugin to do, in the order it asked. */
interface Recorded {
  installs: ComponentStatus['id'][]
  saves: { preferences: ResearchPreferences; imageKey: string }[]
}

const roots: string[] = []
afterEach(async () => {
  cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const configured: ResearchPreferences = {
  main: { provider: 'deepseek', model: 'deepseek-chat' },
  vision: { provider: 'openai-compatible', model: 'qwen-vl' },
  image: { baseUrl: 'https://images.example.com/v1', model: 'flux-1', size: '1536x1024' },
  python: 'C:/Python312/python.exe',
  uv: 'C:/tools/uv.exe',
  texBin: 'C:/texlive/2025/bin',
}

const pythonReady: ComponentStatus = { id: 'python', installed: true, path: '/opt/dsh/python', version: '3.12.7' }
const latexMissing: ComponentStatus = { id: 'latex', installed: false, path: '', version: '2025' }

// Environment records are assigned rather than transitioned: the machine's
// only maker, `createEnvironment`, shells out to a live interpreter over the
// network or SSH, which a render spec cannot run. Everything else about the
// project below is the machine's own.
const defaultEnvironment: EnvironmentRecord = {
  id: 'env-baseline' as EnvironmentId, name: 'baseline', kind: 'uv', target: 'local',
  python: '/opt/venv/baseline/bin/python', requirements: ['torch'], fingerprint: 'sha-baseline',
  status: 'ready', details: '', isDefault: true,
}
const readyEnvironment: EnvironmentRecord = {
  id: 'env-ablation' as EnvironmentId, name: 'ablation', kind: 'existing', target: 'local',
  python: '/usr/bin/python3', requirements: [], fingerprint: 'sha-ablation',
  status: 'ready', details: '', isDefault: false,
}
const failedEnvironment: EnvironmentRecord = {
  id: 'env-cluster' as EnvironmentId, name: 'cluster', kind: 'uv', target: 'ssh',
  python: '/home/rs/.venv/bin/python', sshHost: 'gpu-a100', remoteRoot: '/data/runs',
  requirements: [], fingerprint: 'sha-cluster', status: 'failed', details: 'uv venv exited 1', isDefault: false,
}

/** A real project record, carrying the environments the listing should show. */
async function projectWithEnvironments(environments: EnvironmentRecord[]): Promise<ResearchProject> {
  const root = await mkdtemp(join(tmpdir(), 'research-settings-'))
  roots.push(root)
  const project = newProject(
    { root, title: '块稀疏注意力的长上下文代价', mode: 'spark-to-paper', route: 'data', brief: '1/4 FLOPs 下还能不能保住准确率' },
    'workspace' as WorkspaceId,
  )
  project.environments.push(...environments)
  return project
}

function snapshotOf(parts: {
  preferences?: ResearchPreferences
  components?: ComponentStatus[]
  projects?: ResearchProject[]
}): ResearchSnapshot {
  return { preferences: parts.preferences ?? {}, components: parts.components ?? [], projects: parts.projects ?? [] }
}

function viewOf(snapshot: ResearchSnapshot | null, busy = false): ResearchView {
  return { snapshot, tasks: [], busy, error: '', response: null }
}

function blank(): Recorded {
  return { installs: [], saves: [] }
}

/** Let a refused install or save reach the page's own catch before asserting. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** Props whose injected face records every request; `refuse` makes the plugin say no. */
function propsFor(view: ResearchView, recorded: Recorded, refuse = false): WorkbenchProps {
  return {
    t: (key: string, params?: Record<string, unknown>) => {
      const template = (zh as Record<string, string>)[key] ?? key
      return params ? template.replace(/\{(\w+)\}/g, (m, n: string) => n in params ? String(params[n]) : m) : template
    },
    useResearch: (select: (value: ResearchView) => unknown) => select(view),
    install: (component: ComponentStatus['id']) => {
      recorded.installs.push(component)
      return refuse ? Promise.reject(new Error('the component store is unreachable')) : Promise.resolve()
    },
    configure: (preferences: ResearchPreferences, imageKey: string) => {
      recorded.saves.push({ preferences, imageKey })
      return refuse ? Promise.reject(new Error('the credential store is unreachable')) : Promise.resolve()
    },
  } as unknown as WorkbenchProps
}

function input(element: HTMLElement): HTMLInputElement {
  return element as HTMLInputElement
}

describe('research settings is the one place research is configured', () => {
  it('shows the last failure the plugin reported above the form', () => {
    const view = { ...viewOf(null), error: 'the credential store is unreachable' }
    expect(render(<ResearchSettingsSection {...propsFor(view, blank())} />).getByRole('alert').textContent).toBe('the credential store is unreachable')
    cleanup()
  })

  it('offers every role unbound and lists nothing before a snapshot arrives', () => {
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(null), blank())} />)

    expect(page.getByText(zh.roleUnset)).toBeTruthy()
    expect(page.getByText(zh.roleVisionFollow)).toBeTruthy()
    expect(page.getByText(zh.roleImageOff)).toBeTruthy()
    expect(page.getByText(zh.noEnvironments)).toBeTruthy()
    expect(page.queryByText(zh.installed)).toBeNull()
    expect(page.queryByRole('button', { name: zh.notInstalled })).toBeNull()

    expect(input(page.getByLabelText(zh.mainProvider)).value).toBe('')
    expect(input(page.getByLabelText(zh.mainProvider)).type).toBe('text')
    expect(input(page.getByLabelText(zh.pythonPath)).value).toBe('')
    // The one field that arrives pre-filled without a stored preference.
    expect(input(page.getByLabelText(zh.imageSize)).value).toBe('1024x1024')
    // The key never becomes readable text, here or in the saved record.
    expect(input(page.getByLabelText(zh.imageKey)).type).toBe('password')
  })

  it('asks the backend to store nothing at all when the form is untouched', async () => {
    const recorded = blank()
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(null), recorded, true)} />)

    fireEvent.click(page.getByRole('button', { name: zh.save }))
    await settle()

    // Every binding is conditional, so an untouched form sends an empty
    // record rather than one full of empty strings the schema would reject.
    expect(recorded.saves).toEqual([{ preferences: {}, imageKey: '' }])
    expect(preferencesSchema.parse(recorded.saves[0]!.preferences)).toEqual({})
    // The plugin refused; the page is still standing and still unbound.
    expect(page.getByText(zh.roleUnset)).toBeTruthy()
  })

  it('shows each standing binding and saves the edited one the schema accepts', async () => {
    const recorded = blank()
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(snapshotOf({ preferences: configured }), false), recorded)} />)

    expect(page.getByText('deepseek · deepseek-chat')).toBeTruthy()
    expect(page.getByText('openai-compatible · qwen-vl')).toBeTruthy()
    expect(page.getByText('flux-1')).toBeTruthy()
    expect(page.queryByText(zh.roleUnset)).toBeNull()
    expect(input(page.getByLabelText(zh.mainModel)).value).toBe('deepseek-chat')
    expect(input(page.getByLabelText(zh.visionProvider)).value).toBe('openai-compatible')
    expect(input(page.getByLabelText(zh.imageEndpoint)).value).toBe('https://images.example.com/v1')
    expect(input(page.getByLabelText(zh.imageSize)).value).toBe('1536x1024')
    expect(input(page.getByLabelText(zh.pythonPath)).value).toBe('C:/Python312/python.exe')
    expect(input(page.getByLabelText(zh.uvPath)).value).toBe('C:/tools/uv.exe')
    expect(input(page.getByLabelText(zh.texPath)).value).toBe('C:/texlive/2025/bin')

    // Pasted ids carry stray whitespace; the page trims before it saves.
    fireEvent.change(page.getByLabelText(zh.mainProvider), { target: { value: '  deepseek  ' } })
    fireEvent.change(page.getByLabelText(zh.mainModel), { target: { value: 'deepseek-reasoner' } })
    fireEvent.change(page.getByLabelText(zh.visionProvider), { target: { value: 'zhipu' } })
    fireEvent.change(page.getByLabelText(zh.visionModel), { target: { value: 'glm-4v' } })
    fireEvent.change(page.getByLabelText(zh.imageEndpoint), { target: { value: 'https://images.example.com/v2' } })
    fireEvent.change(page.getByLabelText(zh.imageModel), { target: { value: 'flux-2' } })
    fireEvent.change(page.getByLabelText(zh.imageSize), { target: { value: '2048x2048' } })
    fireEvent.change(page.getByLabelText(zh.imageKey), { target: { value: 'sk-live-image-key' } })
    fireEvent.change(page.getByLabelText(zh.pythonPath), { target: { value: '/usr/bin/python3' } })
    fireEvent.change(page.getByLabelText(zh.uvPath), { target: { value: '/usr/local/bin/uv' } })
    fireEvent.change(page.getByLabelText(zh.texPath), { target: { value: '/usr/local/texlive/2025/bin' } })
    fireEvent.click(page.getByRole('button', { name: zh.save }))
    await settle()

    const expected: ResearchPreferences = {
      main: { provider: 'deepseek', model: 'deepseek-reasoner' },
      vision: { provider: 'zhipu', model: 'glm-4v' },
      image: {
        baseUrl: 'https://images.example.com/v2', model: 'flux-2',
        size: '2048x2048',
      },
      python: '/usr/bin/python3',
      uv: '/usr/local/bin/uv',
      texBin: '/usr/local/texlive/2025/bin',
    }
    // The key travels beside the record, never inside it: the record names
    // only the credential slot the backend will read it back from.
    expect(recorded.saves).toEqual([{ preferences: expected, imageKey: 'sk-live-image-key' }])
    expect(preferencesSchema.parse(recorded.saves[0]!.preferences)).toEqual(expected)
  })

  it('reads a control the form does not carry as empty rather than crashing', async () => {
    const recorded = blank()
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(null), recorded)} />)
    // A disabled control is omitted from FormData. Nothing the page renders
    // disables itself mid-form, so this is the only way to reach the guard
    // that keeps a save from reading `null` as if it were text.
    input(page.getByLabelText(zh.imageKey)).disabled = true

    fireEvent.change(page.getByLabelText(zh.imageEndpoint), { target: { value: 'https://images.example.com/v3' } })
    fireEvent.change(page.getByLabelText(zh.imageModel), { target: { value: 'flux-3' } })
    fireEvent.click(page.getByRole('button', { name: zh.save }))
    await settle()

    const saved = recorded.saves[0]!
    expect(saved.imageKey).toBe('')
    expect(saved.preferences).toEqual({
      image: {
        baseUrl: 'https://images.example.com/v3', model: 'flux-3',
        size: '1024x1024',
      },
    })
    expect(preferencesSchema.parse(saved.preferences)).toEqual(saved.preferences)
  })

  it('leaves the size box empty when the stored image binding carries no size', () => {
    // `preferencesSchema` requires a non-empty size, so only a record written
    // before that rule looks like this. The page then shows an empty box
    // rather than a default the backend never agreed to.
    const sizeless = snapshotOf({
      preferences: {
        image: { baseUrl: 'https://images.example.com/v1', model: 'flux-1', size: '' },
      },
    })
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(sizeless), blank())} />)

    expect(input(page.getByLabelText(zh.imageSize)).value).toBe('')
    expect(page.getByText('flux-1')).toBeTruthy()
    expect(page.getByText(zh.roleUnset)).toBeTruthy()
  })

  it('tags a ready component and installs an absent one on request', async () => {
    const recorded = blank()
    const snapshot = snapshotOf({ components: [pythonReady, latexMissing] })
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(snapshot), recorded)} />)

    expect(page.getByText('python')).toBeTruthy()
    expect(page.getByText('3.12.7')).toBeTruthy()
    expect(page.getByText(zh.installed).getAttribute('data-tone')).toBe('success')
    expect(page.getByText('latex')).toBeTruthy()

    fireEvent.click(page.getByRole('button', { name: zh.notInstalled }))
    await settle()

    expect(recorded.installs).toEqual(['latex'])
  })

  it('holds the install and the save while the plugin is busy', () => {
    const recorded = blank()
    const snapshot = snapshotOf({ components: [latexMissing] })
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(snapshot, true), recorded)} />)

    const held = page.getByRole('button', { name: zh.notInstalled }) as HTMLButtonElement
    expect(held.disabled).toBe(true)
    expect((page.getByRole('button', { name: zh.save }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(held)
    expect(recorded.installs).toEqual([])
  })

  it('stays standing when the install is refused', async () => {
    const recorded = blank()
    const snapshot = snapshotOf({ components: [latexMissing] })
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(snapshot), recorded, true)} />)

    fireEvent.click(page.getByRole('button', { name: zh.notInstalled }))
    await settle()

    expect(recorded.installs).toEqual(['latex'])
    // The refusal is the plugin's to report; the row keeps offering the action.
    expect(page.getByRole('button', { name: zh.notInstalled })).toBeTruthy()
  })

  it('lists every project environment with the tag its state earns', async () => {
    const project = await projectWithEnvironments([defaultEnvironment, readyEnvironment, failedEnvironment])
    const snapshot = snapshotOf({ projects: [project] })
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(snapshot), blank())} />)

    expect(page.queryByText(zh.noEnvironments)).toBeNull()
    expect(page.getByText(zh.environmentDefault).getAttribute('data-tone')).toBe('info')
    expect(page.getAllByText(zh.ready).every(tag => tag.getAttribute('data-tone') === 'success')).toBe(true)
    expect(page.getByText(zh.failed).getAttribute('data-tone')).toBe('warning')
    // Each row names the project it belongs to, so two projects never blur.
    expect(page.getByText(`${project.title} · ${zh.local} · ${readyEnvironment.python}`)).toBeTruthy()
    expect(page.getByText(`${project.title} · ${zh.ssh} · ${failedEnvironment.python}`)).toBeTruthy()
    expect(page.getByText('baseline')).toBeTruthy()
  })
})
