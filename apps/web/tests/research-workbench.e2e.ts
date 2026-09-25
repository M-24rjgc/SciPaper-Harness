/** The research edition through the shipped browser and durable host: the agent drives, the ledger records. */
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, beforeEach, onTestFailed } from 'vitest'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ArtifactId, ExperimentId, ProjectId, ResearchCommand, ResearchResponse } from '@deepseek-ai/dsh-research-workbench/types'
import type {} from '@deepseek-ai/dsh-research-workbench'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

// Borrowed read-only: any settled transcript with a closing assistant reply.
const SETTLED_SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))

/** A deterministic model: the project storage, tools and execution stay real. */
class ReplyAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 128000 })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The service never writes into the conversation: no injected stage prompts, no research system section.
    expect(JSON.stringify(options.messages)).not.toContain('Continue the research project')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Noted.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Noted.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let scaffold: WebScaffold
let browser: Browser
let page: Page
let projectId: ProjectId
let manuscriptId: ArtifactId
let codeId: ArtifactId
let consoleState: ReturnType<typeof watchConsole>
const python = process.env.DSH_RESEARCH_TEST_PYTHON
const texBin = process.env.DSH_RESEARCH_TEST_TEX_BIN

beforeAll(async () => {
  // The research edition as shipped: none of the inherited rows it turns off, and
  // conversations compose from the research preset, the shipped default.
  scaffold = await launchWebScaffold({ enableInheritedRows: false, agentPresets: { roots: [], default: 'research' } })
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['research-browser-test'], new ReplyAdapter()))
  await scaffold.ctx.research.configure({
    main: { provider: 'research-browser-test', model: 'reply' },
    ...(python ? { python } : {}), ...(texBin ? { texBin } : {}),
  })
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  consoleState = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
})

afterAll(async () => {
  try { await browser?.close() } finally { await scaffold?.close() }
})

beforeEach(() => { onTestFailed(() => saveFailureShot(page, 'research-workbench-flow')) })

async function command(request: ResearchCommand): Promise<ResearchResponse> {
  const response = await scaffold.ctx.research.command(request, new AbortController().signal)
  if (!response.jobId) return response
  const id = response.jobId
  await expect.poll(() => scaffold.ctx.research.tasks().find(task => task.id === id)?.status, { timeout: 120000 })
    .not.toBe('running')
  const task = scaffold.ctx.research.tasks().find(item => item.id === id)
  expect(task?.status, task?.message).toBe('completed')
  if (!task?.result) throw new Error('completed research operation has no result')
  return task.result
}

it('creates a project from the welcome screen, records evidence and opens a claim with its sources', async () => {
  // The shell's entry copy is the research product's; with no research yet the composer says where to start one.
  await page.getByText('What shall we work on today?', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: 'Choose research', exact: true }).first().waitFor()
  await page.locator('[data-composer-input][data-placeholder="Start new research or open one on the left first"]').first().waitFor()
  // The entry screen offers no cards and no promise row.
  expect(await page.getByText('I already have material', { exact: true }).count()).toBe(0)
  expect(await page.getByText('Every conclusion points back to the page it came from', { exact: true }).count()).toBe(0)
  await saveFailureShot(page, 'research-welcome')
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.locator('html').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(390)
  await saveFailureShot(page, 'research-welcome-mobile')
  await page.setViewportSize(viewport)
  await page.getByRole('button', { name: 'New project folder…', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New project', exact: true })
  await dialog.getByLabel('Project title', { exact: true }).fill('Evidence study')
  await dialog.getByLabel('Project directory', { exact: true }).fill(join(scaffold.workspaceCwd, '研究 project'))
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect.poll(async () => (await scaffold.ctx.research.snapshot()).projects.length).toBe(1)
  const project = (await scaffold.ctx.research.snapshot()).projects[0]!
  projectId = project.id
  // Nothing starts on its own: creating a project asks the model nothing, and it opens in the general mode.
  // The dialog names the mode its select holds, so the record keeps it as the person's choice.
  expect(project.mode).toBe('general')
  expect(project.modeSetBy).toBe('user')
  expect(project.autonomy).toBe('checkpoints')
  const sourcePath = join(scaffold.workspaceCwd, 'source.csv')
  await writeFile(sourcePath, 'measurement,value\nsample,42\n')
  await command({ action: 'import', projectId, paths: [sourcePath] })
  const source = scaffold.ctx.research.getProject(projectId).evidence[0]!
  expect(await readFile(join(project.root, source.path), 'utf8')).toContain('42')
  await command({ action: 'claim', projectId, claim: {
    id: 'measured-value', text: 'The measured value is 42.', kind: 'empirical', state: 'supported', artifactIds: [],
    evidence: [{ evidenceId: source.id, revision: source.revision, locator: source.chunks[0]!.locator, quote: source.chunks[0]!.text }],
  } })
  await command({ action: 'save-artifact', projectId, path: 'paper/main.tex', kind: 'manuscript', expectedRevision: 0,
    content: '\\documentclass{article}\n\\begin{document}\nMeasured value: 42.\n\\end{document}\n',
    evidence: [], claimIds: ['measured-value'], inputArtifacts: [] })
  manuscriptId = scaffold.ctx.research.getProject(projectId).artifacts[0]!.id
  await command({ action: 'save-artifact', projectId, path: 'code/run.py', kind: 'code', expectedRevision: 0,
    content: 'from pathlib import Path\nimport json\nPath("metrics.json").write_text(json.dumps({"score":42}))\nprint("run-complete")\n',
    evidence: [], claimIds: [], inputArtifacts: [] })
  codeId = scaffold.ctx.research.getProject(projectId).artifacts.find(item => item.path === 'code/run.py')!.id
  // Nothing opened the research tab on its own. Once the conversation has begun, its header chip opens it.
  expect(await page.getByRole('button', { name: /^Claims/ }).filter({ visible: true }).count()).toBe(0)
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, 'Start from the measured sample')
  await input.press('Enter')
  // The scenario records no model reply; the sent message alone ends the blank conversation and brings the header.
  await page.getByText('Start from the measured sample', { exact: true }).first().waitFor({ timeout: 30000 })
  await page.getByTitle('Research progress', { exact: true }).first().click({ timeout: 15000 })
  // The claim opens over the whole frame with the source it rests on.
  await page.getByRole('button', { name: /^Claims/ }).first().click({ timeout: 15000 })
  await page.getByText('The measured value is 42.', { exact: true }).first().click({ timeout: 15000 })
  const claim = page.getByRole('dialog')
  await expect.poll(() => claim.innerText()).toContain(source.title)
  await saveFailureShot(page, 'research-claim-sources')
  await page.keyboard.press('Escape')
})

it('reports the mode and checks the assistant records, and changes only the autonomy', async () => {
  // Back from the project's files to its conversation, where the research tab sits beside the chat.
  await page.getByRole('button', { name: 'Research conversation', exact: true }).first().click()
  // The autonomy is changed in the composer, in the seat of the shell's access chip; the tab only names it.
  const chip = (name: string) => page.getByRole('button', { name, exact: true }).filter({ visible: true }).first()
  await chip('Autonomy, current: Checkpoints').waitFor({ timeout: 15000 })
  expect(await page.getByRole('button', { name: /^Access mode/ }).count()).toBe(0)
  await page.getByText('Checkpoints (change it under the message box)', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  // The tab chooses no mode or autonomy and runs no check or pipeline: those are the assistant's and the composer's.
  expect(await page.locator('select').filter({ has: page.locator('option[value="spark-to-paper/proposal"]') }).count()).toBe(0)
  expect(await page.locator('select').filter({ has: page.locator('option[value="automatic"]') }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Run check', exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Run the pipeline', exact: true }).count()).toBe(0)
  await chip('Autonomy, current: Checkpoints').click()
  await page.getByRole('menuitem', { name: /^Automatic/ }).click()
  await expect.poll(() => scaffold.ctx.research.getProject(projectId).autonomy).toBe('automatic')
  // The host applies the autonomy's preset to the conversation, so the chip names the autonomy alone.
  const sessionId = scaffold.ctx.research.getProject(projectId).sessionId
  const preset = (): string | undefined => {
    const live = sessionId === undefined ? undefined : scaffold.ctx.agents.get(sessionId as never)
    return live === undefined ? undefined : scaffold.ctx.permissionPresets.current(live.session)
  }
  await expect.poll(preset).toBe('research-auto')
  await chip('Autonomy, current: Automatic').waitFor({ timeout: 15000 })
  // A preset typed by hand is this conversation's own until the next autonomy choice applies the autonomy again.
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, '/permission read-only')
  await input.press('Enter')
  await chip('Autonomy: Automatic; this conversation: Read only').waitFor({ timeout: 15000 })
  await page.getByText('This conversation: Read only', { exact: true }).filter({ visible: true }).first().waitFor()
  await saveFailureShot(page, 'research-autonomy-hand-set')
  await chip('Autonomy: Automatic; this conversation: Read only').click()
  await page.getByRole('menuitem', { name: /^Automatic/ }).click()
  await chip('Autonomy, current: Automatic').waitFor({ timeout: 15000 })
  expect(preset()).toBe('research-auto')
  // The assistant sets the mode and checks; the tab reports both, from the progress research_check records.
  await command({ action: 'set-mode', projectId, mode: 'spark-to-paper', route: 'proposal' })
  // Choosing the mode records the decision, in the name of whoever chose it.
  expect(scaffold.ctx.research.getProject(projectId).decisions.at(-1))
    .toMatchObject({ question: '模式与路线', answer: 'spark-to-paper · proposal', by: 'user', key: 'mode' })
  await command({ action: 'check', projectId })
  expect(scaffold.ctx.research.getProject(projectId).progress).toMatchObject({ mode: 'spark-to-paper', route: 'proposal' })
  // The project's file panel draws the same status while hidden; only the tab beside the conversation counts.
  await page.getByText('Open issues', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30000 })
  await page.getByText(/^Checked /).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  await page.getByRole('img', { name: 'Current phase', exact: true }).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  // Each issue group names its check in the reader's language; the checks' own words wait behind Details.
  await page.getByText('Details', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  await saveFailureShot(page, 'research-tab-check')
  // A decision the agent records reaches the tab on the next poll; one that defers the experiments marks that phase.
  await command({ action: 'record-decision', projectId, question: 'Which dataset?', answer: 'The measured sample' })
  await page.getByText('The measured sample', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  await command({ action: 'record-decision', projectId, question: 'Run the experiments here?', answer: 'Later, on the lab server', key: 'experiments-deferred' })
  await page.getByText('Deferred', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 15000 })
})

it('gives every conversation of the research the permission preset its autonomy selects', async () => {
  const presets = scaffold.ctx.permissionPresets
  const live = (id: string | undefined) => {
    const agent = id === undefined ? undefined : scaffold.ctx.agents.get(id as never)
    if (!agent) throw new Error(`session ${String(id)} is not live`)
    return agent.session
  }
  await command({ action: 'set-autonomy', projectId, autonomy: 'automatic' })
  // A conversation nobody has opened takes the preset as it becomes live, after the permission service pinned its default.
  const { workspaceId } = scaffold.ctx.research.getProject(projectId)
  const second = await scaffold.ctx.sessionController.create({ workspaceId })
  expect(presets.current(live(second.sessionId))).toBe('research-auto')
  // A change of autonomy reaches every live conversation of the research.
  await command({ action: 'set-autonomy', projectId, autonomy: 'checkpoints' })
  expect(presets.current(live(second.sessionId))).toBe('workspace-write')
  expect(presets.current(live(scaffold.ctx.research.getProject(projectId).sessionId))).toBe('workspace-write')
  await command({ action: 'set-autonomy', projectId, autonomy: 'automatic' })
  expect(presets.current(live(second.sessionId))).toBe('research-auto')
})

it.skipIf(!python)('executes a real local CPU task, collects metrics and exports the project', async () => {
  await command({ action: 'environment', projectId, environment: {
    name: 'Local Python', kind: 'existing', target: 'local', python: python!, requirements: [], isDefault: true,
  } })
  const project = scaffold.ctx.research.getProject(projectId)
  const runId = randomUUID()
  await command({ action: 'experiment', projectId, requestId: runId, spec: {
    name: 'Measured value', environmentId: project.environments[0]!.id, argv: ['{python}', 'code/run.py'],
    cwd: '.', seed: 42, maxSeconds: 30, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [codeId], metricsPath: 'metrics.json',
  } })
  const waited = await command({ action: 'experiment-wait', projectId, runIds: [runId as ExperimentId], timeoutSeconds: 60 })
  expect(waited.runs?.[0]?.status).toBe('completed')
  expect(scaffold.ctx.research.getProject(projectId).experiments[0]?.metrics).toEqual({ score: 42 })
  expect(scaffold.ctx.research.getProject(projectId).evidence.some(item => item.kind === 'experiment')).toBe(true)
  // Finished runs fold into one row above the composer; opening it shows the card.
  await page.getByRole('button', { name: /^Show finished runs \(\d+\)$/ }).filter({ visible: true }).first().click({ timeout: 15000 })
  await page.getByText('Measured value · seed 42', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  await saveFailureShot(page, 'research-experiment-complete')
  expect((await command({ action: 'experiment-logs', projectId, runId: runId as ExperimentId })).content).toContain('run-complete')
  const exported = await command({ action: 'export', projectId })
  expect((await readFile(exported.path!)).subarray(0, 2).toString()).toBe('PK')
})

it.skipIf(!texBin)('compiles a real PDF and keeps visual review configuration explicit', async () => {
  const result = await command({ action: 'compile', projectId, artifactId: manuscriptId, engine: 'pdflatex' })
  expect(result.message).toMatch(/^PDF built/)
  const project = scaffold.ctx.research.getProject(projectId)
  expect((await readFile(join(project.root, result.path!))).subarray(0, 4).toString()).toBe('%PDF')
  await command({ action: 'visual-review', projectId, artifactId: manuscriptId })
  expect(scaffold.ctx.research.getProject(projectId).visualReviews.at(-1)?.status).toBe('not-configured')
  expect(consoleState.pageErrors).toEqual([])
})

it('offers a new project from a blank conversation and keeps the composer draft when cancelled', async () => {
  await page.getByRole('button', { name: 'New research', exact: true }).last().click()
  await page.getByText('What shall we work on today?', { exact: true }).first().waitFor()
  const createProject = page.getByRole('button', { name: 'New project folder…', exact: true }).first()
  await createProject.waitFor()
  // The edition ships no preset chooser: no preset chip beside the composer.
  expect(await page.getByTitle('Agent preset for the session you are about to start').count()).toBe(0)
  await page.locator('[data-composer-input][data-placeholder="Describe your research question, or drop in papers and data; / for commands, @ for files or conversations"]')
    .first().waitFor()
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, 'Compare the available measurements')
  await createProject.click()
  const dialog = page.getByRole('dialog', { name: 'New project', exact: true })
  // Inside a project folder the form starts empty; outside one it carries the draft (unit-tested in ui-research).
  await dialog.getByLabel('Project title', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await input.innerText()).toBe('Compare the available measurements')
  expect((await scaffold.ctx.research.snapshot()).projects).toHaveLength(1)
})

it('shows a settled reply with no feedback buttons or view tabs', async () => {
  await seedSession(scaffold, await readFile(SETTLED_SEED, 'utf8'), 'research-edition-settled')
  await page.reload({ waitUntil: 'load' })
  const ungrouped = page.getByRole('treeitem', { name: /^Ungrouped/ }).first()
  await ungrouped.waitFor({ timeout: 15000 })
  if (await ungrouped.getAttribute('aria-expanded') !== 'true') await ungrouped.click()
  // Until its log is read, the seeded conversation's row is labelled with its folder's name.
  await page.getByRole('treeitem', { name: new RegExp(basename(scaffold.workspaceCwd)) }).first().click({ timeout: 15000 })
  const reply = page.getByText('DONE', { exact: true }).first()
  await reply.waitFor({ timeout: 30000 })
  await reply.hover()
  // The reply's action strip is drawn, without the ratings that authorise a Session-log upload.
  await page.getByRole('button', { name: 'Branch into a new conversation' }).first().waitFor({ timeout: 15000 })
  expect(await page.getByRole('button', { name: 'Good response' }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Bad response' }).count()).toBe(0)
  // The composer carries no turn, step, token-rate or cache-hit pills.
  expect(await page.getByRole('button', { name: /Cache hit|tok\/s/ }).count()).toBe(0)
  // The conversation is the only view: no Chat / Trajectory tab strip.
  expect(await page.getByRole('tab', { name: 'Trajectory' }).count()).toBe(0)
  expect(await page.getByRole('tab', { name: 'Chat' }).count()).toBe(0)
  // The composer under a conversation invites the next step of the research.
  await page.locator('[data-composer-input][data-placeholder="Keep going, or drop in papers and data; / for commands, @ for files or conversations"]')
    .first().waitFor({ timeout: 15000 })
  await saveFailureShot(page, 'research-settled-reply')
})

it('speaks Chinese on the entry screen of a new research', async () => {
  const zhPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai' })
  try {
    await zhPage.goto(scaffold.authenticatedUrl)
    await zhPage.getByRole('button', { name: '新研究', exact: true }).last().click({ timeout: 30000 })
    await zhPage.getByText('今天想推进什么？', { exact: true }).first().waitFor({ timeout: 15000 })
    await zhPage.locator('[data-composer-input][data-placeholder="说说你的研究问题，或把论文、数据拖进来（/ 调用指令，@ 引用文件或对话）"]')
      .first().waitFor({ timeout: 15000 })
    await saveFailureShot(zhPage, 'research-welcome-zh')
  } finally {
    await zhPage.close()
  }
})
