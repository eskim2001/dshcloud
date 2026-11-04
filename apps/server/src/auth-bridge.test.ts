import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp, type AppDeps } from './app.js'
import { createAuth } from './auth.js'
import { createDb } from './db/client.js'
import { loadEnv, type Env } from './env.js'

const origin = 'https://console.app.example.com'
const probe = '/api/auth/sign-in/rate-limit-probe'

function env(): Env {
  return loadEnv({
    DATABASE_URL: 'postgres://localhost:5432/nonexistent',
    BASE_DOMAIN: 'app.example.com',
    CONSOLE_DOMAIN: 'console.app.example.com',
    PLATFORM_SECRET: 'p'.repeat(32),
    BETTER_AUTH_SECRET: 'b'.repeat(32),
    INSTANCE_IMAGE_REPO: 'ghcr.io/example/dsh-instance',
  })
}

function deps(auth: AppDeps['auth']): AppDeps {
  return {
    env: env(),
    auth,
    db: {},
    provisioner: {},
    orchestrator: {},
    dataStore: {},
  } as unknown as AppDeps
}

describe('auth 桥接把伪造头收成 request.ip', () => {
  it('handler 只看到 Fastify 收好的单个 x-forwarded-for', async () => {
    const seen: Request[] = []
    const auth = {
      handler: vi.fn(async (request: Request) => {
        seen.push(request)
        return new Response('{}', { status: 200 })
      }),
      api: { getSession: vi.fn() },
    }
    const app = await buildApp(deps(auth as unknown as AppDeps['auth']))
    try {
      const forged = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        remoteAddress: '10.0.0.8',
        headers: {
          host: 'console.app.example.com',
          origin,
          cookie: 'sid=keep',
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.10, 198.51.100.8',
          'cf-connecting-ip': '198.51.100.99',
          'true-client-ip': '192.0.2.50',
          'x-real-ip': '192.0.2.51',
        },
        payload: {},
      })
      expect(forged.statusCode).toBe(200)
      const headers = seen[0]?.headers
      expect(headers?.get('x-forwarded-for')).toBe('203.0.113.10')
      expect(headers?.get('cf-connecting-ip')).toBeNull()
      expect(headers?.get('true-client-ip')).toBeNull()
      expect(headers?.get('x-real-ip')).toBeNull()
      expect(headers?.get('cookie')).toBe('sid=keep')
      expect(headers?.get('origin')).toBe(origin)

      seen.length = 0
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        remoteAddress: '203.0.113.20',
        headers: {
          host: 'console.app.example.com',
          origin,
          'cf-connecting-ip': '198.51.100.99',
          'x-real-ip': '192.0.2.8',
        },
        payload: {},
      })
      expect(seen[0]?.headers.get('x-forwarded-for')).toBe('203.0.113.20')
      expect(seen[0]?.headers.get('cf-connecting-ip')).toBeNull()

      seen.length = 0
      await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        remoteAddress: '203.0.113.60',
        headers: {
          host: 'console.app.example.com',
          origin,
          'x-forwarded-for': 'not-an-ip',
        },
        payload: {},
      })
      expect(seen[0]?.headers.get('x-forwarded-for')).toBe('0.0.0.0')
    } finally {
      await app.close()
    }
  })

  it('编码过的登录路径交给 handler 时已经解开，双重编码直接拒绝', async () => {
    const seen: Request[] = []
    const auth = {
      handler: vi.fn(async (request: Request) => {
        seen.push(request)
        return new Response('{}', { status: 200 })
      }),
      api: { getSession: vi.fn() },
    }
    const app = await buildApp(deps(auth as unknown as AppDeps['auth']))
    try {
      const decoded = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in%2femail',
        headers: { host: 'console.app.example.com', origin },
        payload: {},
      })
      expect(decoded.statusCode).toBe(200)
      expect(new URL(seen[0]!.url).pathname).toBe('/api/auth/sign-in/email')

      const doubled = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in%252femail',
        headers: { host: 'console.app.example.com', origin },
        payload: {},
      })
      expect(doubled.statusCode).toBe(400)
      expect(auth.handler).toHaveBeenCalledOnce()

      const admin = await app.inject({
        method: 'POST',
        url: '/api/auth/admin%2fset-role',
        headers: { host: 'console.app.example.com', origin },
        payload: {},
      })
      expect(admin.statusCode).toBe(403)
      expect(auth.handler).toHaveBeenCalledOnce()
    } finally {
      await app.close()
    }
  })
})

describe('经 buildApp 的登录限速不认伪造头', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let closeDb: () => Promise<void>

  beforeAll(async () => {
    const { db, client } = createDb('postgres://localhost:5432/nonexistent')
    closeDb = () => client.end()
    app = await buildApp(deps(createAuth(env(), db)))
  })

  afterAll(async () => {
    await app.close()
    await closeDb()
  })

  async function post(
    url: string,
    headers: Record<string, string>,
    remoteAddress: string,
  ) {
    return app.inject({
      method: 'POST',
      url,
      remoteAddress,
      headers: {
        host: 'console.app.example.com',
        origin,
        ...headers,
      },
    })
  }

  it('同一 request.ip 上换伪造头或逗号链仍然 429', async () => {
    const ip = '203.0.113.30'
    for (let i = 0; i < 10; i++) {
      expect((await post(probe, { 'x-forwarded-for': ip }, '10.0.0.8')).statusCode).not.toBe(429)
    }
    // 左边还是同一个地址，Fastify 的 request.ip 不变。旧实现会因逗号链得到 null，
    // 测试环境再收成 127.0.0.1，等于换了一只桶。
    const bypass = await post(
      probe,
      {
        'x-forwarded-for': `${ip}, 198.51.100.8`,
        'cf-connecting-ip': '198.51.100.99',
        'true-client-ip': '192.0.2.50',
        'x-real-ip': '192.0.2.51',
      },
      '10.0.0.8',
    )
    expect(bypass.statusCode).toBe(429)

    const other = await post(probe, {}, '203.0.113.31')
    expect(other.statusCode).not.toBe(429)
  })

  it('没有客户端 IP 头时按连接地址限速，补一个伪造头拆不开', async () => {
    const remote = '203.0.113.20'
    for (let i = 0; i < 10; i++) {
      expect((await post(probe, {}, remote)).statusCode).not.toBe(429)
    }
    const limited = await post(
      probe,
      { 'cf-connecting-ip': '198.51.100.99', 'x-real-ip': '192.0.2.8' },
      remote,
    )
    expect(limited.statusCode).toBe(429)
  })

  it('非法地址收进 0.0.0.0，不因缺合法头而停掉限速', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post(probe, { 'x-forwarded-for': 'not-an-ip' }, '203.0.113.60')).statusCode).not.toBe(429)
    }
    expect((await post(probe, { 'x-forwarded-for': 'also-bad', 'cf-connecting-ip': '198.51.100.1' }, '203.0.113.61')).statusCode).toBe(429)
    expect((await post(probe, { 'x-forwarded-for': '0.0.0.0' }, '203.0.113.62')).statusCode).toBe(429)
    // 若非法头被丢掉、test 兜底成 127.0.0.1，这一下会跟着 429。
    expect((await post(probe, {}, '127.0.0.1')).statusCode).not.toBe(429)
  })

  it('%2F 解完仍算同一只登录桶', async () => {
    const ip = '203.0.113.40'
    for (let i = 0; i < 10; i++) {
      expect((await post(probe, { 'x-forwarded-for': ip }, '10.0.0.8')).statusCode).not.toBe(429)
    }
    expect((await post('/api/auth/sign-in%2frate-limit-probe', { 'x-forwarded-for': ip }, '10.0.0.8')).statusCode).toBe(429)
  })
})
