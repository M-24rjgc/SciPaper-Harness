/**
 * The numbers a run reported, laid out the same wherever they appear. A run
 * publishes its measurements only once the child exits, so an empty record is
 * the ordinary state of anything still going and draws nothing at all.
 */
import type { ReactNode } from 'react'
import styles from './MetricsGrid.module.css'

/** Where the grid is drawn and what it is drawing. */
export interface MetricsGridProps {
  /** Metric name to value, exactly as the run's own metrics file reported it. */
  metrics: Record<string, number>
  /** Host class carrying the surrounding surface's own treatment. */
  className?: string | undefined
}

/**
 * Render one run's measurements.
 * @param props - the metric record and the host's layout class.
 * @returns the grid, or nothing when the run has reported no measurements.
 */
export function MetricsGrid(props: MetricsGridProps): ReactNode {
  const entries = Object.entries(props.metrics)
  if (entries.length === 0) return null
  return <div className={[styles.grid, props.className].filter(Boolean).join(' ')}>
    {entries.map(([name, value]) => <span key={name} className={styles.metric}>
      <span className={styles.name}>{name}</span>
      <span className={styles.value}>{value}</span>
    </span>)}
  </div>
}
