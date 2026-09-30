/** Host registration for browser conversation preferences. */
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'

import type { Volatile, Context } from '@deepseek-ai/cordis'
import type { BusyEnterBehavior } from './submission-settings.ts'
import z from '@deepseek-ai/schemastery'
import { BUSY_ENTER_FIELD } from './submission-settings.ts'

import { ConversationSettingsFields } from './submission-settings.ts'

export {
  BUSY_ENTER_BEHAVIORS, BUSY_ENTER_FIELD, CONVERSATION_SETTINGS_NAMESPACE,
  DEFAULT_BUSY_ENTER_BEHAVIOR, type BusyEnterBehavior, type ConversationSettings,
} from './submission-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Enter key behavior while a turn is running. */
  busyEnter: Volatile<BusyEnterBehavior>
  /** Keep the trajectory view available independently of Coding Tools. */
  showTrajectoryWithoutDeveloperTools?: boolean
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  busyEnter: ConversationSettingsFields[BUSY_ENTER_FIELD].volatile(),
  showTrajectoryWithoutDeveloperTools: z.boolean().default(false),
})

/** Host preferences are consumed through the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const showTrajectoryWithoutDeveloperTools = config.showTrajectoryWithoutDeveloperTools === true
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_CONVERSATION__',
      value: { showTrajectoryWithoutDeveloperTools },
    })
  })
}
