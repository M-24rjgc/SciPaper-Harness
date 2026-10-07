/** MCP resource ownership in the shipped Desktop composition. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, initProfile, loadProfileDirectory, readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { createPluginProfile } from '../src/project-manager.ts'

it('retains one shared resource consumer in the Desktop Web profile', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-mcp-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const installAnchor = fileURLToPath(new URL('../../cli/package.json', import.meta.url))
    const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
    const warnings: string[] = []
    const rows = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
    ], message => warnings.push(message))

    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-resources')).toEqual([
      { id: 'mcp-resources', name: '@deepseek-ai/dsh-mcp-resources' },
    ])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-client')).toEqual([])
    expect(rows.find(row => row.id === 'webserver')).toMatchObject({ name: '@deepseek-ai/dsh-host-webserver' })
    expect(rows.find(row => row.id === 'webserver')?.disabled).not.toBe(true)
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-computer-use-cua-driver-native')).toHaveLength(1)
    expect(warnings).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it('adds Desktop research defaults to an existing profile without dropping custom bundles', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-cua-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    initProfile(profileDir, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-research-app',
      '@deepseek-ai/dsh-web-search-exa-bundle',
    ])
    createPluginProfile(profileDir)
    const bundles = readProfileManifest('SciPaper desktop', profileDir).dsh?.profile?.bundles
    expect(bundles).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-research-app',
      '@deepseek-ai/dsh-computer-use-cua-bundle', '@deepseek-ai/dsh-experimental-schedule-bundle',
      '@deepseek-ai/dsh-research-knowledge-bundle', '@deepseek-ai/dsh-web-search-exa-bundle',
    ])
    createPluginProfile(profileDir)
    expect(readProfileManifest('SciPaper desktop', profileDir).dsh?.profile?.bundles).toEqual(bundles)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
