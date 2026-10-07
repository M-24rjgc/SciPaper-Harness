import { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, type InvocationDescriptor, type TypertLookup } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it } from 'vitest'
import TypertGatewayService from '../src/index.ts'

interface FixtureValue {
  readonly id: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    cancellationFixture: TypertLookup<FixtureValue, string>
  }
}

class CounterService extends TypertRemoteService {
  readonly calls: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'cancellationFixture', { namespace: 'cancellationFixture' })
  }

  write(value: FixtureValue): string {
    this.calls.push(value.id)
    return value.id
  }

  watch(value: FixtureValue): Iterable<string> {
    this.calls.push(value.id)
    return [value.id]
  }
}

describe('Gateway business invocation cancellation', () => {
  it.each(['write', 'watch'] as const)('refuses %s side effects when cancellation arrives during lookup', async (method) => {
    const ctx = new Context()
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<FixtureValue>()
    try {
      await ctx.plugin(TypertRegistry)
      await ctx.plugin(TypertGatewayService)
      await ctx.plugin(CounterService)
      ctx.typert.lookups.register('cancellationFixture', {
        parameter: 'value', wire: 'valueId',
        hostTypeSymbol: '@fixture/cancellation#Value', wireTypeSymbol: '@fixture/cancellation#ValueId',
        resolve: async () => {
          started.resolve(undefined)
          return await release.promise
        },
      })
      const descriptor: InvocationDescriptor = {
        id: `@fixture/cancellation#cancellationFixture/${method}`,
        service: 'cancellationFixture', namespace: 'cancellationFixture', method,
        ...(method === 'watch' ? { mode: 'stream' } : {}),
        invocation: { kind: 'direct' },
        parameters: [{ name: 'value', wire: 'valueId', source: 'lookup',
          lookup: 'cancellationFixture', codec: { mode: 'src-json' } }],
        result: { mode: 'src-json' },
      }
      ctx.typert.register({ package: '@fixture/cancellation', face: 'host', schemas: [],
        model: { services: [], events: [], objects: [] }, invocations: [descriptor] })
      const abort = new AbortController()
      const request = { namespace: 'cancellationFixture', method, args: { valueId: 'value-1' }, signal: abort.signal }
      const pending = method === 'watch' ? ctx.typertGateway.stream(request) : ctx.typertGateway.invoke(request)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'gateway/cancelled' })
      await started.promise
      abort.abort(new Error('Peer authority revoked'))
      release.resolve({ id: 'value-1' })
      await rejected
      const service = ctx.get('cancellationFixture') as CounterService
      expect(service.calls).toEqual([])
    } finally {
      release.resolve({ id: 'value-1' })
      await ctx.fiber.dispose()
    }
  })
})
