/**
 * The figure gallery: published papers' Figure 1s to study before drawing. A
 * search reads only the index the host ships; saving a figure copies it under
 * figures/refs/ with a record of its paper, where the assistant draws from it.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { GalleryFigure, GalleryPage, ResearchProject } from '@deepseek-ai/dsh-research-workbench/types'
import type { GallerySearchRequest, WorkbenchProps } from './contract.ts'
import { galleryImageUrl, type Translate } from './format.ts'
import type { ResearchKey } from './locales.ts'
import styles from './Gallery.module.css'

/** Figures fetched per page. */
const PAGE_SIZE = 24
/** Authors named before the rest become a count. */
const SHOWN_AUTHORS = 4
const TIERS = ['award', 'oral', 'spotlight'] as const
type Tier = typeof TIERS[number]
/** Venue names as the venues write them; an unknown venue is shown in capitals. */
const VENUES: Record<string, string> = { iclr: 'ICLR', icml: 'ICML', neurips: 'NeurIPS', cvpr: 'CVPR', acl: 'ACL', aaai: 'AAAI' }
const PATTERN_KEYS: Record<string, ResearchKey> = {
  architecture: 'galleryPattern_architecture', pipeline: 'galleryPattern_pipeline', framework: 'galleryPattern_framework',
  conceptual: 'galleryPattern_conceptual', taxonomy: 'galleryPattern_taxonomy', teaser: 'galleryPattern_teaser',
  comparison: 'galleryPattern_comparison', results: 'galleryPattern_results',
}
const TIER_KEYS: Record<Tier, ResearchKey> = { award: 'galleryTier_award', oral: 'galleryTier_oral', spotlight: 'galleryTier_spotlight' }
const BASIS_KEYS: Record<GalleryPage['basis'], ResearchKey> = {
  browse: 'galleryBasis_browse', keyword: 'galleryBasis_keyword', semantic: 'galleryBasis_semantic',
}

interface Filters { query: string; pattern: string; venue: string; year: string; tier: string }
const NO_FILTERS: Filters = { query: '', pattern: '', venue: '', year: '', tier: '' }

function searchRequest(projectId: ResearchProject['id'], filters: Filters, offset: number): GallerySearchRequest {
  const query = filters.query.trim()
  return {
    action: 'find-reference-figures', projectId, limit: PAGE_SIZE, offset,
    ...query ? { query } : {},
    ...filters.pattern ? { pattern: filters.pattern } : {},
    ...filters.venue ? { venue: filters.venue } : {},
    ...filters.year ? { year: Number(filters.year) } : {},
    ...filters.tier ? { tier: filters.tier as Tier } : {},
  }
}

const venueName = (venue: string): string => VENUES[venue] ?? venue.toUpperCase()
const patternName = (pattern: string, t: Translate): string => {
  const key = PATTERN_KEYS[pattern]
  return key ? t(key) : pattern
}
/** The mark a figure is filed under: an award outranks the Oral or Spotlight mark the paper may also carry. */
const tierOf = (figure: GalleryFigure): Tier | undefined => figure.award ? 'award' : figure.tier

/** The panel: filters, the grid of figures, and the one open for a closer look. */
export function Gallery(props: WorkbenchProps & { project: ResearchProject }): ReactNode {
  const { project, t } = props
  const [draft, setDraft] = useState(NO_FILTERS)
  const [active, setActive] = useState(NO_FILTERS)
  const [page, setPage] = useState<GalleryPage | null>(null)
  const [figures, setFigures] = useState<GalleryFigure[]>([])
  const [error, setError] = useState('')
  const [open, setOpen] = useState<GalleryFigure | null>(null)
  const [saving, setSaving] = useState('')
  // Only the latest search may fill the grid: an earlier one that answers late is dropped.
  const latest = useRef(0)
  const load = (filters: Filters, offset: number): void => {
    const ticket = ++latest.current
    setActive(filters)
    props.searchFigures(searchRequest(project.id, filters, offset)).then((result) => {
      if (ticket !== latest.current) return
      setPage(result)
      setError('')
      setFigures(previous => offset === 0 ? result.figures : [...previous, ...result.figures])
    }, (reason: unknown) => {
      if (ticket === latest.current) setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  useEffect(() => { load(NO_FILTERS, 0) }, [project.id])
  const choose = (change: Partial<Filters>): void => {
    const next = { ...draft, ...change }
    setDraft(next)
    load(next, 0)
  }
  const submit = (event: FormEvent<HTMLFormElement>): void => { event.preventDefault(); load(draft, 0) }
  const save = (figure: GalleryFigure, label: string): void => {
    setSaving(figure.id)
    void props.run({ action: 'fetch-reference-figures', projectId: project.id, galleryIds: [figure.id], label }).catch(() => {})
  }
  const facet = (name: keyof GalleryPage['facets']): [string, number][] => Object.entries(page?.facets[name] ?? {})
  return <section className={styles.root}>
    <p className={styles.intro}>{t('galleryIntro')}</p>
    <form className={styles.filters} role="search" onSubmit={submit}>
      <input
        type="search" className={styles.query} aria-label={t('galleryQuery')} placeholder={t('galleryQuery')} value={draft.query}
        onChange={(event) => { setDraft({ ...draft, query: event.target.value }) }}
      />
      <button type="submit">{t('gallerySearch')}</button>
      <select aria-label={t('galleryPatternLabel')} value={draft.pattern} onChange={(event) => { choose({ pattern: event.target.value }) }}>
        <option value="">{t('galleryPatternLabel')} · {t('galleryAll')}</option>
        {facet('pattern').sort((a, b) => b[1] - a[1]).map(([pattern, n]) => <option key={pattern} value={pattern}>{patternName(pattern, t)} ({n})</option>)}
      </select>
      <select aria-label={t('galleryVenueLabel')} value={draft.venue} onChange={(event) => { choose({ venue: event.target.value }) }}>
        <option value="">{t('galleryVenueLabel')} · {t('galleryAll')}</option>
        {facet('venue').sort((a, b) => venueName(a[0]).localeCompare(venueName(b[0]))).map(([venue, n]) => <option key={venue} value={venue}>{venueName(venue)} ({n})</option>)}
      </select>
      <select aria-label={t('galleryYearLabel')} value={draft.year} onChange={(event) => { choose({ year: event.target.value }) }}>
        <option value="">{t('galleryYearLabel')} · {t('galleryAll')}</option>
        {facet('year').sort((a, b) => b[0].localeCompare(a[0])).map(([year, n]) => <option key={year} value={year}>{year} ({n})</option>)}
      </select>
      <select aria-label={t('galleryTierLabel')} value={draft.tier} onChange={(event) => { choose({ tier: event.target.value }) }}>
        <option value="">{t('galleryTierLabel')} · {t('galleryAll')}</option>
        {TIERS.map(tier => <option key={tier} value={tier}>{t(TIER_KEYS[tier])} ({page?.facets.tier[tier] ?? 0})</option>)}
      </select>
    </form>
    {error && <div className={styles.error} role="alert">{error}</div>}
    {page && <p className={styles.status}>{t('galleryCount', { n: page.total })} · {t(BASIS_KEYS[page.basis])}</p>}
    {open && <Detail
      key={open.id} t={t} figure={open} saving={saving === open.id}
      onSave={(label) => { save(open, label) }} onClose={() => { setOpen(null) }}
    />}
    {page?.total === 0 && <p className={styles.empty}>{t('galleryEmpty')}</p>}
    <ul className={styles.grid}>{figures.map((figure) => {
      const tier = tierOf(figure)
      return <li key={figure.id}>
        <button type="button" className={styles.card} aria-pressed={open?.id === figure.id} onClick={() => { setOpen(figure); setSaving('') }}>
          <span className={styles.frame}><img src={galleryImageUrl(figure.id)} alt={figure.title} loading="lazy" /></span>
          <span className={styles.title}>{figure.title}</span>
          <span className={styles.meta}>
            {venueName(figure.venue)} {figure.year}
            {tier && <span className={styles.tier}>{t(TIER_KEYS[tier])}</span>}
          </span>
        </button>
      </li>
    })}</ul>
    {page && figures.length < page.total && <button type="button" className={styles.more} onClick={() => { load(active, figures.length) }}>{t('galleryMore')}</button>}
    {page && <p className={styles.status}><a href={page.source.repository} target="_blank" rel="noreferrer">{t('gallerySource', { name: page.source.name })}</a></p>}
  </section>
}

interface DetailProps {
  t: Translate
  figure: GalleryFigure
  /** Whether a save of this figure has been started. */
  saving: boolean
  onSave: (label: string) => void
  onClose: () => void
}

/** One figure, larger, with its paper and the way to keep it as a reference. */
function Detail(props: DetailProps): ReactNode {
  const { figure, t } = props
  const [label, setLabel] = useState('method-overview')
  const named = figure.authors.slice(0, SHOWN_AUTHORS).join(', ')
  const authors = figure.authors.length > SHOWN_AUTHORS ? t('galleryAuthorsMore', { names: named, n: figure.authors.length - SHOWN_AUTHORS }) : named
  const tier = tierOf(figure)
  return <article className={styles.detail} aria-label={figure.title}>
    <img className={styles.large} src={galleryImageUrl(figure.id)} alt={figure.title} />
    <div className={styles.info}>
      <h3>{figure.title}</h3>
      <p>{authors}</p>
      <p className={styles.meta}>{venueName(figure.venue)} {figure.year} · {patternName(figure.pattern, t)}{tier && ` · ${t(TIER_KEYS[tier])}`}</p>
      <a href={figure.paper} target="_blank" rel="noreferrer">{t('galleryOpenPaper')}</a>
      <form className={styles.save} onSubmit={(event) => { event.preventDefault(); props.onSave(label) }}>
        <label>{t('galleryLabel')}<input value={label} required pattern="[a-z0-9]+(-[a-z0-9]+)*" onChange={(event) => { setLabel(event.target.value) }} /></label>
        <button type="submit">{t('gallerySave')}</button>
      </form>
      {props.saving && <p role="status">{t('gallerySaving')}</p>}
      <p className={styles.note}>{t('galleryCopyright')}</p>
      <button type="button" onClick={props.onClose}>{t('close')}</button>
    </div>
  </article>
}
