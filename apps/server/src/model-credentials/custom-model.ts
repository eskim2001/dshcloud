import { stringify } from 'yaml'
import { assertCredentialRef, assertModelKey } from './rules.js'

/** 不写进代码的全站地址；管理员在页面上按用户填写。 */
export const DEFAULT_PROVIDER_ID = 'cliproxy'
export const DEFAULT_DISPLAY_NAME = 'CLIProxyAPI'
export const DEFAULT_API = 'openai-completions'
export const DEFAULT_API_KEY_ENV = 'CLIPROXY_API_KEY'
/**
 * 与官方 Custom model API 写入的插件 id 一致。
 * 若现网镜像要求 `name: '@deepseek-ai/dsh-llm-pi-ai'`，这是需要改的唯一钉点。
 */
export const CORDIS_PLUGIN_ID = 'llm-pi-ai'
export const CORDIS_PATCH_RELATIVE_PATH = 'profiles/web/cordis.patch.yml'
/** 与卷内其它配置同级：属主可读写，同组可读。属主交给随后的 chown。 */
export const CORDIS_PATCH_MODE = 0o640
/** 上游拒绝空 models。这个 id 只是占位，用户在工作区里 Fetch available models 后替换。 */
export const PLACEHOLDER_MODEL_ID = '__dshcloud_fetch_models__'

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:@+/-]{1,128}$/

export class CustomModelRejectedError extends Error {
  constructor() {
    super('自定义模型配置不合法')
    this.name = 'CustomModelRejectedError'
  }
}

export function assertBaseUrl(value: string): void {
  if (value.length === 0 || value.length > 2048 || /\s/.test(value)) {
    throw new CustomModelRejectedError()
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new CustomModelRejectedError()
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.host === ''
  ) {
    throw new CustomModelRejectedError()
  }
}

export function assertProviderId(value: string): void {
  if (!PROVIDER_ID_PATTERN.test(value)) throw new CustomModelRejectedError()
}

export function assertDisplayName(value: string): void {
  if (value.length === 0 || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CustomModelRejectedError()
  }
}

export function assertModelId(value: string): void {
  if (!MODEL_ID_PATTERN.test(value)) throw new CustomModelRejectedError()
}

export function assertCustomApi(value: string): void {
  if (value !== DEFAULT_API) throw new CustomModelRejectedError()
}

export interface CustomModelSeed {
  providerId: string
  displayName: string | null
  baseUrl: string
  api: string
  apiKeyEnv: string
  modelIds: string[]
}

/** base URL 与对应 ref 的密文都在，才允许写 cordis patch。缺一则不写 patch。 */
export function isCustomModelInjectable(
  model: CustomModelSeed | null,
  refs: Readonly<Record<string, string>>,
): boolean {
  if (model === null || model.baseUrl.trim() === '') return false
  return Object.prototype.hasOwnProperty.call(refs, model.apiKeyEnv)
}

export interface CustomModelWrite {
  baseUrl: string
  providerId: string
  displayName: string | null
  api: string
  apiKeyEnv: string
  modelIds: string[]
  /** undefined = 不改 Key；null = 清掉 apiKeyEnv 对应密文；字符串 = 换成新 Key。 */
  apiKey: string | null | undefined
}

/**
 * 省略的字段沿用已有行；第一次写入才落到默认值。
 * 空 Key 串在这里拒绝，调用方不要把它当成清除（清除是 JSON null）。
 */
export function normalizeCustomModelWrite(
  input: {
    baseUrl: string
    apiKey?: string | null | undefined
    providerId?: string | undefined
    displayName?: string | null | undefined
    api?: string | undefined
    apiKeyEnv?: string | undefined
    modelIds?: string[] | undefined
  },
  existing: Pick<CustomModelSeed, 'providerId' | 'displayName' | 'apiKeyEnv' | 'modelIds'> | null,
): CustomModelWrite {
  assertBaseUrl(input.baseUrl)
  const providerId = input.providerId ?? existing?.providerId ?? DEFAULT_PROVIDER_ID
  assertProviderId(providerId)
  const api = input.api ?? DEFAULT_API
  assertCustomApi(api)
  const apiKeyEnv = input.apiKeyEnv ?? existing?.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  assertCredentialRef(apiKeyEnv)
  let displayName: string | null
  if (input.displayName === undefined) displayName = existing?.displayName ?? null
  else if (input.displayName === null) displayName = null
  else {
    assertDisplayName(input.displayName)
    displayName = input.displayName
  }
  const modelIds = input.modelIds ?? existing?.modelIds ?? []
  if (modelIds.length > 32) throw new CustomModelRejectedError()
  for (const id of modelIds) assertModelId(id)
  if (input.apiKey === '') throw new CustomModelRejectedError()
  if (typeof input.apiKey === 'string') assertModelKey(input.apiKey)
  return {
    baseUrl: input.baseUrl,
    providerId,
    displayName,
    api,
    apiKeyEnv,
    modelIds,
    apiKey: input.apiKey,
  }
}

/**
 * 空卷上的第一份 cordis patch：只含这一条 Custom provider。
 * 已有文件不在这里合并——调用方必须 if-absent。
 */
export function renderCordisPatch(model: CustomModelSeed): string {
  assertProviderId(model.providerId)
  assertCustomApi(model.api)
  assertCredentialRef(model.apiKeyEnv)
  assertBaseUrl(model.baseUrl)
  const displayName = model.displayName === null || model.displayName.trim() === ''
    ? DEFAULT_DISPLAY_NAME
    : model.displayName
  assertDisplayName(displayName)
  const ids = model.modelIds.length === 0 ? [PLACEHOLDER_MODEL_ID] : [...model.modelIds]
  for (const id of ids) assertModelId(id)
  const text = stringify([
    {
      id: CORDIS_PLUGIN_ID,
      config: {
        providers: {
          [model.providerId]: {
            displayName,
            apiKeyEnv: model.apiKeyEnv,
            api: model.api,
            baseURL: model.baseUrl,
            models: ids.map((id) => ({ id })),
          },
        },
      },
    },
  ])
  if (!text.includes(`id: ${CORDIS_PLUGIN_ID}`) || text.includes('DEEPSEEK_BASE_URL')) {
    throw new Error('自定义模型补丁渲染失败')
  }
  return text.endsWith('\n') ? text : `${text}\n`
}

/** 管理台看得到的全部。没有明文 Key，也没有密文。 */
export interface CustomModelPublic {
  providerId: string
  displayName: string | null
  baseUrl: string
  api: string
  apiKeyEnv: string
  modelIds: string[]
  keyConfigured: boolean
  updatedAt: Date | null
}

export function projectCustomModel(
  row: {
    providerId: string
    displayName: string | null
    baseUrl: string
    api: string
    apiKeyEnv: string
    modelIds: unknown
    updatedAt: Date
  } | undefined,
  providerRefs: readonly string[],
): { customModelConfigured: boolean; customModel: CustomModelPublic | null } {
  if (row === undefined) return { customModelConfigured: false, customModel: null }
  const modelIds = Array.isArray(row.modelIds)
    ? row.modelIds.filter((item): item is string => typeof item === 'string')
    : []
  const keyConfigured = providerRefs.includes(row.apiKeyEnv)
  const customModel: CustomModelPublic = {
    providerId: row.providerId,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    api: row.api,
    apiKeyEnv: row.apiKeyEnv,
    modelIds,
    keyConfigured,
    updatedAt: row.updatedAt,
  }
  return {
    customModel,
    customModelConfigured: row.baseUrl.trim() !== '' && keyConfigured,
  }
}
