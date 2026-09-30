/**
 * Mode packs: what a mode adds on top of the general research agent. A pack is
 * a directory of data — a `mode.yml` manifest, the skills the agent sees only
 * while the mode is active, and the scripts its checks run. The general mode is
 * itself a pack with no phases and no skills, so every capability of the
 * research tools stays available in every mode; a pack only adds know-how and
 * definitions of done. New modes are new directories, not code.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { errorText } from './files.ts'
import { checkIds } from './schema.ts'
import type { ModeSummary, ResearchProject } from './types.ts'

/** The pack every project falls back to: the general agent, no pipeline. */
export const GENERAL_MODE = 'general'

const name = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'use lowercase words joined by hyphens')
const localized = z.object({ en: z.string().trim().min(1), zh: z.string().trim().min(1) })
const count = z.number().int().positive()

/** One fact about the project a phase can require; an array means any one of them is enough. */
const conditionSchema = z.union([
  z.enum(['manuscript', 'diagram', 'pagesInspected', 'reviewCurrent', 'runsCollected', 'noActiveRuns', 'dataEvidence', 'resultsOrData']),
  z.strictObject({ file: z.string().min(1), min: count.optional() }),
  z.strictObject({ bibEntries: count }),
  z.strictObject({ sections: count }),
  z.strictObject({ figures: count }),
])
const requirementSchema = z.strictObject({
  when: z.union([conditionSchema, z.array(conditionSchema).min(1)]),
  /** What the agent reads while the requirement is unmet; the reason the check found when absent. */
  message: z.string().trim().min(1).optional(),
  /** What the person reads while it is unmet: one short sentence saying what is missing. */
  hint: localized,
})
const phaseSchema = z.strictObject({
  id: name,
  label: localized,
  routes: z.array(name).min(1).optional(),
  skills: z.array(name).default([]),
  checkpoint: z.boolean().default(false),
  checks: z.union([z.literal('all'), z.array(z.string().min(1))]).default([]),
  requires: z.array(requirementSchema).default([]),
  /** A decision key (`record-decision` key) that defers this phase while the phase is not done. */
  deferrable: name.optional(),
})
const scriptSchema = z.strictObject({
  id: name,
  script: z.string().regex(/^[\w./-]+\.py$/, 'a relative .py path inside the pack'),
  args: z.array(z.string()).default([]),
  routes: z.array(name).min(1).optional(),
  timeoutSeconds: z.number().int().min(1).max(600).default(120),
  description: z.string().trim().min(1).optional(),
})
/** A gate is a script that `research_check` runs; its label names its findings for the person. */
const gateSchema = scriptSchema.extend({ label: localized })
const manifestSchema = z.strictObject({
  id: name,
  order: z.number().int(),
  name: localized,
  summary: localized,
  source: z.strictObject({ repo: z.url(), version: z.string().min(1), license: z.string().min(1) }).optional(),
  entry: name.optional(),
  preload: z.array(name).default([]),
  /** The project folder the mode's paper sources live in: `paper`, or `.` for the project root. */
  paperRoot: z.string().regex(/^(?:\.|[\w-]+(?:\/[\w-]+)*)$/, 'a project-relative folder such as paper, or . for the project root'),
  /** A project-relative glob: when set, only a matching file changed after the newest review makes the review out of date. */
  reviewAgainst: z.string().trim().min(1).optional(),
  routes: z.array(z.strictObject({ id: name, name: localized, summary: localized })).default([]),
  defaultRoute: name.optional(),
  phases: z.array(phaseSchema).default([]),
  gates: z.array(gateSchema).default([]),
  scripts: z.array(scriptSchema).default([]),
})

/** A project fact or minimum file/content count used to decide whether a phase requirement is met. */
export type ModeCondition = z.infer<typeof conditionSchema>
/** A phase requirement and its explanations; an array of conditions is satisfied by any one condition. */
export type ModeRequirement = z.infer<typeof requirementSchema>
/** A mode phase with route eligibility, skills, checks and the requirements that determine completion. */
export type ModePhase = z.infer<typeof phaseSchema>
/** A pack-owned Python script with arguments, eligible routes and a bounded execution timeout. */
export type ModeScript = z.infer<typeof scriptSchema>
/** A script research_check runs, with the name its findings are grouped under for the person. */
export type ModeGate = z.infer<typeof gateSchema>

/** A condition's name within its phase: the fact, with its glob or its count. */
function conditionKey(condition: ModeCondition): string {
  if (typeof condition === 'string') return condition
  if ('file' in condition) return condition.min === undefined ? `file:${condition.file}` : `file:${condition.file}>=${condition.min}`
  if ('bibEntries' in condition) return `bibEntries>=${condition.bibEntries}`
  return 'sections' in condition ? `sections>=${condition.sections}` : `figures>=${condition.figures}`
}

/**
 * The key a check reports an unmet requirement under, unique within its phase:
 * its conditions, joined by ` | ` when any one of them is enough.
 * @param requirement - one requirement of a phase.
 * @returns the key, such as `file:story.json` or `resultsOrData`.
 */
export function requirementKey(requirement: ModeRequirement): string {
  return (Array.isArray(requirement.when) ? requirement.when : [requirement.when]).map(conditionKey).join(' | ')
}

/** A skill a pack shows the agent while its mode is active. */
export interface ModeSkill {
  name: string
  description: string
  whenToUse?: string | undefined
  /** Absolute directory holding the skill's SKILL.md and its resources. */
  directory: string
}

/** One loaded pack: its manifest, where it lives, and its skills. */
export interface ModePack extends z.infer<typeof manifestSchema> {
  /** Absolute directory of the pack. */
  directory: string
  skills: ModeSkill[]
}

/** A project's mode as it applies now: the pack, the route, and the phases on that route. */
export interface ResolvedMode {
  pack: ModePack
  route?: string | undefined
  phases: ModePhase[]
  /** The pack gates that apply on this route. */
  gates: ModeGate[]
  /** The recorded mode id when no installed pack carries it; the project then runs as general. */
  missing?: string | undefined
}

/** Frontmatter fields a pack skill may carry; anything else is ignored. */
const skillFrontmatter = z.object({ name, description: z.string().trim().min(1), whenToUse: z.string().optional() })

/**
 * Split a SKILL.md into its frontmatter fields and body.
 * @param text - the whole file.
 * @returns the parsed frontmatter and the body after it.
 */
export function parseSkillFile(text: string): { frontmatter: z.infer<typeof skillFrontmatter>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) throw new Error('SKILL.md must start with a --- frontmatter block')
  return { frontmatter: skillFrontmatter.parse(parseYaml(match[1] as string)), body: match[2] as string }
}

async function loadSkills(directory: string): Promise<ModeSkill[]> {
  let entries: string[]
  try { entries = (await readdir(join(directory, 'skills'), { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name) } catch { return [] }
  const skills: ModeSkill[] = []
  for (const entry of entries.sort()) {
    const skillDirectory = join(directory, 'skills', entry)
    const { frontmatter } = parseSkillFile(await readFile(join(skillDirectory, 'SKILL.md'), 'utf8'))
    if (frontmatter.name !== entry) throw new Error(`skills/${entry}/SKILL.md is named ${frontmatter.name}; the name must match its folder`)
    skills.push({ ...frontmatter, directory: skillDirectory })
  }
  return skills
}

/**
 * Read and validate one pack directory.
 * @param directory - absolute pack directory holding mode.yml.
 * @returns the loaded pack.
 */
export async function loadPack(directory: string): Promise<ModePack> {
  const manifest = manifestSchema.parse(parseYaml(await readFile(join(directory, 'mode.yml'), 'utf8')))
  const skills = await loadSkills(directory)
  const routeIds = new Set(manifest.routes.map(route => route.id))
  const gateIds = new Set(manifest.gates.map(gate => gate.id))
  const skillNames = new Set(skills.map(skill => skill.name))
  const problems: string[] = []
  const unique = (label: string, ids: string[]): void => {
    const seen = new Set<string>()
    for (const id of ids) { if (seen.has(id)) problems.push(`duplicate ${label} ${id}`); seen.add(id) }
  }
  unique('route', manifest.routes.map(route => route.id))
  unique('gate', manifest.gates.map(gate => gate.id))
  unique('script', manifest.scripts.map(script => script.id))
  if (routeIds.size > 0 && (manifest.defaultRoute === undefined || !routeIds.has(manifest.defaultRoute))) problems.push('defaultRoute must name one of the routes')
  if (routeIds.size === 0 && manifest.defaultRoute !== undefined) problems.push('defaultRoute needs routes')
  for (const gate of manifest.gates) if ((checkIds as readonly string[]).includes(gate.id)) problems.push(`gate ${gate.id} shadows a base check`)
  for (const name of [manifest.entry, ...manifest.preload]) if (name !== undefined && !skillNames.has(name)) problems.push(`skill ${name} is not in skills/`)
  for (const item of [...manifest.phases, ...manifest.gates, ...manifest.scripts]) {
    for (const route of item.routes ?? []) if (!routeIds.has(route)) problems.push(`${item.id} names unknown route ${route}`)
  }
  for (const phase of manifest.phases) {
    unique(`requirement of phase ${phase.id}`, phase.requires.map(requirementKey))
    if (phase.checks === 'all') continue
    for (const check of phase.checks) {
      if (!(checkIds as readonly string[]).includes(check) && !gateIds.has(check)) problems.push(`phase ${phase.id} names unknown check ${check}`)
    }
  }
  for (const route of routeIds.size ? [...routeIds] : [undefined]) {
    unique(`phase on route ${route ?? '(none)'}`, manifest.phases.filter(phase => route === undefined || phase.routes === undefined || phase.routes.includes(route)).map(phase => phase.id))
  }
  if (problems.length) throw new Error(problems.join('; '))
  return { ...manifest, directory, skills }
}

const onRoute = (route: string | undefined) => (item: { routes?: string[] | undefined }): boolean =>
  item.routes === undefined || (route !== undefined && item.routes.includes(route))

/** The installed packs, ordered for display, with the general pack always present. */
export class ModeRegistry {
  private readonly byId: Map<string, ModePack>
  private readonly general: ModePack

  /**
   * @param packs - loaded packs; one must be the general pack.
   */
  constructor(packs: ModePack[]) {
    this.byId = new Map([...packs].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map(pack => [pack.id, pack]))
    const general = this.byId.get(GENERAL_MODE)
    if (!general) throw new Error('The general mode pack is missing')
    this.general = general
  }

  /**
   * Load every pack under the given roots. A pack that fails validation is
   * skipped with a warning so one broken pack never takes the service down;
   * the general pack must load.
   * @param roots - directories whose subdirectories are packs.
   * @param logger - where skipped packs are reported.
   * @returns the registry.
   */
  static async load(roots: string[], logger: { warn(format: string, ...args: unknown[]): void }): Promise<ModeRegistry> {
    const packs: ModePack[] = []
    for (const root of roots) {
      let entries: string[]
      try { entries = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name) } catch { continue }
      for (const entry of entries.sort()) {
        try {
          const pack = await loadPack(join(root, entry))
          if (packs.some(existing => existing.id === pack.id)) throw new Error(`another pack already has id ${pack.id}`)
          packs.push(pack)
        } catch (error) {
          logger.warn('research mode pack %s skipped: %s', join(root, entry), errorText(error))
        }
      }
    }
    return new ModeRegistry(packs)
  }

  /**
   * Every pack, in display order.
   * @returns a new array sorted by declared order, then id; the pack objects are shared with the registry.
   */
  list(): ModePack[] {
    return [...this.byId.values()]
  }

  /**
   * One pack by id.
   * @param id - the pack id.
   * @returns the pack, or undefined when none is installed under that id.
   */
  get(id: string): ModePack | undefined {
    return this.byId.get(id)
  }

  /**
   * What the desktop shows for each mode: names, routes and phase labels, no file paths.
   * @returns the installed modes in display order, omitting local directories and executable check definitions.
   */
  summaries(): ModeSummary[] {
    return this.list().map(pack => ({
      id: pack.id, order: pack.order, name: pack.name, summary: pack.summary,
      ...(pack.entry === undefined ? {} : { entry: pack.entry }), preload: pack.preload,
      routes: pack.routes, ...(pack.defaultRoute === undefined ? {} : { defaultRoute: pack.defaultRoute }),
      phases: pack.phases.map(phase => ({
        id: phase.id, label: phase.label, checkpoint: phase.checkpoint, skills: phase.skills,
        ...(phase.routes === undefined ? {} : { routes: phase.routes }),
      })),
    }))
  }

  /**
   * Check a requested mode and route, filling in the pack's default route.
   * @param mode - a pack id.
   * @param route - one of the pack's routes, or undefined for its default.
   * @returns the mode and the route to record.
   */
  choose(mode: string, route?: string): { mode: string; route?: string } {
    const pack = this.byId.get(mode)
    if (!pack) throw new Error(`Unknown mode ${mode}; installed modes: ${[...this.byId.keys()].join(', ')}`)
    if (pack.routes.length === 0) {
      if (route !== undefined) throw new Error(`Mode ${mode} has no routes`)
      return { mode }
    }
    const chosen = pack.routes.find(item => item.id === (route ?? pack.defaultRoute))
    if (!chosen) throw new Error(`Mode ${mode} has no route ${route}; its routes: ${pack.routes.map(item => item.id).join(', ')}`)
    return { mode, route: chosen.id }
  }

  /**
   * The mode a project runs in now. A recorded pack that is no longer
   * installed, or a route the pack no longer has, falls back rather than failing.
   * @param project - the recorded mode and route.
   * @returns the pack, route, phases and gates in effect.
   */
  resolve(project: Pick<ResearchProject, 'mode' | 'route'>): ResolvedMode {
    const recorded = this.byId.get(project.mode)
    const pack = recorded ?? this.general
    const route = pack.routes.some(item => item.id === project.route) ? project.route : pack.defaultRoute
    return {
      pack, ...(route === undefined ? {} : { route }),
      phases: pack.phases.filter(onRoute(route)),
      gates: pack.gates.filter(onRoute(route)),
      // Only a pack other than general can be missing: the registry never exists without the general pack.
      ...(recorded ? {} : { missing: project.mode }),
    }
  }
}
