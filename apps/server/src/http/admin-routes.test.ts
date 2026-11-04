import { Readable } from 'node:stream'
import Fastify, { type FastifyInstance } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { AccountExistsError } from '../account.js'
import type { Env } from '../env.js'
import { RegistryError } from '../instance/image-sync.js'
import { ImageRejectedError, NoRollbackError } from '../instance/provisioner.js'
import { registerAdminRoutes, type AdminRouteDeps } from './admin-routes.js'

const env = {
  MAX_INSTANCES_PER_USER: 3,
  INSTANCE_IMAGE_REPO: 'dsh-instance',
  PLATFORM_MAX_CPUS: 2,
  PLATFORM_MAX_MEMORY_MB: 2048,
  PLATFORM_MAX_PIDS: 512,
  PLATFORM_MAX_DISK_MB: 10_240,
  PLATFORM_MAX_RUNNING: 3,
  PLATFORM_IDLE_CULL_MINUTES: 45,
  BASE_DOMAIN: 'app.example.com',
  CONSOLE_DOMAIN: 'app.example.com',
} as Env

const ADMIN = { id: 'admin-1', role: 'admin' }
const USER = { id: 'user-1', role: 'user' }

const release = (ref: string, isDefault = false) => ({
  id: `r-${ref}`,
  ref,
  isDefault,
  publishedAt: new Date(0),
})

/**
 * 管理面**全部**路由。新增一条就要加到这里——下面会拿它和 Fastify 实际
 * 注册的路由做集合比对，对不上就红。这是「漏挂一条路由不会报错，只有洞」
 * 的机械化防线：手写清单会跟着人一起忘，集合比对不会。
 */
const EXPECTED_ROUTES = [
  { method: 'GET', url: '/api/admin/users' },
  { method: 'POST', url: '/api/admin/users' },
  { method: 'GET', url: '/api/admin/instances' },
  { method: 'POST', url: '/api/admin/users/:id/ban' },
  { method: 'POST', url: '/api/admin/users/:id/unban' },
  { method: 'PATCH', url: '/api/admin/users/:id/quota' },
  { method: 'PATCH', url: '/api/admin/users/:id/role' },
  { method: 'PATCH', url: '/api/admin/instances/:id/quota' },
  { method: 'GET', url: '/api/admin/instances/:id/image' },
  { method: 'PATCH', url: '/api/admin/instances/:id/image' },
  { method: 'POST', url: '/api/admin/instances/:id/image/rollback' },
  { method: 'GET', url: '/api/admin/instances/:id/logs' },
  { method: 'GET', url: '/api/admin/images' },
  { method: 'GET', url: '/api/admin/images/pull' },
  { method: 'POST', url: '/api/admin/images' },
  { method: 'POST', url: '/api/admin/images/sync' },
  { method: 'DELETE', url: '/api/admin/images' },
  { method: 'PATCH', url: '/api/admin/images/default' },
  { method: 'GET', url: '/api/admin/invitations' },
  { method: 'POST', url: '/api/admin/invitations' },
  { method: 'DELETE', url: '/api/admin/invitations/:id' },
]

const ATTACKS = EXPECTED_ROUTES.map((r) => ({ ...r, url: r.url.replace(':id', 'user-1') }))

interface CollectedRoute {
  method: string
  url: string
}

/**
 * 打一条请求。`route.method` 是 onRoute 收上来的 string，而 inject 只收字面量联合
 * （fastify 自己的 HTTPMethods 比它宽一个 'search'，两边对不上），这里做一次类型收口。
 * 运行时传的就是原始字符串，没有改动。
 */
const call = (app: FastifyInstance, route: CollectedRoute) =>
  app.inject({ method: route.method as 'GET', url: route.url, payload: {} })

async function build(
  session: { id: string; role: string } | undefined,
  over: Partial<AdminRouteDeps> = {},
) {
  const app = Fastify()
  const routes: CollectedRoute[] = []
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    // Fastify 给每个 GET 自动配一个 HEAD，它和 GET 共用 handler 和钩子，不用单测
    for (const method of methods) {
      if (method !== 'HEAD') routes.push({ method, url: route.url })
    }
  })
  await registerAdminRoutes(app, {
    env,
    listUsers: async () => [],
    listInstances: async () => [],
    countRunning: async () => 0,
    // 单测里没有 Docker：默认让它失败，路由回退到 DB 快照
    listContainerStates: async () => {
      throw new Error('单测没有 Docker')
    },
    ban: async () => true,
    unban: async () => true,
    setQuota: async () => true,
    findOwnerResourceQuotas: async () => ({
      cpuQuota: null,
      memoryMbQuota: null,
      pidsQuota: null,
      diskMbQuota: null,
    }),
    setRole: async () => 'ok',
    setInstanceQuota: async () => true,
    findInstanceContainer: async () => null,
    findInstanceImage: async () => ({ storageKey: 'alice', image: 'dsh-instance:0.1.0', previousImage: null }),
    listLocalImages: async () => [],
    // 默认有一版已发布的默认镜像——版本管理用例自己覆盖
    listImageReleases: async () => [release('dsh-instance:0.1.0_1', true)],
    listImageCatalog: async () => [],
    syncImages: async () => ({ count: 0, skipped: 0, syncedAt: new Date(0) }),
    pullImageStream: async () => Readable.from([]),
    publishImage: async () => 'ok' as const,
    unpublishImage: async () => 'ok' as const,
    setDefaultImage: async () => true,
    readSnapshot: async () => undefined,
    readDiskAll: async () => undefined,
    setInstanceImage: async () => true,
    rollbackInstanceImage: async () => true,
    streamLogs: async () => {},
    getSessionUser: async () => session,
    createUser: async (input) => ({ id: 'created', email: input.email }),
    // 邀请：默认能生成。用例自己覆盖「邮箱已存在 / 已有待接受邀请」
    createInvite: async () => ({
      ok: true as const,
      url: 'https://console.test/invite/tok',
      expiresAt: new Date(0),
    }),
    listInvites: async () => [],
    revokeInvite: async () => true,
    ...over,
  })
  return { app, routes }
}

describe('平台管理面：注册面 = 测试面', () => {
  it('实际注册的路由集合与清单一致', async () => {
    const { routes } = await build(ADMIN)
    const actual = routes.map((r) => `${r.method} ${r.url}`).sort()
    const expected = EXPECTED_ROUTES.map((r) => `${r.method} ${r.url}`).sort()
    expect(actual).toEqual(expected)
  })
})

describe('平台管理面：每条路由都必须过 admin 钩子', () => {
  it('未登录 → 401', async () => {
    const { app, routes } = await build(undefined)
    for (const route of routes) {
      const res = await call(app, route)
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401)
    }
  })

  it('登录了但不是管理员 → 403', async () => {
    const { app, routes } = await build(USER)
    for (const route of routes) {
      const res = await call(app, route)
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(403)
    }
  })

  it('非管理员触发的动作不会落到回调上', async () => {
    const ban = vi.fn(async () => true)
    const setQuota = vi.fn(async () => true)
    const setRole = vi.fn(async () => 'ok' as const)
    const setInstanceQuota = vi.fn(async () => true)
    const setInstanceImage = vi.fn(async () => true)
    const rollbackInstanceImage = vi.fn(async () => true)
    const publishImage = vi.fn(async () => 'ok' as const)
    const unpublishImage = vi.fn(async () => 'ok' as const)
    const setDefaultImage = vi.fn(async () => true)
    const syncImages = vi.fn(async () => ({ count: 0, skipped: 0, syncedAt: new Date(0) }))
    const pullImageStream = vi.fn(async () => Readable.from([]))
    const createUser = vi.fn(async (input: { email: string }) => ({ id: 'created', email: input.email }))
    const { app } = await build(USER, {
      ban,
      setQuota,
      setRole,
      setInstanceQuota,
      setInstanceImage,
      rollbackInstanceImage,
      publishImage,
      unpublishImage,
      setDefaultImage,
      syncImages,
      pullImageStream,
      createUser,
    })
    for (const route of ATTACKS) {
      await call(app, route)
    }
    expect(ban).not.toHaveBeenCalled()
    expect(setQuota).not.toHaveBeenCalled()
    expect(setRole).not.toHaveBeenCalled()
    expect(setInstanceQuota).not.toHaveBeenCalled()
    expect(setInstanceImage).not.toHaveBeenCalled()
    expect(rollbackInstanceImage).not.toHaveBeenCalled()
    expect(publishImage).not.toHaveBeenCalled()
    expect(unpublishImage).not.toHaveBeenCalled()
    expect(setDefaultImage).not.toHaveBeenCalled()
    expect(syncImages).not.toHaveBeenCalled()
    expect(pullImageStream).not.toHaveBeenCalled()
    expect(createUser).not.toHaveBeenCalled()
  })

  it('普通账号不能用请求体和身份头把自己提升为管理员', async () => {
    const setRole = vi.fn(async () => 'ok' as const)
    const { app } = await build(USER, { setRole })
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${USER.id}/role`,
      headers: {
        'x-user-role': 'admin',
        'x-user-id': ADMIN.id,
        'x-platform-instance': 'admin',
      },
      payload: { role: 'admin', userId: ADMIN.id },
    })
    expect(res.statusCode).toBe(403)
    expect(setRole).not.toHaveBeenCalled()
  })
})

describe('平台管理面：管理员路径', () => {
  it('用户列表带平台默认上限', async () => {
    const { app } = await build(ADMIN)
    const res = await app.inject({ method: 'GET', url: '/api/admin/users' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      users: [],
      maxInstancesPerUser: 3,
      platformCaps: {
        maxCpus: 2,
        maxMemoryMb: 2048,
        maxPids: 512,
        maxDiskMb: 10_240,
        maxRunning: 3,
        idleCullMinutes: 45,
      },
    })
  })

  it('不能封禁自己', async () => {
    const { app } = await build(ADMIN)
    const res = await app.inject({
      method: 'POST',
      url: `/api/admin/users/${ADMIN.id}/ban`,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('封禁把原因透传给回调（回调负责顺带踢会话）', async () => {
    const ban = vi.fn(async () => true)
    const { app } = await build(ADMIN, { ban })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/u-x/ban',
      payload: { reason: '刷接口' },
    })
    expect(res.statusCode).toBe(200)
    expect(ban).toHaveBeenCalledWith('u-x', '刷接口')
  })

  it('封禁不带原因 → null', async () => {
    const ban = vi.fn(async () => true)
    const { app } = await build(ADMIN, { ban })
    await app.inject({ method: 'POST', url: '/api/admin/users/u-x/ban', payload: {} })
    expect(ban).toHaveBeenCalledWith('u-x', null)
  })

  it('目标用户不存在 → 404', async () => {
    const { app } = await build(ADMIN, { ban: async () => false })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users/nobody/ban',
      payload: {},
    })
    expect(res.statusCode).toBe(404)
  })

  it('配额越界 / 非整数 → 400', async () => {
    const { app } = await build(ADMIN)
    for (const quota of [999, -1, 1.5]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/u-x/quota',
        payload: { quota },
      })
      expect(res.statusCode, `quota=${quota}`).toBe(400)
    }
  })

  it('配额可清空为 null（回落到平台默认）', async () => {
    const setQuota = vi.fn(async () => true)
    const { app } = await build(ADMIN, { setQuota })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users/u-x/quota',
      payload: { quota: null },
    })
    expect(res.statusCode).toBe(200)
    expect(setQuota).toHaveBeenCalledWith('u-x', { instanceQuota: null })
  })

  it('用户列表回显每用户资源封顶', async () => {
    const { app } = await build(ADMIN, {
      listUsers: async () => [
        {
          id: 'u-x',
          email: 'ada@example.com',
          name: 'Ada',
          role: 'user',
          banned: false,
          banReason: null,
          instanceQuota: 2,
          cpuQuota: 1,
          memoryMbQuota: 1024,
          pidsQuota: 256,
          diskMbQuota: 5120,
          instanceCount: 1,
          createdAt: new Date(0),
        },
      ],
    })
    const res = await app.inject({ method: 'GET', url: '/api/admin/users' })
    expect(res.statusCode).toBe(200)
    expect(res.json().users[0]).toMatchObject({
      instanceQuota: 2,
      cpuQuota: 1,
      memoryMbQuota: 1024,
      pidsQuota: 256,
      diskMbQuota: 5120,
    })
  })

  it('每用户资源封顶：高于平台 → 400，不写库', async () => {
    const setQuota = vi.fn(async () => true)
    const { app } = await build(ADMIN, { setQuota })
    const over = [
      { cpuQuota: 4 },
      { memoryMbQuota: 4096 },
      { pidsQuota: 1024 },
      { diskMbQuota: 20_480 },
      { diskMbQuota: 64 },
      { cpuQuota: 0 },
    ]
    for (const payload of over) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/u-x/quota',
        payload,
      })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(setQuota).not.toHaveBeenCalled()
  })

  it('每用户资源封顶：封顶内写入，null 表示清掉个人覆盖', async () => {
    const setQuota = vi.fn(async () => true)
    const { app } = await build(ADMIN, { setQuota })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users/u-x/quota',
      payload: { cpuQuota: 1, memoryMbQuota: 1024, pidsQuota: 256, diskMbQuota: null },
    })
    expect(res.statusCode).toBe(200)
    expect(setQuota).toHaveBeenCalledWith('u-x', {
      cpuQuota: 1,
      memoryMbQuota: 1024,
      pidsQuota: 256,
      diskMbQuota: null,
    })
  })

  it('改角色：角色原样透传给回调', async () => {
    const setRole = vi.fn(async () => 'ok' as const)
    const { app } = await build(ADMIN, { setRole })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users/u-x/role',
      payload: { role: 'admin' },
    })
    expect(res.statusCode).toBe(200)
    expect(setRole).toHaveBeenCalledWith('u-x', 'admin')
  })

  it('改角色：角色值非法 → 400，不动回调', async () => {
    const setRole = vi.fn(async () => 'ok' as const)
    const { app } = await build(ADMIN, { setRole })
    for (const role of ['root', 'Admin', '', null, 1]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/users/u-x/role',
        payload: { role },
      })
      expect(res.statusCode, `role=${String(role)}`).toBe(400)
    }
    expect(setRole).not.toHaveBeenCalled()
  })

  it('改角色：用户不存在 → 404', async () => {
    const { app } = await build(ADMIN, { setRole: async () => 'missing' })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users/nobody/role',
      payload: { role: 'admin' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('改角色：降级最后一名管理员 → 400 + 服务端文案', async () => {
    const { app } = await build(ADMIN, { setRole: async () => 'last-admin' })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/users/u-x/role',
      payload: { role: 'user' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('最后一名管理员')
  })

  it('改实例配额：越界 / 非整数 → 400，不动回调', async () => {
    const setInstanceQuota = vi.fn(async () => true)
    const { app } = await build(ADMIN, { setInstanceQuota })
    const bad = [
      { cpus: 0, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 },
      { cpus: 1, memoryMb: 1.5, pidsLimit: 512, diskMb: 10_240 },
      { cpus: 1, memoryMb: 2048, pidsLimit: 99_999, diskMb: 10_240 },
      { cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 64 }, // 磁盘太小
      { cpus: 1, memoryMb: 2048 }, // 缺字段
      { cpus: 4, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 }, // 超平台 CPU 封顶
      { cpus: 2, memoryMb: 4096, pidsLimit: 512, diskMb: 10_240 }, // 超平台内存封顶
    ]
    for (const payload of bad) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/admin/instances/i-x/quota',
        payload,
      })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(setInstanceQuota).not.toHaveBeenCalled()
  })

  it('改实例配额：实例不存在 → 404', async () => {
    const setInstanceQuota = vi.fn(async () => true)
    const { app } = await build(ADMIN, {
      setInstanceQuota,
      findOwnerResourceQuotas: async () => undefined,
    })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/instances/nope/quota',
      payload: { cpus: 2, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 },
    })
    expect(res.statusCode).toBe(404)
    expect(setInstanceQuota).not.toHaveBeenCalled()
  })

  it('改实例配额：超过 owner 的每用户封顶 → 400（即使仍低于平台）', async () => {
    const setInstanceQuota = vi.fn(async () => true)
    const { app } = await build(ADMIN, {
      setInstanceQuota,
      findOwnerResourceQuotas: async () => ({
        cpuQuota: 1,
        memoryMbQuota: null,
        pidsQuota: null,
        diskMbQuota: null,
      }),
    })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/instances/i-x/quota',
      payload: { cpus: 2, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 },
    })
    expect(res.statusCode).toBe(400)
    expect(setInstanceQuota).not.toHaveBeenCalled()
  })

  it('改实例配额：旧的「回调返回 false」仍是 404', async () => {
    const { app } = await build(ADMIN, { setInstanceQuota: async () => false })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/instances/nope/quota',
      payload: { cpus: 2, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 },
    })
    expect(res.statusCode).toBe(404)
  })

  it('改实例配额：四元组原样透传给回调', async () => {
    const setInstanceQuota = vi.fn(async () => true)
    const { app } = await build(ADMIN, { setInstanceQuota })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/instances/i-x/quota',
      payload: { cpus: 2, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 },
    })
    expect(res.statusCode).toBe(200)
    expect(setInstanceQuota).toHaveBeenCalledWith('i-x', {
      cpus: 2,
      memoryMb: 2048,
      pidsLimit: 512,
      diskMb: 10_240,
    })
  })

  it('舰队列表带回 runningCount / maxRunning / platformCaps', async () => {
    const { app } = await build(ADMIN, { countRunning: async () => 2 })
    const res = await app.inject({ method: 'GET', url: '/api/admin/instances' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      instances: [],
      runningCount: 2,
      maxRunning: 3,
      platformCaps: {
        maxCpus: 2,
        maxMemoryMb: 2048,
        maxPids: 512,
        maxDiskMb: 10_240,
        maxRunning: 3,
        idleCullMinutes: 45,
      },
    })
  })

  it('改盘失败（配额设不上）→ 交给默认错误处理，不再当请求侧错误', async () => {
    const { app } = await build(ADMIN, {
      setInstanceQuota: async () => {
        throw new Error('xfs_quota: not permitted')
      },
    })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/instances/i-x/quota',
      payload: { cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 1_024 },
    })
    // 池化之后扩和缩都合法 —— 设不上限额是**服务端**故障（缺 capability / 池子没就绪），
    // 不是"这个请求不合法"，所以不再是 400。
    expect(res.statusCode).toBe(500)
  })

  it('看日志：实例不存在 → 404，还没容器 → 409', async () => {
    const { app } = await build(ADMIN, { findInstanceContainer: async () => undefined })
    const missing = await app.inject({ method: 'GET', url: '/api/admin/instances/nope/logs' })
    expect(missing.statusCode).toBe(404)

    const { app: noContainer } = await build(ADMIN, { findInstanceContainer: async () => null })
    const empty = await noContainer.inject({ method: 'GET', url: '/api/admin/instances/i-x/logs' })
    expect(empty.statusCode).toBe(409)
  })

  it('看版本：管理员拿到本地全部**平台**镜像（不受已发布列表限制，但别人的镜像不列）', async () => {
    const { app } = await build(ADMIN, {
      findInstanceImage: async () => ({
        storageKey: 'alice',
        image: 'dsh-instance:0.1.0',
        previousImage: 'dsh-instance:0.0.9',
      }),
      listLocalImages: async () => ['dsh-instance:0.1.1', 'dsh-instance:0.1.0', 'alpine:3.20'],
      readSnapshot: async () => 128,
      readDiskAll: async () => undefined,
    })

    const res = await app.inject({ method: 'GET', url: '/api/admin/instances/i-x/image' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      image: 'dsh-instance:0.1.0',
      previousImage: 'dsh-instance:0.0.9',
      // alpine 换不上去（准入按仓库拒），所以根本不该出现在选择列表里
      local: ['dsh-instance:0.1.1', 'dsh-instance:0.1.0'],
      snapshotMb: 128,
    })
  })

  it('看版本：实例不存在 → 404', async () => {
    const { app } = await build(ADMIN, { findInstanceImage: async () => undefined })
    const res = await app.inject({ method: 'GET', url: '/api/admin/instances/nope/image' })
    expect(res.statusCode).toBe(404)
  })

  it('换镜像：透传目标版本', async () => {
    const setInstanceImage = vi.fn(async () => true)
    const { app } = await build(ADMIN, { setInstanceImage })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/instances/i-x/image',
      payload: { image: 'dsh-instance:0.1.1' },
    })
    expect(res.statusCode).toBe(200)
    expect(setInstanceImage).toHaveBeenCalledWith('i-x', 'dsh-instance:0.1.1')
  })

  it('换镜像：实例不存在 → 404，镜像被拒 → 400 带原话', async () => {
    const { app } = await build(ADMIN, { setInstanceImage: async () => false })
    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/admin/instances/nope/image',
      payload: { image: 'dsh-instance:0.1.1' },
    })
    expect(missing.statusCode).toBe(404)

    const { app: rejected } = await build(ADMIN, {
      setInstanceImage: async () => {
        throw new ImageRejectedError('宿主上没有镜像 dsh-instance:9.9.9')
      },
    })
    const bad = await rejected.inject({
      method: 'PATCH',
      url: '/api/admin/instances/i-x/image',
      payload: { image: 'dsh-instance:9.9.9' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toContain('宿主上没有镜像')
  })

  it('回滚：没有快照 → 400', async () => {
    const { app } = await build(ADMIN, {
      rollbackInstanceImage: async () => {
        throw new NoRollbackError()
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/instances/i-x/image/rollback',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('没有可回滚')
  })
})

describe('平台管理面：镜像目录与三态（D23）', () => {
  const cat = (ref: string, digest: string) => ({
    ref,
    digest,
    syncedAt: new Date('2026-09-10T00:00:00Z'),
  })

  it('列表：catalog ∪ 已上架 ∪ 本机缓存，published/onHost 派生 + digest + 同步时间，新版本在前', async () => {
    const { app } = await build(ADMIN, {
      listImageCatalog: async () => [
        cat('dsh-instance:0.1.2_2', 'sha256:2222'),
        cat('dsh-instance:0.1.2_1', 'sha256:1111'),
      ],
      listImageReleases: async () => [release('dsh-instance:0.1.2_2', true)],
      // alpine 是别人的镜像，不该出现；0.1.1_3 只在宿主上，不在 catalog 里
      listLocalImages: async () => ['dsh-instance:0.1.2_2', 'dsh-instance:0.1.1_3', 'alpine:3.20'],
    })

    const res = await app.inject({ method: 'GET', url: '/api/admin/images' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      syncedAt: '2026-09-10T00:00:00.000Z',
      images: [
        {
          ref: 'dsh-instance:0.1.2_2',
          published: true,
          onHost: true,
          isDefault: true,
          publishedAt: '1970-01-01T00:00:00.000Z',
          digest: 'sha256:2222',
        },
        {
          ref: 'dsh-instance:0.1.2_1',
          published: false,
          onHost: false,
          isDefault: false,
          publishedAt: null,
          digest: 'sha256:1111',
        },
        {
          ref: 'dsh-instance:0.1.1_3',
          published: false,
          onHost: true,
          isDefault: false,
          publishedAt: null,
          digest: null,
        },
      ],
    })
  })

  it('列表：从没同步过 → syncedAt 为 null，只剩宿主上那一版', async () => {
    const { app } = await build(ADMIN, {
      listImageReleases: async () => [],
      listImageCatalog: async () => [],
      listLocalImages: async () => ['dsh-instance:0.1.0_1'],
    })
    const res = await app.inject({ method: 'GET', url: '/api/admin/images' })
    expect(res.json()).toEqual({
      syncedAt: null,
      images: [
        {
          ref: 'dsh-instance:0.1.0_1',
          published: false,
          onHost: true,
          isDefault: false,
          publishedAt: null,
          digest: null,
        },
      ],
    })
  })

  it('同步：透传结果；注册表不可达 → 502（是上游故障，不是平台 500）', async () => {
    const syncImages = vi.fn(async () => ({
      count: 2,
      skipped: 1,
      syncedAt: new Date('2026-09-10T01:02:03Z'),
    }))
    const { app } = await build(ADMIN, { syncImages })
    const res = await app.inject({ method: 'POST', url: '/api/admin/images/sync' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ count: 2, skipped: 1, syncedAt: '2026-09-10T01:02:03.000Z' })

    const { app: broken } = await build(ADMIN, {
      syncImages: async () => {
        throw new RegistryError('拿不到 ghcr.io 的拉取凭据（HTTP 503）')
      },
    })
    const failed = await broken.inject({ method: 'POST', url: '/api/admin/images/sync' })
    expect(failed.statusCode).toBe(502)
    expect(failed.json().error).toContain('HTTP 503')
  })

  it('下载：ref 非法 / 非平台仓库 / 形状不对 → 400，且不碰 docker', async () => {
    const pullImageStream = vi.fn(async () => Readable.from([]))
    const { app } = await build(ADMIN, { pullImageStream })

    const bad = ['', 'not a ref', 'evil/backdoor:0.1.0_1', 'dsh-instance:latest', 'dsh-instance:0.1.0']
    for (const ref of bad) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/images/pull?ref=${encodeURIComponent(ref)}`,
      })
      expect(res.statusCode, ref).toBe(400)
    }
    expect(pullImageStream).not.toHaveBeenCalled()
  })

  it('下载：打不开拉取流 → 200 + 流内 error 事件（EventSource 读不到 502 的 body）', async () => {
    const { app } = await build(ADMIN, {
      pullImageStream: async () => {
        throw new Error('no matching manifest for linux/arm64/v8')
      },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/images/pull?ref=${encodeURIComponent('dsh-instance:0.1.0_1')}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('event: error')
    expect(res.payload).toContain('no matching manifest for linux/arm64/v8')
  })

  it('发布：上游和本机都没有 → 400（先点「同步」）', async () => {
    const publishImage = vi.fn(async () => 'ok' as const)
    const { app } = await build(ADMIN, {
      publishImage,
      listImageCatalog: async () => [],
      listLocalImages: async () => [],
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/images',
      payload: { ref: 'dsh-instance:0.1.1_1' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('上游没有镜像')
    expect(publishImage).not.toHaveBeenCalled()
  })

  /**
   * 回归红线：上架**不要求本机已经缓存**。运行时按需拉取（`create` 的 pullPolicy
   * 默认 `if-missing`），要求先下载的话全新安装根本发不出第一版 ——
   * 没有 release 就没有默认版本，建实例直接 400，是一条死锁。
   */
  it('发布：上游见过、本机没缓存 → 200（不要求先下载，`defaultIfFirst` 传 true）', async () => {
    const publishImage = vi.fn(async () => 'ok' as const)
    const { app } = await build(ADMIN, {
      publishImage,
      listImageCatalog: async () => [cat('dsh-instance:0.1.1_1', 'sha256:abc')],
      listLocalImages: async () => [],
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/images',
      payload: { ref: 'dsh-instance:0.1.1_1' },
    })
    expect(res.statusCode).toBe(200)
    expect(publishImage).toHaveBeenCalledWith('dsh-instance:0.1.1_1', true)
  })

  it('发布：不是平台自己的仓库 → 400', async () => {
    const { app } = await build(ADMIN, {
      listLocalImages: async () => ['evil/backdoor:0.1.0_1'],
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/images',
      payload: { ref: 'evil/backdoor:0.1.0_1' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('只能发布平台自己的镜像')
  })

  it('发布：tag 不是发布序列的形状（:latest）→ 400，哪怕宿主上真有', async () => {
    const publishImage = vi.fn(async () => 'ok' as const)
    const { app } = await build(ADMIN, {
      publishImage,
      listLocalImages: async () => ['dsh-instance:latest'],
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/images',
      payload: { ref: 'dsh-instance:latest' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('不符合发布序列')
    expect(publishImage).not.toHaveBeenCalled()
  })

  it('发布：版本表为空也能发第一版（仓库名来自配置，不靠 seed 引导）', async () => {
    const publishImage = vi.fn(async () => 'ok' as const)
    const { app } = await build(ADMIN, {
      publishImage,
      listImageReleases: async () => [],
      listLocalImages: async () => ['dsh-instance:0.1.0_1'],
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/images',
      payload: { ref: 'dsh-instance:0.1.0_1' },
    })
    expect(res.statusCode).toBe(200)
    expect(publishImage).toHaveBeenCalledWith('dsh-instance:0.1.0_1', true)
  })

  it('发布：正常 → 200；已存在 → 409', async () => {
    const publishImage = vi.fn(async () => 'ok' as const)
    const { app } = await build(ADMIN, {
      publishImage,
      listLocalImages: async () => ['dsh-instance:0.1.1_1'],
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/images',
      payload: { ref: 'dsh-instance:0.1.1_1' },
    })
    expect(res.statusCode).toBe(200)
    expect(publishImage).toHaveBeenCalledWith('dsh-instance:0.1.1_1', true)

    const { app: dup } = await build(ADMIN, {
      publishImage: async () => 'exists' as const,
      listLocalImages: async () => ['dsh-instance:0.1.1_1'],
    })
    const again = await dup.inject({
      method: 'POST',
      url: '/api/admin/images',
      payload: { ref: 'dsh-instance:0.1.1_1' },
    })
    expect(again.statusCode).toBe(409)
  })

  it('下架：没发布过 → 404；默认版本 → 400', async () => {
    const { app } = await build(ADMIN, { unpublishImage: async () => 'missing' as const })
    const missing = await app.inject({
      method: 'DELETE',
      url: '/api/admin/images',
      payload: { ref: 'dsh-instance:0.9.9_1' },
    })
    expect(missing.statusCode).toBe(404)

    const { app: isDefault } = await build(ADMIN, { unpublishImage: async () => 'default' as const })
    const blocked = await isDefault.inject({
      method: 'DELETE',
      url: '/api/admin/images',
      payload: { ref: 'dsh-instance:0.1.0_1' },
    })
    expect(blocked.statusCode).toBe(400)
    expect(blocked.json().error).toContain('默认版本不能下架')
  })

  it('设为默认：没发布过 → 404；正常 → 200', async () => {
    const setDefaultImage = vi.fn(async () => true)
    const { app } = await build(ADMIN, { setDefaultImage })
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/admin/images/default',
      payload: { ref: 'dsh-instance:0.1.1_1' },
    })
    expect(res.statusCode).toBe(200)
    expect(setDefaultImage).toHaveBeenCalledWith('dsh-instance:0.1.1_1')

    const { app: missing } = await build(ADMIN, { setDefaultImage: async () => false })
    const notPublished = await missing.inject({
      method: 'PATCH',
      url: '/api/admin/images/default',
      payload: { ref: 'dsh-instance:0.9.9_1' },
    })
    expect(notPublished.statusCode).toBe(404)
  })
})

describe('管理员直接设账密建号', () => {
  it('邮箱建号 → 201，角色缺省是 user', async () => {
    const createUser = vi.fn(async (input: { email: string; role?: string }) => ({
      id: 'u-1',
      email: input.email,
    }))
    const { app } = await build(ADMIN, { createUser })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      payload: { account: 'Ada@App.Example.com', password: 'correct-horse', name: 'Ada' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().user.email).toBe('ada@app.example.com')
    expect(createUser).toHaveBeenCalledWith({
      email: 'ada@app.example.com',
      password: 'correct-horse',
      name: 'Ada',
    })
  })

  it('用户名收成 <用户名>@父域，并带上角色', async () => {
    const createUser = vi.fn(async (input: { email: string }) => ({ id: 'u-2', email: input.email }))
    const { app } = await build(ADMIN, { createUser })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      payload: { account: 'Ada_01', password: 'correct-horse', role: 'admin' },
    })
    expect(res.statusCode).toBe(201)
    expect(createUser).toHaveBeenCalledWith({
      email: 'ada_01@app.example.com',
      password: 'correct-horse',
      role: 'admin',
    })
  })

  it('密码太短、用户名不像话 → 400，且不建号', async () => {
    const createUser = vi.fn()
    const { app } = await build(ADMIN, { createUser })
    const short = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      payload: { account: 'ada@app.example.com', password: 'short' },
    })
    expect(short.statusCode).toBe(400)
    const bad = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      payload: { account: 'a', password: 'correct-horse' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toMatch(/不合格/)
    expect(createUser).not.toHaveBeenCalled()
  })

  it('邮箱已被占 → 409', async () => {
    const { app } = await build(ADMIN, {
      createUser: async () => {
        throw new AccountExistsError('ada@app.example.com')
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      payload: { account: 'ada@app.example.com', password: 'correct-horse' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('账号已存在')
  })
})
