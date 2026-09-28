/** Opt-in native SDK checks against the local Windows desktop. */

import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerUseRegistry from '@deepseek-ai/dsh-computer-use'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeProvider from '../src/index.ts'

it.skipIf(process.env.DSH_COMPUTER_USE_NATIVE_E2E !== '1')(
  'loads the installed native SDK, reads permission status without prompting, and shuts down',
  { retry: 0 },
  async ({ signal }) => {
    const ctx = new Context()
    try {
      await ctx.plugin(ComputerUseRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const provider = ctx.plugin(NativeProvider)
      await provider
      expect(ctx.computerUse.providerName).toBe('cua-driver-native')
      const names = ctx.tools.schemas().map(tool => tool.name)
      expect(names).toContain('cua_driver_native__check_permissions')
      expect(names).toContain('cua_driver_native__get_window_state')
      expect(names.every(name => name.startsWith('cua_driver_native__'))).toBe(true)

      const result = await ctx.tools.execute({
        name: 'cua_driver_native__check_permissions',
        callId: ToolCallId('native-live-permissions'),
        arguments: { prompt: false },
        signal,
      })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('Native permission-status call failed')
      if (result.value === null || typeof result.value !== 'object' || Array.isArray(result.value)) {
        throw new Error('Native permission status did not return an MCP result object')
      }
      expect(Array.isArray(result.value.content)).toBe(true)
      expect(result.content.some(block => block.type === 'text')).toBe(true)
      expect(result.content.some(block => block.type === 'image')).toBe(false)

      await provider.dispose()
      expect(ctx.tools.schemas()).toEqual([])
      expect(ctx.computerUse.providerName).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  },
)

it.skipIf(process.platform !== 'win32' || process.env.DSH_COMPUTER_USE_NATIVE_INPUT_E2E !== '1')(
  'captures and clicks a disposable native window through the published tools',
  { retry: 0, timeout: 30_000 },
  async ({ signal }) => {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-cua-window-'))
    const script = join(scratch, 'window.ps1')
    writeFileSync(script, `Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH Cua Test Window'
$form.Width = 420
$form.Height = 220
$status = New-Object System.Windows.Forms.Label
$status.Text = 'Before'
$status.Left = 24
$status.Top = 72
$status.Width = 200
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Advance'
$button.Left = 24
$button.Top = 20
$button.Width = 120
$button.Add_Click({ $button.Text = 'After'; $status.Text = 'After' })
$form.Controls.Add($button)
$form.Controls.Add($status)
[void]$form.ShowDialog()
`)
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script], {
      windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childError = ''
    child.stderr?.on('data', (data: Buffer) => { childError += data.toString('utf8') })
    const ctx = new Context()
    try {
      if (child.pid === undefined) throw new Error('test process did not start')
      await ctx.plugin(ComputerUseRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeProvider)
      const execute = async (name: string, args: object) => {
        const result = await ctx.tools.execute({
          name: `cua_driver_native__${name}`,
          callId: ToolCallId(`native-input-${name}`),
          arguments: args,
          signal,
        })
        expect(result.isError).toBe(false)
        if (result.isError) throw new Error(`${name} failed`)
        return result
      }
      let windowId: number | undefined
      let lastWindows: unknown
      for (let attempt = 0; attempt < 30 && windowId === undefined; attempt++) {
        const windows = await execute('list_windows', { pid: child.pid })
        const content = windows.value as { structuredContent?: { windows?: Array<{ window_id: number; title: string }> } }
        lastWindows = content
        windowId = content.structuredContent?.windows?.find(window => window.title === 'DSH Cua Test Window')?.window_id
        if (windowId === undefined) await new Promise(resolve => setTimeout(resolve, 200))
      }
      if (windowId === undefined) throw new Error(`test window missing: exit=${child.exitCode}, stderr=${childError}, windows=${JSON.stringify(lastWindows).slice(0, 2000)}`)
      if (windowId === undefined || child.pid === undefined) throw new Error('test window was not created')
      const snapshot = await execute('get_window_state', {
        pid: child.pid, window_id: windowId, max_elements: 100,
      })
      const value = snapshot.value as {
        content?: Array<{ type: string }>
        structuredContent?: { elements?: Array<{ label: string; role: string; element_token: string }> }
      }
      expect(value.content?.some(block => block.type === 'image')).toBe(true)
      const button = value.structuredContent?.elements?.find(element => element.role === 'Button' && element.label === 'Advance')
      expect(button).toBeDefined()
      if (button === undefined) throw new Error('test button was not discovered')
      const clicked = await execute('click', { pid: child.pid, window_id: windowId, element_token: button.element_token, delivery_mode: 'background' })
      let afterValue: { structuredContent?: { elements?: Array<{ label: string }> } } | undefined
      for (let attempt = 0; attempt < 10; attempt++) {
        const after = await execute('get_window_state', {
          pid: child.pid, window_id: windowId, include_screenshot: false, max_elements: 100,
        })
        afterValue = after.value as typeof afterValue
        if (afterValue?.structuredContent?.elements?.some(element => element.label === 'After')) break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!afterValue?.structuredContent?.elements?.some(element => element.label === 'After')) {
        throw new Error(`button did not change label: click=${JSON.stringify(clicked.value)}, labels=${JSON.stringify(afterValue?.structuredContent?.elements?.map(element => element.label))}`)
      }
    } finally {
      child.kill()
      await ctx.fiber.dispose()
      unlinkSync(script)
      rmdirSync(scratch)
    }
  },
)
