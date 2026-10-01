/** Copy a Session's full log ID to the clipboard and announce the outcome with a banner. */

import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { IconWarningOutlineRegular, Toast, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'

/** Full-opacity hold of the copy banner; one short line needs no longer. */
const COPY_BANNER_HOLD_MS = 1200

/** The copy action of one control and the banner it owns. */
export interface LogIdCopy {
  /** True while the success banner is on screen; render the success glyph off it. */
  copied: boolean
  /** Write the full log ID to the clipboard, then announce success or refusal. */
  copy: () => void
  /** The banner element to render beside the control, or null when none is showing. */
  banner: ReactNode
}

/**
 * Own the clipboard write and its banner for one control.
 * @param logId - the full Session id that is copied; the short form is display only.
 * @param t - Session-log translator for the banner copy.
 * @returns the copy handler, its success flag and the banner element.
 */
export function useLogIdCopy(logId: string, t: TranslateNS<typeof NS>): LogIdCopy {
  // The seq keys the banner so a repeated copy replays it instead of staying in place.
  const [outcome, setOutcome] = useState<{ seq: number; ok: boolean } | null>(null)
  const copy = useCallback(() => {
    void writeClipboard(logId).then((ok) => {
      setOutcome(previous => ({ seq: (previous?.seq ?? 0) + 1, ok }))
    })
  }, [logId])
  return {
    copied: outcome?.ok === true,
    copy,
    banner: outcome === null
      ? null
      : (
        <Toast
          key={outcome.seq}
          text={outcome.ok ? t('log.copied') : t('log.copyFailed')}
          {...outcome.ok ? { tone: 'success' as const } : { icon: <IconWarningOutlineRegular /> }}
          holdMs={COPY_BANNER_HOLD_MS}
          onDone={() => { setOutcome(null) }}
        />
      ),
  }
}
