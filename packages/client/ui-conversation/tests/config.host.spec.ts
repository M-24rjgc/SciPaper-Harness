import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import {
  DEFAULT_BUSY_ENTER_BEHAVIOR, Config, apply,
} from '@deepseek-ai/dsh-client-ui-conversation'


describe('ui-conversation host', () => {
  it('registers, validates, and disposes the durable busy-Enter preference', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    const { fiber } = configuration
    expect(plainConfig(configuration.fiber.config)).toEqual({
      busyEnter: DEFAULT_BUSY_ENTER_BEHAVIOR, showTrajectoryWithoutDeveloperTools: false,
    })
    await configuration.update({ busyEnter: 'steer' })
    expect(plainConfig(configuration.fiber.config)).toEqual({ busyEnter: 'steer', showTrajectoryWithoutDeveloperTools: false })
    await expect(configuration.update({ busyEnter: 'invalid' })).rejects.toThrow()
    await fiber.dispose()
  })

  it.each([true, false])('injects the trajectory preference into the served page and retracts it (%s)', async (enabled) => {
    const ctx = new Context()
    const fiber = ctx.plugin({ Config, apply }, { showTrajectoryWithoutDeveloperTools: enabled })
    await fiber.await()
    const rows: unknown[] = []
    ctx.emit('webserver/index-inject', rows as never)
    expect(rows).toEqual([{
      kind: 'global', name: '__DSH_CONVERSATION__',
      value: { showTrajectoryWithoutDeveloperTools: enabled },
    }])
    await fiber.dispose()
    const after: unknown[] = []
    ctx.emit('webserver/index-inject', after as never)
    expect(after).toEqual([])
  })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
