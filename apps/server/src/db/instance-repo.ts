import { and, asc, count, eq, isNull, ne } from 'drizzle-orm'
import type { Db } from './client.js'
import { instance, user, type InstanceRow } from './schema.js'

const PG_UNIQUE_VIOLATION = '23505'

export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`slug 已被占用：${slug}`)
    this.name = 'SlugTakenError'
  }
}

export class QuotaExceededError extends Error {
  constructor(readonly limit: number) {
    super(`已达实例数上限（${limit} 个）`)
    this.name = 'QuotaExceededError'
  }
}

export interface NewInstance {
  id: string
  slug: string
  ownerId: string
  image: string
  cpus: number
  memoryMb: number
  pidsLimit: number
  diskMb: number
}

/** forward-auth 每个请求都要查——按 slug 唯一索引命中。 */
export async function findInstanceBySlug(db: Db, slug: string): Promise<InstanceRow | undefined> {
  const rows = await db.select().from(instance).where(and(eq(instance.slug, slug), isNull(instance.deletedAt))).limit(1)
  return rows[0]
}

export async function findInstanceById(db: Db, id: string): Promise<InstanceRow | undefined> {
  const rows = await db.select().from(instance).where(and(eq(instance.id, id), isNull(instance.deletedAt))).limit(1)
  return rows[0]
}

/** 只列自己的实例——`ownerId` 是 WHERE 的一部分，不是事后过滤（铁律 7）。 */
export async function listInstancesByOwner(db: Db, ownerId: string): Promise<InstanceRow[]> {
  return db.select().from(instance).where(and(eq(instance.ownerId, ownerId), isNull(instance.deletedAt))).orderBy(asc(instance.createdAt))
}

export async function listAllInstances(db: Db): Promise<InstanceRow[]> {
  return db.select().from(instance).where(isNull(instance.deletedAt)).orderBy(asc(instance.createdAt))
}

/** 配额判定用。`ownerId` 同样进 WHERE（铁律 7）。 */
export async function countInstancesByOwner(db: Db, ownerId: string): Promise<number> {
  const rows = await db.select({ n: count() }).from(instance).where(and(eq(instance.ownerId, ownerId), isNull(instance.deletedAt)))
  return rows[0]?.n ?? 0
}

/**
 * 当前意图为 `running` 的活实例数（与 reconciler 一致：以 DB status 为准，
 * 启动前闸门靠它，不拿 Docker 瞬时态做并发上限）。
 */
export async function countRunningInstances(db: Db): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(instance)
    .where(and(eq(instance.status, 'running'), isNull(instance.deletedAt)))
  return rows[0]?.n ?? 0
}

/**
 * 建实例记录。slug 冲突由唯一索引兜底，转成可读错误。
 *
 * 已删除的行**仍然占着 slug**：同一 owner 可以重建同名（浏览器状态本来就是他的），换个人不行 ——
 * 域名一旦回收给另一个租户，上一个租户留在这个域名下的浏览器状态（cookie / localStorage /
 * service worker）就被继承过去了（D24 / D31）。删实例**不删这一行**，它退役成主机名占位。
 */
export async function createInstanceRecord(db: Db, input: NewInstance, defaultLimit: number): Promise<InstanceRow> {
  try {
    return await db.transaction(async (transaction) => {
      const [owner] = await transaction.select({ quota: user.instanceQuota })
        .from(user).where(eq(user.id, input.ownerId)).for('update')
      if (owner === undefined) throw new Error('Instance owner does not exist')
      const limit = owner.quota ?? defaultLimit
      const [usage] = await transaction.select({ used: count() }).from(instance)
        .where(and(eq(instance.ownerId, input.ownerId), isNull(instance.deletedAt)))
      if ((usage?.used ?? 0) >= limit) throw new QuotaExceededError(limit)
      const [conflict] = await transaction.select({ ownerId: instance.ownerId }).from(instance)
        .where(and(eq(instance.slug, input.slug), ne(instance.ownerId, input.ownerId))).limit(1)
      if (conflict !== undefined) throw new SlugTakenError(input.slug)
      const [created] = await transaction.insert(instance)
        .values({ ...input, status: 'provisioning' }).returning()
      return created!
    })
  } catch (err) {
    if (constraintName(err) === 'instance_slug_unique') throw new SlugTakenError(input.slug)
    throw err
  }
}

export interface InstancePatch {
  status?: string
  containerId?: string | null
  /** 宿主回环发布端口（实例在宿主上的地址，见 schema 的注释）。 */
  hostPort?: number | null
  image?: string
  /** 非空 = 有一份升级前的数据快照可回滚（见 provisioner.setImage）。 */
  previousImage?: string | null
  lastError?: string | null
  /** 资源配额。改了不会自己生效——CPU/内存/磁盘都要重建实例（见 setQuota）。 */
  cpus?: number
  memoryMb?: number
  pidsLimit?: number
  diskMb?: number
  /** 工作空间最近活跃时刻（空闲回收 / forward-auth 触摸）。 */
  lastActiveAt?: Date
}

export async function updateInstance(
  db: Db,
  id: string,
  patch: InstancePatch,
): Promise<InstanceRow | undefined> {
  const rows = await db
    .update(instance)
    .set({ ...patch, ...statusDerivedPatch(patch), updatedAt: new Date() })
    .where(and(eq(instance.id, id), isNull(instance.deletedAt)))
    .returning()
  return rows[0]
}

/**
 * `stoppedAt` / `lastActiveAt` 是派生字段——由 status 推出来，调用方不用自己记。
 * 集中在这里是为了让 stop / start / 对账三条路径自动一致。
 * 显式传入的 `lastActiveAt` 优先（活动触摸别被「顺便标 running」盖掉语义也无妨）。
 */
function statusDerivedPatch(
  patch: InstancePatch,
): { stoppedAt?: Date | null; lastActiveAt?: Date } {
  if (patch.status === 'stopped') return { stoppedAt: new Date() }
  if (patch.status === 'running') {
    return {
      stoppedAt: null,
      ...(patch.lastActiveAt === undefined ? { lastActiveAt: new Date() } : {}),
    }
  }
  return {}
}

/**
 * 删实例后**留下的一行**：它退役成**主机名占位**，不是"数据还在"。
 *
 * 数据在删除时就被删了（见 `provisioner.remove`），这里保留的是那个子域名的归属：
 * 同一 owner 还能拿它重建，别人不能 —— 否则域名一回收，上一个租户在这个域名下的浏览器状态
 * （cookie / localStorage / service worker）就被继承了（D24 / D31）。
 *
 * 行留在库里还有个副作用：`deletedAt` 已置，所以所有列表/查询都看不见它 ✅ 用户视角就是删掉了。
 */
export async function retainInstanceRecord(db: Db, id: string): Promise<void> {
  await db.update(instance).set({
    deletedAt: new Date(),
    updatedAt: new Date(),
    status: 'retained',
    containerId: null,
  }).where(and(eq(instance.id, id), isNull(instance.deletedAt)))
}

function constraintName(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as { code?: string; constraint_name?: string; constraint?: string }
  if (e.code !== PG_UNIQUE_VIOLATION) {
    return err instanceof Error && err.cause !== err ? constraintName(err.cause) : undefined
  }
  return e.constraint_name ?? e.constraint
}
