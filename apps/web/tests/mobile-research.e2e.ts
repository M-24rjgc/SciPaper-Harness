/** Touch-only research workflows use the same session actions and model choices as desktop. */
import { chromium, type Page } from 'playwright'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import {
  LlmAdapter, ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { launchResearchScaffold } from './research-scaffold.ts'
import { watchConsole } from './scaffold.ts'
import { openSettings, writeComposerDraft } from './support.ts'

class PhoneReplyAdapter extends LlmAdapter {
  override listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'reply', name: 'Phone Reply' }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: 'Phone Reply', contextWindow: 128000,
      reasoning: { efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ] },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    expect(options.reasoningEffort).toBe('high')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Phone reply.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Phone reply.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function selectedSession(page: Page): Promise<SessionId> {
  const drawer = page.locator('[data-mobile-sidebar][role="dialog"]')
  const alreadyOpen = await drawer.isVisible()
  if (!alreadyOpen) await page.getByRole('button', { name: 'Open sidebar', exact: true }).tap()
  const key = await drawer.locator('[role="treeitem"][aria-selected="true"][data-key^="conversation:"]').getAttribute('data-key')
  if (!alreadyOpen) {
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'hidden' })
  }
  if (key === null) throw new Error('No selected phone conversation')
  return SessionId(key.slice('conversation:'.length))
}

it('chooses effort, edits a prior message, and opens session actions using touch', async () => {
  const scaffold = await launchResearchScaffold()
  onTestFinished(() => scaffold.close())
  scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['phone-test'], new PhoneReplyAdapter()))
  await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'phone-test', model: 'reply' })
  await vi.waitFor(() => { expect(scaffold.ctx.agentDefaultModel.currentSelection().provider).toBe('phone-test') })
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US',
  })
  const page = await context.newPage()
  const consoleState = watchConsole(page)
  onTestFailed(async () => {
    if (!page.isClosed()) await page.screenshot({ path: join(tmpdir(), 'scipaper-mobile-research-failure.png'), fullPage: true })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByText('What shall we work on today?', { exact: true }).waitFor()
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  expect(await input.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16)
  const model = page.getByRole('button', { name: /^Select model/ }).first()
  expect((await model.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: join(tmpdir(), 'scipaper-mobile-hero-light.png'), fullPage: true })
  await model.tap()
  await page.getByRole('menuitem', { name: /^Effort/ }).tap()
  await page.getByRole('menuitemradio', { name: 'High', exact: true }).tap()
  await expect.poll(() => model.getAttribute('aria-label')).toContain('High')
  await writeComposerDraft(page, input, 'Phone original instruction')
  await page.getByRole('button', { name: 'Send message', exact: true }).tap()
  await page.getByText('Phone reply.', { exact: true }).waitFor()
  const originalId = await selectedSession(page)
  await expect.poll(async () => (await scaffold.ctx.sessionController.list({}, new AbortController().signal))
    .items.find(item => item.sessionId === originalId)?.running).toBe(false)
  const original = await scaffold.ctx.sessionController.inspect(originalId)
  await page.screenshot({ path: join(tmpdir(), 'scipaper-mobile-chat-light.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.locator('body[data-ds-dark-theme]').waitFor()
  await page.screenshot({ path: join(tmpdir(), 'scipaper-mobile-chat-dark.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.locator('body[data-ds-dark-theme]').waitFor({ state: 'detached' })
  const edit = page.getByRole('button', { name: 'Edit and resend', exact: true }).first()
  expect((await edit.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await edit.tap()
  const editor = page.getByRole('dialog', { name: 'Edit and resend', exact: true })
  for (const action of await editor.getByRole('button').all()) {
    expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  }
  await editor.getByRole('textbox', { name: 'Edit message', exact: true }).fill('Phone revised instruction')
  await expect.poll(() => editor.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  await page.screenshot({ path: join(tmpdir(), 'scipaper-mobile-message-editor.png'), fullPage: true })
  await editor.getByRole('button', { name: 'Resend', exact: true }).tap()
  await editor.waitFor({ state: 'hidden' })
  await page.getByText('Phone revised instruction', { exact: true }).waitFor()
  await page.getByText('Phone reply.', { exact: true }).waitFor()
  await expect.poll(() => selectedSession(page)).not.toBe(originalId)
  expect((await scaffold.ctx.sessionController.inspect(originalId)).events).toEqual(original.events)
  const currentId = await selectedSession(page)
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).tap()
  const drawer = page.locator('[data-mobile-sidebar][role="dialog"]')
  const currentRow = drawer.locator(`[data-key="conversation:${currentId}"]`)
  const more = currentRow.getByRole('button', { name: /^More for/ })
  expect(await more.isVisible()).toBe(true)
  expect((await more.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await more.tap()
  const rename = page.getByRole('menuitem', { name: 'Rename', exact: true })
  await rename.waitFor()
  // A contact leaves its target after tap; the menu must remain selectable.
  await page.waitForTimeout(500)
  expect(await rename.isVisible()).toBe(true)
  expect((await rename.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: join(tmpdir(), 'scipaper-mobile-session-menu-light.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.locator('body[data-ds-dark-theme]').waitFor()
  await page.screenshot({ path: join(tmpdir(), 'scipaper-mobile-session-menu-dark.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.locator('body[data-ds-dark-theme]').waitFor({ state: 'detached' })
  await rename.tap()
  const renameDialog = page.getByRole('dialog', { name: 'Rename conversation', exact: true })
  await renameDialog.getByRole('textbox').fill('Phone renamed conversation')
  await renameDialog.getByRole('button', { name: 'Rename', exact: true }).tap()
  await renameDialog.waitFor({ state: 'hidden' })
  await drawer.getByText('Phone renamed conversation', { exact: true }).waitFor()
  await currentRow.tap()
  await drawer.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).tap()
  await openSettings(page, 'en')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('button', { name: 'Research', exact: true }).tap()
  const examples = settings.getByRole('switch', { name: 'Show example researches', exact: true })
  const switchBox = await examples.boundingBox()
  expect(switchBox?.width).toBeGreaterThanOrEqual(44)
  expect(switchBox?.height).toBeGreaterThanOrEqual(44)
  expect(await examples.getAttribute('aria-checked')).toBe('true')
  await examples.tap()
  await expect.poll(() => examples.getAttribute('aria-checked')).toBe('false')
  await expect.poll(() => examples.isEnabled()).toBe(true)
  // Native Space activation still works with an enlarged phone touch target.
  await examples.focus()
  await page.keyboard.press('Space')
  await expect.poll(() => examples.getAttribute('aria-checked')).toBe('true')
  await settings.getByRole('button', { name: 'Close', exact: true }).tap()
  await page.keyboard.press('Escape')
  await drawer.waitFor({ state: 'hidden' })
  expect(await page.locator('html').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(390)
  expect(consoleState.pageErrors).toEqual([])
}, 120_000)
