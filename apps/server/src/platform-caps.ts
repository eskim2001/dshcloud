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

/** 用户自助创建：在历史护栏与平台封顶之间取更紧的那档。 */
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
