/** Host configuration injected into research pages. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { apply as applyHost, Config as HostConfig } from '../src/index.ts'

it.each([true, false])('has the host half put the validated setting into every served page, and take it back (webServer: %s)', async (hasWebServer) => {
  const host = new Context()
  if (hasWebServer) host.provide('webServer', {} as never)
  const served = async (config?: unknown): Promise<unknown[]> => {
    const fiber = config === undefined ? host.plugin({ apply: applyHost }) : host.plugin({ apply: applyHost, Config: HostConfig }, config)
    await fiber.await()
    const rows: unknown[] = []
    host.emit('webserver/index-inject', rows as never)
    await fiber.dispose()
    const after: unknown[] = []
    host.emit('webserver/index-inject', after as never)
    expect(after).toEqual([])
    return rows
  }
  const global = (hideDeveloperCells: boolean): unknown[] => [{ kind: 'global', name: '__DSH_RESEARCH__', value: { hideDeveloperCells } }]
  expect(await served({ hideDeveloperCells: true })).toEqual(global(true))
  expect(await served({})).toEqual(global(false))
  expect(await served()).toEqual(global(false))
  // A row whose YAML says something other than a boolean fails the load.
  expect(() => HostConfig({ hideDeveloperCells: 'yes' } as never)).toThrow()
})

