import type { Db } from '../db/client.js'
import { decryptStoredRefs } from './crypto.js'
import { findUserCustomModel } from './custom-model-repo.js'
import type { CustomModelSeed } from './custom-model.js'
import { listUserModelCredentialSecrets } from './repo.js'

/**
 * 只给「新建数据卷」用。返回值是明文 map，调用方渲染完就丢掉，不要打日志。
 * 没有默认时返回空对象，调用方不要因此创建 `.credentials.yaml`。
 */
export async function readOwnerModelRefs(
  db: Db,
  secret: string,
  userId: string,
): Promise<Record<string, string>> {
  const rows = await listUserModelCredentialSecrets(db, userId)
  if (rows.length === 0) return {}
  return decryptStoredRefs(rows, secret, userId)
}

/**
 * 新建数据卷时读取 Custom 通道的非密字段。没有行就返回 null，调用方不要因此写 patch。
 * 这里不碰 `.credentials.yaml`，也不打开已有工作区的 cordis patch。
 */
export async function readOwnerCustomModel(db: Db, userId: string): Promise<CustomModelSeed | null> {
  return findUserCustomModel(db, userId)
}
