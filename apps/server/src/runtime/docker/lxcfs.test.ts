import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectLxcfsProc } from './lxcfs.js'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'dsh-lxcfs-test-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('detectLxcfsProc', () => {
  it('proc/meminfo 在 → 返回那个目录（驱动照它拼挂载源）', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'proc'))
    await writeFile(join(root, 'proc', 'meminfo'), 'MemTotal:       2097152 kB\n')

    expect(await detectLxcfsProc(root)).toBe(join(root, 'proc'))
  })

  it('proc/ 在但 meminfo 不在 → null：宿主没装 lxcfs，别把空目录当成装了', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'proc'))

    expect(await detectLxcfsProc(root)).toBeNull()
  })

  it('路径整个不在 → null，不抛（缺席是常态）', async () => {
    expect(await detectLxcfsProc(join(await tempDir(), 'not-mounted'))).toBeNull()
  })
})
