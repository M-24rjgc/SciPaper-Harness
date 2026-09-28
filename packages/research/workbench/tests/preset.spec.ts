import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { Context } from '@deepseek-ai/cordis'
import { RESEARCH_TOOL_MODULES, registerResearchTools } from '../src/tools.ts'
import { ModeRegistry } from '../src/modes.ts'
import type { ResearchWorkbench } from '../src/index.ts'

const SKILLS = join(import.meta.dirname, '../runtime/skills')
const PRESET = join(import.meta.dirname, '../../../bundle/research-app/presets/research.patch.yml')
const STANDARD = join(import.meta.dirname, '../../../bundle/web-app/presets/standard.patch.yml')

interface PluginRow {
  id: string
  name: string
  config?: { id?: string; prefix?: string; modules?: string[]; plugins?: PluginRow[] }
}

async function declaration(file: string): Promise<PluginRow> {
  const patches = yaml.load(await readFile(file, 'utf8'), { schema: entryListSchema }) as { insert: PluginRow[] }[]
  return patches[0]!.insert[0]!
}

/** The research tool names the service registers, read from the real registration. */
function registeredTools(): string[] {
  const names: string[] = []
  const ctx = { tools: { register: (tool: { name: string }) => { names.push(tool.name) } }, on: () => {} } as unknown as Context
  registerResearchTools(ctx, {} as ResearchWorkbench)
  return names
}

describe('the research preset', () => {
  it('is the standard agent plus a research persona, its own tools and its own skills', async () => {
    const preset = await declaration(PRESET)
    expect(preset.name).toBe('@deepseek-ai/dsh-agent-preset')
    expect(preset.config?.id).toBe('research')
    const research = preset.config!.plugins!
    const standard = (await declaration(STANDARD)).config!.plugins!
    const added = [...RESEARCH_TOOL_MODULES.map(module => `research-${module}`), 'research-mode-skills', 'tool-lsp']
    expect(research.map(row => row.id).sort()).toEqual([...standard.map(row => row.id), ...added].sort())
    // The tools belong to this preset's agents; the host-wide service registers none.
    for (const module of RESEARCH_TOOL_MODULES) {
      expect(research.find(row => row.id === `research-${module}`)).toMatchObject({
        name: '@deepseek-ai/dsh-research-workbench/tools', config: { modules: [module] },
      })
    }
    expect(research.find(row => row.id === 'research-mode-skills')?.name).toBe('@deepseek-ai/dsh-research-workbench/mode-skills')
    const persona = research.find(row => row.id === 'persona')!
    expect(persona.config?.prefix).toMatch(/research collaborator/)
    // What the host lets the agent import without asking: the files the user attached.
    expect(persona.config?.prefix).toContain('Files the user attached to the conversation can be imported directly.')
    expect(JSON.stringify(research.find(row => row.id === 'skill-filesystem'))).toMatch(/customSkillDirs/)
  })

  it('ships well-formed general skills and mode packs, and every research tool and skill they name exists', async () => {
    const tools = new Set(registeredTools())
    const general = (await readdir(SKILLS)).sort()
    expect(general).toEqual([
      'figures-from-data', 'latex-compile-and-fix', 'literature-review', 'method-diagram', 'paper-review', 'paper-writing',
      'research-modes', 'results-ingest', 'running-experiments', 'submission-package', 'visual-self-review',
    ])
    const modes = await ModeRegistry.load([join(import.meta.dirname, '../runtime/modes')], { warn: (...args: unknown[]) => { throw new Error(args.join(' ')) } })
    const skillFiles = [
      ...general.map(skill => ({ name: skill, file: join(SKILLS, skill, 'SKILL.md') })),
      ...modes.list().flatMap(pack => pack.skills.map(skill => ({ name: skill.name, file: join(skill.directory, 'SKILL.md') }))),
    ]
    const texts = [await readFile(PRESET, 'utf8')]
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
    const guide = await readFile(join(SKILLS, 'research-modes', 'SKILL.md'), 'utf8')
    for (const pack of modes.list()) expect(guide, `research-modes describes ${pack.id}`).toMatch(new RegExp(`\\*\\*${pack.id === 'general' ? 'General|general mode' : pack.id}`, 'i'))
  })
})
