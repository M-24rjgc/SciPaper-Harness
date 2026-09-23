import { describe, expect, it } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { SHIPPED_PRESET_ROOT } from '@deepseek-ai/dsh-agent-presets'
import type { Context } from '@deepseek-ai/cordis'
import { registerResearchTools } from '../src/tools.ts'
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

  it('ships well-formed skills, and every research tool they name exists', async () => {
    const tools = new Set(registeredTools())
    const skills = await readdir(join(PRESET, 'skills'))
    expect(skills.sort()).toEqual([
      'figures-from-data', 'idea-development', 'latex-compile-and-fix', 'literature-review', 'method-diagram', 'paper-plan',
      'paper-review', 'paper-writing', 'research-paper', 'results-ingest', 'running-experiments', 'submission-package', 'visual-self-review',
    ])
    const texts = [await readFile(join(PRESET, 'agent.cordis.yml'), 'utf8')]
    for (const skill of skills) {
      const text = await readFile(join(PRESET, 'skills', skill, 'SKILL.md'), 'utf8')
      const front = /^---\r?\nname: (.+)\r?\ndescription: (.+)\r?\n---/.exec(text)
      expect(front?.[1]).toBe(skill)
      expect(front?.[2]?.length).toBeGreaterThan(40)
      texts.push(text)
    }
    const mentioned = new Set(texts.flatMap(text => [...text.matchAll(/`(research_[a-z]+)/g)].map(match => match[1])))
    for (const name of mentioned) expect(tools.has(name as string), `${String(name)} is registered`).toBe(true)
    // Every skill the orchestrator routes to exists.
    const orchestrator = texts[skills.indexOf('research-paper') + 1] ?? ''
    for (const named of orchestrator.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)) {
      if (['paper-first', 'from-results', 'record-decision', 'set-mode', 'ask-user-question'].includes(named[1] ?? '')) continue
      expect(skills, `skill ${named[1]}`).toContain(named[1])
    }
  })
})
