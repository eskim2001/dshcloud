import { describe, expect, it } from 'vitest'
import { buildApp, type AppDeps } from '../app.js'

/**
 * 注册面清单（铁律 6）。
 *
 * 认证是**逐条 router 显式挂的**，漏挂不报错、不告警——它只表现为「照常 200」。
 * 所以「新增一个 GET 路由」必须是一次人工决定：加进这份清单，顺带想清楚
 * 「谁认证它、谁授权它」。有副作用的 GET（SSE 之类）尤其要在这里交代清楚。
 */
const ALLOWED_GET_ROUTES = [
  'GET /api/workspace/authorize', // Console session + DB owner check; browser transaction binds exchange.
  'GET /auth/verify', // 入口调它判定数据面（Traefik forward-auth）
  'GET /api/auth/*', // better-auth 自己的端点（登录 / 登出 / 会话）
  'GET /healthz', // 存活探针，无数据
  // 公开：回「配好没」+ 演示账号（运营方设了 DEMO_EMAIL / DEMO_PASSWORD 才有，登录页要它）。
  // 演示账号本来就是给任何访客用的，这个口子公开是**故意的**（见 setup-routes.ts）。
  'GET /api/setup/state',
  // 引导页边打字边问「这个父域解析通了没」。凭证是 URL 里那枚一次性 token（**不是**公开的
  // —— 它会让服务器去查 DNS），只读、不改任何状态。
  'GET /api/setup/probe',
  'GET /api/sessions', // 自己的会话列表
  // 实例面：全部带 owner 维度
  'GET /api/instances',
  'GET /api/images', // 建实例可选的已发布版本，登录即可
  'GET /api/instances/:id',
  'GET /api/instances/:id/stats',
  'GET /api/instances/:id/metrics',
  'GET /api/instances/:id/image',
  'GET /api/instances/:id/logs',
  // 管理面：全部要 admin
  'GET /api/admin/users',
  'GET /api/admin/instances',
  'GET /api/admin/instances/:id/image',
  'GET /api/admin/instances/:id/logs',
  'GET /api/admin/images',
  // 邀请列表：要 admin。**不含链接**——库里只存哈希，明文早就不存在了
  'GET /api/admin/invitations',
  // 有副作用的 GET：EventSource 只能 GET，起 docker pull 的那一下靠 admin 鉴权兜底
  'GET /api/admin/images/pull',
]

/**
 * **引导态**（还没配域名）的注册面：只有 setup 与存活探针。
 *
 * 这份清单比上面那份更要紧：那时平台**直接对外开着一个端口**（靠一次性 token 挡），
 * 所以**往里加任何一条都是一次显式决定** —— "多一条路由"在这里等于"多一个域名配好之前
 * 对外的口子"。业务路由一概不挂（`buildApp` 在那之前就返回了）。
 *
 * `probe` 是 2026-09-14 加的，理由记在这儿：提交域名那一步**不可逆**（落库 → 带着它重启），
 * 解析配错就把操作者关在门外。要把「解析通没通」提前到提交之前，只能让服务器代查一次 DNS。
 * 这条端点就是那个代价，范围卡在「**只读** + 要 token + 只回一个布尔和控制台主机名」。
 */
const BOOTSTRAP_ALLOWED_GET_ROUTES = [
  'GET /api/setup/state',
  'GET /api/setup/probe',
  'GET /healthz',
]

function dependencies(onRoute: AppDeps['onRoute'], bootstrap = false): AppDeps {
  return {
    env: {
      BASE_DOMAIN: 'app.example.com',
      CONSOLE_DOMAIN: 'console.app.example.com',
      PUBLIC_SCHEME: 'https',
      PLATFORM_SECRET: 'test-platform-secret',
      EXTRA_TRUSTED_ORIGINS: '',
      INSTANCE_IMAGE_REPO: 'ghcr.io/example/dsh-instance',
      INSTANCE_IMAGE_REGISTRY_USER: '',
      INSTANCE_IMAGE_REGISTRY_TOKEN: '',
    },
    auth: {
      handler: async () => new Response('{}'),
      api: { getSession: async () => null },
    },
    db: {},
    provisioner: {},
    orchestrator: {},
    storage: {},
    onRoute,
    ...(bootstrap ? { bootstrap: true } : {}),
  } as unknown as AppDeps
}

async function collect(bootstrap = false): Promise<Array<{ method: string; url: string }>> {
  const routes: Array<{ method: string; url: string }> = []
  const app = await buildApp(
    dependencies((route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method]
      for (const method of methods) {
        // HEAD 是 Fastify 给每条 GET 自动挂的，不是独立的路由面
        if (method !== 'HEAD') routes.push({ method, url: route.url })
      }
    }, bootstrap),
  )
  await app.ready()
  await app.close()
  return routes
}

describe('注册面：GET 必须逐一交代清楚', () => {
  it('实际注册的 GET 路由与白名单完全一致', async () => {
    const actual = (await collect())
      .filter((r) => r.method === 'GET')
      .map((r) => `${r.method} ${r.url}`)
      .sort()
    expect(actual).toEqual([...ALLOWED_GET_ROUTES].sort())
  })

  it('写操作只用 POST / PATCH / PUT / DELETE（没有把副作用藏在别的动词里）', async () => {
    const methods = new Set((await collect()).map((r) => r.method))
    // PUT 只给管理员改用户级模型凭据：幂等替换一份 map，仍然挂在 admin 钩子上。
    expect([...methods].sort()).toEqual(['DELETE', 'GET', 'PATCH', 'POST', 'PUT'])
  })
})

describe('引导态的注册面：只该有 setup 与存活探针', () => {
  it('GET 面就是那三条', async () => {
    const actual = (await collect(true))
      .filter((r) => r.method === 'GET')
      .map((r) => `${r.method} ${r.url}`)
      .sort()
    expect(actual).toEqual([...BOOTSTRAP_ALLOWED_GET_ROUTES].sort())
  })

  it('写操作只有 POST /api/setup 一条 —— 其余业务路由一概不挂', async () => {
    const writes = (await collect(true))
      .filter((r) => r.method !== 'GET')
      .map((r) => `${r.method} ${r.url}`)
      .sort()
    expect(writes).toEqual(['POST /api/setup'])
  })
})
