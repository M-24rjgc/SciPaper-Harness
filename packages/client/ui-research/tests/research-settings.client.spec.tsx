// @vitest-environment jsdom

/**
 * The settings page against the backend's own contract: every preference
 * object the form emits is parsed by `preferencesSchema`, and the project
 * whose environments the page lists is the one `newProject` produces. Saving
 * and each install keep their own progress and failure, shown beside the
 * control that started them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
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

/** What the page asked the plugin to do, in the order it asked, and the answers still held back. */
interface Recorded {
  installs: ComponentStatus['id'][]
  saves: { preferences: ResearchPreferences; keys: { image: string; embedding: string } }[]
  held: (() => void)[]
}

/** How the plugin answers: at once, with a refusal, or when the spec says so. */
type Answer = 'accept' | 'refuse' | 'hold'

const roots: string[] = []
afterEach(async () => {
  cleanup()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const configured: ResearchPreferences = {
  // A main-model binding the page no longer offers, as a document saved before the change still carries it.
  main: { provider: 'deepseek', model: 'deepseek-chat' },
  vision: { provider: 'openai-compatible', model: 'qwen-vl' },
  image: { baseUrl: 'https://images.example.com/v1', model: 'flux-1', size: '1536x1024', quality: 'low', apiStyle: 'chat' },
  embedding: { baseUrl: 'https://embed.example.com/v1', model: 'bge-m3' },
  python: 'C:/Python312/python.exe',
  uv: 'C:/tools/uv.exe',
  texBin: 'C:/texlive/2025/bin',
}

const pythonReady: ComponentStatus = { id: 'python', installed: true, path: '/opt/dsh/python', version: '3.12.7' }
const latexMissing: ComponentStatus = { id: 'latex', installed: false, path: '', version: '2025' }
const drawioMissing: ComponentStatus = { id: 'drawio', installed: false, path: '', version: '24.7' }

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
const pendingEnvironment: EnvironmentRecord = {
  id: 'env-sweep' as EnvironmentId, name: 'sweep', kind: 'conda', target: 'local',
  python: '/opt/conda/envs/sweep/bin/python', requirements: [], fingerprint: 'sha-sweep',
  status: 'pending', details: '', isDefault: false,
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
  return { preferences: parts.preferences ?? {}, components: parts.components ?? [], projects: parts.projects ?? [], modes: [] }
}

function viewOf(snapshot: ResearchSnapshot | null): ResearchView {
  return { snapshot, tasks: [], response: null }
}

function blank(): Recorded {
  return { installs: [], saves: [], held: [] }
}

/** Let the page's own work reach the plugin, and its answer reach the page, inside React's act. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
}

/** Let the plugin answer every request it held back, and the page take the answers in. */
async function release(recorded: Recorded): Promise<void> {
  for (const resolve of recorded.held.splice(0)) resolve()
  await settle()
}

/** The failure line the page shows for a refusal with this reason. */
function failure(reason: string): string {
  return zh.actionFailed.replace('{reason}', reason)
}

/** Props whose injected face records every request and answers as `answer` says. */
function propsFor(view: ResearchView, recorded: Recorded, answer: Answer = 'accept'): WorkbenchProps {
  const reply = (reason: string): Promise<void> => {
    if (answer === 'refuse') return Promise.reject(new Error(reason))
    if (answer === 'hold') return new Promise<void>((resolve) => { recorded.held.push(resolve) })
    return Promise.resolve()
  }
  return {
    t: (key: string, params?: Record<string, unknown>) => {
      const template = (zh as Record<string, string>)[key] ?? key
      return params ? template.replace(/\{(\w+)\}/g, (m, n: string) => n in params ? String(params[n]) : m) : template
    },
    useResearch: (select: (value: ResearchView) => unknown) => select(view),
    install: (component: ComponentStatus['id']) => {
      recorded.installs.push(component)
      return reply('the component store is unreachable')
    },
    configure: (preferences: ResearchPreferences, keys: { image: string; embedding: string }) => {
      recorded.saves.push({ preferences, keys })
      return reply('the credential store is unreachable')
    },
  } as unknown as WorkbenchProps
}

function input(element: HTMLElement): HTMLInputElement {
  return element as HTMLInputElement
}

function button(element: HTMLElement): HTMLButtonElement {
  return element as HTMLButtonElement
}

describe('research settings is the one place research is configured', () => {
  it('offers the three optional roles at their defaults and lists nothing before a snapshot arrives', () => {
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(null), blank())} />)

    expect(page.getByText(zh.roleVisionFollow)).toBeTruthy()
    expect(page.getByText(zh.roleImageOff)).toBeTruthy()
    expect(page.getByText(zh.roleEmbeddingOff)).toBeTruthy()
    // Each role says what it takes, even unbound.
    expect(page.getByText(zh.roleVisionNote)).toBeTruthy()
    expect(page.getByText(zh.roleImageNote)).toBeTruthy()
    expect(page.getByText(zh.roleEmbeddingNote)).toBeTruthy()
    // The conversation's model is chosen in the composer, so there is no main-model role here.
    expect(page.queryByText('主模型')).toBeNull()
    expect(page.queryByLabelText(/主模型/)).toBeNull()
    expect(page.getByText(zh.noEnvironments)).toBeTruthy()
    expect(page.queryByText(zh.installed)).toBeNull()
    expect(page.queryByRole('button', { name: zh.notInstalled })).toBeNull()
    // Nothing has been tried, so nothing has failed or been saved.
    expect(page.queryByRole('alert')).toBeNull()
    expect(page.queryByRole('status')).toBeNull()

    expect(input(page.getByLabelText(zh.visionProvider)).value).toBe('')
    expect(input(page.getByLabelText(zh.visionProvider)).type).toBe('text')
    expect(input(page.getByLabelText(zh.pythonPath)).value).toBe('')
    // The image model and size arrive pre-filled (gpt-image-2); the endpoint stays empty until a key or an endpoint is given.
    expect(input(page.getByLabelText(zh.imageSize)).value).toBe('1536x1024')
    expect(input(page.getByLabelText(zh.imageModel)).value).toBe('gpt-image-2')
    expect(input(page.getByLabelText(zh.imageEndpoint)).value).toBe('')
    expect((page.getByLabelText(zh.imageQuality) as HTMLSelectElement).value).toBe('high')
    expect((page.getByLabelText(zh.imageApiStyle) as HTMLSelectElement).value).toBe('images')
    // The key never becomes readable text, here or in the saved record.
    expect(input(page.getByLabelText(zh.imageKey)).type).toBe('password')
    expect(input(page.getByLabelText(zh.embeddingKey)).type).toBe('password')
    expect(input(page.getByLabelText(zh.embeddingModel)).value).toBe('text-embedding-3-small')
    expect(input(page.getByLabelText(zh.embeddingEndpoint)).value).toBe('')
  })

  it('asks the backend to store nothing at all when the form is untouched, and says why a refused save failed', async () => {
    const recorded = blank()
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(null), recorded, 'refuse')} />)

    fireEvent.click(page.getByRole('button', { name: zh.save }))
    await settle()

    // Every binding is conditional, so an untouched form sends an empty
    // record rather than one full of empty strings the schema would reject.
    expect(recorded.saves).toEqual([{ preferences: {}, keys: { image: '', embedding: '' } }])
    expect(preferencesSchema.parse(recorded.saves[0]!.preferences)).toEqual({})
    // The refusal shows under the form, and the save can be tried again.
    expect(page.getByRole('alert').textContent).toBe(failure('the credential store is unreachable'))
    expect(page.queryByRole('status')).toBeNull()
    expect(button(page.getByRole('button', { name: zh.save })).disabled).toBe(false)
    expect(page.getByText(zh.roleVisionFollow)).toBeTruthy()
  })

  it('says it is saving until the plugin answers, then that the settings are saved', async () => {
    const recorded = blank()
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(null), recorded, 'hold')} />)

    fireEvent.change(page.getByLabelText(zh.pythonPath), { target: { value: '/usr/bin/python3' } })
    fireEvent.click(page.getByRole('button', { name: zh.save }))
    await settle()

    const saving = button(page.getByRole('button', { name: zh.saving }))
    expect(saving.disabled).toBe(true)
    expect(page.queryByRole('status')).toBeNull()
    // A second press while the first is in flight sends nothing more.
    fireEvent.click(saving)
    await settle()
    expect(recorded.saves).toEqual([{ preferences: { python: '/usr/bin/python3' }, keys: { image: '', embedding: '' } }])

    await release(recorded)
    expect(page.getByRole('status').textContent).toBe(zh.settingsSaved)
    expect(button(page.getByRole('button', { name: zh.save })).disabled).toBe(false)
    expect(page.queryByRole('alert')).toBeNull()
  })

  it('shows each standing binding and saves the edited one the schema accepts, dropping the old main-model binding', async () => {
    const recorded = blank()
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(snapshotOf({ preferences: configured })), recorded)} />)

    expect(page.getByText('openai-compatible · qwen-vl')).toBeTruthy()
    expect(page.getByText('flux-1')).toBeTruthy()
    expect(page.getByText('bge-m3')).toBeTruthy()
    // The stored main binding is not shown anywhere on the page.
    expect(page.queryByText('deepseek · deepseek-chat')).toBeNull()
    expect(page.queryByDisplayValue('deepseek-chat')).toBeNull()
    expect(input(page.getByLabelText(zh.visionProvider)).value).toBe('openai-compatible')
    expect(input(page.getByLabelText(zh.visionModel)).value).toBe('qwen-vl')
    expect(input(page.getByLabelText(zh.imageEndpoint)).value).toBe('https://images.example.com/v1')
    expect(input(page.getByLabelText(zh.imageModel)).value).toBe('flux-1')
    expect(input(page.getByLabelText(zh.imageSize)).value).toBe('1536x1024')
    expect((page.getByLabelText(zh.imageQuality) as HTMLSelectElement).value).toBe('low')
    expect((page.getByLabelText(zh.imageApiStyle) as HTMLSelectElement).value).toBe('chat')
    expect(input(page.getByLabelText(zh.embeddingEndpoint)).value).toBe('https://embed.example.com/v1')
    expect(input(page.getByLabelText(zh.embeddingModel)).value).toBe('bge-m3')
    expect(input(page.getByLabelText(zh.pythonPath)).value).toBe('C:/Python312/python.exe')
    expect(input(page.getByLabelText(zh.uvPath)).value).toBe('C:/tools/uv.exe')
    expect(input(page.getByLabelText(zh.texPath)).value).toBe('C:/texlive/2025/bin')

    // Pasted ids carry stray whitespace; the page trims before it saves.
    fireEvent.change(page.getByLabelText(zh.visionProvider), { target: { value: '  zhipu  ' } })
    fireEvent.change(page.getByLabelText(zh.visionModel), { target: { value: 'glm-4v' } })
    fireEvent.change(page.getByLabelText(zh.imageEndpoint), { target: { value: 'https://images.example.com/v2' } })
    fireEvent.change(page.getByLabelText(zh.imageModel), { target: { value: 'flux-2' } })
    fireEvent.change(page.getByLabelText(zh.imageSize), { target: { value: '2048x2048' } })
    fireEvent.change(page.getByLabelText(zh.imageKey), { target: { value: 'sk-live-image-key' } })
    fireEvent.change(page.getByLabelText(zh.imageQuality), { target: { value: 'medium' } })
    fireEvent.change(page.getByLabelText(zh.imageApiStyle), { target: { value: 'images' } })
    fireEvent.change(page.getByLabelText(zh.embeddingModel), { target: { value: 'bge-large' } })
    fireEvent.change(page.getByLabelText(zh.embeddingKey), { target: { value: 'sk-embed' } })
    fireEvent.change(page.getByLabelText(zh.pythonPath), { target: { value: '/usr/bin/python3' } })
    fireEvent.change(page.getByLabelText(zh.uvPath), { target: { value: '/usr/local/bin/uv' } })
    fireEvent.change(page.getByLabelText(zh.texPath), { target: { value: '/usr/local/texlive/2025/bin' } })
    fireEvent.click(page.getByRole('button', { name: zh.save }))
    await settle()

    const expected: ResearchPreferences = {
      vision: { provider: 'zhipu', model: 'glm-4v' },
      image: {
        baseUrl: 'https://images.example.com/v2', model: 'flux-2',
        size: '2048x2048', quality: 'medium', apiStyle: 'images',
      },
      embedding: { baseUrl: 'https://embed.example.com/v1', model: 'bge-large' },
      python: '/usr/bin/python3',
      uv: '/usr/local/bin/uv',
      texBin: '/usr/local/texlive/2025/bin',
    }
    // The key travels beside the record, never inside it: the record names
    // only the credential slot the backend will read it back from.
    expect(recorded.saves).toEqual([{ preferences: expected, keys: { image: 'sk-live-image-key', embedding: 'sk-embed' } }])
    expect(preferencesSchema.parse(recorded.saves[0]!.preferences)).toEqual(expected)
    expect(page.getByRole('status').textContent).toBe(zh.settingsSaved)
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
    expect(saved.keys.image).toBe('')
    expect(saved.preferences).toEqual({
      image: {
        baseUrl: 'https://images.example.com/v3', model: 'flux-3',
        size: '1536x1024', quality: 'high', apiStyle: 'images',
      },
    })
    expect(preferencesSchema.parse(saved.preferences)).toEqual(saved.preferences)
  })

  it('turns image generation and embeddings on with OpenAI defaults when only their keys are given', async () => {
    const recorded = blank()
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(null), recorded)} />)
    fireEvent.change(page.getByLabelText(zh.imageKey), { target: { value: 'sk-only-key' } })
    fireEvent.change(page.getByLabelText(zh.embeddingKey), { target: { value: 'sk-embed-only' } })
    fireEvent.change(page.getByLabelText(zh.embeddingModel), { target: { value: '' } })
    fireEvent.change(page.getByLabelText(zh.imageModel), { target: { value: '' } })
    fireEvent.change(page.getByLabelText(zh.imageSize), { target: { value: '' } })
    // A value the select never offers reads as the default rather than reaching the record.
    const quality = page.getByLabelText(zh.imageQuality) as HTMLSelectElement
    quality.append(Object.assign(document.createElement('option'), { value: 'ultra' }))
    fireEvent.change(quality, { target: { value: 'ultra' } })
    const style = page.getByLabelText(zh.imageApiStyle) as HTMLSelectElement
    style.append(Object.assign(document.createElement('option'), { value: 'grpc' }))
    fireEvent.change(style, { target: { value: 'grpc' } })
    fireEvent.click(page.getByRole('button', { name: zh.save }))
    await settle()
    expect(recorded.saves).toEqual([{
      preferences: {
        image: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-2', size: '1536x1024', quality: 'high', apiStyle: 'images' },
        embedding: { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
      },
      keys: { image: 'sk-only-key', embedding: 'sk-embed-only' },
    }])
    expect(preferencesSchema.parse(recorded.saves[0]!.preferences)).toEqual(recorded.saves[0]!.preferences)
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
    // The roles it does not bind still read as their defaults.
    expect(page.getByText(zh.roleVisionFollow)).toBeTruthy()
    expect(page.getByText(zh.roleEmbeddingOff)).toBeTruthy()
  })
})

describe('local components', () => {
  it('tags a ready component, and says an absent one is installing until the plugin answers', async () => {
    const recorded = blank()
    const snapshot = snapshotOf({ components: [pythonReady, latexMissing, drawioMissing] })
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(snapshot), recorded, 'hold')} />)

    expect(page.getByText('python')).toBeTruthy()
    expect(page.getByText('3.12.7')).toBeTruthy()
    expect(page.getByText(zh.installed).getAttribute('data-tone')).toBe('success')
    expect(page.getByText('latex')).toBeTruthy()

    const [latex, drawio] = page.getAllByRole('button', { name: zh.notInstalled })
    fireEvent.click(latex!)
    await settle()

    expect(recorded.installs).toEqual(['latex'])
    const installing = button(page.getByRole('button', { name: zh.installing }))
    expect(installing.disabled).toBe(true)
    // Each component keeps its own progress: the other install and the save stay open.
    expect(button(drawio!).disabled).toBe(false)
    expect(button(page.getByRole('button', { name: zh.save })).disabled).toBe(false)
    fireEvent.click(installing)
    await settle()
    expect(recorded.installs).toEqual(['latex'])

    await release(recorded)
    // Until the next snapshot reports it ready, the row keeps offering the install, with no failure.
    expect(page.getAllByRole('button', { name: zh.notInstalled })).toHaveLength(2)
    expect(page.queryByRole('alert')).toBeNull()
  })

  it('says why a refused install failed under that component, and offers it again', async () => {
    const recorded = blank()
    const snapshot = snapshotOf({ components: [latexMissing] })
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(snapshot), recorded, 'refuse')} />)

    fireEvent.click(page.getByRole('button', { name: zh.notInstalled }))
    await settle()

    expect(recorded.installs).toEqual(['latex'])
    expect(page.getByRole('alert').textContent).toBe(failure('the component store is unreachable'))
    const again = button(page.getByRole('button', { name: zh.notInstalled }))
    expect(again.disabled).toBe(false)
    fireEvent.click(again)
    await settle()
    expect(recorded.installs).toEqual(['latex', 'latex'])
  })
})

describe('experiment environments', () => {
  it('lists every project environment, tagging only the default and the states that need attention', async () => {
    const project = await projectWithEnvironments([defaultEnvironment, readyEnvironment, pendingEnvironment, failedEnvironment])
    const snapshot = snapshotOf({ projects: [project] })
    const page = render(<ResearchSettingsSection {...propsFor(viewOf(snapshot), blank())} />)

    expect(page.queryByText(zh.noEnvironments)).toBeNull()
    expect(page.getByText(zh.environmentDefault).getAttribute('data-tone')).toBe('info')
    // `ready` is only what creation found, never probed since, so it earns no tag.
    expect(page.queryByText(zh.ready)).toBeNull()
    expect(page.getByText(zh.pending).getAttribute('data-tone')).toBe('warning')
    expect(page.getByText(zh.failed).getAttribute('data-tone')).toBe('warning')
    // Each row names the project it belongs to, so two projects never blur.
    expect(page.getByText(`${project.title} · ${zh.local} · ${readyEnvironment.python}`)).toBeTruthy()
    expect(page.getByText(`${project.title} · ${zh.ssh} · ${failedEnvironment.python}`)).toBeTruthy()
    expect(page.getByText('baseline')).toBeTruthy()
    expect(page.getByText('sweep')).toBeTruthy()
  })
})
