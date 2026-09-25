import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  blankRecord, canonicalPath, DRAFT_TITLE, draftFolderName, holdsFiles, nextDraftRoot, onlyScaffold, removeEmptyScaffold,
  resolveResearchHome, SCAFFOLD,
} from '../src/drafts.ts'
import { newProject } from '../src/project.ts'
import type { ArtifactId, EvidenceId, ResearchProject } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function temp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'research-drafts-'))
  roots.push(root)
  return root
}

/** A folder with the empty scaffold a research is created with. */
async function scaffolded(root: string): Promise<string> {
  for (const folder of SCAFFOLD) await mkdir(join(root, folder), { recursive: true })
  return root
}

function draft(): ResearchProject {
  return { ...newProject({ title: DRAFT_TITLE, root: join(tmpdir(), 'research-drafts-none'), brief: '' }, 'w' as WorkspaceId), untitled: true }
}

describe('where new researches go', () => {
  it('prefers the person\'s choice, then the deployment\'s, then SciPaper in the profile', () => {
    expect(resolveResearchHome('D:\\Research', 'E:\\Configured', 'C:\\Users\\me')).toBe('D:\\Research')
    expect(resolveResearchHome(undefined, 'E:\\Configured', 'C:\\Users\\me')).toBe('E:\\Configured')
    expect(resolveResearchHome(undefined, undefined, join(tmpdir(), 'profile'))).toBe(join(tmpdir(), 'profile', 'SciPaper'))
    // The default reads the profile directory only; nothing is created there.
    expect(resolveResearchHome(undefined, undefined)).toBe(join(homedir(), 'SciPaper'))
  })

  it('names a research folder by the local date and the first free number', async () => {
    expect(draftFolderName(new Date(2026, 8, 6, 23, 59), 3)).toBe('2026-09-06-3')
    expect(draftFolderName(new Date(2026, 11, 25), 12)).toBe('2026-12-25-12')
    const home = await temp()
    const day = new Date(2026, 8, 26)
    expect(nextDraftRoot(home, day, () => false)).toBe(join(home, '2026-09-26-1'))
    // A folder on disk, or a research recorded at a folder that is gone, takes its number.
    await writeFile(join(home, '2026-09-26-1'), 'a file, not a folder')
    expect(nextDraftRoot(home, day, path => path === join(home, '2026-09-26-2'))).toBe(join(home, '2026-09-26-3'))
    // A home that does not exist yet has every number free.
    expect(nextDraftRoot(join(home, 'missing'), day, () => false)).toBe(join(home, 'missing', '2026-09-26-1'))
  })

  it('spells a folder that may not exist yet the way its research will be recorded', async () => {
    const home = await temp()
    const real = await realpath(home)
    expect(await canonicalPath(home)).toBe(real)
    expect(await canonicalPath(join(home, 'not', 'yet'))).toBe(join(real, 'not', 'yet'))
    await expect(canonicalPath(join(home, 'bad\0name'))).rejects.toThrow()
  })
})

describe('what an untouched draft holds', () => {
  it('reads a record as blank only while it holds nothing but its placeholder title and autonomy', () => {
    expect(blankRecord(draft())).toBe(true)
    expect(blankRecord({ ...draft(), autonomy: 'automatic', revision: 3 })).toBe(true)
    const touched: Partial<ResearchProject>[] = [
      { untitled: undefined }, { mode: 'spark-to-paper' }, { modeSetBy: 'agent' }, { route: 'data' }, { venue: 'iclr' },
      { modeReason: 'why' }, { brief: 'an idea' },
      { lastCheck: { clean: true, scope: 'all', gatesRun: [], phases: [], findings: [], checkedAt: 'now' } },
      { progress: { mode: 'general', phases: {}, findings: {} } },
      { evidence: [{ id: 'e' as EvidenceId, title: 't', kind: 'file', path: 'p', sha256: 's', revision: 1, importedAt: 'now', chunks: [], coverage: 'data', verified: true, stale: false }] },
      { claims: [{ id: 'c', text: 't', kind: 'hypothesis', state: 'proposed', evidence: [], artifactIds: [] }] },
      { artifacts: [{ id: 'a' as ArtifactId, path: 'p', kind: 'code', revision: 1, sha256: 's', evidence: [], claimIds: [], inputArtifacts: [], stale: false, updatedAt: 'now', author: 'user' }] },
      { decisions: [{ id: 'd', question: 'q', answer: 'a', by: 'user', rationale: '', at: 'now' }] },
      { environments: [{} as ResearchProject['environments'][number]] },
      { experiments: [{} as ResearchProject['experiments'][number]] },
      { compilations: [{} as ResearchProject['compilations'][number]] },
      { visualReviews: [{} as ResearchProject['visualReviews'][number]] },
    ]
    for (const change of touched) expect(blankRecord({ ...draft(), ...change })).toBe(false)
  })

  it('tells a folder with only the empty scaffold from one that holds anything', async () => {
    const root = await temp()
    // Nothing on disk at all, as when the person removed the folder by hand.
    expect(await onlyScaffold(join(root, 'gone'))).toBe(true)
    expect(await holdsFiles(join(root, 'gone'))).toBe(false)
    expect(await onlyScaffold(root)).toBe(true)
    expect(await holdsFiles(root)).toBe(false)
    await scaffolded(root)
    expect(await onlyScaffold(root)).toBe(true)
    expect(await holdsFiles(root)).toBe(true)
    await writeFile(join(root, 'paper', 'main.tex'), '\\documentclass{article}')
    expect(await onlyScaffold(root)).toBe(false)
    await rm(join(root, 'paper', 'main.tex'))
    await mkdir(join(root, 'notes'))
    expect(await onlyScaffold(root)).toBe(false)
    await rm(join(root, 'notes'), { recursive: true })
    await writeFile(join(root, 'readme.md'), 'x')
    expect(await onlyScaffold(root)).toBe(false)
    // A file where a folder was chosen holds something, and is no research folder.
    expect(await holdsFiles(join(root, 'readme.md'))).toBe(true)
    expect(await onlyScaffold(join(root, 'readme.md'))).toBe(false)
    // Any other failure to read the folder is reported.
    await expect(onlyScaffold(join(root, 'bad\0name'))).rejects.toThrow()
  })

  it('removes only empty folders, and the root only when the research created it', async () => {
    const made = await scaffolded(join(await temp(), 'made'))
    await removeEmptyScaffold(made, true)
    expect(existsSync(made)).toBe(false)
    // Already gone: nothing to do.
    await removeEmptyScaffold(made, true)

    const chosen = await scaffolded(await temp())
    await removeEmptyScaffold(chosen, false)
    expect(existsSync(chosen)).toBe(true)
    expect(await holdsFiles(chosen)).toBe(false)

    // A folder that holds anything stays, and so does the root around it; a file under a scaffold name is left alone.
    const kept = await scaffolded(join(await temp(), 'kept'))
    await writeFile(join(kept, 'data', 'results.csv'), 'a,b')
    await rm(join(kept, 'code'), { recursive: true })
    await writeFile(join(kept, 'code'), 'a file named like a folder')
    await removeEmptyScaffold(kept, true)
    expect(existsSync(join(kept, 'data', 'results.csv'))).toBe(true)
    expect(existsSync(join(kept, 'code'))).toBe(true)
    expect(existsSync(join(kept, 'paper'))).toBe(false)
    await expect(removeEmptyScaffold(join(kept, 'bad\0name'), false)).rejects.toThrow()
  })
})
