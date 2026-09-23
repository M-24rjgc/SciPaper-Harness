import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'
import type { Context } from '@deepseek-ai/cordis'
import { registerResearchTools } from '../src/tools.ts'
import { ModeRegistry } from '../src/modes.ts'
import type { ResearchWorkbench } from '../src/index.ts'

const PRESET = join(SHIPPED_PRESET_ROOT, 'research')

/** The research tool names the service registers, read from the real registration. */
function registeredTools(): string[] {
  const names: string[] = []
  const ctx = { tools: { register: (tool: { name: string }) => { names.push(tool.name) } }, on: () => {} } as unknown as Context
  registerResearchTools(ctx, {} as ResearchWorkbench)
  return names
}

describe('the research preset', () => {
  it('is the standard agent plus a research persona, its own tools and its own skills', async () => {
    const research = yaml.load(await readFile(join(PRESET, 'agent.cordis.yml'), 'utf8'), { schema: entryListSchema }) as { id: string; name: string }[]
    const standard = yaml.load(await readFile(join(SHIPPED_PRESET_ROOT, 'standard', 'agent.cordis.yml'), 'utf8'), { schema: entryListSchema }) as { id: string }[]
    expect(research.map(row => row.id).sort()).toEqual([...standard.map(row => row.id), 'research-tools'].sort())
    // The tools belong to this preset's agents; the host-wide service registers none.
    expect(research.find(row => row.id === 'research-tools')?.name).toBe('@deepseek-ai/dsh-research-workbench/tools')
    const persona = research.find(row => row.id === 'persona') as unknown as { config: { prefix: string } }
    expect(persona.config.prefix).toMatch(/research collaborator/)
    expect(JSON.stringify(research.find(row => row.id === 'skill-filesystem'))).toMatch(/customSkillDirs/)
    expect(await readFile(join(PRESET, 'preset.yml'), 'utf8')).toMatch(/^name: /m)
  })

  it('ships well-formed general skills and mode packs, and every research tool and skill they name exists', async () => {
    const tools = new Set(registeredTools())
    const general = (await readdir(join(PRESET, 'skills'))).sort()
    expect(general).toEqual([
      'figures-from-data', 'latex-compile-and-fix', 'literature-review', 'method-diagram', 'paper-review', 'paper-writing',
      'research-modes', 'results-ingest', 'running-experiments', 'submission-package', 'visual-self-review',
    ])
    const modes = await ModeRegistry.load([join(import.meta.dirname, '../runtime/modes')], { warn: (...args: unknown[]) => { throw new Error(args.join(' ')) } })
    const skillFiles = [
      ...general.map(skill => ({ name: skill, file: join(PRESET, 'skills', skill, 'SKILL.md') })),
      ...modes.list().flatMap(pack => pack.skills.map(skill => ({ name: skill.name, file: join(skill.directory, 'SKILL.md') }))),
    ]
    const texts = [await readFile(join(PRESET, 'agent.cordis.yml'), 'utf8')]
    for (const { name, file } of skillFiles) {
      const text = await readFile(file, 'utf8')
      const front = /^---\r?\nname: (.+)\r?\ndescription: (.+)\r?\n---/.exec(text)
      expect(front?.[1]).toBe(name)
      expect(front?.[2]?.length).toBeGreaterThan(40)
      texts.push(text)
    }
    const mentioned = new Set(texts.flatMap(text => [...text.matchAll(/`(research_[a-z]+)/g)].map(match => match[1])))
    for (const name of mentioned) expect(tools.has(name as string), `${String(name)} is registered`).toBe(true)
    for (const pack of modes.list()) {
      const own = pack.skills.map(skill => skill.name)
      // A pack skill never shadows a general one: the general skills stay what they are in every mode.
      for (const name of own) expect(general, `${pack.id}/${name} clashes with a general skill`).not.toContain(name)
      for (const phase of pack.phases) {
        for (const skill of phase.skills) expect([...own, ...general], `${pack.id} phase ${phase.id} names ${skill}`).toContain(skill)
      }
      if (pack.id !== 'general') expect(pack.source?.license, `${pack.id} names its upstream licence`).toBeTruthy()
    }
    // The general mode's guide names every installed pack.
    const guide = await readFile(join(PRESET, 'skills', 'research-modes', 'SKILL.md'), 'utf8')
    for (const pack of modes.list()) expect(guide, `research-modes describes ${pack.id}`).toMatch(new RegExp(`\\*\\*${pack.id === 'general' ? 'General|general mode' : pack.id}`, 'i'))
  })
})
