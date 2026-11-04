import { z } from 'zod'
import { ImageRefSchema, InstanceSlugSchema, isReservedSlug } from '@dsh-cloud/instance-spec'
import type { Env } from './env.js'

/**
 * 平台级资源 / 并发封顶的只读视图。env 是真相源；路由与 UI 都读这份，
 * 避免各处手写默认值漂开。
 */
export interface PlatformCaps {
  maxCpus: number
  maxMemoryMb: number
  maxPids: number
  maxDiskMb: number
  /** `0` = 不限制同时 running 数。 */
  maxRunning: number
  /** `0` = 关闭空闲回收。 */
  idleCullMinutes: number
}

export function platformCaps(env: Env): PlatformCaps {
  return {
    maxCpus: env.PLATFORM_MAX_CPUS,
    maxMemoryMb: env.PLATFORM_MAX_MEMORY_MB,
    maxPids: env.PLATFORM_MAX_PIDS,
    maxDiskMb: env.PLATFORM_MAX_DISK_MB,
    maxRunning: env.PLATFORM_MAX_RUNNING,
    idleCullMinutes: env.PLATFORM_IDLE_CULL_MINUTES,
  }
}

/**
 * 某个用户在单实例上的个人封顶。每一项 NULL = 不覆盖，回落平台。
 * 个数上限（`instanceQuota`）不在这里——那是「能开几个」，不是一档的资源。
 */
export interface UserResourceQuotas {
  cpuQuota: number | null
  memoryMbQuota: number | null
  pidsQuota: number | null
  diskMbQuota: number | null
}

export const EMPTY_USER_RESOURCE_QUOTAS: UserResourceQuotas = {
  cpuQuota: null,
  memoryMbQuota: null,
  pidsQuota: null,
  diskMbQuota: null,
}

/**
 * 这个用户创建 / 改档时真正生效的单实例封顶。
 *
 * 用户字段为 null 就用平台；有值则取更小的那个——库里就算写进了高于平台的数，
 * 也不能把平台封顶抬上去。`maxRunning` / `idleCullMinutes` 仍是全站的，不按用户收。
 */
export function effectiveInstanceCaps(
  platform: PlatformCaps,
  userQuotas: UserResourceQuotas | null | undefined,
): PlatformCaps {
  const user = userQuotas ?? EMPTY_USER_RESOURCE_QUOTAS
  return {
    ...platform,
    maxCpus: user.cpuQuota === null ? platform.maxCpus : Math.min(platform.maxCpus, user.cpuQuota),
    maxMemoryMb:
      user.memoryMbQuota === null
        ? platform.maxMemoryMb
        : Math.min(platform.maxMemoryMb, user.memoryMbQuota),
    maxPids:
      user.pidsQuota === null ? platform.maxPids : Math.min(platform.maxPids, user.pidsQuota),
    maxDiskMb:
      user.diskMbQuota === null
        ? platform.maxDiskMb
        : Math.min(platform.maxDiskMb, user.diskMbQuota),
  }
}

/**
 * 用户自助创建：在历史护栏与传入封顶之间取更紧的那档。
 * 调用方应传入 `effectiveInstanceCaps`（平台 ∩ 该用户），不要只传平台。
 */
export function createBodySchema(caps: PlatformCaps) {
  return z.object({
    // 保留字是**创建期命名政策**，只在这里生效——库里已有的行只做形状校验，
    // 否则扩表会让存量实例连删都删不掉（见 DECISIONS 的域名拆分 ADR）。
    slug: InstanceSlugSchema.refine((s) => !isReservedSlug(s), '该 slug 是保留字'),
    cpus: z
      .number()
      .positive()
      .max(Math.min(8, caps.maxCpus))
      .default(Math.min(1, caps.maxCpus)),
    memoryMb: z
      .number()
      .int()
      .positive()
      .max(Math.min(16_384, caps.maxMemoryMb))
      .default(Math.min(2048, caps.maxMemoryMb)),
    pidsLimit: z
      .number()
      .int()
      .positive()
      .max(Math.min(4096, caps.maxPids))
      .default(Math.min(512, caps.maxPids)),
    // 自助上限比管理员宽（D17）：这里 100GB，管理员能到 1TB——但都不得越过平台封顶。
    diskMb: z
      .number()
      .int()
      .min(128)
      .max(Math.min(102_400, caps.maxDiskMb))
      .default(Math.min(10_240, caps.maxDiskMb)),
    /** 自选版本，留空用平台默认版本。合法性（已发布 / 平台仓库）由 provisioner 判。 */
    image: ImageRefSchema.optional(),
  })
}

/**
 * 管理员改实例资源配额。历史上限比用户自助宽，但仍受平台封顶约束
 * （小机上管理员也不该把单实例撑爆宿主）。
 */
export function instanceQuotaBodySchema(caps: PlatformCaps) {
  return z.object({
    cpus: z.number().positive().max(Math.min(64, caps.maxCpus)),
    memoryMb: z.number().int().positive().max(Math.min(262_144, caps.maxMemoryMb)),
    pidsLimit: z.number().int().positive().max(Math.min(4_096, caps.maxPids)),
    diskMb: z.number().int().min(128).max(Math.min(1_048_576, caps.maxDiskMb)),
  })
}

/**
 * 管理员改某个用户的个数配额和/或单实例资源封顶。
 *
 * `quota` 沿用旧字段名（个数，NULL = 平台默认个数）。资源四项同样 NULL = 清掉个人覆盖。
 * 缺省的键不改库。资源项必须 ≤ 平台封顶——个人封顶是收紧，不是另开一道更高的门。
 * 磁盘另有 128MB 下限：实例档位本身不允许更小，封顶写得比档位下限还低会让创建 schema 无解。
 */
export function userQuotaBodySchema(caps: PlatformCaps) {
  return z
    .object({
      quota: z.number().int().min(0).max(100).nullable().optional(),
      cpuQuota: z.number().positive().max(caps.maxCpus).nullable().optional(),
      memoryMbQuota: z.number().int().positive().max(caps.maxMemoryMb).nullable().optional(),
      pidsQuota: z.number().int().positive().max(caps.maxPids).nullable().optional(),
      diskMbQuota: z.number().int().min(128).max(caps.maxDiskMb).nullable().optional(),
    })
    .refine(
      (value) =>
        value.quota !== undefined ||
        value.cpuQuota !== undefined ||
        value.memoryMbQuota !== undefined ||
        value.pidsQuota !== undefined ||
        value.diskMbQuota !== undefined,
      { message: '至少要改一项' },
    )
}
