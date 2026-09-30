// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { SearchBackendBadge, type SearchBackendBadgeProps } from '../src/client/OptionalSearchBackend.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const globalProps = {} as GlobalStandardProps

it('does not repeat credential queries when the slot injects a fresh props object', async () => {
  const readCredential = vi.fn(async () => ({ configured: false, writable: true }))
  const onCredentialChanged = vi.fn(() => () => {})
  const subject = { kind: 'bundle', pkg: { name: '@deepseek-ai/dsh-web-search-exa-bundle', installed: false, enabled: false, rows: [] } } as const
  const stable = {
    ...globalProps,
    subject,
    t: makeTranslate(en),
    readCredential,
    writeCredential: vi.fn(),
    onCredentialChanged,
  } satisfies SearchBackendBadgeProps
  const view = render(<SearchBackendBadge {...stable} />)
  await screen.findByText(en.backendPending)
  expect(readCredential).toHaveBeenCalledTimes(1)
  view.rerender(<SearchBackendBadge {...{ ...stable }} />)
  await waitFor(() => { expect(readCredential).toHaveBeenCalledTimes(1) })
  expect(onCredentialChanged).toHaveBeenCalledTimes(1)
})

it('labels an enabled search backend without a key as pending configuration', async () => {
  const props = {
    ...globalProps,
    subject: { kind: 'bundle', pkg: { name: '@deepseek-ai/dsh-web-search-exa-bundle', installed: false, enabled: true, rows: [] } } as const,
    t: makeTranslate(en),
    readCredential: vi.fn(async () => ({ configured: false, writable: true })),
    writeCredential: vi.fn(),
    onCredentialChanged: vi.fn(() => () => {}),
  } satisfies SearchBackendBadgeProps
  render(<SearchBackendBadge {...props} />)
  expect(await screen.findByText(en.backendEnabledPending)).toBeTruthy()
  expect(screen.queryByText(en.backendReady)).toBeNull()
})
