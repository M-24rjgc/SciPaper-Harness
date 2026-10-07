/** Real phone viewport navigation keeps the conversation usable beneath transient panels. */
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { describe, expect, it, onTestFinished } from 'vitest'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'
import { openSettings } from './support.ts'

const SESSION_SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const SESSION_TITLE = 'Phone research conversation'

describe.skipIf(webSnapshotMode() === 'record')('web e2e: phone navigation', () => {
  it('covers the conversation with navigation, selects a session, and uses full-width settings', async () => {
    const scaffold = await launchWebScaffold({})
    onTestFinished(() => scaffold.close())
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = await seedSession(scaffold, await readFile(SESSION_SEED, 'utf8'), 'phone-layout-web-e2e')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: SESSION_TITLE })
    const browser = await chromium.launch()
    onTestFinished(() => browser.close())
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US',
    })
    const page = await context.newPage()
    const consoleState = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-mobile="true"]').waitFor()
    const center = page.locator('[data-layout-center]')
    const centerElement = await center.elementHandle()
    const open = page.getByRole('button', { name: 'Open sidebar', exact: true })
    expect((await center.boundingBox())?.width).toBe(390)
    await open.tap()
    const drawer = page.locator('[data-mobile-sidebar][role="dialog"]')
    await drawer.waitFor()
    expect((await center.boundingBox())?.width).toBe(390)
    expect(await center.evaluate(element => element instanceof HTMLElement && element.inert)).toBe(true)
    expect(await centerElement!.evaluate(element => element.isConnected)).toBe(true)
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'hidden' })
    expect(await open.evaluate(element => element === document.activeElement)).toBe(true)
    await open.tap()
    await drawer.waitFor()
    const row = drawer.getByRole('treeitem').filter({ has: page.getByText(SESSION_TITLE, { exact: true }) })
    await row.tap()
    await drawer.waitFor({ state: 'hidden' })
    await center.getByText(SESSION_TITLE, { exact: true }).waitFor()
    expect(await center.evaluate(element => element instanceof HTMLElement && element.inert)).toBe(false)
    await open.tap()
    await openSettings(page, 'en')
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.waitFor()
    const settingsBox = await settings.boundingBox()
    expect(settingsBox?.x).toBe(0)
    expect(settingsBox?.width).toBe(390)
    await settings.getByRole('button', { name: 'Models', exact: true }).tap()
    expect(await settings.getByRole('button', { name: 'Models', exact: true }).getAttribute('aria-current')).toBe('true')
    await page.screenshot({ path: join(tmpdir(), 'scipaper-mobile-settings-light.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.locator('body[data-ds-dark-theme]').waitFor()
    await page.screenshot({ path: join(tmpdir(), 'scipaper-mobile-settings-dark.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.locator('body[data-ds-dark-theme]').waitFor({ state: 'detached' })
    await settings.getByRole('button', { name: 'Close', exact: true }).tap()
    await settings.waitFor({ state: 'hidden' })
    await page.locator('[data-mobile-sidebar-mask]').tap({ position: { x: 375, y: 400 } })
    await drawer.waitFor({ state: 'hidden' })
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.locator('[data-mobile="true"]').waitFor({ state: 'detached' })
    expect(await page.locator('[data-mobile-sidebar-mask]').count()).toBe(0)
    await page.getByRole('treeitem').filter({ has: page.getByText(SESSION_TITLE, { exact: true }) }).waitFor()
    expect(consoleState.pageErrors).toEqual([])
  })
})
