/**
 * Host entry: validates the research edition's browser configuration and
 * hands it to every served page; the presentation loads from the client export.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Research edition configuration, read by the browser half from the served page. */
export interface Config {
  /**
   * Shadow the shell cells that are developer surfaces in this product: the
   * turn, step, token-rate and cache-hit pills under the composer, General
   * settings' default permission (the research's autonomy decides it), and the
   * button that opens the raw configuration file. The shipped Web bundle sets it.
   */
  hideDeveloperCells?: boolean
}

/** Validated research edition configuration. */
export const Config: z<Config> = z.object({
  hideDeveloperCells: z.boolean().default(false),
})

/**
 * Put the validated configuration into each page the Web server serves, as the
 * `__DSH_RESEARCH__` global the browser half reads when it applies. Without a
 * Web server nothing is served, and nothing is put anywhere.
 * @param ctx - Host plugin context.
 * @param config - resolved configuration (schema defaults applied).
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  const value = { hideDeveloperCells: config.hideDeveloperCells === true }
  ctx.inject(['webServer'], (web) => {
    web.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_RESEARCH__', value })
    })
  })
}
