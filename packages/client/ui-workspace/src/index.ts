/**
 * Workspace picker plugin, node half. The browser half ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration. A client row's `config` reaches only this half, so it validates
 * the row and hands a non-default entry rule to every served page.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Workspace UI configuration, read by the browser half from the served page. */
export interface Config {
  /**
   * What selects a Session when nothing is selected, and what the unscoped
   * New Session action opens. `recent` (the default) connects the most
   * recently active Workspace at startup and starts New Session in the
   * current, then the most recent Workspace. `policy` asks the entry policy a
   * plugin registers through `uiWorkspace.setEntryPolicy`: its `land()` at
   * startup and whenever the selection is lost, its `startNew()` for the
   * unscoped action. A startup in which no policy registers within 5 s of the
   * Session and Workspace lists being ready uses `recent`.
   */
  entry?: 'recent' | 'policy'
}

/** Validated Workspace UI configuration. */
export const Config: z<Config> = z.object({
  entry: z.union(['recent', 'policy'] as const).default('recent'),
})

/**
 * Put `entry: policy` into each page the Web server serves, as the
 * `__DSH_WORKSPACE__` global the browser half reads when it applies. The
 * browser half reads an absent global as `recent`, so a row left at the
 * default serves every page unchanged.
 * @param ctx - Host plugin context.
 * @param config - resolved configuration (schema defaults applied).
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  if (config.entry !== 'policy') return
  ctx.inject(['webServer'], (web) => {
    web.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_WORKSPACE__', value: { entry: 'policy' } })
    })
  })
}
