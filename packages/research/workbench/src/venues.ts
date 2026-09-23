/**
 * The venue template library, shared by every mode: 139 CCF venues over 16
 * official style kits (runtime/venues, built by scripts/build_venues.py from
 * CCFA-Skills). Applying a venue copies its kit and example into
 * `template/<venue>/` for a hand-written paper, and writes a spark-to-paper
 * `template.json`, `main.tex.tmpl` and the style files into the project root,
 * so an assembled paper builds against the venue too.
 */
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { atomicWrite, projectPath } from './files.ts'

const stages = ['review', 'final'] as const
export type VenueStage = typeof stages[number]
const staged = z.object({ review: z.string(), final: z.string() })

const kitSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  from: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
  rename: z.record(z.string(), z.string()),
  extra: z.record(z.string(), z.record(z.string(), z.string())),
  documentclass: z.string().min(1),
  isClass: z.boolean(),
  stylePackage: z.string().nullable(),
  citationStyle: z.enum(['numeric', 'author_year']),
  bibstyle: z.string().min(1),
  options: staged,
  stage: staged,
  author: z.string(),
  anonymousAuthor: z.string().nullable(),
  missing: z.array(z.string()),
  notes: z.array(z.string()),
})
export type VenueKit = z.infer<typeof kitSchema>

const venueSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  family: z.string().nullable(),
  tier: z.string().nullable(),
  kit: z.string().min(1),
  anonymous: z.boolean(),
  url: z.string().nullable(),
  guide: z.string().nullable(),
  example: z.string().nullable(),
  verified: z.string().nullable(),
  notes: z.array(z.string()),
  classOptions: staged.optional(),
})
export type Venue = z.infer<typeof venueSchema>
const librarySchema = z.object({ version: z.literal(1), source: z.string(), venues: z.array(venueSchema) })

/** The loaded library: venues by id and the kits they use. */
export interface VenueLibrary {
  root: string
  venues: Venue[]
  kits: Map<string, VenueKit>
}

/**
 * Read the library and check that every venue names a kit it has.
 * @param root - the library directory (runtime/venues).
 * @returns the library.
 */
export async function loadVenues(root: string): Promise<VenueLibrary> {
  const { venues } = librarySchema.parse(JSON.parse(await readFile(join(root, 'venues.json'), 'utf8')))
  const kits = new Map<string, VenueKit>()
  for (const entry of await readdir(join(root, 'kits'))) {
    const kit = kitSchema.parse(JSON.parse(await readFile(join(root, 'kits', entry, 'kit.json'), 'utf8')))
    kits.set(kit.id, kit)
  }
  for (const venue of venues) {
    if (!kits.has(venue.kit)) throw new Error(`Venue ${venue.id} names an unknown kit ${venue.kit}`)
  }
  return { root, venues, kits }
}

/** The style files a kit puts beside a paper, under their installed names. */
export function kitFiles(kit: VenueKit): string[] {
  return [...kit.files.map(name => kit.rename[name] ?? name), ...Object.values(kit.extra).flatMap(files => Object.values(files))]
}

/**
 * The venues matching a query, compactly.
 * @param library - the library.
 * @param query - words matched against id, name, family and tier; every venue when empty.
 * @returns one line of facts per venue.
 */
export function listVenues(library: VenueLibrary, query?: string): Record<string, unknown>[] {
  const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return library.venues
    .filter(venue => words.every(word => [venue.id, venue.name, venue.family ?? '', venue.tier ?? ''].some(field => field.toLowerCase().includes(word))))
    .map(venue => ({
      id: venue.id, name: venue.name, tier: venue.tier, family: venue.family, kit: (library.kits.get(venue.kit) as VenueKit).name,
      anonymous: venue.anonymous, guide: venue.guide !== null, ...venue.notes.length ? { notes: venue.notes } : {},
    }))
}

/** The spark-to-paper template spec for a venue: the kit's engine and citation style over conference-sized sections. */
function templateSpec(venue: Venue, kit: VenueKit, stage: VenueStage, resultsMode: string): Record<string, unknown> {
  const numeric = kit.citationStyle === 'numeric'
  return {
    name: venue.id,
    display_name: venue.name,
    official: true,
    source: `${kit.name} style files from the venue's official kit, via CCFA-Skills; check them against this year's call for papers`,
    engine: {
      documentclass: kit.documentclass, style_package: kit.stylePackage, is_class: kit.isClass, assets: kitFiles(kit), main_template: 'main.tex.tmpl',
    },
    sections: [
      { id: 'introduction', title: 'Introduction', words: [600, 1000], recipe: { paragraphs: 4, contrib_items: 3, min_cites: 6 } },
      { id: 'related_work', title: 'Related Work', words: [400, 800], recipe: { theme_subsections: 2, closing_paragraph: true, cites_per_theme: [4, 8] } },
      { id: 'method', title: 'Method', words: [1000, 1800], recipe: { require_notation_table: false, min_pseudocode: 0, design_rationale: true } },
      { id: 'experiments', title: 'Experiments', words: [900, 1600], recipe: { subsections: 3, result_tables: ['main_results', 'ablation_results'], display_math: false } },
      { id: 'conclusion', title: 'Conclusion', words: [120, 250], recipe: { paragraphs: 1, lists: false } },
    ],
    writing_order: ['method', 'related_work', 'introduction', 'experiments', 'conclusion', 'abstract'],
    abstract: { words: [150, 250], paragraphs: 1, cites: false, math: false, single_paragraph: true },
    contributions: { count: 3 },
    title: { max_words: 15, max_chars: 150 },
    keywords: { min: 3, max: 6, cap: 6, lowercase: false },
    citations: {
      style: kit.citationStyle, bibstyle: kit.bibstyle, floor: 30,
      types: ['CORE', 'CONTEXT', 'BASELINE', 'METRIC', 'DEFINITION'],
      per_section_coverage: { related_work: [12, 25], introduction: [6, 12] },
      in_abstract: false, in_headings: false, merge_adjacent: numeric,
    },
    tables: { caption_position: 'above', min: 2 },
    experiment_complexity: 'moderate',
    figures: { caption_position: 'below', min: 3, distribute_across: ['method', 'experiments'] },
    headings: { case: 'title', numbered: true },
    results_mode: resultsMode,
    venue: { id: venue.id, tier: venue.tier, url: venue.url, anonymous: venue.anonymous, stage, guide: venue.guide ? `template/${venue.id}/GUIDE.md` : null },
  }
}

/** What applying a venue wrote. */
export interface AppliedVenue {
  venue: Venue
  kit: VenueKit
  stage: VenueStage
  /** Project-relative paths written. */
  written: string[]
}

/**
 * Apply a venue's template to a project.
 * @param library - the library.
 * @param root - the project root.
 * @param id - the venue id.
 * @param stage - `review` (anonymous where the venue is) or `final` (camera-ready).
 * @returns the venue, its kit and the files written.
 */
export async function applyVenue(library: VenueLibrary, root: string, id: string, stage: VenueStage = 'review'): Promise<AppliedVenue> {
  const venue = library.venues.find(item => item.id === id)
  if (!venue) throw new Error(`Unknown venue ${id}; list-venues shows the venues and their ids`)
  const kit = library.kits.get(venue.kit) as VenueKit
  const kitDir = join(library.root, 'kits', kit.id)
  const written: string[] = []
  const put = async (path: string, source: string | { copy: string }): Promise<void> => {
    const target = await projectPath(root, path)
    await mkdir(dirname(target), { recursive: true })
    if (typeof source === 'string') await atomicWrite(target, source)
    else await copyFile(source.copy, target)
    written.push(path)
  }
  for (const name of kitFiles(kit)) {
    await put(name, { copy: join(kitDir, name) })
    await put(`template/${venue.id}/${name}`, { copy: join(kitDir, name) })
  }
  const anonymousAuthor = stage === 'review' && venue.anonymous ? kit.anonymousAuthor : null
  const tmpl = (await readFile(join(kitDir, 'main.tex.tmpl'), 'utf8'))
    .replace('<<classoptions>>', (venue.classOptions ?? kit.options)[stage])
    .replace('<<stage>>', kit.stage[stage])
    .replace('<<author>>', anonymousAuthor ?? kit.author)
  await put('main.tex.tmpl', tmpl)
  // A results mode already set (the data route, or after experiments) survives a change of venue.
  const previous = z.object({ results_mode: z.string() })
    .safeParse(await readFile(await projectPath(root, 'template.json'), 'utf8').then(text => JSON.parse(text) as unknown).catch(() => undefined))
  const resultsMode = previous.success ? previous.data.results_mode : 'proposal'
  await put('template.json', `${JSON.stringify(templateSpec(venue, kit, stage, resultsMode), null, 2)}\n`)
  if (venue.guide) await put(`template/${venue.id}/GUIDE.md`, { copy: join(library.root, 'guides', venue.guide) })
  if (venue.example) {
    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(directory, entry.name), `${prefix}${entry.name}/`)
        else await put(`template/${venue.id}/${prefix}${entry.name}`, { copy: join(directory, entry.name) })
      }
    }
    await walk(join(library.root, venue.example), '')
  }
  return { venue, kit, stage, written }
}
