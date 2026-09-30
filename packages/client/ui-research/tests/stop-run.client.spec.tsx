// @vitest-environment jsdom

/**
 * Stopping a run: the control on a run card and on the experiment board. A
 * stopped run cannot be resumed, so the control asks once before it sends
 * anything, and every command it sends goes through the validator the service
 * parses commands with.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { randomUUID } from 'node:crypto'
import { newProject } from '@deepseek-ai/dsh-research-workbench/src/project.ts'
import { newExperiment } from '@deepseek-ai/dsh-research-workbench/src/experiments.ts'
import { commandSchema } from '@deepseek-ai/dsh-research-workbench/src/schema.ts'
import type { EnvironmentId, ExperimentRecord, ResearchCommand, ResearchProject, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { StopRun } from '../src/client/StopRun.tsx'
import type { WorkbenchProps } from '../src/client/contract.ts'
import type { Translate } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const t = ((key: string, params?: Record<string, unknown>) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as Translate

/** Let the work a press started, and the state it settles into, run before asserting. */
const flush = async (): Promise<void> => { await act(async () => { for (let index = 0; index < 6; index++) await Promise.resolve() }) }

/** A running run the experiment service admitted into a project with one ready environment. */
function runningRun(): { project: ResearchProject; record: ExperimentRecord } {
  const project = newProject({ root: '/research/sparse', title: 'Sparse attention', brief: '' }, 'workspace' as WorkspaceId)
  project.environments.push({
    id: 'environment-local' as EnvironmentId, name: '本机 3.12', kind: 'existing', target: 'local',
    python: '/usr/bin/python3.12', requirements: [], fingerprint: 'e3b0c442', status: 'ready', details: '', isDefault: true,
  })
  const submitted = newExperiment(project, {
    environmentId: project.environments[0]!.id, name: 'block-sparse-4k', argv: ['{python}', 'code/train.py'], cwd: '.',
    seed: 7, maxSeconds: 600, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [], metricsPath: 'metrics.json',
  }, randomUUID())
  // Only a supervisor moves a run past `queued`; the state it reports is assigned.
  const record: ExperimentRecord = { ...submitted, status: 'running', startedAt: new Date().toISOString() }
  project.experiments.push(record)
  return { project, record }
}

interface Mounted {
  ui: ReturnType<typeof render>
  commands: ResearchCommand[]
  project: ResearchProject
  record: ExperimentRecord
}

/** The stop control over one run, recording every command it sends. */
function mount(respond: (command: ResearchCommand) => Promise<ResearchResponse>): Mounted {
  const { project, record } = runningRun()
  const commands: ResearchCommand[] = []
  const props = {
    t, project, record,
    run: (command: ResearchCommand) => { commands.push(command); return respond(command) },
  } as unknown as WorkbenchProps & { project: ResearchProject; record: ExperimentRecord }
  return { ui: render(<StopRun {...props} />), commands, project, record }
}

/** Press 停止, then confirm it in the question that follows. */
function stopConfirmed(ui: ReturnType<typeof render>): void {
  fireEvent.click(ui.getByRole('button', { name: zh.runStop }))
  fireEvent.click(within(ui.getByRole('group', { name: zh.confirmStop })).getByRole('button', { name: zh.runStop }))
}

describe('stopping a run', () => {
  it('asks once before stopping, and sends nothing when the person keeps the run going', async () => {
    const { ui, commands } = mount(() => Promise.resolve({ message: 'Cancelled' }))
    fireEvent.click(ui.getByRole('button', { name: zh.runStop }))

    const question = ui.getByRole('group', { name: zh.confirmStop })
    expect(within(question).getByText(zh.confirmStop)).toBeTruthy()
    expect(within(question).getByRole('button', { name: zh.runStop })).toBeTruthy()
    fireEvent.click(within(question).getByRole('button', { name: zh.runKeep }))
    await flush()

    expect(ui.queryByRole('group', { name: zh.confirmStop })).toBeNull()
    expect(ui.getByRole('button', { name: zh.runStop })).toBeTruthy()
    expect(commands).toEqual([])
  })

  it('stops the run once confirmed and says so while the host cancels it', async () => {
    let answer = (_response: ResearchResponse): void => {}
    const { ui, commands, project, record } = mount(() => new Promise((resolve) => { answer = resolve }))
    stopConfirmed(ui)
    await flush()

    expect(ui.getByRole('status').textContent).toBe(zh.runStopping)
    expect(ui.queryByRole('button')).toBeNull()
    expect(commands).toEqual([{ action: 'experiment-cancel', projectId: project.id, runId: record.id }])
    expect(commandSchema.parse(commands[0])).toEqual(commands[0])

    await act(async () => { answer({ message: 'Cancelled' }) })
    await flush()
    expect(ui.queryByRole('status')).toBeNull()
    expect(ui.queryByRole('alert')).toBeNull()
  })

  it('says under the button why the host refused, and the button stays available', async () => {
    const answers: (Error | ResearchResponse)[] = [new Error('The supervisor is unreachable'), { message: 'Cancelled' }]
    const { ui, commands } = mount(() => {
      const answer = answers.shift()!
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    })
    stopConfirmed(ui)
    await flush()

    expect(ui.getByRole('alert').textContent).toBe(t('actionFailed', { reason: 'The supervisor is unreachable' }))
    expect(ui.getByRole('button', { name: zh.runStop })).toBeTruthy()

    // Trying again asks again, and a stop that goes through clears the failure.
    stopConfirmed(ui)
    await flush()
    expect(ui.queryByRole('alert')).toBeNull()
    expect(commands.map(command => command.action)).toEqual(['experiment-cancel', 'experiment-cancel'])
  })
})
