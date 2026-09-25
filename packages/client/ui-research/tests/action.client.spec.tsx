// @vitest-environment jsdom

/**
 * One control's own progress and failure. Every research control that asks the
 * host for something holds itself off while its work runs and says why it
 * failed beside itself, whatever the other controls are doing.
 */
import { StrictMode, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ActionError, useAction } from '../src/client/Action.tsx'
import type { Translate } from '../src/client/format.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: Translate = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}
const failed = (reason: string): string => t('actionFailed', { reason })

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (reason: unknown) => void } {
  let resolve: () => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Let started work run and the outcome it settles with reach the screen. */
const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) }) }

/** A control built on its own action, as the save forms are: a status line, and a way to open afresh. */
function SaveForm(props: { work: () => unknown }): ReactNode {
  const action = useAction()
  return <>
    <button type="button" onClick={() => { action.start(props.work) }}>{zh.save}</button>
    <button type="button" onClick={() => { action.clear() }}>{zh.cancel}</button>
    {action.pending && <p role="status">{zh.saving}</p>}
    {action.done && <p role="status">{zh.gallerySaved}</p>}
    <ActionError t={t} error={action.error} />
  </>
}

describe('a control that keeps its own action', () => {
  it('says it is done only once the last attempt succeeded and nothing else is in flight', async () => {
    const first = deferred()
    const second = deferred()
    const attempts = [first, second]
    const view = render(<SaveForm work={() => attempts.shift()?.promise} />)
    const status = (): string | null | undefined => view.queryByRole('status')?.textContent
    expect(status()).toBeUndefined()
    fireEvent.click(view.getByRole('button', { name: zh.save }))
    fireEvent.click(view.getByRole('button', { name: zh.save }))
    expect(status()).toBe(zh.saving)
    await act(async () => { first.resolve(); await first.promise })
    await settle()
    expect(status()).toBe(zh.saving)
    await act(async () => { second.resolve(); await second.promise })
    await settle()
    expect(status()).toBe(zh.gallerySaved)
    expect(view.queryByRole('alert')).toBeNull()
    // Opening the form afresh forgets the success.
    fireEvent.click(view.getByRole('button', { name: zh.cancel }))
    expect(status()).toBeUndefined()
  })

  it('forgets a failure when the form is opened afresh', async () => {
    const view = render(<SaveForm work={() => { throw new Error('no space left') }} />)
    fireEvent.click(view.getByRole('button', { name: zh.save }))
    await settle()
    expect(view.getByRole('alert').textContent).toBe(failed('no space left'))
    expect(view.queryByRole('status')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: zh.cancel }))
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('says why its work failed in the failure\'s own words, and clears the reason on the next attempt', async () => {
    const first = deferred()
    const attempts = [first, deferred()]
    const view = render(<SaveForm work={() => attempts.shift()?.promise} />)
    fireEvent.click(view.getByRole('button', { name: zh.save }))
    // A failure that is not an Error still reads as its own words.
    await act(async () => { first.reject('the host went offline'); await first.promise.catch(() => {}) })
    await settle()
    expect(view.getByRole('alert').textContent).toBe(failed('the host went offline'))
    fireEvent.click(view.getByRole('button', { name: zh.save }))
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('still reports its outcome after the development mount, unmount and mount again', async () => {
    const view = render(<StrictMode><SaveForm work={() => Promise.reject(new Error('read-only file'))} /></StrictMode>)
    fireEvent.click(view.getByRole('button', { name: zh.save }))
    await settle()
    expect(view.getByRole('alert').textContent).toBe(failed('read-only file'))
  })

  it('drops quietly the outcome of work that settles after the control closed', async () => {
    const saving = deferred()
    const errors = vi.spyOn(console, 'error')
    const view = render(<SaveForm work={() => saving.promise} />)
    fireEvent.click(view.getByRole('button', { name: zh.save }))
    await settle()
    view.unmount()
    await act(async () => { saving.reject(new Error('too late')); await saving.promise.catch(() => {}) })
    await settle()
    expect(errors).not.toHaveBeenCalled()
    expect(document.body.textContent).toBe('')
  })
})
