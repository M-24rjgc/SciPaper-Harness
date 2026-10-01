// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrajectoryToolbar } from '../src/client/TrajectoryToolbar.tsx'
import { t } from './locale.client.ts'

afterEach(cleanup)

function renderToolbar(overrides: Partial<Parameters<typeof TrajectoryToolbar>[0]> = {}) {
  const handlers = {
    onActualDurationChange: vi.fn(),
    onActualTimeChange: vi.fn(),
    onToggleAllTurns: vi.fn(),
    onToggleAllAssistants: vi.fn(),
    onSearchQueryChange: vi.fn(),
  }
  const view = render(
    <TrajectoryToolbar
      actualDuration={false}
      actualTime={false}
      allTurnsCollapsed={false}
      allAssistantsCollapsed={false}
      searchQuery=""
      t={t}
      {...handlers}
      {...overrides}
    />,
  )
  return { ...handlers, view }
}

describe('TrajectoryToolbar', () => {
  it('switches the duration scale and reflects the selected one in its label', () => {
    const { onActualDurationChange, view } = renderToolbar()
    const toggle = view.getByRole('button', { name: 'Use actual duration' })
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    expect(toggle.getAttribute('title')).toBe('Use actual duration')
    fireEvent.click(toggle)
    expect(onActualDurationChange).toHaveBeenCalledWith(true)

    cleanup()
    const pressed = renderToolbar({ actualDuration: true })
    expect(pressed.view.getByRole('button', { name: 'Use actual duration' }).getAttribute('title'))
      .toBe('Use equal-width operations')
    fireEvent.click(pressed.view.getByRole('button', { name: 'Use actual duration' }))
    expect(pressed.onActualDurationChange).toHaveBeenCalledWith(false)
  })

  it('keeps the actual-time switch out of sight but wired', () => {
    const { onActualTimeChange, view } = renderToolbar({ actualTime: true })
    const control = view.getByRole('switch', { hidden: true })
    expect(control.hasAttribute('hidden')).toBe(true)
    expect(control.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(control)
    expect(onActualTimeChange).toHaveBeenCalledWith(false)
  })

  it('folds and unfolds turns and calls', () => {
    const { onToggleAllTurns, onToggleAllAssistants, view } = renderToolbar()
    fireEvent.click(view.getByRole('button', { name: 'Collapse turns' }))
    fireEvent.click(view.getByRole('button', { name: 'Collapse calls' }))
    expect(onToggleAllTurns).toHaveBeenCalledOnce()
    expect(onToggleAllAssistants).toHaveBeenCalledOnce()

    cleanup()
    const folded = renderToolbar({ allTurnsCollapsed: true, allAssistantsCollapsed: true })
    expect(folded.view.getByRole('button', { name: 'Expand turns' }).getAttribute('aria-pressed')).toBe('true')
    expect(folded.view.getByRole('button', { name: 'Expand calls' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('reports each edit of the ledger search', () => {
    const { onSearchQueryChange, view } = renderToolbar({ searchQuery: 'beam' })
    const search = view.getByRole('searchbox', { name: 'Search trajectory' }) as HTMLInputElement
    expect(search.value).toBe('beam')
    fireEvent.change(search, { target: { value: 'beam search' } })
    expect(onSearchQueryChange).toHaveBeenCalledWith('beam search')
  })

  it('places what the trailing seat holds before the search box, in the same toolbar', () => {
    const { view } = renderToolbar({ children: <span>Log ID 8f261bbc</span> })
    const toolbar = view.getByRole('toolbar', { name: 'Trajectory toolbar' })
    const occupant = within(toolbar).getByText('Log ID 8f261bbc')
    const search = within(toolbar).getByRole('searchbox')
    expect(occupant.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByRole('searchbox')).toHaveLength(1)
  })
})
