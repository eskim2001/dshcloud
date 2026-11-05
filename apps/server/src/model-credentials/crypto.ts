import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * 用户默认模型凭据的 at-rest 加密。钉死如下，换算法要升 key_version：
 *
 * - KEK：HKDF-SHA256
 *   - IKM：`PLATFORM_SECRET` 的 UTF-8 字节（不另设环境变量）
 *   - salt：`dsh-cloud/user-model-credential`
 *   - info：`aes-256-gcm/v1`
 *   - 长度：32 字节
 * - 数据密钥算法：AES-256-GCM，每条随机 12 字节 IV
 * - AAD：`userId || NUL || providerRef`，密文不能挪到别的用户或别的 ref
 * - 落库：`v1.` + base64(iv[12] ‖ tag[16] ‖ ciphertext)，key_version 列同时记 1
 *
 * 与 gate token 分开：门禁用的是 HMAC-SHA256(`dsh-cloud:gate:<slug>`)，
 * 这里是另一条 HKDF info，算法、字段、表都不共用。
 */
export const MODEL_CREDENTIAL_KEY_VERSION = 1

const HKDF_SALT = 'dsh-cloud/user-model-credential'
const HKDF_INFO = 'aes-256-gcm/v1'

export function modelCredentialAad(userId: string, providerRef: string): string {
  return `${userId}\0${providerRef}`
}

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf8'),
    Buffer.from(HKDF_SALT, 'utf8'),
    Buffer.from(HKDF_INFO, 'utf8'),
    32,
  ))
}

export function encryptModelCredential(
  plaintext: string,
  secret: string,
  aad: string,
): { ciphertext: string; keyVersion: number } {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: `v1.${Buffer.concat([iv, tag, body]).toString('base64')}`,
    keyVersion: MODEL_CREDENTIAL_KEY_VERSION,
  }
}

export function decryptModelCredential(
  ciphertext: string,
  secret: string,
  aad: string,
  keyVersion: number,
): string {
  try {
    if (keyVersion !== MODEL_CREDENTIAL_KEY_VERSION || !ciphertext.startsWith('v1.')) {
      throw new Error('bad-version')
    }
    const packed = Buffer.from(ciphertext.slice(3), 'base64')
    if (packed.length < 12 + 16 + 1) throw new Error('bad-length')
    const iv = packed.subarray(0, 12)
    const tag = packed.subarray(12, 28)
    const body = packed.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // 不把明文、密文或 OpenSSL 原文带出去：lastError 会进管理台。
    throw new Error('用户默认模型凭据无法解密')
  }
}

export function decryptStoredRefs(
  rows: Array<{ providerRef: string; ciphertext: string; keyVersion: number }>,
  secret: string,
  userId: string,
): Record<string, string> {
  const refs: Record<string, string> = {}
  for (const row of rows) {
    refs[row.providerRef] = decryptModelCredential(
      row.ciphertext,
      secret,
      modelCredentialAad(userId, row.providerRef),
      row.keyVersion,
    )
  }
  return refs
}
