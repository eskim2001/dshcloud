import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { UserResourceQuotas } from '../platform-caps.js'
import type { Db } from './client.js'
import { instance, session, user } from './schema.js'

/**
 * 平台管理面（管理员）用到的查询。**不属于任何实例**——这些是跨实例的
 * 平台视图，只有 role='admin' 能调用（见 http/admin-routes.ts）。
 *
 * 注意这里读的是**元数据**（谁、几个实例、什么状态），不是实例内容。
 * 管理员默认读不到用户的 /data——那是隔离承诺的一部分（ARCHITECTURE §四）。
 */

export interface AdminUserRow {
  id: string
  email: string
  name: string
  role: string
  banned: boolean
  banReason: string | null
  /** NULL = 用平台默认个数上限。 */
  instanceQuota: number | null
  /** 单实例资源封顶。NULL = 用平台 PLATFORM_MAX_*。 */
  cpuQuota: number | null
  memoryMbQuota: number | null
  pidsQuota: number | null
  diskMbQuota: number | null
  instanceCount: number
  createdAt: Date
}

export async function listUsersWithInstanceCount(db: Db): Promise<AdminUserRow[]> {
  const rows = await db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      banned: user.banned,
      banReason: user.banReason,
      instanceQuota: user.instanceQuota,
      cpuQuota: user.cpuQuota,
      memoryMbQuota: user.memoryMbQuota,
      pidsQuota: user.pidsQuota,
      diskMbQuota: user.diskMbQuota,
      createdAt: user.createdAt,
      instanceCount: sql<number>`count(${instance.id})::int`,
    })
    .from(user)
    .leftJoin(instance, and(eq(instance.ownerId, user.id), isNull(instance.deletedAt)))
    .groupBy(user.id)
    .orderBy(asc(user.createdAt))
  return rows
}

export interface AdminInstanceRow {
  id: string
  slug: string
  /** 数据卷标识。舰队页按它查磁盘用量（宿主路径不进 API，只认这个不透明的 key）。 */
  storageKey: string
  status: string
  /** 判实时状态要用（见 instance/runtime-status.ts）。 */
  containerId: string | null
  image: string
  cpus: number
  memoryMb: number
  pidsLimit: number
  diskMb: number
  lastError: string | null
  createdAt: Date
  ownerEmail: string
}

export async function listInstancesWithOwner(db: Db): Promise<AdminInstanceRow[]> {
  return db
    .select({
      id: instance.id,
      slug: instance.slug,
      storageKey: instance.storageKey,
      status: instance.status,
      containerId: instance.containerId,
      image: instance.image,
      cpus: instance.cpus,
      memoryMb: instance.memoryMb,
      pidsLimit: instance.pidsLimit,
      diskMb: instance.diskMb,
      lastError: instance.lastError,
      createdAt: instance.createdAt,
      ownerEmail: user.email,
    })
    .from(instance)
    .innerJoin(user, eq(instance.ownerId, user.id))
    .where(isNull(instance.deletedAt))
    .orderBy(asc(instance.createdAt))
}

/** NULL = 没给这个用户单独设过，调用方用平台默认值。 */
export async function findUserQuota(db: Db, userId: string): Promise<number | null> {
  const rows = await db
    .select({ quota: user.instanceQuota })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  return rows[0]?.quota ?? null
}

/** 单实例资源封顶。用户不存在 → undefined（调用方回落平台，别当成「全是 null 的覆盖」以外的事）。 */
export async function findUserResourceQuotas(
  db: Db,
  userId: string,
): Promise<UserResourceQuotas | undefined> {
  const rows = await db
    .select({
      cpuQuota: user.cpuQuota,
      memoryMbQuota: user.memoryMbQuota,
      pidsQuota: user.pidsQuota,
      diskMbQuota: user.diskMbQuota,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  return rows[0]
}

/**
 * 管理员改这个用户的配额。只写 patch 里出现的键——个数和四项资源可以分开保存，
 * null 是「清掉个人覆盖」，不是「没传」。
 */
export interface UserQuotaPatch {
  instanceQuota?: number | null
  cpuQuota?: number | null
  memoryMbQuota?: number | null
  pidsQuota?: number | null
  diskMbQuota?: number | null
}

export async function setUserQuota(
  db: Db,
  userId: string,
  patch: UserQuotaPatch,
): Promise<boolean> {
  const next: UserQuotaPatch & { updatedAt: Date } = { updatedAt: new Date() }
  if (patch.instanceQuota !== undefined) next.instanceQuota = patch.instanceQuota
  if (patch.cpuQuota !== undefined) next.cpuQuota = patch.cpuQuota
  if (patch.memoryMbQuota !== undefined) next.memoryMbQuota = patch.memoryMbQuota
  if (patch.pidsQuota !== undefined) next.pidsQuota = patch.pidsQuota
  if (patch.diskMbQuota !== undefined) next.diskMbQuota = patch.diskMbQuota
  const rows = await db
    .update(user)
    .set(next)
    .where(eq(user.id, userId))
    .returning({ id: user.id })
  return rows.length > 0
}

/** 封禁/解封。真正的拦截在 better-auth 的 admin 插件（建会话时拒绝）。 */
export async function setUserBanned(
  db: Db,
  userId: string,
  banned: boolean,
  reason: string | null,
): Promise<boolean> {
  const rows = await db
    .update(user)
    .set({ banned, banReason: banned ? reason : null, banExpires: null, updatedAt: new Date() })
    .where(eq(user.id, userId))
    .returning({ id: user.id })
  return rows.length > 0
}

/**
 * 踢掉这个用户的所有会话。
 *
 * **封禁必须配这一步**：admin 插件只在**建新会话**时拒绝被封禁者，
 * 已经存在的会话不受影响——不删就等于没封。
 */
export async function revokeUserSessions(db: Db, userId: string): Promise<void> {
  await db.delete(session).where(eq(session.userId, userId))
}

/**
 * 按 id 取账号——改角色和 seed 引导都要先知道「这个人现在是不是 admin」。
 *
 * `instanceQuota` 一并读出来，是为了让实例列表能告诉用户"你还能开几个"：
 * 额度是运营配的，但**用户该知道自己的额度**，而不是撞上去才被告知。
 */
export async function findUserById(
  db: Db,
  userId: string,
): Promise<{ id: string; role: string; instanceQuota: number | null } | undefined> {
  const rows = await db
    .select({ id: user.id, role: user.role, instanceQuota: user.instanceQuota })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  return rows[0]
}

/** 邮箱大小写不敏感：别假设库里存的就是小写。 */
export async function findUserByEmail(
  db: Db,
  email: string,
): Promise<{ id: string; role: string } | undefined> {
  const rows = await db
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.toLowerCase()}`)
    .limit(1)
  return rows[0]
}

/** 平台管理员数量。降级最后一名管理员会把自己锁在门外，改角色前必须看它。 */
export async function countAdmins(db: Db): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(user)
    .where(eq(user.role, 'admin'))
  return rows[0]?.n ?? 0
}

/** 改角色。用户不存在 → false。 */
export async function setUserRole(
  db: Db,
  userId: string,
  role: 'user' | 'admin',
): Promise<boolean> {
  const rows = await db
    .update(user)
    .set({ role, updatedAt: new Date() })
    .where(eq(user.id, userId))
    .returning({ id: user.id })
  return rows.length > 0
}
