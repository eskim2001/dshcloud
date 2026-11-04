import { describe, expect, it } from 'vitest'
import { loadEnv, withPlatformDomains } from './env.js'

function source(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgres://localhost:5432/x',
    BASE_DOMAIN: 'lvh.me',
    CONSOLE_DOMAIN: 'console.lvh.me',
    PLATFORM_SECRET: 'p'.repeat(32),
    BETTER_AUTH_SECRET: 'b'.repeat(32),
    ...overrides,
  }
}

describe('平台封顶 / 并发 / 空闲回收默认值', () => {
  it('未配置时落到小机默认值', () => {
    const env = loadEnv(source())
    expect(env.CONTROL_PLANE_LISTEN_HOST).toBe('0.0.0.0')
    expect(env.PLATFORM_MAX_CPUS).toBe(2)
    expect(env.PLATFORM_MAX_MEMORY_MB).toBe(2048)
    expect(env.PLATFORM_MAX_PIDS).toBe(512)
    expect(env.PLATFORM_MAX_DISK_MB).toBe(10_240)
    expect(env.PLATFORM_MAX_RUNNING).toBe(3)
    expect(env.PLATFORM_IDLE_CULL_MINUTES).toBe(45)
  })

  it('PLATFORM_MAX_RUNNING=0 / PLATFORM_IDLE_CULL_MINUTES=0 合法（= 关闭）', () => {
    const env = loadEnv(
      source({ PLATFORM_MAX_RUNNING: '0', PLATFORM_IDLE_CULL_MINUTES: '0' }),
    )
    expect(env.PLATFORM_MAX_RUNNING).toBe(0)
    expect(env.PLATFORM_IDLE_CULL_MINUTES).toBe(0)
  })

  it('CONTROL_PLANE_LISTEN_HOST 可改回回环', () => {
    expect(loadEnv(source({ CONTROL_PLANE_LISTEN_HOST: '127.0.0.1' })).CONTROL_PLANE_LISTEN_HOST).toBe(
      '127.0.0.1',
    )
  })
})

describe('控制台可使用独立域名', () => {
  it('严格子域放行', () => {
    expect(loadEnv(source()).CONSOLE_DOMAIN).toBe('console.lvh.me')
  })

  it('父域本身被拒——父域不当主机名用', () => {
    expect(() => loadEnv(source({ CONSOLE_DOMAIN: 'lvh.me' }))).toThrow(/不能.*相同/)
  })

  it('显式配置的独立控制台主机名放行', () => {
    for (const consoleDomain of ['console.other.me', 'evil-lvh.me', 'notlvh.me']) {
      expect(loadEnv(source({ CONSOLE_DOMAIN: consoleDomain })).CONSOLE_DOMAIN).toBe(consoleDomain)
    }
  })
})

describe('域名可以整对留空（= 引导态：还没配域名）', () => {
  it('两个都空合法', () => {
    const env = loadEnv(source({ BASE_DOMAIN: '', CONSOLE_DOMAIN: '' }))
    expect([env.BASE_DOMAIN, env.CONSOLE_DOMAIN]).toEqual(['', ''])
  })

  it('压根不写域名也是引导态', () => {
    const { BASE_DOMAIN: _b, CONSOLE_DOMAIN: _c, ...rest } = source()
    const env = loadEnv(rest)
    expect([env.BASE_DOMAIN, env.CONSOLE_DOMAIN]).toEqual(['', ''])
  })

  it('**只填一个**是配置错误 —— 别让它悄悄跑成引导态', () => {
    expect(() => loadEnv(source({ CONSOLE_DOMAIN: '' }))).toThrow(/都空/)
    expect(() => loadEnv(source({ BASE_DOMAIN: '' }))).toThrow(/都空/)
  })
})

describe('withPlatformDomains：env 优先 → DB → 都没有才是引导态', () => {
  const stored = { baseDomain: 'example.com', consoleDomain: 'console.example.com' }
  const boot = loadEnv(source({ BASE_DOMAIN: '', CONSOLE_DOMAIN: '' }))

  it('env 里有 → 用 env，DB 说什么都不听', () => {
    const r = withPlatformDomains(loadEnv(source()), stored)
    expect(r.bootstrap).toBe(false)
    expect(r.env.BASE_DOMAIN).toBe('lvh.me')
  })

  it('env 空、DB 有 → 用 DB 那对', () => {
    const r = withPlatformDomains(boot, stored)
    expect(r.bootstrap).toBe(false)
    expect([r.env.BASE_DOMAIN, r.env.CONSOLE_DOMAIN]).toEqual(['example.com', 'console.example.com'])
  })

  it('都没有 → 引导态', () => {
    expect(withPlatformDomains(boot).bootstrap).toBe(true)
    expect(withPlatformDomains(boot, { baseDomain: '', consoleDomain: '' }).bootstrap).toBe(true)
  })

  it('数据库同样接受独立控制台域名', () => {
    const r = withPlatformDomains(boot, { baseDomain: 'example.com', consoleDomain: 'console.other.com' })
    expect(r.bootstrap).toBe(false)
    expect(r.env.CONSOLE_DOMAIN).toBe('console.other.com')
  })
  it('拒绝数据库中带端口或路径的非法域名', () => {
    expect(withPlatformDomains(boot, { baseDomain: 'example.com', consoleDomain: 'evil.test/path' }).bootstrap).toBe(true)
  })
})
