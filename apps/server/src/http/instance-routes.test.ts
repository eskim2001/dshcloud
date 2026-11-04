import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { machineName } from '@dsh-cloud/instance-spec'
import type { InstanceRow } from '../db/schema.js'
import type { Env } from '../env.js'
import {
  ImageRejectedError,
  MaxRunningExceededError,
  NoRollbackError,
  SlugConfirmMismatchError,
} from '../instance/provisioner.js'
import { registerInstanceRoutes, type InstanceOps, type InstanceRouteDeps } from './instance-routes.js'

const env = {
  PUBLIC_SCHEME: 'http',
  BASE_DOMAIN: 'app.example.com',
  CONSOLE_DOMAIN: 'console.app.example.com',
  INSTANCE_IMAGE_REPO: 'dsh-instance',
  PLATFORM_MAX_CPUS: 2,
  PLATFORM_MAX_MEMORY_MB: 2048,
  PLATFORM_MAX_PIDS: 512,
  PLATFORM_MAX_DISK_MB: 10_240,
  PLATFORM_MAX_RUNNING: 3,
  PLATFORM_IDLE_CULL_MINUTES: 45,
} as Env

const ME = 'user-1'
const OTHER = 'user-2'

function row(over: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: 'i-1',
    slug: 'alice',
    storageKey: 'alice',
    deletedAt: null,
    ownerId: ME,
    status: 'running',
    image: 'dsh-instance:0.1.0',
    previousImage: null,
    containerId: 'c-1',
    hostPort: null,
    cpus: 1,
    memoryMb: 2048,
    pidsLimit: 512,
    diskMb: 10_240,
    lastError: null,
    stoppedAt: null,
    lastActiveAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }
}

/**
 * 用户面**全部**路由。新增一条就加到这里——和 Fastify 实际注册的集合比对。
 * 用户面比管理面更怕漏挂：漏了就是「别人能操作你的实例」。
 */
const EXPECTED_ROUTES = [
  { method: 'GET', url: '/api/images' },
  { method: 'GET', url: '/api/instances' },
  { method: 'POST', url: '/api/instances' },
  { method: 'GET', url: '/api/instances/:id' },
  { method: 'POST', url: '/api/instances/:id/restart' },
  { method: 'POST', url: '/api/instances/:id/stop' },
  { method: 'POST', url: '/api/instances/:id/start' },
  { method: 'DELETE', url: '/api/instances/:id' },
  { method: 'GET', url: '/api/instances/:id/stats' },
  { method: 'GET', url: '/api/instances/:id/metrics' },
  { method: 'GET', url: '/api/instances/:id/image' },
  { method: 'POST', url: '/api/instances/:id/image' },
  { method: 'POST', url: '/api/instances/:id/image/rollback' },
  { method: 'GET', url: '/api/instances/:id/logs' },
]

interface CollectedRoute {
  method: string
  url: string
}

const call = (app: FastifyInstance, route: CollectedRoute) =>
  app.inject({ method: route.method as 'GET', url: route.url, payload: {} })

async function build(
  session: string | undefined,
  over: Partial<Omit<InstanceRouteDeps, 'provisioner'>> & { provisioner?: Partial<InstanceOps> } = {},
) {
  const app = Fastify()
  const { provisioner: ops, ...rest } = over
  const routes: CollectedRoute[] = []
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) {
      if (method !== 'HEAD') routes.push({ method, url: route.url })
    }
  })
  await registerInstanceRoutes(app, {
    env,
    provisioner: {
      create: async (input) => row({ slug: input.slug }),
      restart: async () => row(),
      stop: async () => row({ status: 'stopped' }),
      start: async () => row(),
      remove: async () => {},
      setImage: async () => row(),
      rollbackImage: async () => row(),
      ...ops,
    },
    listMine: async () => [],
    readInstanceLimit: async () => 3,
    readResourceQuotas: async () => ({
      cpuQuota: null,
      memoryMbQuota: null,
      pidsQuota: null,
      diskMbQuota: null,
    }),
    getById: async () => undefined,
    // 单测里没有 Docker：默认让它失败，路由回退到 DB 快照（原断言不受影响）。
    // 实时状态的合并逻辑在 runtime-status.test.ts 里单测，这里只测「接得对不对」。
    listContainerStates: async () => {
      throw new Error('单测没有 Docker')
    },
    readStats: async () => undefined,
    readDisk: async () => undefined,
    listMetrics: async () => [],
    listLocalImages: async () => [],
    listImageReleases: async () => [],
    readSnapshot: async () => undefined,
    readDiskAll: async () => undefined,
    streamLogs: async () => {},
    getUserId: async () => session,
    ...rest,
  })
  return { app, routes }
}

describe('实例面：注册面 = 测试面', () => {
  it('实际注册的路由集合与清单一致', async () => {
    const { routes } = await build(ME)
    const actual = routes.map((r) => `${r.method} ${r.url}`).sort()
    const expected = EXPECTED_ROUTES.map((r) => `${r.method} ${r.url}`).sort()
    expect(actual).toEqual(expected)
  })
})

describe('实例面：每条路由都要登录', () => {
  it('未登录 → 401', async () => {
    const { app, routes } = await build(undefined)
    for (const route of routes) {
      const res = await call(app, route)
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401)
    }
  })

  it('未登录不会落到编排上', async () => {
    const stop = vi.fn(async () => row({ status: 'stopped' }))
    const { app, routes } = await build(undefined, {
      provisioner: {
        create: async () => row(),
        restart: async () => row(),
        stop,
        start: async () => row(),
        remove: async () => {},
      },
      getById: async () => row(),
    })
    for (const route of routes) {
      await call(app, route)
    }
    expect(stop).not.toHaveBeenCalled()
  })
})

describe('实例面：不是 owner 一律 404（不泄漏 id 是否存在）', () => {
  const owned = EXPECTED_ROUTES.filter((r) => r.url.includes(':id')).map((r) => ({
    ...r,
    url: r.url.replace(':id', 'i-1'),
  }))

  it('别人的实例 → 404', async () => {
    const stop = vi.fn(async () => row())
    const remove = vi.fn(async () => {})
    const { app } = await build(ME, {
      getById: async () => row({ ownerId: OTHER }),
      provisioner: {
        create: async () => row(),
        restart: async () => row(),
        stop,
        start: async () => row(),
        remove,
      },
    })
    for (const route of owned) {
      const res = await call(app, route)
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(404)
    }
    expect(stop).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('实例不存在 → 404', async () => {
    const { app } = await build(ME, { getById: async () => undefined })
    for (const route of owned) {
      const res = await call(app, route)
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(404)
    }
  })
})

describe('实例面：生命周期动作', () => {
  it('停止 / 启动走编排并把新状态回给前端', async () => {
    const stop = vi.fn(async () => row({ status: 'stopped' }))
    const start = vi.fn(async () => row())
    const { app } = await build(ME, {
      getById: async () => row(),
      provisioner: {
        create: async () => row(),
        restart: async () => row(),
        stop,
        start,
        remove: async () => {},
      },
    })

    const stopped = await app.inject({ method: 'POST', url: '/api/instances/i-1/stop' })
    expect(stopped.statusCode).toBe(200)
    expect(stopped.json().instance.status).toBe('stopped')

    const started = await app.inject({ method: 'POST', url: '/api/instances/i-1/start' })
    expect(started.statusCode).toBe(200)
    expect(started.json().instance.status).toBe('running')

    expect(stop).toHaveBeenCalledWith('i-1')
    expect(start).toHaveBeenCalledWith('i-1')
  })

  it('删除带上子域名确认，并透传给编排（删除不可逆，必须过一道确认）', async () => {
    const remove = vi.fn(async () => {})
    const { app } = await build(ME, {
      getById: async () => row(),
      provisioner: {
        create: async () => row(),
        restart: async () => row(),
        stop: async () => row(),
        start: async () => row(),
        remove,
      },
    })

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/instances/i-1?confirmSlug=alice',
    })
    expect(res.statusCode).toBe(204)
    expect(remove).toHaveBeenCalledWith('i-1', { confirmSlug: 'alice' })
  })

  it('不带确认参数 → 400，编排根本不调', async () => {
    const remove = vi.fn(async () => {})
    const { app } = await build(ME, {
      getById: async () => row(),
      provisioner: {
        create: async () => row(),
        restart: async () => row(),
        stop: async () => row(),
        start: async () => row(),
        remove,
      },
    })

    const res = await app.inject({ method: 'DELETE', url: '/api/instances/i-1' })
    expect(res.statusCode).toBe(400)
    expect(remove).not.toHaveBeenCalled()
  })

  it('子域名对不上 → 400（编排拒绝，路由转成可读错误）', async () => {
    const { app } = await build(ME, {
      getById: async () => row(),
      provisioner: {
        create: async () => row(),
        restart: async () => row(),
        stop: async () => row(),
        start: async () => row(),
        remove: async () => {
          throw new SlugConfirmMismatchError()
        },
      },
    })

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/instances/i-1?purge=true&confirmSlug=nope',
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('实例面：用量', () => {
  it('实时快照：容器没跑 → null', async () => {
    const { app } = await build(ME, { getById: async () => row({ containerId: null }) })
    const res = await app.inject({ method: 'GET', url: '/api/instances/i-1/stats' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ stats: null })
  })

  it('实时快照：容器在跑 → 透传数值', async () => {
    const readStats = vi.fn(async () => ({ cpuPercent: 3.5, memMb: 210 }))
    const { app } = await build(ME, { getById: async () => row(), readStats })
    const res = await app.inject({ method: 'GET', url: '/api/instances/i-1/stats' })
    expect(res.json()).toEqual({ stats: { cpuPercent: 3.5, memMb: 210 } })
    expect(readStats).toHaveBeenCalledWith('c-1')
  })

  it('容器刚好被删 → 200 + null，不是 500', async () => {
    const { app } = await build(ME, {
      getById: async () => row(),
      readStats: async () => {
        throw new Error('No such container')
      },
    })
    const res = await app.inject({ method: 'GET', url: '/api/instances/i-1/stats' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ stats: null })
  })

  it('历史采样：默认 120 条，按实例维度查', async () => {
    const listMetrics = vi.fn(async () => [])
    const { app } = await build(ME, { getById: async () => row(), listMetrics })
    const res = await app.inject({ method: 'GET', url: '/api/instances/i-1/metrics' })
    expect(res.statusCode).toBe(200)
    expect(listMetrics).toHaveBeenCalledWith('i-1', 120)
  })

  it('历史采样：limit 越界 → 400', async () => {
    const { app } = await build(ME, { getById: async () => row() })
    const res = await app.inject({ method: 'GET', url: '/api/instances/i-1/metrics?limit=9999' })
    expect(res.statusCode).toBe(400)
  })
})

/**
 * 踩过的坑：详情页和设置页读的是单实例响应，而它曾经**没把磁盘用量传下去** ——
 * 于是那两页的「存储」永远显示「暂无数据」，列表页却正常（列表走的是 `readDiskAll`）。
 * 只在真机上现形：开发机没有池子，那里本来就该是「暂无数据」。
 */
describe('实例面：单实例响应必须带磁盘用量', () => {
  const disk = { usedMb: 123, quotaMb: 10_240, enforced: true }

  it('详情里带 diskUsedMb / diskEnforced', async () => {
    const { app } = await build(ME, { getById: async () => row(), readDisk: async () => disk })
    const res = await app.inject({ method: 'GET', url: '/api/instances/i-1' })
    expect(res.statusCode).toBe(200)
    expect(res.json().instance.diskUsedMb).toBe(123)
    expect(res.json().instance.diskEnforced).toBe(true)
  })

  it('读不到时是 undefined 而不是 0（页面据此显示「暂无数据」）', async () => {
    const { app } = await build(ME, { getById: async () => row(), readDisk: async () => undefined })
    const res = await app.inject({ method: 'GET', url: '/api/instances/i-1' })
    expect(res.json().instance.diskUsedMb).toBeUndefined()
    expect(res.json().instance.diskEnforced).toBe(false)
  })

  it('生命周期动作的响应也带（否则点一下「停止」，页面上的数字就没了）', async () => {
    const { app } = await build(ME, { getById: async () => row(), readDisk: async () => disk })
    const res = await app.inject({ method: 'POST', url: '/api/instances/i-1/stop' })
    expect(res.statusCode).toBe(200)
    expect(res.json().instance.diskUsedMb).toBe(123)
  })

  it('创建的新实例同样带（此时多半是 0）', async () => {
    const { app } = await build(ME, {
      readDisk: async () => ({ usedMb: 0, quotaMb: 10_240, enforced: true }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { slug: 'newbie' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().instance.diskUsedMb).toBe(0)
  })
})

describe('实例面：日志', () => {
  it('实例还没有容器 → 409，不去碰日志流', async () => {
    const streamLogs = vi.fn(async () => {})
    const { app } = await build(ME, { getById: async () => row({ containerId: null }), streamLogs })
    const res = await app.inject({ method: 'GET', url: '/api/instances/i-1/logs' })
    expect(res.statusCode).toBe(409)
    expect(streamLogs).not.toHaveBeenCalled()
  })

  it('tail 透传给日志流（默认 200）', async () => {
    const streamLogs = vi.fn(async (_req, reply) => {
      reply.hijack()
      reply.raw.end()
    })
    const { app } = await build(ME, { getById: async () => row(), streamLogs })

    await app.inject({ method: 'GET', url: '/api/instances/i-1/logs' })
    expect(streamLogs).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'c-1',
      { tail: 200 },
    )

    await app.inject({ method: 'GET', url: '/api/instances/i-1/logs?tail=50' })
    expect(streamLogs).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), 'c-1', {
      tail: 50,
    })
  })

  it('tail 越界 → 400', async () => {
    const { app } = await build(ME, { getById: async () => row() })
    const res = await app.inject({ method: 'GET', url: '/api/instances/i-1/logs?tail=99999' })
    expect(res.statusCode).toBe(400)
  })
})

describe('实例面：创建', () => {
  it('子域名不合法 → 400', async () => {
    const { app } = await build(ME)
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { slug: 'A!' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('保留字 → 400（政策只在创建期生效，见 provisioner 的存量实例用例）', async () => {
    const create = vi.fn()
    const { app } = await build(ME, { provisioner: { create } })
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { slug: 'grafana' },
    })
    expect(res.statusCode).toBe(400)
    // 具体原因要顶到 error 上——前端只显示它，「参数不合法」等于没说
    expect(res.json().error).toMatch(/保留字/)
    expect(create).not.toHaveBeenCalled()
  })

  it('slug 撞上控制台域名首段 → 400（静态保留字表之外的词也挡得住）', async () => {
    const create = vi.fn()
    const { app } = await build(ME, {
      env: { ...env, CONSOLE_DOMAIN: 'portal-x.app.example.com' },
      provisioner: { create },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { slug: 'portal-x' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/控制台域名/)
    expect(create).not.toHaveBeenCalled()
  })

  it('控制台就是父域时，父域首段不再被当成可抢的 label', async () => {
    const create = vi.fn(async (input: { slug: string; ownerId: string }) =>
      row({ slug: input.slug, ownerId: input.ownerId }),
    )
    const { app } = await build(ME, {
      env: { ...env, BASE_DOMAIN: 'workspace.example.com', CONSOLE_DOMAIN: 'workspace.example.com' },
      provisioner: { create },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { slug: 'workspace' },
    })
    expect(res.statusCode).toBe(201)
    expect(create).toHaveBeenCalled()
  })

  it('合法请求 → 201，owner 由会话决定而不是请求体', async () => {
    const create = vi.fn(async (input: { slug: string; ownerId: string }) =>
      row({ slug: input.slug, ownerId: input.ownerId }),
    )
    const { app } = await build(ME, {
      provisioner: {
        create,
        restart: async () => row(),
        stop: async () => row(),
        start: async () => row(),
        remove: async () => {},
      },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { slug: 'alice', ownerId: OTHER },
    })
    expect(res.statusCode).toBe(201)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'alice', ownerId: ME, cpus: 1, memoryMb: 2048 }),
    )
  })

  it('自选版本 → 透传给编排层', async () => {
    const create = vi.fn(async (input: { slug: string }) => row({ slug: input.slug }))
    const { app } = await build(ME, { provisioner: { create } })

    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { slug: 'alice', image: 'dsh-instance:0.1.1_1' },
    })
    expect(res.statusCode).toBe(201)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'dsh-instance:0.1.1_1' }),
    )
  })

  it('没有默认镜像版本 → 400，带编排层的原话（不是 500）', async () => {
    const { app } = await build(ME, {
      provisioner: {
        create: async () => {
          throw new ImageRejectedError('平台还没有默认镜像版本：先跑 db:seed')
        },
        restart: async () => row(),
        stop: async () => row(),
        start: async () => row(),
        remove: async () => {},
      },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { slug: 'alice' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/还没有默认镜像版本/)
  })

  it('超过该用户有效封顶 → 400，不调 create（即使仍低于平台）', async () => {
    const create = vi.fn()
    const { app } = await build(ME, {
      provisioner: { create },
      readResourceQuotas: async () => ({
        cpuQuota: 1,
        memoryMbQuota: 1024,
        pidsQuota: 256,
        diskMbQuota: 5120,
      }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { slug: 'alice', cpus: 2, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 },
    })
    expect(res.statusCode).toBe(400)
    expect(create).not.toHaveBeenCalled()
  })

  it('落在该用户有效封顶内 → 放行', async () => {
    const create = vi.fn(async (input: { slug: string }) => row({ slug: input.slug }))
    const { app } = await build(ME, {
      provisioner: { create },
      readResourceQuotas: async () => ({
        cpuQuota: 1,
        memoryMbQuota: 1024,
        pidsQuota: 256,
        diskMbQuota: 5120,
      }),
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { slug: 'alice', cpus: 1, memoryMb: 1024, pidsLimit: 256, diskMb: 5120 },
    })
    expect(res.statusCode).toBe(201)
    expect(create).toHaveBeenCalled()
  })

  it('超过平台资源封顶 → 400，不调 create', async () => {
    const create = vi.fn()
    const { app } = await build(ME, { provisioner: { create } })
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { slug: 'alice', cpus: 4, memoryMb: 8192 },
    })
    expect(res.statusCode).toBe(400)
    expect(create).not.toHaveBeenCalled()
  })

  it('同时 running 已满 → 409 + 中文错误', async () => {
    const { app } = await build(ME, {
      provisioner: {
        create: async () => {
          throw new MaxRunningExceededError(3, 3)
        },
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { slug: 'alice' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/同时运行的工作空间已达上限/)
  })

  it('列表带回 platformCaps', async () => {
    const { app } = await build(ME)
    const res = await app.inject({ method: 'GET', url: '/api/instances' })
    expect(res.statusCode).toBe(200)
    expect(res.json().platformCaps).toEqual({
      maxCpus: 2,
      maxMemoryMb: 2048,
      maxPids: 512,
      maxDiskMb: 10_240,
      maxRunning: 3,
      idleCullMinutes: 45,
    })
  })

  it('列表的 platformCaps 是当前用户的有效封顶', async () => {
    const { app } = await build(ME, {
      readResourceQuotas: async () => ({
        cpuQuota: 1,
        memoryMbQuota: null,
        pidsQuota: 128,
        diskMbQuota: null,
      }),
    })
    const res = await app.inject({ method: 'GET', url: '/api/instances' })
    expect(res.statusCode).toBe(200)
    expect(res.json().platformCaps).toMatchObject({
      maxCpus: 1,
      maxMemoryMb: 2048,
      maxPids: 128,
      maxDiskMb: 10_240,
      maxRunning: 3,
    })
  })

  it('start 撞 max-running → 409', async () => {
    const { app } = await build(ME, {
      getById: async () => row({ status: 'stopped' }),
      provisioner: {
        start: async () => {
          throw new MaxRunningExceededError(3, 3)
        },
      },
    })
    const res = await app.inject({ method: 'POST', url: '/api/instances/i-1/start' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/同时运行/)
  })
})

describe('实例面：状态以 Docker 为准', () => {
  it('DB 记着 running、容器在 crash-loop → 显示 restarting', async () => {
    const { app } = await build(ME, {
      listMine: async () => [row()],
      listContainerStates: async () =>
        new Map([
          [
            machineName('alice'),
            { state: 'restarting', statusText: 'Restarting (3) 20 seconds ago' },
          ],
        ]),
    })

    const res = await app.inject({ method: 'GET', url: '/api/instances' })
    expect(res.statusCode).toBe(200)
    const [instance] = res.json().instances
    expect(instance.status).toBe('restarting')
    expect(instance.statusText).toBe('Restarting (3) 20 seconds ago')
  })

  it('取不到实时状态 → 回退 DB 快照，不谎报「已停止」', async () => {
    const { app } = await build(ME, { listMine: async () => [row()] })

    const res = await app.inject({ method: 'GET', url: '/api/instances' })
    expect(res.json().instances[0].status).toBe('running')
  })
})

describe('实例面：版本', () => {
  it('建实例的可选版本：全部已发布，新的在前，默认版本单独标出来', async () => {
    const { app } = await build(ME, {
      listImageReleases: async () => [
        { id: 'r-1', ref: 'dsh-instance:0.1.0', isDefault: true, publishedAt: new Date(0) },
        { id: 'r-2', ref: 'dsh-instance:0.1.1', isDefault: false, publishedAt: new Date(1) },
        { id: 'r-3', ref: 'dsh-instance:0.1.2', isDefault: false, publishedAt: new Date(2) },
      ],
    })

    const res = await app.inject({ method: 'GET', url: '/api/images' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      default: 'dsh-instance:0.1.0',
      published: ['dsh-instance:0.1.2', 'dsh-instance:0.1.1', 'dsh-instance:0.1.0'],
    })
  })

  it('一个版本都没发布 → 空列表，不报错（页面显示「还没发布」）', async () => {
    const { app } = await build(ME)
    const res = await app.inject({ method: 'GET', url: '/api/images' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ default: null, published: [] })
  })

  it('只列**本地已有**的已发布版本——发布了但宿主上没有的不摆出来', async () => {
    const { app } = await build(ME, {
      getById: async () => row({ previousImage: 'dsh-instance:0.0.9' }),
      listImageReleases: async () => [
        { id: 'r-1', ref: 'dsh-instance:0.1.0', isDefault: true, publishedAt: new Date(0) },
        { id: 'r-2', ref: 'dsh-instance:0.1.1', isDefault: false, publishedAt: new Date(1) },
        { id: 'r-3', ref: 'dsh-instance:0.1.2', isDefault: false, publishedAt: new Date(2) },
      ],
      listLocalImages: async () => ['dsh-instance:0.1.1', 'alpine:3.20'],
      readSnapshot: async () => 42,
      readDiskAll: async () => undefined,
    })

    const res = await app.inject({ method: 'GET', url: '/api/instances/i-1/image' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      image: 'dsh-instance:0.1.0',
      previousImage: 'dsh-instance:0.0.9',
      stable: ['dsh-instance:0.1.1'],
      snapshotMb: 42,
    })
  })

  it('升级：透传目标版本，回新实例', async () => {
    const setImage = vi.fn(async () => row({ image: 'dsh-instance:0.1.1' }))
    const { app } = await build(ME, {
      getById: async () => row(),
      provisioner: { setImage },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/instances/i-1/image',
      payload: { image: 'dsh-instance:0.1.1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().instance.image).toBe('dsh-instance:0.1.1')
    expect(setImage).toHaveBeenCalledWith('i-1', 'dsh-instance:0.1.1')
  })

  it('用户面**不**传 allowAny——已发布列表由编排层兜底', async () => {
    const setImage = vi.fn(async () => row())
    const { app } = await build(ME, { getById: async () => row(), provisioner: { setImage } })
    await app.inject({
      method: 'POST',
      url: '/api/instances/i-1/image',
      payload: { image: 'dsh-instance:0.1.1' },
    })
    expect(setImage).toHaveBeenCalledWith('i-1', 'dsh-instance:0.1.1')
  })

  it('镜像被拒 / 没有可回滚的版本 → 400，带原话', async () => {
    const { app } = await build(ME, {
      getById: async () => row(),
      provisioner: {
        setImage: async () => {
          throw new ImageRejectedError('宿主上没有镜像 dsh-instance:9.9.9')
        },
        rollbackImage: async () => {
          throw new NoRollbackError()
        },
      },
    })

    const upgrade = await app.inject({
      method: 'POST',
      url: '/api/instances/i-1/image',
      payload: { image: 'dsh-instance:9.9.9' },
    })
    expect(upgrade.statusCode).toBe(400)
    expect(upgrade.json().error).toContain('宿主上没有镜像')

    const rollback = await app.inject({
      method: 'POST',
      url: '/api/instances/i-1/image/rollback',
    })
    expect(rollback.statusCode).toBe(400)
    expect(rollback.json().error).toContain('没有可回滚')
  })

  it('别人的实例 → 404，不泄漏 id 存在', async () => {
    const setImage = vi.fn(async () => row())
    const { app } = await build(ME, {
      getById: async () => row({ ownerId: OTHER }),
      provisioner: { setImage },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/instances/i-1/image',
      payload: { image: 'dsh-instance:0.1.1' },
    })
    expect(res.statusCode).toBe(404)
    expect(setImage).not.toHaveBeenCalled()
  })
})
