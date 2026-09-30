/** Header-only V4 to V5 migration; event sequence and inherited cut are unchanged. */

import { defineSessionFormatMigration, isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import type { SessionFormatEvent, SessionFormatEventRun } from '@deepseek-ai/dsh-session-format'
import { assertReleasedV4Header } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { assertReleasedV5Header } from './validation.ts'

/** Upgrade V4 headers to V5 while preserving every event and inherited boundary. */
export const sessionFormatV4ToV5 = defineSessionFormatMigration({
  name: '@deepseek-ai/dsh-session-format-v4-to-v5',
  fromVersion: 4,
  toVersion: 5,
  migrateHeader(header) {
    assertReleasedV4Header(header)
    return { ...header, version: 5, execution: { kind: 'local' } }
  },
  createStage(input) {
    let inherited = input.sourceHeader.isSeeded ? input.sourceInheritedEventCount : 0
    return {
      ...(input.sourceInheritedEventCount === undefined ? {} : { headerInheritedEventCount: input.sourceInheritedEventCount }),
      transformEvent(event: SessionFormatEvent, context) {
        if (event.type === 'session/end-seed' && isSessionFormatJsonObject(event.data)
          && event.data['inherited'] === true) inherited = event.seq
        context.emitEvent(event)
      },
      transformRun(run: SessionFormatEventRun, context) {
        for (const event of run.expand()) this.transformEvent(event, context)
      },
      finish() { return inherited ?? 0 },
    }
  },
  validateTargetHeader: assertReleasedV5Header,
})
