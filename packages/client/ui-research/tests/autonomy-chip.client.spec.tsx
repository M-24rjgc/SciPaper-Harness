// @vitest-environment jsdom

/**
 * The research's autonomy in the composer, where the shell's access chip sat.
 * It names the research's autonomy and offers both, and a choice goes to the
 * research record (the host applies the preset to every conversation), never
 * to this conversation alone. It names this conversation's own preset while a
 * hand-typed `/permission` left the autonomy, keeps its pending state and its
 * failure beside it, reads as read-only in an example, and draws nothing
 * outside a research. Every command it sends is handed to the validator the
 * service parses commands with.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type { Autonomy, ResearchCommand, ResearchProject, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { AutonomyChip, type AutonomyChipProps } from '../src/client/AutonomyChip.tsx'
import type { ResearchView } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'
import { MODES } from './fixtures/modes.ts'

afterEach(() => { cleanup() })

const SESSION = 'session-composer'

/** The Chinese dictionary, interpolating `{name}` the way the locale seat does. */
function t(key: string, params?: Record<string, unknown>): string {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}

/** This conversation's research, with the given autonomy. */
function project(autonomy: Autonomy = 'checkpoints'): ResearchProject {
  const record = newProject({ root: 'C:\\research\\sparse', title: 'Sparse attention', brief: '', autonomy }, 'workspace' as WorkspaceId)
  record.sessionId = SESSION
  return record
}

/** What the chip's seat reads, which a test may change between renders. */
interface World {
  projects: ResearchProject[]
  /** This conversation's `permissions` projection value; undefined before the host publishes one. */
  preset: string | undefined
  locked: boolean
  commands: ResearchCommand[]
  answer: () => Promise<ResearchResponse>
}

function world(projects: ResearchProject[], preset: string | undefined = 'workspace-write'): World {
  return { projects, preset, locked: false, commands: [], answer: () => Promise.resolve({ message: '' }) }
}

function propsOf(w: World): AutonomyChipProps {
  const snapshot = { projects: w.projects, preferences: {}, components: [], modes: MODES }
  const view: ResearchView = { snapshot, tasks: [], response: null }
  return {
    sessionId: SESSION,
    locked: w.locked,
    t,
    useResearch: (select: (value: ResearchView) => unknown) => select(view),
    useDirectories: (select: (value: Record<string, string>) => unknown) => select({}),
    useProjection: (_key: string, select: (value: { currentValue: string } | undefined) => unknown) =>
      select(w.preset === undefined ? undefined : { currentValue: w.preset }),
    run: (command: ResearchCommand) => { w.commands.push(command); return w.answer() },
  } as unknown as AutonomyChipProps
}

function mount(w: World): { chip: ReturnType<typeof render>; update: () => void } {
  const chip = render(<AutonomyChip {...propsOf(w)} />)
  return { chip, update: () => { chip.rerender(<AutonomyChip {...propsOf(w)} />) } }
}

/** Let the host's answers land. */
const settle = async (): Promise<void> => { await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 0) }) }) }

const trigger = (): HTMLElement => screen.getByRole('button', { name: /^自主程度/ })
const choices = (): HTMLElement[] => screen.queryAllByRole('menuitem')

describe('the autonomy chip in the composer', () => {
  it('draws nothing in a conversation outside every research', () => {
    const stranger = project()
    stranger.sessionId = 'elsewhere'
    expect(mount(world([stranger])).chip.container.innerHTML).toBe('')
  })

  it('reads as read-only in an example, with nothing to press', () => {
    const shipped = project()
    shipped.example = true
    const { chip } = mount(world([shipped]))
    const label = chip.getByText(zh.autonomyExample)
    expect(label.getAttribute('title')).toBe(zh.exampleBanner)
    expect(chip.queryByRole('button')).toBeNull()
  })

  it('names the research\'s autonomy and offers both, each with what it promises, from the keyboard too', () => {
    mount(world([project()]))
    const button = trigger()
    expect(button.getAttribute('aria-label')).toBe('自主程度，当前：检查点')
    expect(button.textContent).toBe(zh.autonomyShortCheckpoints)
    expect(button.getAttribute('title')).toBe(zh.autonomyCheckpointsDetail)
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(choices()).toEqual([])

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu').textContent).toContain(zh.autonomyMenuHeading)
    expect(choices().map(item => item.textContent)).toEqual([
      `${zh.autonomyShortCheckpoints}${zh.autonomyCheckpointsDetail}`,
      `${zh.autonomyShortAutomatic}${zh.autonomyAutomaticDetail}`,
    ])
    // The menu takes the focus, arrows move it, and Escape closes it back onto the chip.
    expect(document.activeElement).toBe(choices()[0])
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(choices()[1])
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(choices()).toEqual([])
    expect(document.activeElement).toBe(button)

    // A second press closes what the first opened, and so does a press elsewhere.
    fireEvent.click(button)
    fireEvent.click(button)
    expect(choices()).toEqual([])
    fireEvent.click(button)
    fireEvent.pointerDown(document.body)
    expect(choices()).toEqual([])
  })

  it('sends the choice to the research, holds itself while it is saved, then names the new autonomy', async () => {
    const research = project()
    const w = world([research])
    let release = (): void => {}
    w.answer = () => new Promise((resolve) => { release = () => { resolve({ message: 'Autonomy: automatic' }) } })
    const { update } = mount(w)
    fireEvent.click(trigger())
    fireEvent.click(choices()[1]!)
    await settle()
    expect(w.commands).toEqual([{ action: 'set-autonomy', projectId: research.id, autonomy: 'automatic' }])
    for (const command of w.commands) expect(commandSchema.parse(command)).toEqual(command)
    // While it is saved the chip names the choice and takes no other, whatever the conversation's preset says meanwhile.
    expect(trigger()).toHaveProperty('disabled', true)
    expect(trigger().textContent).toBe(zh.autonomyShortAutomatic)
    w.preset = 'research-auto'
    update()
    expect(trigger().textContent).toBe(zh.autonomyShortAutomatic)
    // The host applied it to the record and to this conversation.
    research.autonomy = 'automatic'
    await act(async () => { release(); await Promise.resolve() })
    await settle()
    expect(trigger()).toHaveProperty('disabled', false)
    expect(trigger().getAttribute('aria-label')).toBe('自主程度，当前：全自动')
    expect(trigger().getAttribute('title')).toBe(zh.autonomyAutomaticDetail)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('sends nothing when the autonomy already in force is chosen', () => {
    const w = world([project()])
    mount(w)
    fireEvent.click(trigger())
    fireEvent.click(choices()[0]!)
    expect(choices()).toEqual([])
    expect(w.commands).toEqual([])
  })

  it('names a preset typed by hand, and applies the autonomy again when one is chosen', async () => {
    const research = project()
    const w = world([research], 'read-only')
    const { update } = mount(w)
    expect(trigger().textContent).toBe('本对话：仅可查看')
    expect(trigger().getAttribute('aria-label')).toBe('自主程度：检查点；本对话：仅可查看')
    expect(trigger().getAttribute('title')).toBe(zh.autonomyDivergedHint)
    // The same autonomy again is a real choice here: it brings this conversation back in line.
    fireEvent.click(trigger())
    fireEvent.click(choices()[0]!)
    await settle()
    expect(w.commands).toEqual([{ action: 'set-autonomy', projectId: research.id, autonomy: 'checkpoints' }])

    // Every preset goes by this product's name for it; one it does not know, as the host spells it.
    const named: [Autonomy, string, string][] = [
      ['checkpoints', 'research-auto', zh.autonomyShortAutomatic],
      ['automatic', 'workspace-write', zh.autonomyShortCheckpoints],
      ['checkpoints', 'danger-full-access', zh.presetFullAccess],
      ['checkpoints', 'auto', zh.presetAutoReview],
      ['checkpoints', 'custom', zh.presetCustom],
      ['checkpoints', 'lab-only', 'lab-only'],
    ]
    for (const [autonomy, preset, name] of named) {
      research.autonomy = autonomy
      w.preset = preset
      update()
      expect(trigger().textContent).toBe(`本对话：${name}`)
    }
    // Before the host publishes this conversation's preset there is nothing to compare.
    research.autonomy = 'automatic'
    w.preset = undefined
    update()
    expect(trigger().textContent).toBe(zh.autonomyShortAutomatic)
  })

  it('says why a change failed, beside the chip, and can be tried again', async () => {
    const w = world([project()])
    w.answer = () => Promise.reject(new Error('refused'))
    mount(w)
    fireEvent.click(trigger())
    fireEvent.click(choices()[1]!)
    await settle()
    expect(screen.getByRole('alert').textContent).toBe(t('actionFailed', { reason: 'refused' }))
    expect(trigger()).toHaveProperty('disabled', false)
    expect(trigger().textContent).toBe(zh.autonomyShortCheckpoints)
  })

  it('stays shut while the composer is locked, and closes when it locks', () => {
    const w = world([project()])
    w.locked = true
    const { update } = mount(w)
    expect(trigger()).toHaveProperty('disabled', true)
    w.locked = false
    update()
    fireEvent.click(trigger())
    expect(choices()).toHaveLength(2)
    w.locked = true
    update()
    expect(choices()).toEqual([])
  })
})
