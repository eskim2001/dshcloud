import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { user, userModelCredential } from '../db/schema.js'
import { applyCredentialPatch, type StoredModelCredential } from './patch.js'
import { projectModelCredentials, type ModelCredentialPublic } from './view.js'

export async function listUserModelCredentialSecrets(
  db: Db,
  userId: string,
): Promise<Array<{ providerRef: string; ciphertext: string; keyVersion: number }>> {
  return db
    .select({
      providerRef: userModelCredential.providerRef,
      ciphertext: userModelCredential.ciphertext,
      keyVersion: userModelCredential.keyVersion,
    })
    .from(userModelCredential)
    .where(eq(userModelCredential.userId, userId))
}

export async function applyUserModelCredentials(
  db: Db,
  secret: string,
  userId: string,
  adminId: string,
  patch: Readonly<Record<string, string | null>>,
): Promise<'missing' | ModelCredentialPublic> {
  return db.transaction(async (tx) => {
    const found = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
    if (found[0] === undefined) return 'missing'

    const existing = await tx
      .select({
        providerRef: userModelCredential.providerRef,
        ciphertext: userModelCredential.ciphertext,
        keyVersion: userModelCredential.keyVersion,
        updatedAt: userModelCredential.updatedAt,
        updatedByAdminId: userModelCredential.updatedByAdminId,
      })
      .from(userModelCredential)
      .where(eq(userModelCredential.userId, userId))

    const next = applyCredentialPatch(existing, patch, {
      userId,
      adminId,
      secret,
      now: new Date(),
    })
    await replaceUserModelCredentials(tx, userId, next)
    return projectModelCredentials(next)
  })
}

export async function clearUserModelCredentials(
  db: Db,
  userId: string,
): Promise<'missing' | ModelCredentialPublic> {
  return db.transaction(async (tx) => {
    const found = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1)
    if (found[0] === undefined) return 'missing'
    await tx.delete(userModelCredential).where(eq(userModelCredential.userId, userId))
    return { configured: false, providerRefs: [], updatedAt: null }
  })
}

async function replaceUserModelCredentials(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  userId: string,
  rows: StoredModelCredential[],
): Promise<void> {
  await tx.delete(userModelCredential).where(eq(userModelCredential.userId, userId))
  if (rows.length === 0) return
  await tx.insert(userModelCredential).values(rows.map((row) => ({
    userId,
    providerRef: row.providerRef,
    ciphertext: row.ciphertext,
    keyVersion: row.keyVersion,
    updatedAt: row.updatedAt,
    updatedByAdminId: row.updatedByAdminId,
  })))
}
