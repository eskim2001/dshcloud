import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerForwardAuth } from './forward-auth-route.js'
import { gateToken } from '../instance/gate-token.js'
import type { ForwardAuthDeps } from './forward-auth.js'

const BASE = 'app.example.com'
const CONSOLE = `console.${BASE}`
const SECRET = 'route-test-secret'

function build(over: Partial<ForwardAuthDeps> = {}) {
  const app = Fastify()
  registerForwardAuth(app, {
    baseDomain: BASE,
    consoleDomain: CONSOLE,
    publicScheme: 'https',
    gateSecret: SECRET,
    findInstanceBySlug: async (slug) =>
      slug === 'alice' ? { id: 'i-alice', slug: 'alice', ownerId: 'user-alice' } : undefined,
    resolveUserId: async (cookie) => (cookie?.includes('dsh_cloud.session_token=ok') ? 'user-alice' : undefined),
    ...over,
  })
  return app
}

describe('GET /auth/verify', () => {
  it('checks the original method and browser origin forwarded by the proxy', async () => {
    const app = build()
    for (const origin of [undefined, 'https://bob.app.example.com', 'null']) {
      const res = await app.inject({
        method: 'GET', url: '/auth/verify',
        headers: {
          'x-forwarded-host': 'alice.app.example.com',
          'x-forwarded-method': 'POST',
          cookie: 'dsh_cloud.session_token=ok',
          ...(origin === undefined ? {} : { origin }),
        },
      })
      expect(res.statusCode).toBe(403)
      expect(res.headers['x-platform-token']).toBeUndefined()
    }
    const allowed = await app.inject({
      method: 'GET', url: '/auth/verify',
      headers: {
        'x-forwarded-host': 'alice.app.example.com',
        'x-forwarded-method': 'POST',
        cookie: 'dsh_cloud.session_token=ok',
        origin: 'https://alice.app.example.com',
      },
    })
    expect(allowed.statusCode).toBe(200)
    await app.close()
  })
  it('未登录 → 302，location 指向控制台登录页', async () => {
    const res = await build().inject({
      method: 'GET',
      url: '/auth/verify',
      headers: {
        'x-forwarded-host': 'alice.app.example.com',
        'x-forwarded-proto': 'https',
        'x-forwarded-uri': '/chat?x=1',
      },
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toContain(`https://${CONSOLE}/login?next=`)
  })

  it('owner → 200 且回注两个 header', async () => {
    const res = await build().inject({
      method: 'GET',
      url: '/auth/verify',
      headers: {
        'x-forwarded-host': 'alice.app.example.com',
        'x-forwarded-proto': 'https',
        'x-forwarded-uri': '/',
        cookie: 'dsh_cloud.session_token=ok',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-platform-instance']).toBe('alice')
    expect(res.headers['x-platform-token']).toBe(gateToken('alice', SECRET))
    expect(res.headers.cookie).toBe('')
  })

  it('登录了但不是 owner → 403', async () => {
    const res = await build({ resolveUserId: async () => 'user-bob' }).inject({
      method: 'GET',
      url: '/auth/verify',
      headers: { 'x-forwarded-host': 'alice.app.example.com' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('未知实例 → 404', async () => {
    const res = await build().inject({
      method: 'GET',
      url: '/auth/verify',
      headers: { 'x-forwarded-host': 'nobody.app.example.com' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('放行时不泄漏 token 到 body', async () => {
    const res = await build().inject({
      method: 'GET',
      url: '/auth/verify',
      headers: {
        'x-forwarded-host': 'alice.app.example.com',
        cookie: 'dsh_cloud.session_token=ok',
      },
    })
    expect(res.body).toBe('')
  })
})
