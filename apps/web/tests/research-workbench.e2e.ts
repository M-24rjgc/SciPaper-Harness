/** The research edition through the shipped browser and durable host: the agent drives, the ledger records. */
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, beforeEach, onTestFailed, vi } from 'vitest'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {
  ArtifactId, ExperimentId, ProjectId, ResearchCommand, ResearchProject, ResearchResponse,
} from '@deepseek-ai/dsh-research-workbench/types'
import type {} from '@deepseek-ai/dsh-research-workbench'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { launchResearchScaffold } from './research-scaffold.ts'
import { newEnglishPage, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

// Borrowed read-only: any settled transcript with a closing assistant reply.
const SETTLED_SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))

/** A deterministic model: the project storage, tools and execution stay real. */
class ReplyAdapter extends LlmAdapter {
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'reply', name: 'Reply' }])
  }

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
  scaffold = await launchResearchScaffold()
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['research-browser-test'], new ReplyAdapter()))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'research-browser-test', model: 'reply' })
  await vi.waitFor(() => {
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toMatchObject({ provider: 'research-browser-test', model: 'reply' })
  })
  await scaffold.ctx.research.configure({
    researchHome: join(scaffold.workspaceCwd, 'SciPaper'),
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

/**
 * What is left in a discarded draft's folder. Windows keeps the emptied folder
 * while a skill watcher still holds it, so it may remain, but never with
 * anything in it.
 */
function leftInFolder(folder: string): string[] {
  return existsSync(folder) ? readdirSync(folder) : []
}

/** The person's own researches the host records now, the untouched draft marked; the shipped examples are not among them. */
async function projects(): Promise<ResearchProject[]> {
  return (await scaffold.ctx.research.snapshot()).projects.filter(project => project.example !== true)
}

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

it('starts with an ordinary conversation, creates an explicit project, and opens claim evidence', async () => {
  await page.getByText('What shall we work on today?', { exact: true }).first().waitFor()
  await page.getByText('Ordinary conversation · You can add it to a project later', { exact: true }).waitFor()
  expect(await projects()).toHaveLength(0)
  await page.getByRole('button', { name: /^Autonomy/ }).click()
  await page.getByRole('menuitem').filter({ hasText: 'Automatic' }).click()
  await expect.poll(() => page.getByRole('button', { name: /^Autonomy/ }).innerText()).toContain('Automatic')
  expect(await projects()).toHaveLength(0)
  const chip = page.getByRole('button', { name: 'Choose project', exact: true }).first()
  await chip.filter({ hasText: 'Ordinary conversations' }).waitFor()
  await page.getByText('Try:', { exact: true }).first().waitFor()
  await saveFailureShot(page, 'research-welcome')
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.locator('html').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(390)
  await saveFailureShot(page, 'research-welcome-mobile')
  await page.setViewportSize(viewport)
  const chosen = join(scaffold.workspaceCwd, '研究 project')
  await page.getByRole('button', { name: 'New research project', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'New research project', exact: true })
  await dialog.getByLabel('Project name', { exact: true }).fill('Evidence study')
  await dialog.getByLabel('Save location', { exact: true }).fill(chosen)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await projects()).toHaveLength(0)
  expect(existsSync(chosen)).toBe(false)
  await page.getByRole('button', { name: 'New research project', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'New research project', exact: true })
  await dialog.getByLabel('Project name', { exact: true }).fill('Evidence study')
  await dialog.getByLabel('Save location', { exact: true }).fill(chosen)
  await saveFailureShot(page, 'research-create-project')
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect.poll(async () => (await projects()).map(item => item.root), { timeout: 15000 }).toEqual([chosen])
  const project = (await projects())[0]!
  projectId = project.id
  expect(project).toMatchObject({ title: 'Evidence study', mode: 'general' })
  expect(project.draft).not.toBe(true)
  expect(project.modeSetBy).toBeUndefined()
  await chip.filter({ hasText: 'Evidence study' }).waitFor({ timeout: 15000 })
  await page.getByText('New conversation in “Evidence study”', { exact: true }).waitFor()
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
  // The scripted adapter answers through the real conversation loop.
  await page.getByText('Start from the measured sample', { exact: true }).first().waitFor({ timeout: 30000 })
  await page.getByText('Noted.', { exact: true }).first().waitFor({ timeout: 30000 })
  await page.getByTitle('Research record', { exact: true }).first().click({ timeout: 15000 })
  // The claims count opens the Sources tab beside the conversation, at its claims; nothing takes the main panel.
  await page.getByRole('button', { name: /^Claims/ }).first().click({ timeout: 15000 })
  await page.getByText('Start from the measured sample', { exact: true }).first().waitFor()
  // The claim opens over the whole frame with the source it rests on.
  await page.getByText('The measured value is 42.', { exact: true }).filter({ visible: true }).first().click({ timeout: 15000 })
  const claim = page.getByRole('dialog')
  await expect.poll(() => claim.innerText()).toContain(source.title)
  await claim.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished))
  })
  await saveFailureShot(page, 'research-claim-sources')
  await page.keyboard.press('Escape')
})

it('reports the mode and checks the assistant records, and changes only the autonomy', async () => {
  // The header chip brings the research tab back beside the conversation.
  await page.getByTitle('Research record', { exact: true }).first().click({ timeout: 15000 })
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
  await page.getByText('Open issues', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 30000 })
  await page.getByText(/^Checked /).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  await page.getByRole('img', { name: 'Current phase', exact: true }).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  // Each issue group names its check in the reader's language; the checks' own words wait behind Details.
  await page.getByText('Details', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  // The record reads the mode as the person chose it, and its Now line names the next phase.
  await page.getByText('spark-to-paper · From a proposal · you chose it', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  await page.getByText(/^Next: /).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  await saveFailureShot(page, 'research-tab-check')
  // Its suggestion only fills the composer; the person still decides whether to send it.
  const suggest = page.getByRole('button', { name: /^Suggest in the conversation: Continue: / }).filter({ visible: true }).first()
  const sentence = ((await suggest.textContent()) ?? '').replace('Suggest in the conversation: ', '')
  await suggest.click()
  await expect.poll(() => input.innerText()).toBe(sentence)
  await input.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await expect.poll(async () => (await input.innerText()).trim()).toBe('')
  // A decision the agent records reaches the tab on the next poll; one that defers the experiments marks that phase.
  await command({ action: 'record-decision', projectId, question: 'Which dataset?', answer: 'The measured sample' })
  await page.getByText('The measured sample', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 15000 })
  await command({ action: 'record-decision', projectId, question: 'Run the experiments here?', answer: 'Later, on the lab server', key: 'experiments-deferred' })
  await page.getByText('Deferred', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 15000 })
})

it('opens the secondary tools as tabs beside the conversation, and a .drawio file in the draw.io editor', async () => {
  const tool = (name: string) => page.getByRole('button', { name, exact: true }).filter({ visible: true }).first()
  const chip = page.getByTitle('Research record', { exact: true }).first()
  const sourcesCount = page.getByRole('button', { name: /^Sources/ }).filter({ visible: true }).first()
  // The record is on screen, so the header chip closes the panel; clicking it again opens the record.
  await sourcesCount.waitFor({ timeout: 15000 })
  await chip.click({ timeout: 15000 })
  await expect.poll(() => sourcesCount.count(), { timeout: 15000 }).toBe(0)
  await chip.click()
  // The sources count opens 资料 (Sources); a source opens in the sidebar's own viewer, read through this conversation.
  await sourcesCount.click({ timeout: 15000 })
  const sources = page.getByRole('heading', { name: /^Sources\s*1$/ }).filter({ visible: true }).first()
  await sources.waitFor({ timeout: 15000 })
  await page.getByText('source.csv', { exact: true }).filter({ visible: true }).first().waitFor()
  await saveFailureShot(page, 'research-sources-tab')
  await tool('Open this page in the source').click()
  const spreadsheet = page.locator('[data-excel-preview]').filter({ visible: true }).first()
  await spreadsheet.waitFor({ timeout: 15000 })
  await expect.poll(() => spreadsheet.innerText()).toContain('measurement')
  // The board opens from the tools row, empty until the assistant registers a run; the conversation stays on screen.
  await page.getByTitle('Research record', { exact: true }).first().click()
  await tool('Experiment board').click({ timeout: 15000 })
  await page.getByText('This research has no experiments yet. The assistant registers runs here when it needs them.', { exact: true })
    .filter({ visible: true }).first().waitFor({ timeout: 15000 })
  expect(await page.getByText('Start from the measured sample', { exact: true }).filter({ visible: true }).count()).toBeGreaterThan(0)
  await saveFailureShot(page, 'research-board-tab')
  // A .drawio file in the research files opens in the draw.io editor, which registers the file with the record.
  const { root } = scaffold.ctx.research.getProject(projectId)
  await mkdir(join(root, 'figures'), { recursive: true })
  await writeFile(join(root, 'figures', 'flow.drawio'), '<mxfile><diagram name="Flow"></diagram></mxfile>\n')
  await page.getByTitle('Research record', { exact: true }).first().click()
  await tool('Research files').click({ timeout: 15000 })
  await page.locator('[data-files-entry="directory"][data-files-path$="/figures"] > button').filter({ visible: true }).first().click({ timeout: 15000 })
  await page.locator('[data-files-entry="file"][data-files-path$="/flow.drawio"] > button').filter({ visible: true }).first().click({ timeout: 15000 })
  await expect.poll(() => scaffold.ctx.research.getProject(projectId).artifacts.find(item => item.path === 'figures/flow.drawio')?.kind, { timeout: 15000 })
    .toBe('diagram')
  // The scaffold's home has no draw.io component, so the editor offers its install.
  await page.getByText('The draw.io editor is a local component. Install it once to edit diagrams here.', { exact: true })
    .filter({ visible: true }).first().waitFor({ timeout: 15000 })
  await saveFailureShot(page, 'research-drawio-tab')
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
  // The assistant submits the run from the conversation on screen, which the run records.
  const sessionId = project.sessionId!
  await scaffold.ctx.research.execute({ action: 'experiment', projectId, requestId: runId, spec: {
    name: 'Measured value', environmentId: project.environments[0]!.id, argv: ['{python}', 'code/run.py'],
    cwd: '.', seed: 42, maxSeconds: 30, gpuIds: [], dataEvidenceIds: [], codeArtifactIds: [codeId], metricsPath: 'metrics.json',
  } }, new AbortController().signal, 'agent', sessionId)
  expect(scaffold.ctx.research.getProject(projectId).experiments[0]?.sessionId).toBe(sessionId)
  const waited = await command({ action: 'experiment-wait', projectId, runIds: [runId as ExperimentId], timeoutSeconds: 60 })
  expect(waited.runs?.[0]?.status).toBe('completed')
  expect(scaffold.ctx.research.getProject(projectId).experiments[0]?.metrics).toEqual({ score: 42 })
  expect(scaffold.ctx.research.getProject(projectId).evidence.some(item => item.kind === 'experiment')).toBe(true)
  // Finished runs of this conversation fold into one row above its composer; opening it shows the card.
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

it('opens and reuses a project conversation, separates ordinary conversations, and carries an unsent draft into a project', async () => {
  const newConversation = page.getByRole('button', { name: 'New conversation', exact: true }).last()
  await newConversation.click()
  const chip = page.getByRole('button', { name: 'Choose project', exact: true }).first()
  await chip.filter({ hasText: 'Evidence study' }).waitFor({ timeout: 15000 })
  await newConversation.click()
  await page.getByText('This conversation is ready; describe your question.', { exact: true }).first().waitFor()
  expect(await projects()).toHaveLength(1)
  await page.getByRole('button', { name: 'New ordinary conversation', exact: true }).click()
  await chip.filter({ hasText: 'Ordinary conversations' }).waitFor()
  expect(await projects()).toHaveLength(1)
  const crowded = join(scaffold.workspaceCwd, 'notes folder')
  await mkdir(crowded, { recursive: true })
  await writeFile(join(crowded, 'notes.txt'), 'kept as it is\n')
  await page.getByRole('button', { name: 'New research project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New research project', exact: true })
  await dialog.getByLabel('Project name', { exact: true }).fill('Notes')
  await dialog.getByLabel('Save location', { exact: true }).fill(crowded)
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
  await dialog.getByText('This folder contains files. Use it for the project?', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await projects()).toHaveLength(1)
  expect(leftInFolder(crowded)).toEqual(['notes.txt'])
  const idea = 'Can block-sparse attention hold long-context accuracy at a quarter of the FLOPs?'
  await page.getByRole('button', { name: `“${idea}”`, exact: true }).click()
  await chip.click()
  await page.getByRole('menuitem', { name: 'Move to another research', exact: true }).hover()
  await page.getByRole('menuitem', { name: 'Evidence study', exact: true }).click()
  await chip.filter({ hasText: 'Evidence study' }).waitFor()
  await expect.poll(() => page.locator('[data-composer-input][contenteditable="true"]').first().innerText()).toBe(idea)
  const record = page.getByRole('button', { name: 'Research record', exact: true })
  await record.click()
  await page.getByText('Decisions', { exact: true }).filter({ visible: true }).first().waitFor()
  await saveFailureShot(page, 'research-second-conversation')
})

it('lists the researches in the sidebar, opens a second conversation, and removes a research from the list until it is restored', async () => {
  const tree = page.getByRole('tree', { name: 'Research projects', exact: true })
  await tree.waitFor({ timeout: 15000 })
  // The shell's workspace browser is shadowed: no workspace list, no Add workspace, no view options.
  expect(await page.getByRole('button', { name: 'Add workspace' }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'View options' }).count()).toBe(0)
  // The research on screen is open on its blank conversation, which carries the typed question;
  // ＋ New conversation waits until the person leaves it.
  const research = tree.getByRole('treeitem', { name: /^Evidence study/ })
  await expect.poll(() => research.getAttribute('aria-expanded'), { timeout: 15000 }).toBe('true')
  const blank = tree.getByRole('treeitem', { name: /^Draft · Can block-sparse attention/ })
  await expect.poll(() => blank.getAttribute('aria-selected'), { timeout: 15000 }).toBe('true')
  const add = tree.getByRole('treeitem', { name: 'New conversation in “Evidence study”', exact: true })
  expect(await add.count()).toBe(0)
  // The conversation that has started opens from its row, and ＋ New conversation then offers the blank one again.
  const bound = scaffold.ctx.research.getProject(projectId).sessionId!
  await tree.locator(`[data-key="conversation:${bound}"]`).click()
  await page.getByText('Start from the measured sample', { exact: true }).first().waitFor({ timeout: 15000 })
  await add.waitFor({ timeout: 15000 })
  await saveFailureShot(page, 'research-tree')
  await add.click()
  await page.getByText('What shall we work on today?', { exact: true }).first().waitFor({ timeout: 15000 })
  await expect.poll(() => add.count(), { timeout: 15000 }).toBe(0)
  // The search finds a conversation by what was said in it, through the shell's content search.
  await page.getByRole('button', { name: 'Search researches and conversations', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search researches and conversations', exact: true }).fill('measured sample')
  const results = page.getByRole('tree', { name: 'Search results', exact: true })
  await results.getByRole('treeitem').filter({ hasText: 'Evidence study' }).first().waitFor({ timeout: 15000 })
  await page.getByRole('textbox', { name: 'Search researches and conversations', exact: true }).press('Escape')
  // The row menu renames the research.
  const menuOf = async (name: string): Promise<void> => {
    const row = tree.getByRole('treeitem', { name: new RegExp(`^${name}`) })
    await row.hover()
    await row.getByRole('button', { name: `More for “${name}”`, exact: true }).click()
  }
  await menuOf('Evidence study')
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const rename = page.getByRole('dialog', { name: 'Rename research', exact: true })
  await rename.getByLabel('Name', { exact: true }).fill('Evidence study, measured')
  await rename.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect.poll(() => scaffold.ctx.research.getProject(projectId).title, { timeout: 15000 }).toBe('Evidence study, measured')
  const renamed = tree.getByRole('treeitem', { name: /^Evidence study, measured/ })
  await renamed.waitFor({ timeout: 15000 })
  // Removing a project archives its conversations and opens an ordinary conversation.
  await menuOf('Evidence study, measured')
  await page.getByRole('menuitem', { name: 'Remove from list', exact: true }).click()
  await expect.poll(async () => (await projects()).find(item => item.id === projectId)?.archived, { timeout: 15000 }).toBe(true)
  await expect.poll(() => renamed.count(), { timeout: 15000 }).toBe(0)
  await page.getByText('Ordinary conversation · You can add it to a project later', { exact: true }).waitFor({ timeout: 15000 })
  expect(existsSync(scaffold.ctx.research.getProject(projectId).root)).toBe(true)
  // Settings list it among the removed researches, and 恢复 puts it back; the examples switch saves at once.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Research', exact: true }).click()
  const examples = settings.getByRole('switch', { name: 'Show example researches', exact: true })
  await examples.waitFor({ timeout: 15000 })
  expect(await examples.getAttribute('aria-checked')).toBe('true')
  await examples.click()
  await expect.poll(async () => (await scaffold.ctx.research.snapshot()).preferences.showExamples, { timeout: 15000 }).toBe(false)
  await examples.click()
  await expect.poll(async () => (await scaffold.ctx.research.snapshot()).preferences.showExamples, { timeout: 15000 }).toBe(true)
  await settings.getByText('Evidence study, measured', { exact: true }).waitFor({ timeout: 15000 })
  await saveFailureShot(page, 'research-settings-removed')
  await settings.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect.poll(async () => (await projects()).find(item => item.id === projectId)?.archived, { timeout: 15000 }).toBeUndefined()
  await settings.getByRole('button', { name: 'Close' }).last().click()
  await renamed.waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  const plugins = page.locator('[data-plugin-panel]')
  await plugins.getByRole('heading', { name: 'Plugins', exact: true }).waitFor({ timeout: 15000 })
  await expect.poll(() => plugins.locator('[data-plugin-package]').count(), { timeout: 15000 }).toBeGreaterThan(0)
  await renamed.click()
})

it('shows a settled reply with no feedback buttons or view tabs', async () => {
  await seedSession(scaffold, await readFile(SETTLED_SEED, 'utf8'), 'research-edition-settled')
  await page.reload({ waitUntil: 'load' })
  // A conversation outside every folder is listed with ordinary conversations.
  const tree = page.getByRole('tree', { name: 'Research projects', exact: true })
  const loose = tree.getByRole('treeitem', { name: /^Ordinary conversations/ })
  await loose.waitFor({ timeout: 15000 })
  if (await loose.getAttribute('aria-expanded') !== 'true') await loose.click()
  // Until its log is read, the seeded conversation's row is labelled with its folder's name.
  await tree.getByRole('treeitem', { name: new RegExp(basename(scaffold.workspaceCwd)) }).first().click({ timeout: 15000 })
  const reply = page.getByText('DONE', { exact: true }).first()
  await reply.waitFor({ timeout: 30000 })
  await reply.hover()
  // The reply's action strip is drawn, without the ratings that authorise a Session-log upload.
  await page.getByRole('button', { name: 'Continue from here' }).first().waitFor({ timeout: 15000 })
  expect(await page.getByRole('button', { name: 'Good response' }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Bad response' }).count()).toBe(0)
  // The composer carries no turn, step, token-rate or cache-hit pills.
  expect(await page.getByRole('button', { name: /Cache hit|tok\/s/ }).count()).toBe(0)
  // The research edition keeps the trajectory view (research-edition-rows), so the conversation offers Chat and Trajectory tabs.
  expect(await page.getByRole('tab', { name: 'Trajectory' }).count()).toBe(1)
  expect(await page.getByRole('tab', { name: 'Chat' }).count()).toBe(1)
  // The composer under a conversation invites the next step of the research.
  await page.locator('[data-composer-input][data-placeholder="Keep going, or drop in papers and data; / for commands, @ for files or conversations"]')
    .first().waitFor({ timeout: 15000 })
  await saveFailureShot(page, 'research-settled-reply')
})

it('speaks Chinese on the entry screen of an ordinary conversation', async () => {
  const zhPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai' })
  try {
    await zhPage.goto(scaffold.authenticatedUrl)
    // A new window lands on the research used last, on its conversation that has started.
    await zhPage.getByTitle('研究记录', { exact: true }).first().waitFor({ timeout: 30000 })
    await zhPage.getByRole('button', { name: '新建普通对话', exact: true }).last().click({ timeout: 30000 })
    await zhPage.getByText('今天想推进什么？', { exact: true }).first().waitFor({ timeout: 15000 })
    await zhPage.locator('[data-composer-input][data-placeholder="说说你的研究问题，或把论文、数据拖进来（/ 调用指令，@ 引用文件或对话）"]')
      .first().waitFor({ timeout: 15000 })
    await zhPage.getByText('试试：', { exact: true }).first().waitFor({ timeout: 15000 })
    await zhPage.getByRole('button', { name: '选择项目', exact: true }).first().click()
    await zhPage.getByRole('menuitem', { name: '换到另一项研究', exact: true }).waitFor()
    await saveFailureShot(zhPage, 'research-welcome-zh')
  } finally {
    await zhPage.close()
  }
})

it('continues an ordinary conversation in a project with its full history and keeps the source files', async () => {
  const tree = page.getByRole('tree', { name: 'Research projects', exact: true })
  await page.getByRole('button', { name: 'New ordinary conversation', exact: true }).click()
  await page.getByText('Ordinary conversation · You can add it to a project later', { exact: true }).waitFor()
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  const question = 'Compare the two measurements in this ordinary conversation'
  await writeComposerDraft(page, input, question)
  await input.press('Enter')
  await page.getByText('Noted.', { exact: true }).first().waitFor({ timeout: 30000 })
  const selected = tree.locator('[role="treeitem"][aria-selected="true"][data-key^="conversation:"]')
  const sourceId = (await selected.getAttribute('data-key'))!.slice('conversation:'.length)
  await expect.poll(async () => {
    const { items } = await scaffold.ctx.sessionController.list({}, new AbortController().signal)
    return items.find(item => item.sessionId === sourceId)?.running
  }).toBe(false)
  const source = await scaffold.ctx.sessionController.inspect(sourceId as never)
  const note = join(source.meta.cwd!, 'notes.txt')
  await writeFile(note, 'Original conversation files remain available')
  await selected.hover()
  await selected.getByRole('button', { name: /^More for/ }).click()
  await page.getByRole('menuitem', { name: 'Add to project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add this conversation to a project', exact: true })
  await dialog.getByRole('radio', { name: scaffold.ctx.research.getProject(projectId).title, exact: true }).check()
  await dialog.getByRole('button', { name: 'Add to project', exact: true }).click()
  await expect.poll(() => dialog.count(), { timeout: 15000 }).toBe(0)
  await page.getByText(question, { exact: true }).first().waitFor()
  await page.getByText('Noted.', { exact: true }).first().waitFor()
  const targetId = (await selected.getAttribute('data-key'))!.slice('conversation:'.length)
  expect(targetId).not.toBe(sourceId)
  const target = await scaffold.ctx.sessionController.inspect(targetId as never)
  expect(target.meta.cwd).toBe(scaffold.ctx.research.getProject(projectId).root)
  expect(target.events.slice(0, source.events.length)).toEqual(source.events)
  const hierarchy = page.getByRole('navigation', { name: 'Session hierarchy', exact: true })
  expect(await hierarchy.getByText(/^Compare the two measurements/).count()).toBe(1)
  expect(scaffold.ctx.workspaceRegistry.archivedSessionIds).toContain(sourceId)
  expect(await readFile(note, 'utf8')).toBe('Original conversation files remain available')
  await page.reload({ waitUntil: 'load' })
  await tree.locator(`[data-key="conversation:${targetId}"]`).click({ timeout: 15000 })
  await page.getByText(question, { exact: true }).first().waitFor()
  await page.getByText('Noted.', { exact: true }).first().waitFor()
  await saveFailureShot(page, 'research-conversation-assigned')
})

it('moves a draft to another research without replacing its existing unsent draft', async () => {
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await input.waitFor({ timeout: 30000 })
  const first = await scaffold.ctx.research.create({
    title: 'Draft destination', root: join(scaffold.workspaceCwd, 'draft-destination'), brief: 'Keep the first question',
  })
  const second = await scaffold.ctx.research.create({
    title: 'Draft source', root: join(scaffold.workspaceCwd, 'draft-source'), brief: 'Move the second question',
  })
  const tree = page.getByRole('tree', { name: 'Research projects', exact: true })
  const chip = page.getByRole('button', { name: 'Choose project', exact: true }).first()
  const firstDraft = 'X: preserve this unfinished research question'
  const carriedDraft = 'Y: move this question into the destination research'
  const firstSessions = () => scaffold.ctx.workspaceRegistry.get(first.workspaceId)!.sessionIds

  // Both host sessions are blank: only the browser knows about the unsent text.
  await tree.locator(`[data-key="research:${first.id}"]`).click({ timeout: 15000 })
  await chip.filter({ hasText: first.title }).waitFor({ timeout: 15000 })
  await writeComposerDraft(page, input, firstDraft)
  await expect.poll(() => input.innerText()).toBe(firstDraft)
  expect(firstSessions()).toEqual([first.sessionId])

  await tree.locator(`[data-key="research:${second.id}"]`).click({ timeout: 15000 })
  await chip.filter({ hasText: second.title }).waitFor({ timeout: 15000 })
  await writeComposerDraft(page, input, carriedDraft)
  await expect.poll(() => input.innerText()).toBe(carriedDraft)
  await chip.click()
  await page.getByRole('menuitem', { name: 'Move to another research', exact: true }).hover()
  await page.getByRole('menuitem', { name: first.title, exact: true }).click()

  // Carrying Y needs a fresh session in A, since A's original blank session owns X.
  await chip.filter({ hasText: first.title }).waitFor({ timeout: 15000 })
  await expect.poll(() => input.innerText()).toBe(carriedDraft)
  await expect.poll(() => firstSessions().length, { timeout: 15000 }).toBe(2)
  const carriedSession = firstSessions().find(id => id !== first.sessionId)!
  await expect.poll(() => tree.locator(`[data-key="conversation:${carriedSession}"]`).getAttribute('aria-selected'))
    .toBe('true')

  await tree.locator(`[data-key="conversation:${first.sessionId}"]`).click()
  await expect.poll(() => input.innerText()).toBe(firstDraft)
  await tree.locator(`[data-key="conversation:${carriedSession}"]`).click()
  await expect.poll(() => input.innerText()).toBe(carriedDraft)
  await tree.locator(`[data-key="research:${second.id}"]`).click()
  await chip.filter({ hasText: second.title }).waitFor({ timeout: 15000 })
  await expect.poll(async () => (await input.innerText()).trim()).toBe('')
  // The destination's independent drafts also survive a real browser reload.
  await page.reload({ waitUntil: 'load' })
  const firstRow = tree.locator(`[data-key="research:${first.id}"]`)
  await firstRow.waitFor({ timeout: 15000 })
  if (await firstRow.getAttribute('aria-expanded') !== 'true') await firstRow.press('ArrowRight')
  await tree.locator(`[data-key="conversation:${first.sessionId}"]`).click({ timeout: 15000 })
  await expect.poll(() => input.innerText()).toBe(firstDraft)
  await tree.locator(`[data-key="conversation:${carriedSession}"]`).click()
  await expect.poll(() => input.innerText()).toBe(carriedDraft)
  expect(consoleState.pageErrors).toEqual([])
})
