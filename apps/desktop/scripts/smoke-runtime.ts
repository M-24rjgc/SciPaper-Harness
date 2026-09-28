/** Boot the materialized target runtime without access to a user's Harness profile. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { readPrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

/**
 * Check Host startup, shipped research examples, external plugins and real Office-to-PDF conversion.
 * @param root - Materialized dsh resources.
 * @param node - Prepared target Electron executable.
 * @param runtime - Verified resource descriptor.
 * @param environment - Credential-scrubbed build environment and private native cache.
 * @param resourcesRuntime - Bundled interpreters outside the application archive.
 * @returns Resolves after checks and teardown; rejects on a check or teardown failure.
 */
export async function smokeDesktopRuntime(
  root: string, node: string, runtime: DesktopRuntimeDescriptor, environment: NodeJS.ProcessEnv, resourcesRuntime: string,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-'))
  const profile = join(home, 'profiles', 'desktop')
  const host = new DesktopHostProcess(node, root, profile, undefined, { ...environment, DSH_HOME: home },
    undefined, join(resourcesRuntime, 'primary-runtime'),
    { pnpm: join(resourcesRuntime, 'pnpm', 'bin', 'pnpm.cjs'), nodeBin: join(resourcesRuntime, 'bin') })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    createPluginProfile(profile)
    const pluginName = 'desktop-runtime-smoke-plugin'
    const plugin = join(profile, 'node_modules', pluginName)
    mkdirSync(plugin, { recursive: true })
    const primary = join(resourcesRuntime, 'primary-runtime')
    const dependencies = workspaceDependencyPaths(primary, await readPrimaryRuntime(primary))
    await promisify(execFile)(dependencies.python, ['-I', '-B',
      fileURLToPath(new URL('../tests/fixtures/office-conversion-inputs.py', import.meta.url)), home],
    { env: environment, timeout: 120_000, windowsHide: true })
    const inputs = ['docx', 'xlsx', 'pptx'].map(extension => ({ extension,
      bytes: readFileSync(join(home, `input.${extension}`)).toString('base64') }))
    const cordis = runtime.sharedPackages.find(entry => entry.name === '@deepseek-ai/cordis')
    if (cordis === undefined) throw new Error('desktop runtime: missing shared Cordis package')
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({
      name: pluginName, version: '1.0.0', type: 'module', exports: './index.js',
      peerDependencies: { '@deepseek-ai/cordis': cordis.version, '@deepseek-ai/dsh-subprocess': '0.1.7-rc.2' },
      dsh: { bundle: { patch: './bundle.yml' } },
    }))
    writeFileSync(join(plugin, 'index.js'), `
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { inspect, promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
export function apply(ctx) {
  if (!(ctx instanceof Context)) throw new Error('desktop runtime: external plugin loaded another Cordis instance')
  if (!(ctx.subprocess instanceof SubprocessRuntime)) throw new Error('desktop runtime: external DSH service identity differs')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke',
    handler(_request, response) { response.end('plugin route ready') } }))
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-office-cli',
    async handler(_request, response) {
      try {
        const skill = await ctx.skills.get('office-docx')
        const json = skill?.content.match(/\\n(\\{\\n[\\s\\S]+)$/u)?.[1]
        if (json === undefined) throw new Error('Office skill did not supply CLI paths')
        const { libreofficeKit: { node, cli } } = JSON.parse(json)
        const options = { cwd: ${JSON.stringify(home)}, env: { ...process.env, PATH: '' }, timeout: 120_000 }
        const capabilities = await promisify(execFile)(node, [cli, 'capabilities'], options)
        const output = ${JSON.stringify(join(home, 'cli.pdf'))}
        await promisify(execFile)(node, [cli, 'convert', '--input', ${JSON.stringify(join(home, 'input.docx'))}, '--output', output], options)
        response.end(JSON.stringify({ capabilities: JSON.parse(capabilities.stdout), pdf: (await readFile(output)).toString('base64') }))
      } catch (error) {
        response.statusCode = 500
        response.end(inspect(error, { depth: 5 }))
      }
    } }))
  for (const input of ${JSON.stringify(inputs)}) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/desktop-smoke-office/' + input.extension,
      async handler(_request, response) {
        try {
          const bytes = Buffer.from(input.bytes, 'base64')
          const result = await ctx.officeToPdf.convert({ extension: input.extension, priority: 'foreground',
            source: { key: 'desktop-smoke-' + input.extension, version: 'fixture', bytes: bytes.length,
              async read() { return { bytes, version: 'fixture' } } } })
          response.end(Buffer.from(result.pdf))
        } catch (error) {
          response.statusCode = 500
          response.end(inspect(error, { depth: 5 }))
        }
      } }))
  }
}
`)
    writeFileSync(join(plugin, 'bundle.yml'), '- insert:\n    - id: desktop-runtime-smoke-plugin\n      name: desktop-runtime-smoke-plugin\n      inject: [webServer, officeToPdf, skills, subprocess]\n')
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    manifest.dependencies[pluginName] = '1.0.0'
    manifest.dsh.profile.bundles.push(pluginName)
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(profile, 'cordis.patch.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
    const ready = await Promise.race([host.start(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('desktop runtime: Host readiness exceeded 120 seconds')) }, 120_000)
    })])
    clearTimeout(timer)
    const login = await fetch(ready.url, { redirect: 'manual' })
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const response = await fetch(new URL('/', ready.url), { headers: { cookie } })
    if (response.status !== 200 || !(await response.text()).includes('<html')) {
      throw new Error('desktop runtime: packaged frontend smoke failed')
    }
    const researchUrl = new URL('/api/research/snapshot', ready.url)
    const rpc = { type: 'client-request', rpcId: 'research-desktop-smoke', method: 'research/snapshot', payload: { args: {} } }
    const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rpc) }
    const denied = await fetch(researchUrl, request)
    await denied.body?.cancel()
    if (denied.status !== 401) throw new Error('desktop runtime: unauthenticated research RPC was not rejected')
    const research = await fetch(researchUrl, { ...request, headers: { ...request.headers, cookie } })
    const snapshot = await research.json() as {
      type?: string
      rpcId?: string
      result?: {
        ok?: boolean
        value?: {
          projects?: {
            id: string
            title: string
            workspaceId: string
            sessionId?: string
            example?: boolean
            artifacts: { id: string; path: string }[]
          }[]
          modes?: { id: string }[]
        }
      }
    }
    if (!research.ok || snapshot.type !== 'server-response' || snapshot.rpcId !== rpc.rpcId
      || snapshot.result?.ok !== true || !Array.isArray(snapshot.result.value?.projects)
      || !['general', 'spark-to-paper', 'ccfa'].every(id => snapshot.result?.value?.modes?.some(mode => mode.id === id))) {
      throw new Error('desktop runtime: research plugin snapshot or installed research modes are unavailable')
    }
    const examples = snapshot.result.value?.projects?.filter(project => project.example === true) ?? []
    const expectedExamples = ['example-v1-ccfa-sparse-attention', 'example-v1-spark-summary-consistency']
    if (examples.length !== expectedExamples.length
      || !expectedExamples.every(id => examples.some(project => project.id === id && project.sessionId !== undefined))) {
      throw new Error('desktop runtime: a fresh home did not receive the shipped research examples and conversations')
    }
    for (const project of examples) {
      const artifact = project.artifacts.find(entry => entry.path === 'paper/paper.md')
      if (artifact === undefined) throw new Error('desktop runtime: shipped example manuscript is not registered')
      const commandUrl = new URL('/api/research/command', ready.url)
      const commandHeaders = { 'content-type': 'application/json', cookie }
      const read = await fetch(commandUrl, {
        method: 'POST', headers: commandHeaders,
        body: JSON.stringify({ type: 'client-request', rpcId: `example-read-${project.id}`,
          method: 'research/command', payload: { args: { request: {
            action: 'read-artifact', projectId: project.id, artifactId: artifact.id,
          } } } }),
      })
      const readResult = await read.json() as { result?: { ok?: boolean; value?: { content?: string } } }
      if (!read.ok || readResult.result?.ok !== true || (readResult.result.value?.content?.length ?? 0) < 100) {
        throw new Error('desktop runtime: shipped example manuscript cannot be read through the research API')
      }
      const update = await fetch(commandUrl, {
        method: 'POST', headers: commandHeaders,
        body: JSON.stringify({ type: 'client-request', rpcId: `example-write-${project.id}`,
          method: 'research/command', payload: { args: { request: {
            action: 'rename', projectId: project.id, title: 'modified example',
          } } } }),
      })
      const updateResult = await update.json() as { result?: { ok?: boolean } }
      if (updateResult.result?.ok !== false || !/example research|示例研究/u.test(JSON.stringify(updateResult))) {
        throw new Error('desktop runtime: shipped example accepted a write or failed for an unrelated reason')
      }
      const sessionWrites = [
        { method: 'fork', request: { sessionId: project.sessionId } },
        { method: 'rename', request: { sessionId: project.sessionId, title: 'modified example conversation' } },
        { method: 'create', request: { workspaceId: project.workspaceId, agentPreset: 'research' } },
        { method: 'prompt', request: { sessionId: project.sessionId, requestId: `readonly-${project.id}`,
          mode: 'queue', content: [{ type: 'text', text: 'Change this authored example.' }] } },
      ]
      for (const write of sessionWrites) {
        const deniedWrite = await fetch(new URL(`/api/session/${write.method}`, ready.url), {
          method: 'POST', headers: commandHeaders,
          body: JSON.stringify({ type: 'client-request', rpcId: `example-${write.method}-${project.id}`,
            method: `session/${write.method}`, payload: { args: { request: write.request } } }),
        })
        const deniedResult = await deniedWrite.json() as { result?: { ok?: boolean; error?: { code?: string } } }
        if (deniedResult.result?.ok !== false || deniedResult.result.error?.code !== 'session/read-only') {
          throw new Error(`desktop runtime: shipped example ${write.method} was not rejected as read-only`)
        }
      }
    }
    const again = await fetch(researchUrl, { ...request, headers: { ...request.headers, cookie } })
    const repeated = await again.json() as typeof snapshot
    const repeatedExamples = repeated.result?.value?.projects?.filter(project => project.example === true) ?? []
    if (!again.ok || repeated.result?.ok !== true || repeatedExamples.length !== examples.length
      || !examples.every(project => repeatedExamples.some(entry => entry.id === project.id
        && entry.title === project.title && entry.sessionId === project.sessionId))) {
      throw new Error('desktop runtime: repeated research reads changed or duplicated shipped examples')
    }
    console.log('desktop runtime: shipped research examples, manuscript reads and read-only enforcement passed')
    const pluginResponse = await fetch(new URL('/desktop-smoke', ready.url), { headers: { cookie } })
    if (await pluginResponse.text() !== 'plugin route ready') throw new Error('desktop runtime: plugin HTTP route failed')
    for (const { extension } of inputs) {
      const converted = await fetch(new URL(`/desktop-smoke-office/${extension}`, ready.url), {
        headers: { cookie }, signal: AbortSignal.timeout(120_000),
      })
      if (!converted.ok) throw new Error(`desktop runtime: ${extension} conversion failed: ${await converted.text()}`)
      const pdf = Buffer.from(await converted.arrayBuffer())
      if (!/^%PDF-\d\.\d/u.test(pdf.subarray(0, 8).toString())
        || !pdf.subarray(-1024).toString().trimEnd().endsWith('%%EOF')) {
        throw new Error(`desktop runtime: invalid ${extension} PDF output`)
      }
    }
    const cliResponse = await fetch(new URL('/desktop-smoke-office-cli', ready.url), {
      headers: { cookie }, signal: AbortSignal.timeout(120_000),
    })
    if (!cliResponse.ok) throw new Error(`desktop runtime: skill CLI failed: ${await cliResponse.text()}`)
    const cliResult = await cliResponse.json() as { capabilities: { runtime: { cliPath: string } }; pdf: string }
    if (!cliResult.capabilities.runtime.cliPath.endsWith('cli.js') || Buffer.from(cliResult.pdf, 'base64').subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('desktop runtime: skill CLI did not return capabilities and a PDF')
    }
    console.log('desktop runtime: DOCX, XLSX, PPTX to PDF and skill CLI discovery passed')
  } finally {
    clearTimeout(timer)
    await host.stop()
    rmSync(home, { recursive: true })
  }
}
