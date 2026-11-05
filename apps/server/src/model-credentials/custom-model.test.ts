import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  decryptModelCredential,
  encryptModelCredential,
  modelCredentialAad,
} from './crypto.js'
import { renderCredentialsYaml } from './document.js'
import {
  CORDIS_PLUGIN_ID,
  CustomModelRejectedError,
  DEFAULT_API_KEY_ENV,
  PLACEHOLDER_MODEL_ID,
  normalizeCustomModelWrite,
  projectCustomModel,
  renderCordisPatch,
} from './custom-model.js'
import { ModelCredentialRejectedError } from './rules.js'

const SECRET = 'platform-secret-for-custom-model-test'
const USER = 'user-a'
const PLAIN = 'fixture-model-key-alpha-9f3c'
const OTHER = 'fixture-model-key-beta-9f3c'
const FIXTURE_URL = 'https://example.test/v1'

const seed = {
  providerId: 'cliproxy',
  displayName: 'CLIProxyAPI',
  baseUrl: FIXTURE_URL,
  api: 'openai-completions',
  apiKeyEnv: DEFAULT_API_KEY_ENV,
  modelIds: [] as string[],
}

describe('Custom 模型文档', () => {
  it('凭据 YAML 把 CLIPROXY 和其它 ref 一起列出来，URL 不进 refs', () => {
    const text = renderCredentialsYaml({
      DEEPSEEK_API_KEY: OTHER,
      CLIPROXY_API_KEY: PLAIN,
    })
    expect(parse(text)).toEqual({
      version: 1,
      refs: { CLIPROXY_API_KEY: PLAIN, DEEPSEEK_API_KEY: OTHER },
      records: {},
    })
    expect(text).not.toContain(FIXTURE_URL)
    expect(text).not.toContain('DEEPSEEK_BASE_URL')
  })

  it('空 modelIds 写成占位，非空则按给定列表', () => {
    const empty = renderCordisPatch(seed)
    expect(parse(empty)).toEqual([
      {
        id: CORDIS_PLUGIN_ID,
        config: {
          providers: {
            cliproxy: {
              displayName: 'CLIProxyAPI',
              apiKeyEnv: 'CLIPROXY_API_KEY',
              api: 'openai-completions',
              baseURL: FIXTURE_URL,
              models: [{ id: PLACEHOLDER_MODEL_ID }],
            },
          },
        },
      },
    ])
    expect(empty).not.toContain('DEEPSEEK_BASE_URL')
    expect(empty).not.toContain(PLAIN)

    const listed = renderCordisPatch({ ...seed, displayName: null, modelIds: ['model-a', 'model-b'] })
    const parsed = parse(listed) as Array<{ config: { providers: { cliproxy: { displayName: string; models: Array<{ id: string }> } } } }>
    expect(parsed[0]?.config.providers.cliproxy.displayName).toBe('CLIProxyAPI')
    expect(parsed[0]?.config.providers.cliproxy.models).toEqual([{ id: 'model-a' }, { id: 'model-b' }])
  })

  it('非法 baseUrl 和空 Key 都拒绝，错误里不带原文', () => {
    for (const baseUrl of ['', '   ', 'not a url', 'ftp://example.test/v1', 'https://user:secret@example.test/v1', 'javascript:alert(1)']) {
      let caught: unknown
      try {
        normalizeCustomModelWrite({ baseUrl, apiKey: PLAIN }, null)
      } catch (err) {
        caught = err
      }
      expect(caught, baseUrl).toBeInstanceOf(CustomModelRejectedError)
      expect(caught instanceof Error ? caught.message : '').not.toContain('secret')
      expect(caught instanceof Error ? caught.message : '').not.toContain(PLAIN)
    }
    expect(() => normalizeCustomModelWrite({ baseUrl: FIXTURE_URL, apiKey: '' }, null)).toThrow(CustomModelRejectedError)
    expect(() => normalizeCustomModelWrite({ baseUrl: FIXTURE_URL, apiKey: 'has space' }, null)).toThrow(ModelCredentialRejectedError)
    expect(() => normalizeCustomModelWrite({ baseUrl: FIXTURE_URL, api: 'anthropic-messages' }, null)).toThrow(CustomModelRejectedError)
    expect(() => normalizeCustomModelWrite({ baseUrl: FIXTURE_URL, apiKeyEnv: 'DSH_LAUNCH_TOKEN' }, null)).toThrow(ModelCredentialRejectedError)
    const kept = normalizeCustomModelWrite({ baseUrl: FIXTURE_URL }, {
      providerId: 'cliproxy',
      displayName: 'Kept',
      apiKeyEnv: 'CLIPROXY_API_KEY',
      modelIds: ['kept-model'],
    })
    expect(kept.apiKey).toBeUndefined()
    expect(kept.modelIds).toEqual(['kept-model'])
    expect(kept.displayName).toBe('Kept')
  })
})

describe('Custom 模型加密与公开投影', () => {
  it('CLIPROXY Key 往返成功，GET 投影没有明文', () => {
    const aad = modelCredentialAad(USER, DEFAULT_API_KEY_ENV)
    const stored = encryptModelCredential(PLAIN, SECRET, aad)
    expect(stored.ciphertext).not.toContain(PLAIN)
    expect(decryptModelCredential(stored.ciphertext, SECRET, aad, stored.keyVersion)).toBe(PLAIN)

    const projected = projectCustomModel({
      ...seed,
      modelIds: [],
      updatedAt: new Date('2026-11-05T00:00:00.000Z'),
    }, [DEFAULT_API_KEY_ENV])
    const wire = {
      customModelConfigured: projected.customModelConfigured,
      customModel: {
        ...projected.customModel,
        updatedAt: projected.customModel?.updatedAt?.toISOString() ?? null,
      },
    }
    expect(wire.customModelConfigured).toBe(true)
    expect(wire.customModel?.baseUrl).toBe(FIXTURE_URL)
    expect(wire.customModel?.keyConfigured).toBe(true)
    expect(JSON.stringify(wire)).not.toContain(PLAIN)
    expect(JSON.stringify(wire)).not.toContain(stored.ciphertext)
    expect(JSON.stringify(projectCustomModel(undefined, [DEFAULT_API_KEY_ENV]))).not.toContain(PLAIN)

    const partial = projectCustomModel({
      ...seed,
      modelIds: [],
      updatedAt: new Date(0),
    }, ['DEEPSEEK_API_KEY'])
    expect(partial.customModelConfigured).toBe(false)
    expect(partial.customModel?.keyConfigured).toBe(false)
  })
})

describe('自定义模型表', () => {
  it('删用户级联删配置行，管理员删除只置空审计列', async () => {
    const sql = await readFile(new URL('../../drizzle/0016_user_model_provider.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE "user_model_provider"')
    expect(sql).toContain('FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade')
    expect(sql).toContain('FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."user"("id") ON DELETE set null')
    expect(sql).not.toContain(PLAIN)
    expect(sql).not.toContain('example.test')
  })
})

describe('硬禁：不改 token / host 通道，也不用 DEEPSEEK_BASE_URL 冒充', () => {
  it('入口、门禁和 owns-host 不出现这条 Custom 通道', async () => {
    const root = new URL('../../../../', import.meta.url)
    const files = [
      'docker/instance-image/entrypoint.sh',
      'docker/instance-image/owns-host.yml',
      'docker/instance-image/owns-host.mjs',
      'apps/server/src/instance/gate-token.ts',
      'apps/server/src/instance/provisioner.ts',
    ]
    for (const file of files) {
      const text = await readFile(new URL(file, root), 'utf8')
      expect(text, file).not.toContain('DEEPSEEK_BASE_URL')
      expect(text, file).not.toContain('CLIPROXY_API_KEY')
    }
    const provisioner = await readFile(new URL('apps/server/src/instance/provisioner.ts', root), 'utf8')
    expect(provisioner).toContain('seedCordisPatchIfAbsent')
    expect(provisioner).toContain('createData === true')
  })
})
