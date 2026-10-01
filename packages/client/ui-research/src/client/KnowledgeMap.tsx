/**
 * 领域地图 (Domain map): the map of the research field with the research's idea and library on it. The map plugin
 * serves the map; until it has map data to draw, this view says that the map is not built.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MapViewPage, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { WorkbenchProps } from './contract.ts'
import { ActionError } from './Action.tsx'
import styles from './KnowledgeMap.module.css'

/**
 * The view of one research's domain map. It asks the map plugin when it opens, so a plugin that was switched off since
 * the view was offered says so.
 * @param props - the research face and the research whose map to show; the owner keys it by research.
 * @returns the line that the map is not built, a failure, or a loading line while the plugin answers.
 */
export function MapView(props: WorkbenchProps & { project: ResearchProject }): ReactNode {
  const { project, t } = props
  const [page, setPage] = useState<MapViewPage | null>(null)
  const [error, setError] = useState('')
  const latest = useRef(0)
  useEffect(() => {
    const ticket = ++latest.current
    props.run({ action: 'map-view', projectId: project.id }).then((result) => {
      if (ticket !== latest.current) return
      if (!result.mapView) throw new Error(t('kgNoResponse'))
      setPage(result.mapView)
      setError('')
    }).catch((reason: unknown) => {
      if (ticket === latest.current) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { latest.current++ }
  }, [project.id])
  return <section className={styles.view} data-map-view aria-busy={page === null && error === ''}>
    <ActionError t={t} error={error} />
    {page === null && error === '' && <p role="status" className={styles.body}>{t('kgLoading')}</p>}
    {page !== null && <>
      <h3 className={styles.title}>{t('kmNotBuiltTitle')}</h3>
      <p className={styles.body}>{t('kmNotBuiltBody')}</p>
    </>}
  </section>
}
