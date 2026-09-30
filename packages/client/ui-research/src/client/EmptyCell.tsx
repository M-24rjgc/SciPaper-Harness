/** The cell this product puts in place of a shell cell it leaves out. */
import type { ReactNode } from 'react'

/**
 * Registered under a shipped cell's id at a lower priority, it shadows that
 * cell: the renderer draws this one instead, and it draws nothing.
 * @returns nothing.
 */
export function EmptyCell(): ReactNode {
  return null
}
