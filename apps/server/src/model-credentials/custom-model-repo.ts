import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { user, userModelCredential, userModelProvider } from '../db/schema.js'
import { encryptModelCredential, modelCredentialAad } from './crypto.js'
import {
  normalizeCustomModelWrite,
  projectCustomModel,
  type CustomModelPublic,
  type CustomModelSeed,
} from './custom-model.js'

export type CustomModelResult = {
  customModelConfigured: boolean
  customModel: CustomModelPublic | null
}

export async function findUserCustomModel(db: Db, userId: string): Promise<CustomModelSeed | null> {
  const rows = await db
    .select({
      providerId: userModelProvider.providerId,
      displayName: userModelProvider.displayName,
      baseUrl: userModelProvider.baseUrl,
      api: userModelProvider.api,
      apiKeyEnv: userModelProvider.apiKeyEnv,
      modelIds: userModelProvider.modelIds,
    })
    .from(userModelProvider)
    .where(eq(userModelProvider.userId, userId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  return {
    providerId: row.providerId,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    api: row.api,
    apiKeyEnv: row.apiKeyEnv,
    modelIds: Array.isArray(row.modelIds) ? row.modelIds : [],
  }
}

export async function applyUserCustomModel(
  db: Db,
  secret: string,
  userId: string,
  adminId: string,
  input: {
    baseUrl: string
    apiKey?: string | null | undefined
    providerId?: string | undefined
    displayName?: string | null | undefined
    api?: string | undefined
    apiKeyEnv?: string | undefined
    modelIds?: string[] | undefined
  },
): Promise<'missing' | CustomModelResult> {
  return db.transaction(async (tx) => {
    const found = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
    if (found[0] === undefined) return 'missing'

    const existingRows = await tx
      .select({
        providerId: userModelProvider.providerId,
        displayName: userModelProvider.displayName,
        apiKeyEnv: userModelProvider.apiKeyEnv,
        modelIds: userModelProvider.modelIds,
      })
      .from(userModelProvider)
      .where(eq(userModelProvider.userId, userId))
      .limit(1)
    const existing = existingRows[0]
    const write = normalizeCustomModelWrite(input, existing === undefined ? null : {
      providerId: existing.providerId,
      displayName: existing.displayName,
      apiKeyEnv: existing.apiKeyEnv,
      modelIds: Array.isArray(existing.modelIds) ? existing.modelIds : [],
    })
    const now = new Date()
    await tx.insert(userModelProvider).values({
      userId,
      providerId: write.providerId,
      displayName: write.displayName,
      baseUrl: write.baseUrl,
      api: write.api,
      apiKeyEnv: write.apiKeyEnv,
      modelIds: write.modelIds,
      updatedAt: now,
      updatedByAdminId: adminId,
    }).onConflictDoUpdate({
      target: userModelProvider.userId,
      set: {
        providerId: write.providerId,
        displayName: write.displayName,
        baseUrl: write.baseUrl,
        api: write.api,
        apiKeyEnv: write.apiKeyEnv,
        modelIds: write.modelIds,
        updatedAt: now,
        updatedByAdminId: adminId,
      },
    })

    if (typeof write.apiKey === 'string') {
      const encrypted = encryptModelCredential(
        write.apiKey,
        secret,
        modelCredentialAad(userId, write.apiKeyEnv),
      )
      await tx.insert(userModelCredential).values({
        userId,
        providerRef: write.apiKeyEnv,
        ciphertext: encrypted.ciphertext,
        keyVersion: encrypted.keyVersion,
        updatedAt: now,
        updatedByAdminId: adminId,
      }).onConflictDoUpdate({
        target: [userModelCredential.userId, userModelCredential.providerRef],
        set: {
          ciphertext: encrypted.ciphertext,
          keyVersion: encrypted.keyVersion,
          updatedAt: now,
          updatedByAdminId: adminId,
        },
      })
    } else if (write.apiKey === null) {
      await tx.delete(userModelCredential).where(and(
        eq(userModelCredential.userId, userId),
        eq(userModelCredential.providerRef, write.apiKeyEnv),
      ))
    }

    const refs = await tx
      .select({ providerRef: userModelCredential.providerRef })
      .from(userModelCredential)
      .where(eq(userModelCredential.userId, userId))
    return projectCustomModel({
      providerId: write.providerId,
      displayName: write.displayName,
      baseUrl: write.baseUrl,
      api: write.api,
      apiKeyEnv: write.apiKeyEnv,
      modelIds: write.modelIds,
      updatedAt: now,
    }, refs.map((row) => row.providerRef))
  })
}

/**
 * 清掉默认 Custom 行，以及它指向的那一个 ref。
 * 其它 ref（例如仍单独保存的 `DEEPSEEK_API_KEY`）留着。
 */
export async function clearUserCustomModel(db: Db, userId: string): Promise<'missing' | CustomModelResult> {
  return db.transaction(async (tx) => {
    const found = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
    if (found[0] === undefined) return 'missing'
    const rows = await tx
      .select({ apiKeyEnv: userModelProvider.apiKeyEnv })
      .from(userModelProvider)
      .where(eq(userModelProvider.userId, userId))
      .limit(1)
    const env = rows[0]?.apiKeyEnv
    await tx.delete(userModelProvider).where(eq(userModelProvider.userId, userId))
    if (env !== undefined) {
      await tx.delete(userModelCredential).where(and(
        eq(userModelCredential.userId, userId),
        eq(userModelCredential.providerRef, env),
      ))
    }
    return { customModelConfigured: false, customModel: null }
  })
}
