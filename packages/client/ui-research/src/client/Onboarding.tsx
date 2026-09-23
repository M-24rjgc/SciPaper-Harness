/** First-run steps this product replaces. */
import { useEffect, type ReactNode } from 'react'
import type { SettingsOnboardingOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'

/**
 * Stands in for the harness's internal-testing notice, which speaks for
 * DeepSeek Harness rather than this product. It shows nothing and hands the
 * first run straight to the next step, adding a model's API key.
 */
export function SkipHarnessNotice(props: SettingsOnboardingOwnerProps): ReactNode {
  const { complete, stepId } = props
  useEffect(() => { complete() }, [complete, stepId])
  return null
}
