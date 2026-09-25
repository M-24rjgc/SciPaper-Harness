/**
 * New researches: where they are created, the folders a research starts with,
 * and what an untouched draft holds on disk. The service decides which
 * research is the draft; these functions only read and tidy folders.
 */
import { existsSync } from 'node:fs'
import { readdir, realpath, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { ResearchProject } from './types.ts'

/** The folders every research is created with, all empty at first. */
export const SCAFFOLD = ['paper', 'figures', 'code', 'data', '.research', 'exports'] as const

/** The title a research carries while it is an untouched draft; `untitled` marks it as the product's placeholder. */
export const DRAFT_TITLE = '新研究'

/** The research home when neither the person nor the deployment chose one: an ASCII folder in the profile, outside Documents. */
const DEFAULT_HOME_FOLDER = 'SciPaper'

/**
 * Where new researches are created: the person's choice in the settings,
 * else the deployment's `researchHome`, else `<profile home>/SciPaper`.
 * @param chosen - the `researchHome` preference, when the person set one.
 * @param configured - the service's configured `researchHome`, when the deployment set one.
 * @param profile - the person's profile directory (`%USERPROFILE%` on Windows).
 * @returns the absolute research home.
 */
export function resolveResearchHome(chosen: string | undefined, configured: string | undefined, profile: string = homedir()): string {
  return chosen ?? configured ?? join(profile, DEFAULT_HOME_FOLDER)
}

/**
 * The folder name of a new research: the local date and a number, such as `2026-09-26-1`.
 * @param date - when the research is created; its local calendar day is used.
 * @param n - the number of the research that day, from 1.
 * @returns the folder name.
 */
export function draftFolderName(date: Date, n: number): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${n}`
}

/**
 * The first free folder for a new research in the research home: `<home>/<yyyy-mm-dd>-<n>`
 * with the smallest `n` whose path holds nothing on disk and no recorded research.
 * @param home - the research home.
 * @param date - when the research is created.
 * @param recorded - whether a research is already recorded at a path, even one whose folder is gone.
 * @returns the absolute folder path.
 */
export function nextDraftRoot(home: string, date: Date, recorded: (path: string) => boolean): string {
  for (let n = 1; ; n++) {
    const candidate = join(home, draftFolderName(date, n))
    if (!existsSync(candidate) && !recorded(candidate)) return candidate
  }
}

/**
 * Whether a research's record holds nothing but what creating a draft wrote:
 * the placeholder title, the general mode with no mode chosen, and no
 * sources, claims, files, decisions, environments, runs, compiles, reviews or
 * checks. The autonomy is the person's setting for its conversations and
 * does not count.
 * @param project - the stored record.
 * @returns true for a record nobody has worked in.
 */
export function blankRecord(project: ResearchProject): boolean {
  const lists = [
    project.evidence, project.claims, project.artifacts, project.decisions,
    project.environments, project.experiments, project.compilations, project.visualReviews,
  ]
  return project.untitled === true && project.mode === 'general' && project.modeSetBy === undefined && project.route === undefined
    && project.venue === undefined && project.modeReason === undefined && project.brief === ''
    && project.lastCheck === undefined && project.progress === undefined && lists.every(list => list.length === 0)
}

/** The file-system error code of a thrown value. */
function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

/**
 * The names a directory holds; none for a directory that does not exist.
 * @param directory - absolute path.
 * @returns the entries, or undefined when the path is a file rather than a folder.
 */
async function entries(directory: string): Promise<{ name: string; folder: boolean }[] | undefined> {
  try {
    return (await readdir(directory, { withFileTypes: true })).map(entry => ({ name: entry.name, folder: entry.isDirectory() }))
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT') return []
    if (code === 'ENOTDIR') return undefined
    throw error
  }
}

/**
 * The canonical spelling of a path that may not exist yet: its nearest
 * existing ancestor resolved through links (and, on Windows, long names),
 * followed by the parts that do not exist. Research roots are stored in this
 * spelling, so a folder about to be created compares equal to the one
 * recorded once it is.
 * @param path - an absolute path.
 * @returns the canonical absolute path.
 */
export async function canonicalPath(path: string): Promise<string> {
  const missing: string[] = []
  let current = resolve(path)
  while (true) {
    try {
      return join(await realpath(current), ...missing)
    } catch (error) {
      const parent = dirname(current)
      // Any other failure, or a root that does not resolve (a drive that is not there), ends the walk with its error.
      if (codeOf(error) !== 'ENOENT' || parent === current) throw error
      missing.unshift(basename(current))
      current = parent
    }
  }
}

/** What removing a directory that holds something, or is gone, or is a file, fails with; such a path stays as it is. */
const KEPT = new Set(['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR'])

/**
 * Whether a folder holds anything at all. A folder that does not exist holds nothing.
 * @param directory - absolute path of the folder.
 * @returns true when it has at least one entry, or is a file rather than a folder.
 */
export async function holdsFiles(directory: string): Promise<boolean> {
  const found = await entries(directory)
  return found === undefined || found.length > 0
}

/**
 * Whether a research folder holds only the empty folders it was created
 * with, or nothing at all (a folder removed by hand holds nothing either).
 * @param root - the research's absolute root.
 * @returns true when nothing but empty scaffold folders is there.
 */
export async function onlyScaffold(root: string): Promise<boolean> {
  const found = await entries(root)
  if (found === undefined) return false
  for (const entry of found) {
    if (!entry.folder || !(SCAFFOLD as readonly string[]).includes(entry.name)) return false
    if (await holdsFiles(join(root, entry.name))) return false
  }
  return true
}

/** Remove one directory if it is empty; one that holds anything, or is already gone, stays as it is. */
async function removeIfEmpty(directory: string): Promise<void> {
  try {
    await rmdir(directory)
  } catch (error) {
    // Not empty, already gone, or not a folder: a folder that holds something is never removed.
    if (!KEPT.has(String(codeOf(error)))) throw error
  }
}

/**
 * Remove the scaffold folders of a research that are still empty, and then
 * its root when the research created that folder and it is empty now. A
 * folder that holds anything is never removed.
 * @param root - the research's absolute root.
 * @param createdRoot - whether creating the research also created the root.
 */
export async function removeEmptyScaffold(root: string, createdRoot: boolean): Promise<void> {
  for (const folder of SCAFFOLD) await removeIfEmpty(join(root, folder))
  if (createdRoot) await removeIfEmpty(root)
}
