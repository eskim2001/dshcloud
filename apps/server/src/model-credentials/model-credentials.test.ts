import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gateToken } from '../instance/gate-token.js'
import {
  decryptModelCredential,
  decryptStoredRefs,
  encryptModelCredential,
  modelCredentialAad,
} from './crypto.js'
import { renderCredentialsYaml } from './document.js'
import { applyCredentialPatch } from './patch.js'
import { ModelCredentialRejectedError } from './rules.js'
import { projectModelCredentials } from './view.js'
import { parse } from 'yaml'

const SECRET = 'platform-secret-for-model-credentials-test'
const USER = 'user-a'
const REF = 'DEEPSEEK_API_KEY'
const PLAIN = 'fixture-model-key-alpha-9f3c'
const OTHER = 'fixture-model-key-beta-9f3c'

describe('模型凭据 YAML', () => {
  it('写成 version 1 的 refs，records 留空', () => {
    const text = renderCredentialsYaml({
      OPENAI_API_KEY: OTHER,
      DEEPSEEK_API_KEY: PLAIN,
    })
    expect(text).toBe(
      `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${PLAIN}\n  OPENAI_API_KEY: ${OTHER}\nrecords: {}\n`,
    )
    expect(parse(text)).toEqual({
      version: 1,
      refs: { DEEPSEEK_API_KEY: PLAIN, OPENAI_API_KEY: OTHER },
      records: {},
    })
  })

  it('空 key、空白和危险字符都拒绝，错误里不带原文', () => {
    for (const value of ['', '   ', 'has space', 'line\nbreak', 'hash#frag', PLAIN + '\n']) {
      let caught: unknown
      try {
        renderCredentialsYaml({ [REF]: value })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ModelCredentialRejectedError)
      expect(caught instanceof Error ? caught.message : '').not.toContain(PLAIN)
      expect(caught instanceof Error ? caught.message : '').not.toContain('hash#')
    }
    expect(() => renderCredentialsYaml({})).toThrow(/没有可写入/)
    expect(() => renderCredentialsYaml({ DSH_LAUNCH_TOKEN: PLAIN })).toThrow(ModelCredentialRejectedError)
  })
})

describe('模型凭据加密', () => {
  it('往返成功，序列化结果里没有明文，也不是 gate token', () => {
    const aad = modelCredentialAad(USER, REF)
    const first = encryptModelCredential(PLAIN, SECRET, aad)
    const second = encryptModelCredential(PLAIN, SECRET, aad)
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.keyVersion).toBe(1)
    expect(first.ciphertext.startsWith('v1.')).toBe(true)
    expect(first.ciphertext).not.toContain(PLAIN)
    expect(JSON.stringify(first)).not.toContain(PLAIN)
    expect(first.ciphertext).not.toBe(gateToken(USER, SECRET))
    expect(decryptModelCredential(first.ciphertext, SECRET, aad, first.keyVersion)).toBe(PLAIN)

    const stored = [{ providerRef: REF, ciphertext: first.ciphertext, keyVersion: first.keyVersion }]
    expect(decryptStoredRefs(stored, SECRET, USER)).toEqual({ [REF]: PLAIN })
    expect(() => decryptStoredRefs(stored, SECRET, 'user-b')).toThrow('无法解密')
    expect(() => decryptModelCredential(first.ciphertext, SECRET, modelCredentialAad(USER, 'OPENAI_API_KEY'), 1)).toThrow('无法解密')
    expect(() => decryptModelCredential(first.ciphertext, 'another-platform-secret-value-xxxx', aad, 1)).toThrow('无法解密')
  })

  it('公开投影和省略语义都不带明文', () => {
    const now = new Date('2026-11-05T00:00:00.000Z')
    const older = new Date('2026-11-04T00:00:00.000Z')
    const kept = encryptModelCredential(OTHER, SECRET, modelCredentialAad(USER, 'OPENAI_API_KEY'))
    const existing = [{
      providerRef: 'OPENAI_API_KEY',
      ciphertext: kept.ciphertext,
      keyVersion: kept.keyVersion,
      updatedAt: older,
      updatedByAdminId: 'admin-old',
    }]
    const next = applyCredentialPatch(existing, { [REF]: PLAIN }, {
      userId: USER,
      adminId: 'admin-1',
      secret: SECRET,
      now,
    })
    const openai = next.find((row) => row.providerRef === 'OPENAI_API_KEY')
    const deepseek = next.find((row) => row.providerRef === REF)
    expect(openai?.ciphertext).toBe(kept.ciphertext)
    expect(openai?.updatedAt).toBe(older)
    expect(deepseek?.ciphertext).not.toContain(PLAIN)
    expect(deepseek?.updatedByAdminId).toBe('admin-1')
    expect(decryptStoredRefs(next, SECRET, USER)).toEqual({
      OPENAI_API_KEY: OTHER,
      [REF]: PLAIN,
    })

    const projected = projectModelCredentials(next)
    const wire = {
      configured: projected.configured,
      providerRefs: projected.providerRefs,
      updatedAt: projected.updatedAt?.toISOString() ?? null,
    }
    expect(wire).toEqual({
      configured: true,
      providerRefs: ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'],
      updatedAt: now.toISOString(),
    })
    expect(JSON.stringify(wire)).not.toContain(PLAIN)
    expect(JSON.stringify(wire)).not.toContain(OTHER)
    expect(JSON.stringify(projected)).not.toContain(PLAIN)

    const cleared = applyCredentialPatch(next, { [REF]: null }, {
      userId: USER,
      adminId: 'admin-1',
      secret: SECRET,
      now,
    })
    expect(cleared.map((row) => row.providerRef)).toEqual(['OPENAI_API_KEY'])
    expect(JSON.stringify(projectModelCredentials(cleared))).not.toContain(PLAIN)
  })
})

describe('用户默认凭据表', () => {
  it('删用户级联删密文，管理员删除只置空审计列', async () => {
    const sql = await readFile(new URL('../../drizzle/0015_user_model_credential.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE "user_model_credential"')
    expect(sql).toContain('FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade')
    expect(sql).toContain('FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."user"("id") ON DELETE set null')
    expect(sql).not.toContain(PLAIN)
  })
})

describe('凭据归档', () => {
  it('0600 的单文件 tar 能被系统 tar 解出，且拒绝路径', async () => {
    const { singleFileTar } = await import('../runtime/docker/single-file-tar.js')
    const body = Buffer.from(`version: 1\nrefs:\n  ${REF}: ${PLAIN}\nrecords: {}\n`, 'utf8')
    const archive = singleFileTar('.credentials.yaml', body, 0o600, 1000, 1000)
    const dir = await mkdtemp(join(tmpdir(), 'dsh-cred-tar-'))
    try {
      const file = join(dir, 'one.tar')
      await writeFile(file, archive)
      const listing = execFileSync('tar', ['-tvf', file], { encoding: 'utf8' })
      expect(listing).toContain('.credentials.yaml')
      expect(listing).toMatch(/-rw-------/)
      expect(execFileSync('tar', ['-xOf', file], { encoding: 'utf8' })).toBe(body.toString('utf8'))
      const mode = await readFile(file)
      expect(mode.includes(body)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    expect(() => singleFileTar('../.credentials.yaml', body, 0o600, 1000, 1000)).toThrow(/文件名/)
  })
})
