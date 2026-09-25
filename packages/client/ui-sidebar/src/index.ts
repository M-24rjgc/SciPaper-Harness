/**
 * Host loader entry for the sidebar plugin. A client row's `config` reaches
 * only this half, so it validates the row and hands a non-default brand
 * action to every served page.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Sidebar configuration, read by the browser half from the served page. */
export interface Config {
  /**
   * What the expanded brand row does. `new-session` (the default) makes it a
   * second New Session button beside the labelled one; `none` renders it as
   * plain identity, not a button.
   */
  brandAction?: 'new-session' | 'none'
}

/** Validated sidebar configuration. */
export const Config: z<Config> = z.object({
  brandAction: z.union(['new-session', 'none'] as const).default('new-session'),
})

/**
 * Put `brandAction: none` into each page the Web server serves, as the
 * `__DSH_SIDEBAR__` global the browser half reads when it applies. The browser
 * half reads an absent global as `new-session`, so a row left at the default
 * serves every page unchanged.
 * @param ctx - Host plugin context.
 * @param config - resolved configuration (schema defaults applied).
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  if (config.brandAction !== 'none') return
  ctx.inject(['webServer'], (web) => {
    web.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_SIDEBAR__', value: { brandAction: 'none' } })
    })
  })
}
