/**
 * The scripts a mode pack ships: gates that `research_check` runs, and
 * scripts the agent may run through `research_artifact` run-script. Both run
 * with the platform Python, from the pack's own directory, in the project root,
 * with an argument vector (never a shell). A gate prints
 * `{"findings": [{severity, message, file?, line?}]}`; anything else it prints
 * becomes one error finding, so a broken gate reports instead of failing the
 * check.
 */
import { join } from 'node:path'
import { z } from 'zod'
import type { GateRunner } from './checks.ts'
import type { ModeScript, ResolvedMode } from './modes.ts'
import { runProcess, type ProcessResult } from './process.ts'
import type { CheckFinding, ResearchProject } from './types.ts'

/** How much a gate or script may print; its findings are capped separately by the check. */
const OUTPUT_LIMIT = 4 * 1024 * 1024
const TAIL = 1500

const findingSchema = z.object({
  severity: z.enum(['error', 'warning']),
  message: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().nonnegative().optional(),
})
const gateOutputSchema = z.object({ findings: z.array(findingSchema) })

/**
 * Read a gate's findings from what it printed: the last line of standard
 * output that is a findings object. A gate that printed none reports one
 * error naming its exit code and the end of its output.
 * @param result - the finished process.
 * @param check - the gate id the findings are reported under.
 * @returns the findings.
 */
export function parseGateOutput(result: ProcessResult, check: string): CheckFinding[] {
  const lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).reverse()
  for (const line of lines) {
    if (!line.startsWith('{')) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { continue }
    const parsed = gateOutputSchema.safeParse(value)
    if (parsed.success) return parsed.data.findings.map(finding => ({ check, ...finding }))
  }
  const tail = `${result.stderr}\n${result.stdout}`.trim().slice(-TAIL)
  return [{ check, severity: 'error', message: `The gate printed no findings (exit code ${result.code})${tail ? `: ${tail}` : ''}` }]
}

/** The script's argument vector with the manifest's placeholders filled in. */
function argv(script: ModeScript, mode: ResolvedMode, project: ResearchProject): string[] {
  return script.args.map(arg => arg
    .replaceAll('{root}', project.root)
    .replaceAll('{pack}', mode.pack.directory)
    .replaceAll('{route}', mode.route ?? ''))
}

/**
 * Run one pack script.
 * @param python - the interpreter.
 * @param script - the manifest entry.
 * @param mode - the mode it belongs to.
 * @param project - the project it runs in.
 * @param extra - arguments the caller adds after the manifest's.
 * @param signal - cancellation of the call.
 * @returns the finished process.
 */
export function runPackScript(
  python: string, script: ModeScript, mode: ResolvedMode, project: ResearchProject, extra: string[], signal: AbortSignal,
): Promise<ProcessResult> {
  // -I keeps the user's site packages and PYTHON* variables out of the script — including PYTHONUTF8,
  // so UTF-8 mode is asked for on the command line; without it files read in the system code page.
  return runProcess(python, ['-I', '-X', 'utf8', join(mode.pack.directory, script.script), ...argv(script, mode, project), ...extra], {
    cwd: project.root, signal, timeoutMs: script.timeoutSeconds * 1000, maxBytes: OUTPUT_LIMIT,
  })
}

/**
 * The runner a check uses for a mode's gates.
 * @param python - resolves the installed platform Python, or undefined when there is none; gates never install it.
 * @param signal - cancellation of the check.
 * @returns the runner.
 */
export function createGateRunner(python: () => Promise<string | undefined>, signal: AbortSignal): GateRunner {
  return async (gate, mode, project) => {
    const interpreter = await python()
    if (interpreter === undefined) {
      return [{ check: gate.id, severity: 'error', message: 'This gate needs the platform Python: install it under Tools & models in the research settings' }]
    }
    return parseGateOutput(await runPackScript(interpreter, gate, mode, project, [], signal), gate.id)
  }
}
