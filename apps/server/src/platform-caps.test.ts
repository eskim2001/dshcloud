import { describe, expect, it } from 'vitest'
import type { Env } from './env.js'
import { createBodySchema, instanceQuotaBodySchema, platformCaps } from './platform-caps.js'

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
