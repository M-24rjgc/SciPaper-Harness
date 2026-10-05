/** Message revisions and custom reasoning capabilities through the shipped research UI. */
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed, vi } from 'vitest'
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchResearchScaffold } from './research-scaffold.ts'
import { watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, openSettings, saveFailureShot, writeComposerDraft } from './support.ts'

class RevisionReplyAdapter extends LlmAdapter {
  override listModels(provider: string) { return Promise.resolve([{ provider, id: 'reply', name: 'Reply' }]) }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: 'Reply', contextWindow: 128000 })
  }
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Recorded.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recorded.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let scaffold: WebScaffold
let browser: Browser
let page: Page
let consoleState: ReturnType<typeof watchConsole>

beforeAll(async () => {
  scaffold = await launchResearchScaffold()
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['revision-test'], new RevisionReplyAdapter()))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'revision-test', model: 'reply' })
  await vi.waitFor(() => { expect(scaffold.ctx.agentDefaultModel.currentSelection().provider).toBe('revision-test') })
  browser = await chromium.launch()
  page = await newEnglishPage(browser)
  consoleState = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
})

afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })

async function selectedSession(): Promise<SessionId> {
  const key = await page.getByRole('tree', { name: 'Research projects', exact: true })
    .locator('[role="treeitem"][aria-selected="true"][data-key^="conversation:"]').getAttribute('data-key')
  if (key === null) throw new Error('No selected conversation')
  return SessionId(key.slice('conversation:'.length))
}

async function settled(): Promise<void> {
  const id = await selectedSession()
  await expect.poll(async () => (await scaffold.ctx.sessionController.list({}, new AbortController().signal))
    .items.find(item => item.sessionId === id)?.running).toBe(false)
}

it('edits, resends and continues from an earlier answer while retaining the original conversation', async () => {
  onTestFailed(() => saveFailureShot(page, 'conversation-revision-failure'))
  await page.getByText('What shall we work on today?', { exact: true }).waitFor()
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await writeComposerDraft(page, input, 'Original instruction')
  await input.press('Enter')
  await page.getByText('Recorded.', { exact: true }).waitFor({ timeout: 30000 })
  await settled()
  await writeComposerDraft(page, input, 'Later instruction')
  await input.press('Enter')
  await expect.poll(() => page.getByText('Recorded.', { exact: true }).count()).toBe(2)
  await settled()
  const originalId = await selectedSession()
  const original = await scaffold.ctx.sessionController.inspect(originalId)
  await page.getByRole('button', { name: 'Edit and resend', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Edit and resend', exact: true })
  await dialog.getByRole('textbox', { name: 'Edit message' }).fill('Revised instruction')
  await expect.poll(() => dialog.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  await saveFailureShot(page, 'conversation-revision-editor')
  await dialog.getByRole('button', { name: 'Resend', exact: true }).click()
  await expect.poll(() => selectedSession()).not.toBe(originalId)
  await page.getByText('Revised instruction', { exact: true }).waitFor()
  await page.getByText('Recorded.', { exact: true }).waitFor()
  await settled()
  expect(await page.getByText('Later instruction', { exact: true }).count()).toBe(0)
  const editedId = await selectedSession()
  expect((await scaffold.ctx.sessionController.inspect(originalId)).events).toEqual(original.events)
  await page.getByRole('button', { name: 'Resend', exact: true }).click()
  await expect.poll(() => selectedSession()).not.toBe(editedId)
  await page.getByText('Recorded.', { exact: true }).waitFor()
  await settled()
  await page.getByRole('tree').locator(`[data-key="conversation:${originalId}"]`).click()
  await expect.poll(() => page.getByText('Recorded.', { exact: true }).count()).toBe(2)
  await page.getByRole('button', { name: 'Continue from here', exact: true }).first().click()
  await expect.poll(() => selectedSession()).not.toBe(originalId)
  await page.locator('[data-chat-flow-kind="user"]').getByText('Original instruction', { exact: true }).waitFor()
  expect(await page.getByText('Later instruction', { exact: true }).count()).toBe(0)
  const continued = await scaffold.ctx.sessionController.inspect(await selectedSession())
  expect(continued.meta.cwd).toBe(original.meta.cwd)
  expect((await scaffold.ctx.research.snapshot()).projects.filter(project => project.example !== true)).toHaveLength(0)
  expect(consoleState.pageErrors).toEqual([])
}, 120000)

it('saves custom reasoning levels and exposes them in the conversation model menu', async () => {
  onTestFailed(() => saveFailureShot(page, 'custom-reasoning-failure'))
  await openSettings(page, 'en')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Models', exact: true }).click()
  await settings.getByRole('button', { name: 'Add model provider', exact: true }).click()
  await settings.getByRole('tab', { name: 'Custom model API', exact: true }).click()
  const custom = settings.getByRole('tabpanel', { name: 'Custom model API', exact: true })
  await custom.getByLabel('Provider ID', { exact: true }).fill('revision-reasoner')
  await custom.getByLabel('Base URL', { exact: true }).fill('https://reasoner.example/v1')
  await custom.getByRole('button', { name: 'Add model', exact: true }).click()
  await custom.getByLabel('Model ID 1', { exact: true }).fill('custom-reasoner')
  await custom.getByRole('button', { name: 'Model options 1', exact: true }).click()
  await custom.getByRole('combobox', { name: 'Reasoning levels 1', exact: true }).selectOption('custom')
  await custom.getByRole('checkbox', { name: 'Maximum', exact: true }).check()
  await custom.getByLabel('API value Maximum 1', { exact: true }).fill('ultra')
  await saveFailureShot(page, 'custom-reasoning-light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await saveFailureShot(page, 'custom-reasoning-dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await custom.getByRole('button', { name: 'Create provider', exact: true }).click()
  await settings.getByRole('button', { name: 'Edit revision-reasoner', exact: true }).waitFor()
  const info = await scaffold.ctx.llm.resolveModelInfo('revision-reasoner', 'custom-reasoner')
  expect(info.reasoning?.efforts.map(level => level.id)).toEqual(['low', 'medium', 'high', 'max'])
  await page.keyboard.press('Escape')
  const modelMenu = page.getByRole('button', { name: /^Select model/ }).first()
  await modelMenu.click()
  await page.getByRole('menuitem', { name: /^Model/ }).click()
  await page.getByRole('menuitemradio').filter({ hasText: 'custom-reasoner' }).click()
  await modelMenu.click()
  await page.getByRole('menuitem', { name: /^Effort/ }).click()
  await page.getByRole('menuitemradio', { name: /High/i }).click()
  await expect.poll(() => modelMenu.getAttribute('aria-label')).toContain('High')
  const selected = await scaffold.ctx.sessionController.inspect(await selectedSession())
  expect(selected.events.filter(event => event.type === 'model/selection').at(-1)?.data)
    .toMatchObject({ provider: 'revision-reasoner', model: 'custom-reasoner', reasoningEffort: 'high' })
  expect(consoleState.pageErrors).toEqual([])
}, 90000)
