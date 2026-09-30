/** Real file-symlink capability probe for tests; directory tests use junctions on Windows. */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'vitest'

function probeFileSymlinks(): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-test-symlink-capability-'))
  try {
    const target = join(directory, 'target.txt')
    writeFileSync(target, 'capability probe')
    symlinkSync(target, join(directory, 'link.txt'), 'file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Whether this test process can create a real file symlink without changing system policy. */
export const fileSymlinksAvailable = probeFileSymlinks()

/** Skip only a file-symlink-specific test, retaining an explicit runner-visible reason. */
export function requireFileSymlinks(context: TestContext): void {
  if (!fileSymlinksAvailable) context.skip('Host denied file symlink creation (EPERM); directory junction and ordinary file cases still run.')
}
