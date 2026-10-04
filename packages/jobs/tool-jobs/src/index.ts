/**
 * Model-facing `job_output`, `job_list`, and `job_kill` tools over
 * `ctx.jobs`. Loading the plugin attaches the controller required by
 * producers. It also delivers completions the model has not already
 * collected to the owning agent: injected into a busy owner's next step, or
 * opening a turn on an idle one under the default `wakeup` delivery, unbounded
 * unless `maxConsecutiveWakes` caps it per owner.
 * @module @deepseek-ai/dsh-tool-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { TextRetainer } from '@deepseek-ai/dsh-output-retention'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobView, JobRead } from '@deepseek-ai/dsh-jobs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import { publicJob, renderModelDelta, statusLine } from './render.ts'
import type { PublicJobSnapshot } from './render.ts'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'tool-jobs': { kind: 'tool-jobs' } & ContextFormed
  }
}

export const name = 'tool-jobs'
export const inject = ['tools', 'jobs', 'systemPrompt']

/**
 * How an uncollected completion reaches an owner that is already idle: `wakeup`
 * opens a turn for it, `quiet` leaves it pending until something else wakes the
 * owner. A busy owner is injected either way.
 */
export type CompletionDelivery = 'quiet' | 'wakeup'

/** Configures bounded `job_output` waits and completion-notice delivery. */
export interface Config {
  /** Wait duration applied when `job_output` sets `wait` without `timeout_ms` (default 30s). */
  waitTimeoutMs?: number
  /** Hard cap on any single wait; a larger model-supplied `timeout_ms` is clamped down to it (default 1min). */
  maxWaitTimeoutMs?: number
  /** Whether a completion opens a turn on an idle owner (default `wakeup`). */
  completionDelivery?: CompletionDelivery
  /**
   * Turns one owner may have opened by completion wakes before the next
   * notice degrades to injection, reset by any user-authored input. Absent by
   * default: every idle completion wakes its owner. Set it to bound the
   * self-exciting chain where a woken turn starts the job whose completion
   * wakes it again, at the cost of notices past the cap waiting silently for
   * the next user input.
   */
  maxConsecutiveWakes?: number
}

export const Config: z<Config> = z.object({
  waitTimeoutMs: z.number().min(1).default(30_000),
  maxWaitTimeoutMs: z.number().min(1).default(60_000),
  completionDelivery: z.union(['quiet', 'wakeup'] as const).default('wakeup'),
  maxConsecutiveWakes: z.number().min(1),
})

/** Shared schema for job-control outputs. */
const PUBLIC_JOB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    label: { type: 'string', required: true },
    status: {
      type: 'string',
      required: true,
      enum: ['running', 'stopping', 'completed', 'killed', 'failed'],
    },
    detail: { type: 'string' },
    startedAt: { type: 'integer', required: true },
    finishedAt: { type: 'integer' },
  },
} as const

const encoder = new TextEncoder()

function retainTail(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'tail', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function retainHead(text: string, maxBytes: number): string {
  const retainer = new TextRetainer({ kind: 'head', maxBytes })
  retainer.push(text)
  return retainer.finish().text
}

function fitWithSuffix(
  content: string,
  suffix: string,
  maxBytes: number | undefined,
  omitted: string,
): string {
  const complete = `${content}${suffix}`
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const fixed = `${content.endsWith(omitted.trimStart()) ? '' : omitted}${suffix}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes >= maxBytes) return retainTail(fixed, maxBytes)
  return `${retainTail(content, maxBytes - fixedBytes)}${fixed}`
}

/**
 * One-line account of a settled job for the `notice` form's collapsed row.
 * @param job - the settled job.
 * @returns its kind, label, and status, bounded like every notice summary.
 */
function completionSummary(job: JobView): string {
  return boundContextSummary(`${job.kind} ${job.label} ${statusLine(publicJob(job))}`)
}

function fitCompletionNotice(job: JobView): string {
  const prefix = `background job ${job.id}`
  const detail = ` (${job.kind}: ${job.label}) finished ${statusLine(publicJob(job))}`
  const action = '\nDone; job_output.'
  const complete = `${prefix}${detail}. Read its output with job_output.`
  const maxBytes = job.outputLimitBytes
  if (maxBytes === undefined || encoder.encode(complete).byteLength <= maxBytes) return complete
  const omitted = '\n[notice truncated]'
  const fixed = `${prefix}${omitted}${action}`
  const fixedBytes = encoder.encode(fixed).byteLength
  if (fixedBytes <= maxBytes) {
    return fixedBytes === maxBytes
      ? fixed
      : `${prefix}${retainHead(detail, maxBytes - fixedBytes)}${omitted}${action}`
  }
  const compact = `${prefix}${action}`
  const compactBytes = encoder.encode(compact).byteLength
  if (compactBytes <= maxBytes) return compact
  const actionBytes = encoder.encode(action).byteLength
  if (actionBytes >= maxBytes) return retainTail(action, maxBytes)
  return `${retainHead(prefix, maxBytes - actionBytes)}${action}`
}

function rawSingleText(content: readonly ContentBlock[]): string | undefined {
  if (content.length !== 1) return undefined
  const block = content[0]
  if (block?.type !== 'text') return undefined
  return block.text
}

function boundSingleText(content: readonly ContentBlock[], maxBytes: number): ContentBlock[] | undefined {
  const text = rawSingleText(content)
  if (text === undefined) return undefined
  return [{
    type: 'text',
    text: fitWithSuffix(text, '', maxBytes, '\n[result truncated]'),
  }]
}

/** The producer's cap for the job a `job_output` or `job_kill` call names, when it is visible to the caller. */
function visibleOutputLimit(ctx: Context, exec: ToolExecution): number | undefined {
  if (exec.name !== 'job_output' && exec.name !== 'job_kill') return undefined
  const jobId = (exec.arguments as { job_id?: unknown } | null | undefined)?.job_id
  if (typeof jobId !== 'string' || jobId.length === 0) return undefined
  return ctx.jobs.listTree(exec.agent?.id).find(job => job.id === jobId)?.outputLimitBytes
}

/** Resolve a job only through the caller's live ownership tree before using its owner's fenced operations. */
function accessibleJob(ctx: Context, id: JobId, exec: { agent?: Agent }): JobView {
  return ctx.jobs.getTree(id, exec.agent?.id)
}

/** Validate the non-empty constraint that ParameterSchemaSpec cannot express. */
function validateJobId(value: string): JobId {
  if (value.length === 0) {
    throw new Error(`invalid job_id: expected a non-empty string, got ${JSON.stringify(value)}`)
  }
  return JobId(value)
}

/** Pending presentation shared by the three generic job controls. */
function presentJobCall(title: string, kind: 'read' | 'execute', rawInput?: string): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput !== undefined ? { rawInput } : {} }
}

/** The consuming read as the model sees it: the delta, then the result once, then the status line. */
function readBody(read: JobRead): { text: string; job: PublicJobSnapshot } {
  const delta = renderModelDelta(read.chunks, read.lossy, read.job.output.spillPaths ?? [])
  const text = read.result === undefined
    ? delta
    : `${delta}${delta.length > 0 && !delta.endsWith('\n') ? '\n' : ''}${read.result}`
  return { text, job: publicJob(read.job) }
}

export function apply(ctx: Context, config: Config): void {
  const waitDefault = config.waitTimeoutMs ?? 30_000
  const waitCap = config.maxWaitTimeoutMs ?? 60_000
  const waitTimeout = (requested?: number): number => {
    const timeout = requested ?? waitDefault
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('invalid wait timeout: expected positive finite milliseconds')
    return Math.min(timeout, waitCap)
  }
  const delivery = config.completionDelivery ?? 'wakeup'
  const wakeBudget = config.maxConsecutiveWakes

  // Turns this plugin opened on each owner since that owner last consumed
  // human input. Keyed by the exact Agent, so a same-session replacement
  // starts with a full budget.
  const spentWakes = new WeakMap<Agent, number>()
  if (waitDefault > waitCap) {
    throw new Error(`tool-jobs: waitTimeoutMs (${waitDefault}) exceeds maxWaitTimeoutMs (${waitCap})`)
  }
  // A budget is a count of turns: a fraction never names a turn, and
  // `Infinity` would spell an "unbounded" that omitting the field already means.
  if (wakeBudget !== undefined && !Number.isSafeInteger(wakeBudget)) {
    throw new Error(`tool-jobs: maxConsecutiveWakes (${wakeBudget}) must be a whole number of turns`)
  }
  // Nothing spends the budget under quiet delivery or without a cap, so
  // nothing needs to refill it.
  if (delivery === 'wakeup' && wakeBudget !== undefined) {
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
      // Claiming is the point the human's input actually enters a step; a notice
      // this plugin itself queued must not refill the budget it just spent.
      if (message.source.kind === 'user') spentWakes.delete(agent)
    })
  }

  const outputLimits = new WeakMap<ToolExecution, number>()
  ctx.on('tools/pre-execute', (exec, next) => {
    const maxBytes = visibleOutputLimit(ctx, exec)
    if (maxBytes !== undefined) outputLimits.set(exec, maxBytes)
    return next()
  }, { prepend: true })
  const finalizeJobContent: NonNullable<ToolDefinition['finalizeContent']> = (exec, result) => {
    const maxBytes = outputLimits.get(exec) ?? visibleOutputLimit(ctx, exec)
    outputLimits.delete(exec)
    if (maxBytes === undefined) return undefined
    if (exec.name === 'job_output' && !result.isError) {
      // This definition owns and schema-validates the canonical value. Preserve
      // its output/status split only while policy left the default rendering intact.
      const value = result.value as unknown as { text: string; job: PublicJobSnapshot }
      const body = value.text.length > 0 ? value.text : '(no new output)'
      const content = body.endsWith('\n') ? body.slice(0, -1) : body
      const suffix = `\n${statusLine(value.job)}`
      if (rawSingleText(result.content) === `${content}${suffix}`) {
        return [{
          type: 'text',
          text: fitWithSuffix(content, suffix, maxBytes, '\n[output truncated]'),
        }]
      }
    }
    return boundSingleText(result.content, maxBytes)
  }

  // Producers may start work only while a controller is attached.
  ctx.jobs.attachController('tool-jobs')

  // Cross-call guidance follows the filesystem sections and precedes product sections.
  ctx.systemPrompt.section({
    name: 'tool:jobs',
    order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS'),
    text: 'Track every background job id you start. Completion notices report actual settlement; do not busy-poll or duplicate running work. Collect relevant output with job_output, using wait: true only when blocked on the result. A cancelled or timed-out output wait leaves the job running. Use job_kill with wait: true to verify a stop, or job_stop_all when asked to stop all commands. Report stopping or failed stops honestly; a cancellation request alone does not mean the work has stopped.',
  })

  // A busy owner is injected: the notice waits in its next-step inbox, which
  // the turn cannot close over, so jobs settling together cost one step. An
  // idle owner is woken instead, because an undelivered notice is a completion
  // the model never learns about. Either way, disposal before delivery
  // discards it with the owner, and a teardown settlement has no reader left.
  //
  // The registry routes each settlement to the scope this plugin was mounted
  // under, so a mount under one preset never sees another preset's agents;
  // this listener owns delivery, not the choice of whom to deliver to.
  ctx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
    if (event.type !== 'settled') return
    if (event.awaited || event.cause === 'teardown' || event.job.owner === undefined) return
    // Retained jobs cannot notify a replacement runtime using the owner's id.
    const owner = ctx.get('agents')?.get(event.job.owner)
    if (owner === undefined) return
    try { ctx.jobs.get(event.job.id, owner.id) } catch { return }
    const message = createUserMessage({
      content: [{
        type: 'text',
        text: fitCompletionNotice(event.job),
      }],
      source: {
        kind: 'tool-jobs',
        form: 'notice',
        summary: completionSummary(event.job),
      },
    })
    if (delivery === 'wakeup' && owner.status === 'idle') {
      if (wakeBudget === undefined) {
        owner.followup(message)
        return
      }
      const spent = spentWakes.get(owner) ?? 0
      if (spent < wakeBudget) {
        spentWakes.set(owner, spent + 1)
        owner.followup(message)
        return
      }
    }
    owner.inject(message)
  })

  ctx.tools.register(defineTool({
    name: 'job_output',
    description: 'Read a background job: output since the previous read for stream jobs, or the result of a finished final-output job.',
    // A timed-out wait returns job state rather than a TOOL_TIMEOUT error, so
    // this tool owns its deadline instead of using ToolDefinition.timeoutMs.
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by the tool that started the background work.' },
      wait: { type: 'boolean', description: 'Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false.' },
      timeout_ms: { type: 'number', description: 'Max wait in milliseconds with wait: true. Defaults to and is capped by configuration.' },
    },
    finalizeContent: finalizeJobContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          job: { ...PUBLIC_JOB_SCHEMA, required: true },
        },
      },
      render: (_args, value) => {
        const body = value.text.length > 0 ? value.text : '(no new output)'
        const separator = body.endsWith('\n') ? '' : '\n'
        return [{ type: 'text', text: `${body}${separator}${statusLine(value.job)}` }]
      },
    },
    async execute(args, exec) {
      const id = validateJobId(args.job_id)
      const jobs = ctx.jobs
      accessibleJob(ctx, id, exec)
      const caller = exec.agent?.id
      if (args.wait === true) {
        // A settlement that releases this wait is reported `awaited`, so the
        // notice listener above skips it: this result carries the terminal
        // state. A timed-out or aborted wait has left the registry's waiter
        // set before any later settlement, which then notifies as usual.
        await jobs.wait(id, waitTimeout(args.timeout_ms), caller, exec.signal)
      }
      return readBody(jobs.read(id, caller))
    },
    presentCall: args => presentJobCall(`Read output from background job ${args.job_id}`, 'read', args.job_id),
  }))

  ctx.tools.register(defineTool({
    name: 'job_list',
    description: 'List your background jobs (running and finished) with their ids, kinds, and statuses.',
    parameters: {},
    output: {
      schema: { type: 'array', items: PUBLIC_JOB_SCHEMA },
      render: (_args, jobs) => [{
        type: 'text',
        text: jobs.length === 0
          ? '(no background jobs)'
          : jobs.map(t => `${t.id} [${t.kind}] ${t.status} — ${t.label}`).join('\n'),
      }],
    },
    execute(_args, exec) {
      const jobs = ctx.jobs.listTree(exec.agent?.id)
      return Promise.resolve(jobs.map(publicJob))
    },
    presentCall: () => presentJobCall('List background jobs', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'job_kill',
    description: 'Cancel a background job; set wait: true to observe whether it actually stopped.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Job id returned by the tool that started the background work.' },
      reason: { type: 'string', description: 'Optional short reason, recorded in the log and forwarded to the job.' },
      wait: { type: 'boolean', description: 'Wait for actual settlement after requesting cancellation. Defaults to false.' },
      timeout_ms: { type: 'number', description: 'Settlement wait in milliseconds, capped by configuration.' },
    },
    finalizeContent: finalizeJobContent,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: {
            type: 'string',
            required: true,
            enum: ['cancellation-requested', 'already-finished'],
          },
          job: { ...PUBLIC_JOB_SCHEMA, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.outcome === 'already-finished'
          ? `job ${value.job.id} had already finished ${statusLine(value.job)}`
          : `requested cancellation of job ${value.job.id} ${statusLine(value.job)}`,
      }],
    },
    async execute(args, exec) {
      const id = validateJobId(args.job_id)
      const jobs = ctx.jobs
      accessibleJob(ctx, id, exec)
      const caller = exec.agent?.id
      const timeout = args.wait === true ? waitTimeout(args.timeout_ms) : undefined
      const result = jobs.kill(id, caller, args.reason)
      // A projection describes current state without consuming pending output.
      const job = publicJob(timeout !== undefined
        ? await jobs.wait(id, timeout, caller, exec.signal)
        : jobs.get(id, caller))
      return {
        outcome: result === 'already-finished' ? 'already-finished' as const : 'cancellation-requested' as const,
        job,
      }
    },
    presentCall: args => presentJobCall(`Kill background job ${args.job_id}`, 'execute', args.job_id),
  }))

  ctx.tools.register(defineTool({
    name: 'job_stop_all',
    description: 'Stop background jobs and registered independent work in your session and live descendant sessions, and verify their settlement.',
    parameters: {
      reason: { type: 'string', description: 'Optional cancellation reason forwarded to every job.' },
      timeout_ms: { type: 'number', description: 'Concurrent settlement wait in milliseconds, capped by configuration.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          confirmed: { type: 'boolean', required: true },
          jobs: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false,
            properties: { job: { ...PUBLIC_JOB_SCHEMA, required: true }, error: { type: 'string' } },
          } },
          sources: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false,
            properties: {
              source: { type: 'string', required: true },
              confirmed: { type: 'boolean', required: true },
              error: { type: 'string' },
              targets: { type: 'array', required: true, items: {
                type: 'object', additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true }, status: { type: 'string', required: true },
                  confirmed: { type: 'boolean', required: true }, error: { type: 'string' },
                },
              } },
            },
          } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: [
        value.confirmed ? 'All selected background work has stopped.' : 'Some background work has not been confirmed stopped.',
        ...value.jobs.map(result => `${result.job.id} ${statusLine(result.job)}${result.error === undefined ? '' : `; ${result.error}`}`),
        ...value.sources.flatMap(source => [
          `${source.source}: ${source.confirmed ? 'stop confirmed' : 'stop unconfirmed'}${source.error === undefined ? '' : `; ${source.error}`}`,
          ...source.targets.map(target => `${target.id} [status: ${target.status}]; ${target.confirmed ? 'stop confirmed' : 'stop unconfirmed'}${target.error === undefined ? '' : `; ${target.error}`}`),
        ]),
      ].join('\n') }],
    },
    async execute(args, exec) {
      const result = await ctx.jobs.stopAll(exec.agent?.id, waitTimeout(args.timeout_ms), args.reason, exec.signal)
      return {
        confirmed: result.confirmed,
        sources: result.sources.map(source => ({ ...source, targets: source.targets.map(target => ({ ...target })) })),
        jobs: result.jobs.map(item => ({ job: publicJob(item.job), ...item.error === undefined ? {} : { error: item.error } })),
      }
    },
    presentCall: () => presentJobCall('Stop all background jobs', 'execute'),
  }))
}
