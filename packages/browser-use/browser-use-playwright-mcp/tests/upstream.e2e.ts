import { it } from 'vitest'
import { verifyMcpBrowser } from '../../browser-use-runtime/tests/mcp-upstream.ts'
import * as Provider from '../src/index.ts'

it.skipIf(process.env.DSH_BROWSER_EXECUTABLE === undefined).each(['launch', 'attach'] as const)(
  'uses the pinned Playwright MCP server to %s Chromium and visit a loopback page',
  async mode => verifyMcpBrowser(Provider, 'playwright-mcp', { name: 'browser_navigate', arguments: url => ({ url }) }, mode),
)

it.skipIf(process.env.DSH_BROWSER_EXECUTABLE === undefined)(
  'reopens a visible Session browser with its dedicated signed-in profile',
  async () => verifyMcpBrowser(Provider, 'playwright-mcp', { name: 'browser_navigate', arguments: url => ({ url }) },
    'launch', { headed: true, persistentProfile: true }),
)
