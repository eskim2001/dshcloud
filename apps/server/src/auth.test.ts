import { describe, expect, it } from 'vitest'
import { authBaseUrl, createAuth } from './auth.js'
import { createDb } from './db/client.js'
import { loadEnv, type Env } from './env.js'

/**
 * 引导态（还没配域名）下的认证。
 *
 * 真机上踩过一次：`CONSOLE_DOMAIN` 为空时 baseURL 拼成 `"https://"`，better-auth 建上下文
 * 直接抛 `Invalid base URL: https://` —— 死的是 **`scripts/seed.ts`**（它自己也建了一个
 * auth 实例，而且引导态下它恰恰要跑）。所以这两条盯的是"空域名不许拼出裸协议"。
 */
function env(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    DATABASE_URL: 'postgres://localhost:5432/x',
    BASE_DOMAIN: '',
    CONSOLE_DOMAIN: '',
    PLATFORM_SECRET: 'p'.repeat(32),
    BETTER_AUTH_SECRET: 'b'.repeat(32),
    ...overrides,
  })
}

describe('引导态下的认证', () => {
  it('HTTPS console credentials use host-only protected cookies', async () => {
    const { db, client } = createDb('postgres://localhost:5432/nonexistent')
    try {
      const auth = createAuth(env({ BASE_DOMAIN: 'app.example.com', CONSOLE_DOMAIN: 'console.app.example.com' }), db)
      const context = await auth.$context
      for (const cookie of Object.values(context.authCookies)) {
        expect(cookie.name).toMatch(/^__Host-dsh_cloud\./)
        expect(cookie.attributes).toMatchObject({ secure: true, httpOnly: true, path: '/', sameSite: 'lax' })
        expect(cookie.attributes.domain).toBeUndefined()
      }
    } finally { await client.end() }
  })
  it('域名空 → baseURL 兜到占位值，绝不出现裸协议', () => {
    expect(authBaseUrl(env())).toBe('http://127.0.0.1:3000')
    // 对照：配好域名就是真的控制台地址
    expect(
      authBaseUrl(env({ BASE_DOMAIN: 'app.example.com', CONSOLE_DOMAIN: 'console.app.example.com' })),
    ).toBe('https://console.app.example.com')
  })

  it('登录路径走 60s 内存限速，超额直接 429', async () => {
    const { db, client } = createDb('postgres://localhost:5432/nonexistent')
    try {
      const auth = createAuth(
        env({ BASE_DOMAIN: 'app.example.com', CONSOLE_DOMAIN: 'console.app.example.com' }),
        db,
      )
      const context = await auth.$context
      expect(context.rateLimit).toMatchObject({
        enabled: true,
        window: 60,
        max: 100,
        storage: 'memory',
      })
      expect(context.rateLimit.customRules?.['/sign-in/*']).toEqual({ window: 60, max: 10 })
      // 锁死只读这一个头。不设的话，缺头在 test 里会落到 127.0.0.1，测的是兜底不是限速。
      expect(context.options.advanced?.ipAddress).toEqual({
        ipAddressHeaders: ['x-forwarded-for'],
      })

      // 打到登录前缀但不是真登录：限速在进路由之前计数，不必连数据库。
      // 地址必须写在头上。不写的话 NODE_ENV=test 会把所有请求收成 127.0.0.1，空头也能“通过”。
      const ip = '203.0.113.10'
      const signIn = (address: string) =>
        auth.handler(
          new Request('https://console.app.example.com/api/auth/sign-in/rate-limit-probe', {
            method: 'POST',
            headers: {
              origin: 'https://console.app.example.com',
              'x-forwarded-for': address,
            },
          }),
        )

      for (let i = 0; i < 10; i++) {
        expect((await signIn(ip)).status).not.toBe(429)
      }
      expect((await signIn(ip)).status).toBe(429)
      // 另一只地址还有额度，说明桶是按这个头分的，不是测试环境的共享兜底。
      expect((await signIn('203.0.113.11')).status).not.toBe(429)
    } finally { await client.end() }
  })

  it('**建上下文不抛** —— 真机上 seed 就死在这一步', async () => {
    // 连接是懒的，这里不会真的碰数据库；要的只是走完 better-auth 的上下文初始化
    const { db } = createDb('postgres://localhost:5432/nonexistent')
    const auth = createAuth(env(), db)

    // 不抛就算过（未登录时返回 null/undefined 都行）
    await auth.api.getSession({ headers: new Headers() })
  })
})
