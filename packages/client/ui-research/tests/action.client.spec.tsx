// @vitest-environment jsdom

/**
 * One control's own progress and failure. Every research control that asks the
 * host for something holds itself off while its work runs and says why it
 * failed beside itself, whatever the other controls are doing.
 */
import { StrictMode, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { ActionButton, ActionError, useAction } from '../src/client/Action.tsx'
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

describe('a button that runs one action', () => {
  it('holds itself off and says what it is doing while its work runs, then comes back', async () => {
    const saving = deferred()
    const work = vi.fn(() => saving.promise)
    const view = render(<ActionButton t={t} label={zh.save} pendingLabel={zh.saving} work={work} />)
    fireEvent.click(view.getByRole('button', { name: zh.save }))
    const button = view.getByRole('button')
    expect(button.textContent).toBe(zh.saving)
    expect(button).toHaveProperty('disabled', true)
    await settle()
    expect(work).toHaveBeenCalledTimes(1)
    await act(async () => { saving.resolve(); await saving.promise })
    await settle()
    expect(button.textContent).toBe(zh.save)
    expect(button).toHaveProperty('disabled', false)
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('keeps its label while it works when it has no word for working', async () => {
    const refreshing = deferred()
    const view = render(<ActionButton t={t} label={zh.refresh} work={() => refreshing.promise} />)
    fireEvent.click(view.getByRole('button', { name: zh.refresh }))
    expect(view.getByRole('button', { name: zh.refresh })).toHaveProperty('disabled', true)
    await act(async () => { refreshing.resolve(); await refreshing.promise })
    await settle()
    expect(view.getByRole('button', { name: zh.refresh })).toHaveProperty('disabled', false)
  })

  it('says why its work failed beneath it, and clears the reason on the next press', async () => {
    const first = deferred()
    const second = deferred()
    const attempts = [first, second]
    const view = render(<ActionButton t={t} label={zh.exportPaper} work={() => attempts.shift()?.promise} />)
    const press = (): void => { fireEvent.click(view.getByRole('button', { name: zh.exportPaper })) }
    press()
    await act(async () => { first.reject(new Error('disk full')); await first.promise.catch(() => {}) })
    await settle()
    expect(view.getByRole('alert').textContent).toBe(failed('disk full'))
    expect(view.getByRole('button', { name: zh.exportPaper })).toHaveProperty('disabled', false)
    press()
    expect(view.queryByRole('alert')).toBeNull()
    // A failure that is not an Error still reads as its own words.
    await act(async () => { second.reject('the host went offline'); await second.promise.catch(() => {}) })
    await settle()
    expect(view.getByRole('alert').textContent).toBe(failed('the host went offline'))
  })

  it('stays held off while the caller holds it off, whatever its own state', async () => {
    const work = vi.fn()
    const view = render(<ActionButton t={t} label={zh.save} pendingLabel={zh.saving} disabled work={work} />)
    const button = view.getByRole('button', { name: zh.save })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    await settle()
    expect(work).not.toHaveBeenCalled()
    view.rerender(<ActionButton t={t} label={zh.save} pendingLabel={zh.saving} disabled={false} work={work} />)
    fireEvent.click(button)
    await settle()
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('still reports its outcome after the development mount, unmount and mount again', async () => {
    const view = render(<StrictMode><ActionButton t={t} label={zh.save} work={() => Promise.reject(new Error('read-only file'))} /></StrictMode>)
    fireEvent.click(view.getByRole('button', { name: zh.save }))
    await settle()
    expect(view.getByRole('alert').textContent).toBe(failed('read-only file'))
  })
})

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
