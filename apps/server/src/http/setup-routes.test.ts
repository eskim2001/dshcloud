import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccountExistsError } from '../account.js'
import { registerSetupRoutes, type SetupDeps } from './setup-routes.js'

/**
 * 引导态的 setup 端点：**平台在配域名之前唯一对公网开着的写口**。
 *
 * 盯五件事：token 是硬门（错就拒、没配就谁也别想配）、**验 token 在验表单之前**、
 * 域名与账号的形状、DNS 只警告不拦、以及顺序——**先建号再落域名**（反过来会留下
 * "域名配好了但没有任何账号"的死局，那个状态连界面都进不去）。
 */
describe('setup 端点', () => {
  it('保存显式独立控制台域名', async () => {
    app = await build()
    const response = await post(body({ consoleDomain: 'console.other.net' }))
    expect(response.statusCode).toBe(200)
    expect(saved).toEqual([{ baseDomain: 'example.com', consoleDomain: 'console.other.net' }])
  })
  it.each(['evil.test/path', 'https://console.other.net', ''])('拒绝非法控制台域名 %j，且不建管理员', async consoleDomain => {
    app = await build()
    expect((await post(body({ consoleDomain }))).statusCode).toBe(400)
    expect(created).toHaveLength(0)
    expect(saved).toHaveLength(0)
  })
  let app: FastifyInstance
  const saved: Array<{ baseDomain: string; consoleDomain: string }> = []
  const created: Array<{ email: string; password: string }> = []
  let restarts = 0

  const deps = (over: Partial<SetupDeps> = {}): SetupDeps => ({
    configured: false,
    token: 'tok',
    saveDomains: async (domains) => {
      saved.push(domains)
    },
    createAdmin: async (account) => {
      created.push(account)
    },
    restart: () => {
      restarts++
    },
    resolveSubdomain: async () => ['203.0.113.7'],
    ...over,
  })

  beforeEach(() => {
    saved.length = 0
    created.length = 0
    restarts = 0
  })

  async function build(over: Partial<SetupDeps> = {}): Promise<FastifyInstance> {
    const instance = Fastify()
    registerSetupRoutes(instance, deps(over))
    await instance.ready()
    return instance
  }

  /** 一份合格的请求体。用例只覆盖自己关心的字段。 */
  const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    token: 'tok',
    baseDomain: 'example.com',
    email: 'admin@example.com',
    password: 'correct-horse',
    ...over,
  })

  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/setup', payload })

  afterEach(async () => {
    await app?.close()
  })

  it('state：引导态回 false，已配置回 true（控制台靠它决定显示哪套界面）', async () => {
    app = await build()
    expect((await app.inject({ method: 'GET', url: '/api/setup/state' })).json()).toEqual({
      configured: false,
      demo: null,
    })
    await app.close()

    app = await build({ configured: true })
    expect((await app.inject({ method: 'GET', url: '/api/setup/state' })).json()).toEqual({
      configured: true,
      demo: null,
    })
  })

  /**
   * 演示账号跟 `configured` 同路：登录页在**登录之前**就要拿到它。没配的部署必须回 `null`
   * —— 登录页据此决定渲不渲染那一块，回了别的东西自托管的人登录页上就会多出一条提示。
   */
  it('state：配了演示账号就带上，没配就是 null', async () => {
    app = await build({ demo: { email: 'demo@example.com', password: 'demo-pass' } })
    expect((await app.inject({ method: 'GET', url: '/api/setup/state' })).json()).toEqual({
      configured: false,
      demo: { email: 'demo@example.com', password: 'demo-pass' },
    })
  })

  it('token 不对 → 401，且**什么都没写**（没建号、没落域名、没重启）', async () => {
    app = await build()
    const res = await post(body({ token: 'wrong' }))
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid-token' })
    expect(created).toEqual([])
    expect(saved).toEqual([])
    expect(restarts).toBe(0)
  })

  it('没配 token（空串）→ 一样拒：别让「没开 setup」变成「谁都能配」', async () => {
    app = await build({ token: '' })
    const res = await post(body({ token: '' }))
    expect(res.statusCode).toBe(401)
    expect(created).toEqual([])
    expect(saved).toEqual([])
  })

  it('**先验 token、再验表单**：token 不对时，表单再烂也只回 401（不是 400）', async () => {
    app = await build()
    // 邮箱和密码都不合格，但凭证也是错的 —— 该说的是"你不是操作者"，不是"你格式写错了"
    const res = await post({ token: 'wrong', baseDomain: 'nope', email: 'x', password: 'y' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid-token' })
  })

  it('已配置 → 409，不再接受改动', async () => {
    app = await build({ configured: true })
    const res = await post(body())
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'already-configured' })
    expect(saved).toEqual([])
    expect(created).toEqual([])
  })

  it('没接 createAdmin（接线缺了）→ 409，不落域名：宁可不配，也别造出「有域名没账号」的死局', async () => {
    // 真把键删掉，而不是传 undefined —— tsconfig 开了 exactOptionalPropertyTypes，
    // 而且「没接」这个状态本来就该用"键不存在"表达
    const wired = deps()
    delete wired.createAdmin
    const instance = Fastify()
    registerSetupRoutes(instance, wired)
    await instance.ready()
    app = instance

    const res = await post(body())
    expect(res.statusCode).toBe(409)
    expect(saved).toEqual([])
  })

  it('域名形状不对 → 400 invalid-domain（没有点、大写、带路径都拒）', async () => {
    app = await build()
    for (const baseDomain of ['localhost', 'Example.com', 'example.com/evil', '']) {
      const res = await post(body({ baseDomain }))
      expect(res.statusCode, baseDomain).toBe(400)
      expect(res.json().error, baseDomain).toBe('invalid-domain')
    }
    expect(saved).toEqual([])
    expect(created).toEqual([])
  })

  it('账号字段不合格 → 400 invalid-account（邮箱形状、密码长度），且不建号', async () => {
    app = await build()
    const bad = [
      { email: 'not-an-email' },
      { email: 'admin@example.com', password: 'short' },
      { email: '' },
    ]
    for (const over of bad) {
      const res = await post(body(over))
      expect(res.statusCode, JSON.stringify(over)).toBe(400)
      expect(res.json().error, JSON.stringify(over)).toBe('invalid-account')
    }
    expect(created).toEqual([])
    expect(saved).toEqual([])
  })

  it('通过：建号 → 控制台默认就是父域 → 落库 → 安排重启', async () => {
    app = await build()
    const res = await post(body())
    expect(res.statusCode).toBe(200)
    expect(res.json().consoleDomain).toBe('example.com')
    expect(res.json().email).toBe('admin@example.com')
    // 回结构化结果（不是一句中文）：文案归双语的 UI 组
    expect(res.json().dns).toEqual({ probe: expect.stringContaining('.example.com'), resolved: true, workspaceResolved: true, consoleResolved: true })
    expect(created).toEqual([{ email: 'admin@example.com', password: 'correct-horse' }])
    expect(saved).toEqual([{ baseDomain: 'example.com', consoleDomain: 'example.com' }])

    // 重启挂在响应的 finish 上 —— 注入的响应跑完，回调应当已经触发
    await new Promise((r) => setTimeout(r, 10))
    expect(restarts).toBe(1)
  })

  it('邮箱已被占 → 409 account-exists，且**域名没落库**（先建号、后落域名的意义就在这）', async () => {
    app = await build({
      createAdmin: async () => {
        throw new AccountExistsError('admin@example.com')
      },
    })
    const res = await post(body())
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'account-exists' })
    expect(saved).toEqual([])
    expect(restarts).toBe(0)
  })

  it('泛解析查不到 → **只警告不拦**（解析可能是反代 / 生效中，平台判不了）', async () => {
    app = await build({ resolveSubdomain: async () => [] })
    const res = await post(body())
    expect(res.statusCode).toBe(200)
    expect(res.json().dns.resolved).toBe(false)
    // 只回事实、不拦：域名照样落库 —— 否则操作者会被卡在一个他无法从面板里修的状态
    expect(saved).toHaveLength(1)
  })

  /**
   * 探测端点：让向导页在**提交之前**就能显示解析通没通。
   * 提交那一步是有代价的（域名落库 → 带着它重启 → 解析错就进不去），所以这条只读端点
   * 必须：① 凭证照样是那枚 token；② 什么都不改。
   */
  describe('GET /api/setup/probe', () => {
    // token 走 **header**：放 query 里会被原样记进访问日志，而这枚 token 引导期就是唯一凭证
    const probe = (query: string, token = 'tok') =>
      app.inject({
        method: 'GET',
        url: `/api/setup/probe?${query}`,
        headers: { 'x-setup-token': token },
      })

    it('token 不对 → 401', async () => {
      app = await build()
      expect((await probe('baseDomain=example.com', 'wrong')).statusCode).toBe(401)
    })

    it('没带 token → 一样拒', async () => {
      app = await build()
      expect((await probe('baseDomain=example.com', '')).statusCode).toBe(401)
    })

    it('域名形状不对 → 400', async () => {
      app = await build()
      const res = await probe('baseDomain=localhost')
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'invalid-domain' })
    })

    it('解析得到 → resolved: true，并把控制台主机名一并算好回给界面（别让 UI 变成第四处副本）', async () => {
      app = await build()
      const res = await probe('baseDomain=example.com')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ resolved: true, consoleDomain: 'example.com', workspaceResolved: true, consoleResolved: true })
    })

    it('独立控制台未解析时，泛解析成功不能使检查通过', async () => {
      const queried: string[] = []
      app = await build({ resolveSubdomain: async hostname => {
        queried.push(hostname)
        return hostname === 'console.other.net' ? [] : ['203.0.113.7']
      } })
      const result = await probe('baseDomain=example.com&consoleDomain=console.other.net')
      expect(result.json()).toEqual({ resolved: false, workspaceResolved: true, consoleResolved: false, consoleDomain: 'console.other.net' })
      expect(queried).toContain('console.other.net')
      expect(queried.some(hostname => /^dsh-check-.*\.example\.com$/u.test(hostname))).toBe(true)
    })

    it('控制台可解析但泛解析失败时仍未通过', async () => {
      app = await build({ resolveSubdomain: async hostname => hostname === 'console.other.net' ? ['203.0.113.7'] : [] })
      const result = await probe('baseDomain=example.com&consoleDomain=console.other.net')
      expect(result.json()).toMatchObject({ resolved: false, workspaceResolved: false, consoleResolved: true })
    })

    it('父域本身当控制台主机名是合法的，会去查 DNS', async () => {
      let queries = 0
      app = await build({ resolveSubdomain: async () => { queries++; return ['203.0.113.7'] } })
      const res = await probe('baseDomain=example.com&consoleDomain=example.com')
      expect(res.statusCode).toBe(200)
      expect(res.json().consoleDomain).toBe('example.com')
      expect(queries).toBeGreaterThan(0)
    })

    it('非法控制台域名在 DNS 查询前拒绝', async () => {
      let queries = 0
      app = await build({ resolveSubdomain: async () => { queries++; return [] } })
      expect((await probe(`baseDomain=example.com&consoleDomain=${encodeURIComponent('bad/path')}`)).statusCode).toBe(400)
      expect(queries).toBe(0)
    })

    it('解析不到 → resolved: false（界面据此挡住提交）', async () => {
      app = await build({ resolveSubdomain: async () => [] })
      expect((await probe('baseDomain=example.com')).json().resolved).toBe(false)
    })

    it('**什么都没改**：没建号、没落域名、没重启', async () => {
      app = await build()
      await probe('baseDomain=example.com')
      expect(created).toEqual([])
      expect(saved).toEqual([])
      expect(restarts).toBe(0)
    })
  })
})
