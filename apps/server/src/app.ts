import { fromNodeHeaders } from 'better-auth/node'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import type { Auth } from './auth.js'
import type { Db } from './db/client.js'
import {
  countRunningInstances,
  findInstanceBySlug,
  listInstancesByOwner,
  findInstanceById,
} from './db/instance-repo.js'
import {
  listImageReleases,
  publishImageRelease,
  setDefaultImageRelease,
  unpublishImageRelease,
} from './db/image-release-repo.js'
import { listImageCatalog } from './db/image-catalog-repo.js'
import { listRecentMetrics } from './db/metric-repo.js'
import {
  countAdmins,
  findUserByEmail,
  findUserById,
  findUserResourceQuotas,
  listInstancesWithOwner,
  listUsersWithInstanceCount,
  revokeUserSessions,
  setUserBanned,
  setUserQuota,
  setUserRole,
} from './db/user-repo.js'
import {
  createInvitation,
  deleteInvitation,
  findPendingInvitationByEmail,
  listInvitations,
} from './db/invitation-repo.js'
import {
  acceptInvitation,
  hashInviteToken,
  inviteExpiry,
  inviteUrl,
  newInviteToken,
} from './invitation.js'
import { createUserWithPassword } from './account.js'
import { demoAccount, isPlatformHost, trustedOrigins, type Env } from './env.js'
import { EMPTY_USER_RESOURCE_QUOTAS } from './platform-caps.js'
import { registerAdminRoutes } from './http/admin-routes.js'
import { expireLegacyCookies } from './http/legacy-cookies.js'
import { registerForwardAuth } from './http/forward-auth-route.js'
import { registerWorkspaceAuthorization } from './http/workspace-authorization.js'
import { issueWorkspaceGrant, resolveWorkspaceSession } from './db/workspace-access-repo.js'
import { workspaceToken } from './http/workspace-login.js'
import { registerInvitationRoutes } from './http/invitation-routes.js'
import { registerSessionRoutes } from './http/session-routes.js'
import { registerSetupRoutes, type SetupDeps } from './http/setup-routes.js'
import { registerInstanceRoutes } from './http/instance-routes.js'
import type { DiskUsed } from './http/instance-routes.js'
import { registerWebConsole } from './http/web-console.js'
import { streamContainerLogs } from './http/log-stream.js'
import type { DataStore } from './instance/data-store.js'
import { syncImageCatalog } from './instance/image-sync.js'
import type { InstanceOrchestrator } from './instance/orchestrator.js'
import type { InstanceProvisioner } from './instance/provisioner.js'
import { createRegistryClient } from './instance/registry.js'

export interface AppDeps {
  env: Env
  db: Db
  auth: Auth
  provisioner: InstanceProvisioner
  /** 直接读实例的地方（用量快照、日志）走它。 */
  orchestrator: InstanceOrchestrator
  /** 实例数据在宿主上的目录（读用量、快照占用）。 */
  dataStore: DataStore
  /**
   * **还没配域名**（引导态，见 DECISIONS 的引导态装机）：只注册 token 门保护的 setup 端点 +
   * 健康检查 + 管理台静态文件，其余一律不挂。
   *
   * **显式传进来，不从 env 猜**：调用方（`index.ts`）已经把 env 与 DB 合成过一次，
   * 它才知道当前是不是引导态。
   */
  bootstrap?: boolean
  /** setup 端点。省略 = 已配置（state 回 `true`、写端点 409）。 */
  setup?: SetupDeps
  logger?: boolean
  /**
   * 测试用：观察**实际注册**的路由集合。Fastify 没有公开的路由枚举 API
   * （`printRoutes` 会把通配路由的路径前缀吃掉），而漏挂认证只能靠「注册面清单」
   * 测试兜住（铁律 6）。见 http/route-surface.test.ts。
   */
  onRoute?: (route: { method: string | string[]; url: string }) => void
  /**
   * 工作空间授权成功时刷新活跃时刻（空闲回收用）。由 `index.ts` 注入节流后的 toucher。
   */
  onWorkspaceAuthorized?: (instanceId: string) => void
}

interface SessionUser {
  id: string
  role: string
}

/** 引导态唯一的写端点（见 `http/setup-routes.ts`）。 */
const SETUP_PATH = '/api/setup'

/**
 * 记日志之前把 URL 里的**一次性 token** 抹掉。
 *
 * 引导期那枚 setup token 是那个页面的**唯一**凭证，而它只能走 URL（操作者从终端把链接粘过来）。
 * Fastify 默认把整条 `req.url` 记进日志 —— 那等于把凭证抄进 `docker logs`：谁能看日志，
 * 谁就能赶在操作者之前把域名配掉。
 *
 * 这是**兜底**（那条页面 URL 躲不掉）。能不放 URL 的地方就别放 —— 探测端点因此改用了 header，
 * 见 `http/setup-routes.ts`。
 */
export function redactToken(url: string): string {
  const query = url.indexOf('?')
  return query < 0 ? url : `${url.slice(0, query)}?<redacted>`
}

/** 照着 Fastify 默认那份写，只把 url 换掉 —— 其余字段（host、来源）排障要用。 */
function logRequest(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactToken(request.url),
    host: request.headers.host,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort,
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger === true ? { serializers: { req: logRequest } } : false,
    // Traefik 在前面：X-Forwarded-* 是可信的，登录回跳和 cookie 都靠它
    trustProxy: true,
  })
  await app.register(cookie)
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-frame-options', 'DENY')
    reply.header('content-security-policy', "frame-ancestors 'none'")
    reply.header('referrer-policy', 'no-referrer')
    reply.header('x-content-type-options', 'nosniff')
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store')
    // 规范主机是 CONSOLE_DOMAIN（可以就是父域）。别名 console.<父域> 在入口被跳走，
    // 万一请求还是打到了进程上，同样清掉旧的父域 cookie。
    if (deps.bootstrap || !isPlatformHost(deps.env, request.headers.host)) return payload
    const expired = expireLegacyCookies(request.headers.cookie, deps.env.BASE_DOMAIN, deps.env.PUBLIC_SCHEME === 'https')
    if (expired.length) {
      // Fastify appends Set-Cookie values, preserving the authentication response.
      reply.header('set-cookie', expired)
      reply.header('cache-control', 'no-store')
    }
    return payload
  })

  if (deps.onRoute !== undefined) app.addHook('onRoute', deps.onRoute)

  const allowedOrigins = new Set(trustedOrigins(deps.env))
  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return
    // 引导态下 `/api/setup` 是**唯一**的写端点，而此刻还没有可信来源可配（域名正是在这里填的）——
    // 所以对它跳过 Origin 检查。那条路的凭证是安装脚本打印的一次性 token，不是来源。
    if (deps.bootstrap === true && (request.url === SETUP_PATH || request.url.startsWith(`${SETUP_PATH}?`))) {
      return
    }
    if (request.headers.origin === undefined || !allowedOrigins.has(request.headers.origin)) {
      return reply.code(403).send({ error: 'Untrusted request origin' })
    }
  })

  // setup 端点：**两个模式都注册**（控制台启动时用它决定显示 setup 页还是正常界面）。
  // 已配置时 `deps.setup` 缺省 ⇒ state 回 `true`、写端点 409，见 setup-routes.ts。
  // 演示账号从 env 直接取（不经过 `deps.setup`）：演示站跑的是**已配置**模式，那条路没有 setup。
  registerSetupRoutes(app, {
    ...(deps.setup ?? { configured: true, token: '' }),
    demo: demoAccount(deps.env),
  })

  // 引导态到此为止：除了 setup 与健康检查，**什么都不挂**。早返回放在这里（所有业务路由之前），
  // 是为了让「引导态的暴露面」在代码里一目了然 —— 下面那一整段都不属于引导态。
  if (deps.bootstrap === true) {
    app.get('/healthz', async () => ({ ok: true }))
    if (deps.env.WEB_DIST_DIR) {
      await registerWebConsole(app, deps.env.WEB_DIST_DIR)
    }
    return app
  }

  const sessionUser = async (headers: FastifyRequest['headers']): Promise<SessionUser | undefined> => {
    const session = await deps.auth.api.getSession({ headers: fromNodeHeaders(headers) })
    return session == null || session.session.impersonatedBy != null
      ? undefined
      : { id: session.user.id, role: session.user.role ?? 'user' }
  }

  // 日志流：实例面和管理面共用同一条实现（鉴权各自在路由层完成）
  const streamLogs = (
    req: FastifyRequest,
    reply: Parameters<typeof streamContainerLogs>[1],
    containerId: string,
    opts: { tail: number },
  ) =>
    streamContainerLogs(
      req,
      reply,
      containerId,
      opts,
      (machineName, o) => deps.orchestrator.logs(machineName, o),
      // 驱动已经把 Docker 的「8 字节头 + 负载」复用帧拆干净了（见 `DockerDriver.logs`），
      // 到这里就是纯文本，原样转发即可。
      (raw, out) => {
        raw.pipe(out)
      },
    )

  // 注册表只读客户端（D23）。公开包匿名即可，所以凭据是**可选**的——
  // 只设一半会被忽略（见 registry.ts），免得出现半截 Basic 头。
  const registry = createRegistryClient({
    repo: deps.env.INSTANCE_IMAGE_REPO,
    fetch: globalThis.fetch,
    ...(deps.env.INSTANCE_IMAGE_REGISTRY_USER !== '' &&
    deps.env.INSTANCE_IMAGE_REGISTRY_TOKEN !== ''
      ? {
          user: deps.env.INSTANCE_IMAGE_REGISTRY_USER,
          token: deps.env.INSTANCE_IMAGE_REGISTRY_TOKEN,
        }
      : {}),
  })

  // ① forward-auth：数据面的门（D8 ②）
  registerWorkspaceAuthorization(app, {
    consoleOrigin: `${deps.env.PUBLIC_SCHEME}://${deps.env.CONSOLE_DOMAIN}`,
    workspaceOrigin: slug => `${deps.env.PUBLIC_SCHEME}://${slug}.${deps.env.BASE_DOMAIN}`,
    resolveSession: async cookie => {
      const result = await deps.auth.api.getSession({ headers: fromNodeHeaders({ cookie }) })
      return result && !result.session.impersonatedBy ? result.session.id : undefined
    },
    issue: async input => {
      const row = await findInstanceBySlug(deps.db, input.slug)
      return row ? issueWorkspaceGrant(deps.db, { ...input, instanceId: row.id }) : undefined
    },
  })
  registerForwardAuth(app, {
    baseDomain: deps.env.BASE_DOMAIN,
    consoleDomain: deps.env.CONSOLE_DOMAIN,
    publicScheme: deps.env.PUBLIC_SCHEME,
    gateSecret: deps.env.PLATFORM_SECRET,
    findInstanceBySlug: (slug) => findInstanceBySlug(deps.db, slug),
    resolveUserId: async (cookieHeader, slug) => {
      const token = workspaceToken(cookieHeader, deps.env.PUBLIC_SCHEME === 'https')
      if (!slug || !token) return undefined
      const row = await findInstanceBySlug(deps.db, slug)
      return row ? resolveWorkspaceSession(deps.db, token, row.id) : undefined
    },
    ...(deps.onWorkspaceAuthorized === undefined
      ? {}
      : { onAuthorized: (instance) => deps.onWorkspaceAuthorized!(instance.id) }),
  })

  // ② 认证端点（better-auth 自己处理登录/登出/会话）
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const url = new URL(request.url, `${deps.env.PUBLIC_SCHEME}://${request.headers.host}`)
      if (decodeURIComponent(url.pathname).startsWith('/api/auth/admin/')) {
        return reply.code(403).send({ error: 'Platform account administration is not exposed here' })
      }
      const headers = fromNodeHeaders(request.headers)
      const init: RequestInit = { method: request.method, headers }
      if (request.body !== undefined && request.method !== 'GET') {
        init.body = JSON.stringify(request.body)
      }
      const response = await deps.auth.handler(new Request(url, init))
      reply.status(response.status)
      response.headers.forEach((value, key) => reply.header(key, value))
      return reply.send(response.body === null ? null : await response.text())
    },
  })

  // ③ 管理台 API
  /**
   * 列表用：一次读全所有实例的磁盘。**两处注册（实例面 / 管理面）共用同一条实现** ——
   * 逐行读就是 N 次调用，而这两个列表页每行都要显示磁盘。
   */
  const readDiskAll = async (): Promise<Map<string, DiskUsed> | undefined> => {
    const used = await deps.dataStore.usageAll()
    if (used === undefined) return undefined
    // 池子注册表里的 key = 真的建了配额；不在表里的由调用方按「无上限」处理。
    return new Map([...used].map(([key, usedMb]) => [key, { usedMb, enforced: true }]))
  }

  await registerInstanceRoutes(app, {
    env: deps.env,
    provisioner: deps.provisioner,
    listMine: (ownerId) => listInstancesByOwner(deps.db, ownerId),
    // 额度 = 个人覆盖 ?? 平台默认。列表页显示它，用户就不用撞墙才知道。
    readInstanceLimit: async (ownerId) =>
      (await findUserById(deps.db, ownerId))?.instanceQuota ?? deps.env.MAX_INSTANCES_PER_USER,
    readResourceQuotas: async (ownerId) =>
      (await findUserResourceQuotas(deps.db, ownerId)) ?? EMPTY_USER_RESOURCE_QUOTAS,
    getById: (id) => findInstanceById(deps.db, id),
    listContainerStates: () => deps.orchestrator.listInstanceStates(),
    readStats: (containerId) => deps.orchestrator.stats(containerId),
    readDisk: async (storageKey, quotaMb) => {
      const u = await deps.dataStore.usage(storageKey)
      if (u === undefined) return undefined
      // `enforced` 必须一起给：UI 拿它决定显示「用量/配额」还是「无上限」。
      return { usedMb: u.usedMb, quotaMb, enforced: await deps.dataStore.enforced(storageKey) }
    },
    readDiskAll,
    listMetrics: (instanceId, limit) => listRecentMetrics(deps.db, instanceId, limit),
    listLocalImages: () => deps.orchestrator.listImageTags(),
    listImageReleases: () => listImageReleases(deps.db),
    readSnapshot: async (storageKey) => (await deps.dataStore.snapshotUsage(storageKey))?.usedMb,
    streamLogs,
    getUserId: (req) => sessionUser(req.headers).then((u) => u?.id),
  })

  // ④ 会话管理
  await registerSessionRoutes(app, {
    auth: deps.auth,
    getUserId: (req) => sessionUser(req.headers).then((u) => u?.id),
  })

  // ⑤ 平台管理面（仅 admin）
  await registerAdminRoutes(app, {
    env: deps.env,
    listUsers: () => listUsersWithInstanceCount(deps.db),
    listInstances: () => listInstancesWithOwner(deps.db),
    countRunning: () => countRunningInstances(deps.db),
    listContainerStates: () => deps.orchestrator.listInstanceStates(),
    readDiskAll,
    // 封禁 = 打标记 + 踢掉所有会话。少一半都封不住（见 user-repo 注释）。
    ban: async (userId, reason) => {
      if (!(await setUserBanned(deps.db, userId, true, reason))) return false
      await revokeUserSessions(deps.db, userId)
      return true
    },
    unban: (userId) => setUserBanned(deps.db, userId, false, null),
    setQuota: (userId, patch) => setUserQuota(deps.db, userId, patch),
    findOwnerResourceQuotas: async (id) => {
      const row = await findInstanceById(deps.db, id)
      if (row === undefined) return undefined
      // owner 行理论上删不掉（外键 restrict）。真缺了就当没有个人覆盖，别把活实例 404 掉。
      return (await findUserResourceQuotas(deps.db, row.ownerId)) ?? EMPTY_USER_RESOURCE_QUOTAS
    },
    // 降级最后一名管理员 = 所有人都进不了管理台，只能靠 db:seed 恢复。
    // 查两次再写，两个管理员同时自降的窗口极窄，单运营者场景不值得上事务。
    setRole: async (userId, role) => {
      const target = await findUserById(deps.db, userId)
      if (target === undefined) return 'missing'
      if (role === 'user' && target.role === 'admin' && (await countAdmins(deps.db)) <= 1) {
        return 'last-admin'
      }
      await setUserRole(deps.db, userId, role)
      return 'ok'
    },
    // 实例不存在返回 false（404）；重建容器失败会抛出去，让管理员看到原因
    setInstanceQuota: async (id, quota) => {
      if ((await findInstanceById(deps.db, id)) === undefined) return false
      await deps.provisioner.setQuota(id, quota)
      return true
    },
    findInstanceContainer: async (id) => (await findInstanceById(deps.db, id))?.containerId,
    findInstanceImage: async (id) => {
      const row = await findInstanceById(deps.db, id)
      return row === undefined
        ? undefined
        : { storageKey: row.storageKey, image: row.image, previousImage: row.previousImage }
    },
    listLocalImages: () => deps.orchestrator.listImageTags(),
    listImageReleases: () => listImageReleases(deps.db),
    listImageCatalog: () => listImageCatalog(deps.db),
    syncImages: () => syncImageCatalog(deps.db, registry, deps.env.INSTANCE_IMAGE_REPO),
    pullImageStream: (ref) => deps.orchestrator.openImagePull(ref),
    publishImage: (ref, defaultIfFirst) => publishImageRelease(deps.db, ref, defaultIfFirst),
    unpublishImage: (ref) => unpublishImageRelease(deps.db, ref),
    setDefaultImage: (ref) => setDefaultImageRelease(deps.db, ref),
    readSnapshot: async (storageKey) => (await deps.dataStore.snapshotUsage(storageKey))?.usedMb,
    // 管理员可选**任意**平台仓库的本地镜像，不受已发布列表限制
    setInstanceImage: async (id, image) => {
      if ((await findInstanceById(deps.db, id)) === undefined) return false
      await deps.provisioner.setImage(id, image, { allowAny: true })
      return true
    },
    rollbackInstanceImage: async (id) => {
      if ((await findInstanceById(deps.db, id)) === undefined) return false
      await deps.provisioner.rollbackImage(id)
      return true
    },
    streamLogs,
    getSessionUser: (req) => sessionUser(req.headers),
    createUser: (input) => createUserWithPassword(deps.auth, input),

    // 邀请：明文 token 只在这个函数里存在过一次——库里存的是哈希，返回给 owner
    // 之后再也要不回来（见 db/invitation-repo.ts）。
    createInvite: async (email, createdBy) => {
      const address = email.trim().toLowerCase()
      if ((await findUserByEmail(deps.db, address)) !== undefined) {
        return { ok: false, reason: 'exists' }
      }
      if ((await findPendingInvitationByEmail(deps.db, address)) !== undefined) {
        return { ok: false, reason: 'pending' }
      }
      const token = newInviteToken()
      const expiresAt = inviteExpiry()
      await createInvitation(deps.db, {
        tokenHash: hashInviteToken(token),
        email: address,
        createdBy,
        expiresAt,
      })
      return {
        ok: true,
        url: inviteUrl(deps.env.PUBLIC_SCHEME, deps.env.CONSOLE_DOMAIN, token),
        expiresAt,
      }
    },
    listInvites: () => listInvitations(deps.db),
    revokeInvite: (id) => deleteInvitation(deps.db, id),
  })

  // ⑥ 邀请兑换：全平台唯一一个不认证的写端点（认证方式见 http/invitation-routes.ts）
  await registerInvitationRoutes(app, {
    acceptInvite: (input) => acceptInvitation(deps.db, deps.auth, input),
  })

  app.get('/healthz', async () => ({ ok: true }))

  // ⑦ 管理台静态文件。**最后注册**：@fastify/static 与 notFoundHandler 会接管
  // 未被前面路由匹配的请求，早注册会把接口的 404 变成一张 HTML。
  if (deps.env.WEB_DIST_DIR) {
    await registerWebConsole(app, deps.env.WEB_DIST_DIR)
  }

  return app
}
