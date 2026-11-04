import { describe, expect, it } from 'vitest'
import {
  GATE_INSTANCE_HEADER,
  GATE_TOKEN_HEADER,
} from '@dsh-cloud/instance-spec'
import {
  decideForwardAuth,
  instanceSlugFromHost,
  type ForwardAuthDeps,
  type ForwardAuthInput,
} from './forward-auth.js'
import { gateToken } from '../instance/gate-token.js'

const BASE = 'app.example.com'
const CONSOLE = `console.${BASE}`
const SECRET = 'test-gate-secret'

function deps(over: Partial<ForwardAuthDeps> = {}): ForwardAuthDeps {
  return {
    baseDomain: BASE,
    consoleDomain: CONSOLE,
    publicScheme: 'https',
    gateSecret: SECRET,
    findInstanceBySlug: async (slug) =>
      slug === 'alice' ? { id: 'i-alice', slug: 'alice', ownerId: 'user-alice' } : undefined,
    resolveUserId: async (cookie) => (cookie === 'sid=alice' ? 'user-alice' : undefined),
    ...over,
  }
}

function input(host: string | undefined, cookie?: string): ForwardAuthInput {
  return { host, cookie, originalUrl: `https://${host ?? 'nowhere'}/x/y?z=1` }
}

describe('instanceSlugFromHost', () => {
  it.each([
    'alice.app.example.com:bad', 'alice.app.example.com:65536',
    'alice.app.example.com:0', 'alice.app.example.com:',
    'alice.app.example.com:443:evil', 'alice.app.example.com/path',
    'alice.app.example.com@evil.test', ' alice.app.example.com',
    'alice.app.example.com\\evil', 'alice.app.example.com\t',
  ])('拒绝畸形 Host %j', host => {
    expect(instanceSlugFromHost(host, BASE)).toBeUndefined()
  })
  it('取出单标签子域', () => {
    expect(instanceSlugFromHost('alice.app.example.com', BASE)).toBe('alice')
  })

  it('忽略端口', () => {
    expect(instanceSlugFromHost('alice.app.example.com:8443', BASE)).toBe('alice')
  })

  it('大小写不敏感', () => {
    expect(instanceSlugFromHost('ALICE.APP.EXAMPLE.COM', BASE)).toBe('alice')
  })

  it('拒绝裸基域', () => {
    expect(instanceSlugFromHost(BASE, BASE)).toBeUndefined()
  })

  it('拒绝多级子域（否则 a.b. 能绕过前缀判断）', () => {
    expect(instanceSlugFromHost('a.b.app.example.com', BASE)).toBeUndefined()
  })

  it('拒绝别的域', () => {
    expect(instanceSlugFromHost('alice.app.example.com.evil.com', BASE)).toBeUndefined()
    expect(instanceSlugFromHost('alice.evil.com', BASE)).toBeUndefined()
    expect(instanceSlugFromHost('evil-app.example.com', BASE)).toBeUndefined()
  })

  it('保留字**照常解析**——门只做形状校验，命名政策不追溯存量', () => {
    expect(instanceSlugFromHost('admin.app.example.com', BASE)).toBe('admin')
    expect(instanceSlugFromHost('test.app.example.com', BASE)).toBe('test')
  })

  it('控制台主机名解析成 `console`（拦截在 Traefik 优先级 + 创建期政策，不在这里）', () => {
    expect(instanceSlugFromHost(CONSOLE, BASE)).toBe('console')
  })

  it('拒绝非法 slug 字符', () => {
    expect(instanceSlugFromHost('alice_1.app.example.com', BASE)).toBeUndefined()
  })
})

describe('workspace origin boundary', () => {
  const owner = input(`alice.${BASE}`, 'sid=alice')
  it.each([`https://bob.${BASE}`, `https://${CONSOLE}`, 'https://evil.example', 'null'])(
    'rejects browser requests from %s even with an owner cookie', async (origin) => {
      for (const method of ['GET', 'POST', 'DELETE']) {
        expect(await decideForwardAuth({ ...owner, origin, method }, deps()))
          .toEqual({ status: 403 })
      }
    },
  )
  it('allows same-origin writes and ordinary navigation', async () => {
    expect((await decideForwardAuth(owner, deps())).status).toBe(200)
    expect((await decideForwardAuth({
      ...owner, method: 'POST', origin: `https://alice.${BASE}`,
    }, deps())).status).toBe(200)
  })
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('rejects %s without Origin', async (method) => {
    expect(await decideForwardAuth({ ...owner, method }, deps())).toEqual({ status: 403 })
  })
})

describe('decideForwardAuth', () => {
  it.each([
    'dsh_cloud.session_token=secret',
    '__Secure-dsh_cloud.session_token=secret',
    '__Host-dsh_cloud.session_token=secret',
    'dsh_cloud.session_data.0=secret; dsh_cloud.admin_session=secret',
  ])('removes platform cookies after authentication: %s', async (platformCookie) => {
    let authenticatedCookie: string | undefined
    const cookie = `${platformCookie}; dsh_session=instance-token`
    const result = await decideForwardAuth(
      input('alice.app.example.com', cookie),
      deps({ resolveUserId: async (value) => {
        authenticatedCookie = value
        return 'user-alice'
      } }),
    )
    expect(authenticatedCookie).toBe(cookie)
    expect(result.status).toBe(200)
    if (result.status !== 200) throw new Error('expected authorization')
    expect(result.headers.Cookie).toBe('dsh_session=instance-token')
  })

  it('replaces a platform-only cookie header with an empty header', async () => {
    const result = await decideForwardAuth(
      input('alice.app.example.com', 'dsh_cloud.session_token=secret'),
      deps({ resolveUserId: async () => 'user-alice' }),
    )
    if (result.status !== 200) throw new Error('expected authorization')
    expect(result.headers.Cookie).toBe('')
  })

  it('未知实例 → 404', async () => {
    expect(await decideForwardAuth(input('bob.app.example.com'), deps())).toEqual({
      status: 404,
    })
  })

  it('非实例域 → 404', async () => {
    expect(await decideForwardAuth(input('app.example.com'), deps())).toEqual({
      status: 404,
    })
  })

  it('控制台主机名 → 404（轮不到门；即使轮到了，库里也没有 slug=console 的实例）', async () => {
    expect(await decideForwardAuth(input(CONSOLE), deps())).toEqual({ status: 404 })
  })

  it('存量实例的 slug 是保留字 → 仍按 owner 放行（政策不追溯）', async () => {
    const r = await decideForwardAuth(
      input('test.app.example.com', 'sid=alice'),
      deps({
        findInstanceBySlug: async (slug) =>
          slug === 'test' ? { id: 'i-test', slug: 'test', ownerId: 'user-alice' } : undefined,
      }),
    )
    expect(r.status).toBe(200)
    if (r.status !== 200) return
    expect(r.headers[GATE_INSTANCE_HEADER]).toBe('test')
    expect(r.headers[GATE_TOKEN_HEADER]).toBe(gateToken('test', SECRET))
  })

  it('未登录 → 302 回**控制台**登录页，且带上原始地址', async () => {
    const r = await decideForwardAuth(input('alice.app.example.com'), deps())
    expect(r.status).toBe(302)
    if (r.status !== 302) return
    // 只能跳控制台：不能把 Host 拼进 location（开放重定向），也不能跳父域（那里没有登录页）
    expect(r.location.startsWith(`https://${CONSOLE}/login?next=`)).toBe(true)
    expect(r.location).toContain(encodeURIComponent('https://alice.app.example.com/x/y?z=1'))
  })

  it('回跳 scheme 跟随 publicScheme（本地 http 开发时不指向 https）', async () => {
    const r = await decideForwardAuth(
      input('alice.app.example.com'),
      deps({ publicScheme: 'http' }),
    )
    if (r.status !== 302) throw new Error('expected 302')
    expect(r.location.startsWith(`http://${CONSOLE}/login`)).toBe(true)
  })

  it('登录了但不是 owner → 403（授权，不只是认证）', async () => {
    const r = await decideForwardAuth(
      input('alice.app.example.com', 'sid=alice'),
      deps({ resolveUserId: async () => 'user-bob' }),
    )
    expect(r).toEqual({ status: 403 })
  })

  it('owner → 200 并注入桥要的两个 header', async () => {
    const r = await decideForwardAuth(input('alice.app.example.com', 'sid=alice'), deps())
    expect(r.status).toBe(200)
    if (r.status !== 200) return
    expect(r.headers[GATE_INSTANCE_HEADER]).toBe('alice')
    expect(r.headers[GATE_TOKEN_HEADER]).toBe(gateToken('alice', SECRET))
  })

  it('header token 由 slug 派生，换实例就不同', async () => {
    const r = await decideForwardAuth(
      input('alice.app.example.com', 'sid=alice'),
      deps({ findInstanceBySlug: async () => ({ id: 'i-alice', slug: 'alice', ownerId: 'user-alice' }) }),
    )
    if (r.status !== 200) throw new Error('expected 200')
    expect(r.headers[GATE_TOKEN_HEADER]).not.toBe(gateToken('bob', SECRET))
  })
})
