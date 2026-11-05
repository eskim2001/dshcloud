import { encryptModelCredential, modelCredentialAad } from './crypto.js'
import { assertCredentialRef, assertModelKey } from './rules.js'

export interface StoredModelCredential {
  providerRef: string
  ciphertext: string
  keyVersion: number
  updatedAt: Date
  updatedByAdminId: string | null
}

/**
 * 省略的 ref 原样留下（连密文都不重包），null 删掉，字符串换成新密文。
 * 工作区里的 `.credentials.yaml` 不在这里，改默认不会回头改卷。
 */
export function applyCredentialPatch(
  existing: readonly StoredModelCredential[],
  patch: Readonly<Record<string, string | null>>,
  ctx: { userId: string; adminId: string; secret: string; now: Date },
): StoredModelCredential[] {
  const byRef = new Map(existing.map((row) => [row.providerRef, row]))
  for (const [ref, value] of Object.entries(patch)) {
    assertCredentialRef(ref)
    if (value === null) {
      byRef.delete(ref)
      continue
    }
    assertModelKey(value)
    const encrypted = encryptModelCredential(value, ctx.secret, modelCredentialAad(ctx.userId, ref))
    byRef.set(ref, {
      providerRef: ref,
      ciphertext: encrypted.ciphertext,
      keyVersion: encrypted.keyVersion,
      updatedAt: ctx.now,
      updatedByAdminId: ctx.adminId,
    })
  }
  return [...byRef.values()]
}
