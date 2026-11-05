/**
 * 用户模型 API-Key 的形状。
 *
 * 收紧字符集是为了 YAML 可以写成普通标量：冒号、井号、换行进了值，
 * 渲染要么歧义、要么得靠引用规则，而空串又和「没配」分不清。
 * 空串在这里直接拒绝，调用方不要把它当成清除（清除是 JSON null）。
 */
export const CREDENTIAL_REF_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
export const MODEL_KEY_PATTERN = /^[A-Za-z0-9._+/=-]{1,512}$/

/**
 * 这些名字属于入口 token / 平台密钥，不是模型供应商的 bearer。
 * 即使长得像 CredentialRef，也不许写进用户默认。
 */
export const FORBIDDEN_CREDENTIAL_REFS: ReadonlySet<string> = new Set([
  'DSH_LAUNCH_TOKEN',
  'GATE_TOKEN',
  'PLATFORM_SECRET',
])

export class ModelCredentialRejectedError extends Error {
  constructor() {
    super('模型 Key 不合法')
    this.name = 'ModelCredentialRejectedError'
  }
}

export function assertCredentialRef(ref: string): void {
  if (!CREDENTIAL_REF_PATTERN.test(ref) || FORBIDDEN_CREDENTIAL_REFS.has(ref)) {
    throw new ModelCredentialRejectedError()
  }
}

export function assertModelKey(value: string): void {
  if (!MODEL_KEY_PATTERN.test(value)) throw new ModelCredentialRejectedError()
}
