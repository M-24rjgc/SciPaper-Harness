/** Chromium browser tools from the pinned Playwright MCP server. @module */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserMcpConfig, mountSessionMcp, sessionBrowserProfile, validateBrowserMcpConfig } from '@deepseek-ai/dsh-browser-use-runtime/mcp'

/** Cordis identity for the Playwright MCP browser provider. */
export const name = 'browser-use-playwright-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt']

/** Fixed Chromium launch or existing-browser attachment settings. */
export type Config = BrowserMcpConfig

/** Validate the launch or attachment configuration before activation. */
export const Config: typeof BrowserMcpConfig = BrowserMcpConfig

/** Use a separately launched system browser when visible Playwright Chromium was not distributed.
 * @param env - process environment containing Windows browser installation roots.
 * @param exists - filesystem probe for each candidate executable.
 * @returns the first installed Edge or Chrome executable, if any.
 */
export function headedWindowsBrowser(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const candidates = [
    ...[env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]
      .filter((path): path is string => typeof path === 'string' && path.length > 0)
      .map(path => join(path, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...[env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]
      .filter((path): path is string => typeof path === 'string' && path.length > 0)
      .map(path => join(path, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  ]
  return candidates.find(exists)
}

/**
 * Expose Playwright's upstream tools in each live Session's scope.
 * The pinned npm server runs under the current Node executable; profile storage follows the configured launch mode.
 * @param ctx - provider context supplying browser use, Agents, and tools.
 * @param config - validated browser choice and optional tool timeout.
 */
export function apply(ctx: Context, config: Config): void {
  validateBrowserMcpConfig(config)
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js')
  // Upstream environment options can otherwise replace the configured browser
  // mode or import an unrelated profile. Empty values mean absent to its parser.
  const env = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_'))
    .map(key => [key, '']))
  const args = [cli, '--browser', 'chromium']
  if (config.mode === 'attach') {
    args.push('--cdp-endpoint', config.endpoint)
  } else {
    if (!config.persistentProfile) args.push('--isolated')
    if (config.headless) args.push('--headless')
    const executable = config.executablePath ?? (process.platform === 'win32' && !config.headless ? headedWindowsBrowser() : undefined)
    if (executable !== undefined) args.push('--executable-path', executable)
  }
  mountSessionMcp(ctx, {
    name: 'playwright-mcp',
    exclusive: config.mode === 'attach',
    command: process.execPath,
    args,
    ...config.mode === 'launch' && config.persistentProfile
      ? { argsForAgent: agent => ['--user-data-dir', sessionBrowserProfile('playwright-mcp', String(agent.session.id))] }
      : {},
    env,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
  })
}
