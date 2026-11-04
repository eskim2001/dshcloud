import { describe, expect, it } from 'vitest'
import type { Env } from './env.js'
import {
  createBodySchema,
  effectiveInstanceCaps,
  instanceQuotaBodySchema,
  platformCaps,
  userQuotaBodySchema,
} from './platform-caps.js'

const caps = platformCaps({
  PLATFORM_MAX_CPUS: 2,
  PLATFORM_MAX_MEMORY_MB: 2048,
  PLATFORM_MAX_PIDS: 512,
  PLATFORM_MAX_DISK_MB: 10_240,
  PLATFORM_MAX_RUNNING: 3,
  PLATFORM_IDLE_CULL_MINUTES: 45,
} as Env)

describe('createBodySchema：平台封顶', () => {
  it('默认值落在封顶内', () => {
    const parsed = createBodySchema(caps).parse({ slug: 'alice' })
    expect(parsed).toMatchObject({
      cpus: 1,
      memoryMb: 2048,
      pidsLimit: 512,
      diskMb: 10_240,
    })
  })

  it('超过平台封顶 → 拒绝', () => {
    expect(createBodySchema(caps).safeParse({ slug: 'alice', cpus: 4 }).success).toBe(false)
    expect(createBodySchema(caps).safeParse({ slug: 'alice', memoryMb: 4096 }).success).toBe(false)
    expect(createBodySchema(caps).safeParse({ slug: 'alice', pidsLimit: 1024 }).success).toBe(false)
    expect(createBodySchema(caps).safeParse({ slug: 'alice', diskMb: 20_480 }).success).toBe(false)
  })
})

describe('effectiveInstanceCaps', () => {
  it('用户字段全 null → 原样用平台', () => {
    expect(
      effectiveInstanceCaps(caps, {
        cpuQuota: null,
        memoryMbQuota: null,
        pidsQuota: null,
        diskMbQuota: null,
      }),
    ).toEqual(caps)
  })

  it('每项取 min(平台, 用户)；没设的项保持平台', () => {
    expect(
      effectiveInstanceCaps(caps, {
        cpuQuota: 1,
        memoryMbQuota: null,
        pidsQuota: 128,
        diskMbQuota: 20_480,
      }),
    ).toMatchObject({
      maxCpus: 1,
      maxMemoryMb: 2048,
      maxPids: 128,
      maxDiskMb: 10_240,
      maxRunning: 3,
      idleCullMinutes: 45,
    })
  })
})

describe('userQuotaBodySchema：每用户封顶不得高于平台', () => {
  it('封顶内（含 null = 恢复平台默认）放行', () => {
    expect(
      userQuotaBodySchema(caps).safeParse({
        quota: 2,
        cpuQuota: 1,
        memoryMbQuota: null,
        pidsQuota: 256,
        diskMbQuota: 5120,
      }).success,
    ).toBe(true)
  })

  it('高于平台、磁盘低于档位下限、空 body → 拒绝', () => {
    expect(userQuotaBodySchema(caps).safeParse({ cpuQuota: 4 }).success).toBe(false)
    expect(userQuotaBodySchema(caps).safeParse({ memoryMbQuota: 4096 }).success).toBe(false)
    expect(userQuotaBodySchema(caps).safeParse({ diskMbQuota: 64 }).success).toBe(false)
    expect(userQuotaBodySchema(caps).safeParse({}).success).toBe(false)
  })
})

describe('createBodySchema：传入的是有效封顶，不是只看平台', () => {
  it('用户封顶更紧时，平台还允许的值也会被拒', () => {
    const tight = effectiveInstanceCaps(caps, {
      cpuQuota: 1,
      memoryMbQuota: 1024,
      pidsQuota: 256,
      diskMbQuota: 5120,
    })
    expect(createBodySchema(tight).safeParse({ slug: 'alice', cpus: 2 }).success).toBe(false)
    expect(createBodySchema(tight).safeParse({ slug: 'alice', memoryMb: 2048 }).success).toBe(false)
    expect(
      createBodySchema(tight).safeParse({
        slug: 'alice',
        cpus: 1,
        memoryMb: 1024,
        pidsLimit: 256,
        diskMb: 5120,
      }).success,
    ).toBe(true)
  })
})

describe('instanceQuotaBodySchema：平台封顶', () => {
  it('封顶内放行', () => {
    expect(
      instanceQuotaBodySchema(caps).safeParse({
        cpus: 2,
        memoryMb: 2048,
        pidsLimit: 512,
        diskMb: 10_240,
      }).success,
    ).toBe(true)
  })

  it('超过平台封顶 → 拒绝（即使低于历史管理员上限）', () => {
    expect(
      instanceQuotaBodySchema(caps).safeParse({
        cpus: 4,
        memoryMb: 2048,
        pidsLimit: 512,
        diskMb: 10_240,
      }).success,
    ).toBe(false)
  })
})
