import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyVenue, kitFiles, listVenues, loadVenues, type VenueLibrary } from '../src/venues.ts'

const LIBRARY = join(import.meta.dirname, '../runtime/venues')
let library: VenueLibrary
beforeAll(async () => { library = await loadVenues(LIBRARY) })
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'research venues 中文 '))
  roots.push(root)
  return root
}

describe('the venue template library', () => {
  it('ships every venue with a kit whose files, guides and examples exist', async () => {
    expect(library.venues).toHaveLength(139)
    expect(library.kits.size).toBe(16)
    for (const kit of library.kits.values()) {
      for (const name of [...kitFiles(kit), 'main.tex.tmpl']) await expect(access(join(LIBRARY, 'kits', kit.id, name)), `${kit.id}/${name}`).resolves.toBeUndefined()
      const tmpl = await readFile(join(LIBRARY, 'kits', kit.id, 'main.tex.tmpl'), 'utf8')
      for (const token of ['@@title@@', '@@abstract@@', '@@sections@@', '\\usepackage{adjustbox}']) expect(tmpl, `${kit.id} ${token}`).toContain(token)
    }
    for (const venue of library.venues) {
      if (venue.guide) await expect(access(join(LIBRARY, 'guides', venue.guide))).resolves.toBeUndefined()
      if (venue.example) await expect(access(join(LIBRARY, venue.example))).resolves.toBeUndefined()
    }
    await expect(access(join(LIBRARY, 'LICENSE'))).resolves.toBeUndefined()
    // The upstream kit mistakes are corrected.
    const kitOf = (id: string) => library.venues.find(venue => venue.id === id)?.kit
    expect([kitOf('osdi'), kitOf('imc'), kitOf('icalp'), kitOf('ecoop'), kitOf('sp')]).toEqual(['usenix', 'acmart', 'lipics', 'lipics', 'ieeetran'])
  })

  it('lists venues by id, name, family and tier', () => {
    expect(listVenues(library)).toHaveLength(139)
    const neurips = listVenues(library, 'NeurIPS')
    expect(neurips).toEqual([expect.objectContaining({ id: 'neurips', tier: 'CCF-A', kit: 'NeurIPS 2026', anonymous: true, guide: true })])
    expect(listVenues(library, 'ccf-a security').map(venue => venue.id)).toEqual(expect.arrayContaining(['ccs', 'usenix-security']))
    expect(listVenues(library, 'acl')[0]).toMatchObject({ notes: expect.arrayContaining([expect.stringMatching(/acl_natbib\.bst/)]) as unknown })
    expect(listVenues(library, 'zzz-no-such-venue')).toEqual([])
  })

  it('applies a venue: kit, example and guide under template/, the assembly template and style files in the root', async () => {
    const root = await project()
    const applied = await applyVenue(library, root, 'neurips')
    expect(applied).toMatchObject({ stage: 'review', venue: { id: 'neurips' }, kit: { id: 'neurips' } })
    expect(applied.written).toEqual(expect.arrayContaining([
      'neurips_2026.sty', 'template/neurips/neurips_2026.sty', 'template/neurips/checklist.tex', 'template/neurips/GUIDE.md',
      'template/neurips/neurips_2026.tex', 'main.tex.tmpl', 'template.json',
    ]))
    const tmpl = await readFile(join(root, 'main.tex.tmpl'), 'utf8')
    expect(tmpl).toContain('\\usepackage[]{neurips_2026}')
    expect(tmpl).not.toMatch(/<<\w+>>/)
    const spec = JSON.parse(await readFile(join(root, 'template.json'), 'utf8')) as Record<string, unknown>
    expect(spec).toMatchObject({
      name: 'neurips', official: true, results_mode: 'proposal',
      engine: { style_package: 'neurips_2026', is_class: false, assets: ['neurips_2026.sty', 'checklist.tex'], main_template: 'main.tex.tmpl' },
      citations: { style: 'author_year', bibstyle: 'plainnat', merge_adjacent: false },
      venue: { id: 'neurips', stage: 'review', anonymous: true, guide: 'template/neurips/GUIDE.md' },
    })
    // Camera-ready takes the final options; a results mode already set survives.
    spec.results_mode = 'data_aware'
    await writeFile(join(root, 'template.json'), JSON.stringify(spec))
    await applyVenue(library, root, 'neurips', 'final')
    expect(await readFile(join(root, 'main.tex.tmpl'), 'utf8')).toContain('\\usepackage[final,main]{neurips_2026}')
    expect(JSON.parse(await readFile(join(root, 'template.json'), 'utf8'))).toMatchObject({ results_mode: 'data_aware', venue: { stage: 'final' } })
  })

  it('anonymises the author block where the class cannot, and takes each venue\'s class options and stage lines', async () => {
    const ieee = await project()
    await applyVenue(library, ieee, 'icde')
    expect(await readFile(join(ieee, 'main.tex.tmpl'), 'utf8')).toContain('\\IEEEauthorblockN{Anonymous Authors}')
    await applyVenue(library, ieee, 'icde', 'final')
    expect(await readFile(join(ieee, 'main.tex.tmpl'), 'utf8')).toContain('\\IEEEauthorblockN{@@authors@@}')
    const pldi = await project()
    await applyVenue(library, pldi, 'pldi')
    expect(await readFile(join(pldi, 'main.tex.tmpl'), 'utf8')).toMatch(/^\\documentclass\[acmsmall,screen,review,anonymous\]\{acmart\}/)
    expect(JSON.parse(await readFile(join(pldi, 'template.json'), 'utf8'))).toMatchObject({ citations: { style: 'numeric', merge_adjacent: true } })
    const iclr = await project()
    await applyVenue(library, iclr, 'iclr', 'final')
    expect(await readFile(join(iclr, 'main.tex.tmpl'), 'utf8')).toContain('\\iclrfinalcopy')
    // An example with folders keeps them.
    const cvpr = await project()
    expect((await applyVenue(library, cvpr, 'cvpr')).written).toEqual(expect.arrayContaining(['template/cvpr/main.tex', 'template/cvpr/sec/0_abstract.tex']))
    // A venue without a guide or example writes only its kit.
    const plain = await project()
    const applied = await applyVenue(library, plain, 'asiacrypt')
    expect(applied.written.filter(path => path.startsWith('template/asiacrypt/'))).toEqual(['template/asiacrypt/llncs.cls', 'template/asiacrypt/splncs04.bst'])
    // A template.json the project broke is replaced rather than trusted.
    await writeFile(join(plain, 'template.json'), '{broken')
    await applyVenue(library, plain, 'asiacrypt')
    expect(JSON.parse(await readFile(join(plain, 'template.json'), 'utf8'))).toMatchObject({ results_mode: 'proposal' })
    await expect(applyVenue(library, plain, 'nowhere')).rejects.toThrow(/Unknown venue nowhere; list-venues/)
  })

  it('refuses a library whose venue names a kit it lacks', async () => {
    const root = await project()
    await mkdir(join(root, 'kits'))
    await writeFile(join(root, 'venues.json'), JSON.stringify({ version: 1, source: 's', venues: [{
      id: 'x', name: 'X', family: null, tier: null, kit: 'ghost', anonymous: false, url: null, guide: null, example: null, verified: null, notes: [],
    }] }))
    await expect(loadVenues(root)).rejects.toThrow(/Venue x names an unknown kit ghost/)
  })
})
