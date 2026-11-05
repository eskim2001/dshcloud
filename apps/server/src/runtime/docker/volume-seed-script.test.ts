import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { VOLUME_SEED_PREPARE_SCRIPT } from './volume-seed-script.js'

const exec = promisify(execFile)

async function prepare(root: string, relativePath: string): Promise<number> {
  try {
    await exec('sh', ['-c', VOLUME_SEED_PREPARE_SCRIPT, 'sh', root, relativePath])
    return 0
  } catch (error) {
    const status = (error as { code?: unknown }).code
    return typeof status === 'number' ? status : 1
  }
}

describe('命名卷种子脚本', () => {
  it('为嵌套 patch 建父目录，目标已在则退出 3 且不改内容', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-seed-'))
    try {
      expect(await prepare(root, 'profiles/web/cordis.patch.yml')).toBe(0)
      const file = join(root, 'profiles/web/cordis.patch.yml')
      await writeFile(file, 'keep-me')
      expect(await prepare(root, 'profiles/web/cordis.patch.yml')).toBe(3)
      expect(await readFile(file, 'utf8')).toBe('keep-me')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('拒绝白名单外的路径，也拒绝符号链接父目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-seed-'))
    try {
      expect(await prepare(root, '../.credentials.yaml')).toBe(2)
      expect(await prepare(root, 'profiles/other/cordis.patch.yml')).toBe(2)
      await exec('mkdir', ['-p', join(root, 'profiles')])
      await symlink('/tmp', join(root, 'profiles/web'))
      expect(await prepare(root, 'profiles/web/cordis.patch.yml')).toBe(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
