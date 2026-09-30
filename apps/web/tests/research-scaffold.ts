/** The research bundle on the shared Web test world, with all durable state confined to that world. */
import { join } from 'node:path'
import { launchWebScaffold, type LaunchOptions, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT } from './support.ts'
import type {} from '@deepseek-ai/dsh-research-workbench'

/** Boot the shipped research plugin stack and select the research preset. */
export async function launchResearchScaffold(options: LaunchOptions = {}): Promise<WebScaffold> {
  const bundle = join(REPO_ROOT, 'packages/bundle/research-app')
  const overlays = options.extraOverlayPath === undefined ? []
    : typeof options.extraOverlayPath === 'string' ? [options.extraOverlayPath] : options.extraOverlayPath
  const scaffold = await launchWebScaffold({
    ...options,
    extraInstallAnchors: [join(bundle, 'package.json'), ...options.extraInstallAnchors ?? []],
    extraOverlayPath: [join(bundle, 'cordis.patch.yml'), join(bundle, 'presets/research.patch.yml'), ...overlays],
    agentPresets: { default: 'research', ...options.agentPresets },
  })
  try {
    await scaffold.ctx.research.configure({ researchHome: join(scaffold.workspaceCwd, 'SciPaper') })
    return scaffold
  } catch (error) {
    await scaffold.close()
    throw error
  }
}
