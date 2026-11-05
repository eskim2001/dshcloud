import type { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ImageRefSchema } from '@dsh-cloud/instance-spec'
import { z } from 'zod'
import { AccountExistsError, canonicalLoginEmail } from '../account.js'
import type { ImageCatalogRow, ImageReleaseRow } from '../db/schema.js'
import type { InvitationRow } from '../db/invitation-repo.js'
import { INVITE_TTL_HOURS } from '../invitation.js'
import type { AdminInstanceRow, AdminUserRow, UserQuotaPatch } from '../db/user-repo.js'
import type { DiskUsed } from './instance-routes.js'
import type { Env } from '../env.js'
import type { ModelCredentialPublic } from '../model-credentials/view.js'
import { CREDENTIAL_REF_PATTERN, FORBIDDEN_CREDENTIAL_REFS, MODEL_KEY_PATTERN, ModelCredentialRejectedError } from '../model-credentials/rules.js'
import type { QuotaInput } from '../instance/provisioner.js'
import {
  effectiveInstanceCaps,
  instanceQuotaBodySchema,
  platformCaps,
  userQuotaBodySchema,
  type UserResourceQuotas,
} from '../platform-caps.js'
import {
  compareImageRefs,
  imageRepo,
  isReleaseTag,
  platformTags,
} from '../instance/image-catalog.js'
import { RegistryError, type SyncImagesResult } from '../instance/image-sync.js'
import { isImageFailure } from '../instance/provisioner.js'
import { resolveRuntimeStatus, type ContainerStates } from '../instance/runtime-status.js'
import type { LogStreamOptions } from './log-stream.js'
import { LogsQuerySchema } from './log-stream.js'
import { streamImagePull } from './pull-stream.js'

/**
 * 管理员直接建号。`account` 是邮箱或用户名（用户名会收成 `<用户名>@<父域>`）。
 * 密码口径与邀请兑换、引导建号一致：至少 8 位。
 */
const CreateUserBodySchema = z.object({
  account: z.string().trim().min(1).max(254),
  password: z.string().min(8, '密码至少 8 位').max(200),
  name: z.string().trim().max(80).optional(),
  role: z.enum(['user', 'admin']).optional(),
})
const BanBodySchema = z.object({ reason: z.string().max(200).optional() })
const RoleBodySchema = z.object({ role: z.enum(['user', 'admin']) })
/**
 * 省略的 ref 不出现在对象里（不改）。null 清除该 ref。空串进不了正则，整单拒绝。
 * UI v1 只发 DEEPSEEK_API_KEY；接口按 map 收，好让以后加 OPENAI 不必改形状。
 */
const PutModelCredentialsSchema = z.object({
  refs: z.record(
    z.string().regex(CREDENTIAL_REF_PATTERN),
    z.union([z.string().regex(MODEL_KEY_PATTERN), z.null()]),
  ),
}).strict()
/** 邀请只按邮箱发：链接捡到了也得知道是发给谁的（见 db/invitation-repo.ts）。 */
const InviteBodySchema = z.object({ email: z.string().trim().email().max(254) })
const ImageBodySchema = z.object({ image: z.string().min(1).max(255) })
/** 镜像版本用 body 传 ref：tag 里的 `:` / registry 里的 `/` 进 path 会被编码坑。 */
const ImageRefBodySchema = z.object({ ref: z.string().min(1).max(255) })
/** 拉取走 GET（`EventSource` 只支持 GET），所以 ref 从 query 传。 */
const PullQuerySchema = z.object({ ref: z.string().min(1).max(255) })

/**
 * 一条版本记录：catalog（上游有）∪ releases（我们上架了）∪ 宿主（本机缓存）三条来源取并集。
 *
 * **没有 `state` 三态**——「未下载 / 已下载 / 已发布」是把内部来源当成了产品状态，
 * 而且「下载」根本不是必经步骤（运行时在建实例时按需拉取，见 runtime/driver.ts）。
 * 页面只关心两件事：这一版**上架了没有**（用户能不能选到），本机**缓存了没有**
 * （用户第一次创建要不要等下载）。
 */
export interface AdminImage {
  ref: string
  /** 在 `image_release` 里。新建实例的默认版本、用户面的「换版本」列表都按它来。 */
  published: boolean
  /** 宿主上有没有（运行时事实）。与 `published` 分开：上架了但本机没缓存是正常状态。 */
  onHost: boolean
  isDefault: boolean
  publishedAt: Date | null
  /** 注册表给的 manifest digest；没同步过或只在宿主上就是 null。 */
  digest: string | null
}

/**
 * 版本新的排前面。tag 形如 `<dsh版本>_<修订号>`：修订号按**数字**比（字典序会把
 * `_10` 排在 `_9` 前面），再按版本串倒序。
 */
function byNewestFirst(a: string, b: string): number {
  return compareImageRefs(b, a)
}

/** 三条来源取并集后派生态：catalog（上游有）∪ releases（我们发布了）∪ 宿主（本地有）。 */
function shapeImages(
  releases: ImageReleaseRow[],
  catalog: ImageCatalogRow[],
  local: string[],
): AdminImage[] {
  const published = new Map(releases.map((r) => [r.ref, r]))
  const digests = new Map(catalog.map((c) => [c.ref, c.digest]))
  const onHost = new Set(local)
  const refs = new Set([...digests.keys(), ...published.keys(), ...onHost])

  return [...refs].sort(byNewestFirst).map((ref) => {
    const release = published.get(ref)
    return {
      ref,
      published: release !== undefined,
      onHost: onHost.has(ref),
      isDefault: release?.isDefault ?? false,
      publishedAt: release?.publishedAt ?? null,
      digest: digests.get(ref) ?? null,
    }
  })
}

export interface AdminRouteDeps {
  env: Env
  listUsers(): Promise<AdminUserRow[]>
  listInstances(): Promise<AdminInstanceRow[]>
  /** 当前 DB 意图为 running 的活实例数（与 max-running 闸门同一口径）。 */
  countRunning(): Promise<number>
  /** 全部容器的实时状态（一次 `docker ps -a`）。实例状态以它为准。 */
  listContainerStates(): Promise<ContainerStates>
  ban(userId: string, reason: string | null): Promise<boolean>
  unban(userId: string): Promise<boolean>
  setQuota(userId: string, patch: UserQuotaPatch): Promise<boolean>
  /**
   * 实例 owner 的单实例资源封顶。实例不存在 → undefined。
   * 全 null = 这个用户没有个人覆盖，有效封顶等于平台。
   */
  findOwnerResourceQuotas(instanceId: string): Promise<UserResourceQuotas | undefined>
  /** 授予 / 撤销管理员。`last-admin` = 降的是最后一名管理员，不能降（会自锁）。 */
  setRole(userId: string, role: 'user' | 'admin'): Promise<'ok' | 'missing' | 'last-admin'>
  /**
   * 写入用户级默认模型凭据。返回值只有 configured / providerRefs / updatedAt。
   * 明文只在这个回调的参数里出现一次，响应不得再带回去。
   */
  putModelCredentials(
    userId: string,
    adminId: string,
    refs: Record<string, string | null>,
  ): Promise<'missing' | ModelCredentialPublic>
  /** 清掉该用户全部默认。不影响已经建好的工作区。 */
  clearModelCredentials(userId: string): Promise<'missing' | ModelCredentialPublic>
  /** 改实例的 CPU / 内存 / pids。实例不存在 → false。**会重建容器**（几秒中断）。 */
  setInstanceQuota(id: string, quota: QuotaInput): Promise<boolean>
  /** 实例的镜像信息（当前 / 可回滚的上一版 / 数据文件）。实例不存在 → undefined。 */
  findInstanceImage(
    id: string,
  ): Promise<{ storageKey: string; image: string; previousImage: string | null } | undefined>
  /** 宿主上已有的镜像 tag——管理员可选**任意**平台仓库的本地版本，不受已发布列表限制。 */
  listLocalImages(): Promise<string[]>

  /** 平台已发布的镜像版本（D21）。 */
  listImageReleases(): Promise<ImageReleaseRow[]>
  /** 上次同步到本地的注册表快照（D23）。**可丢弃**——只回答「上游有什么」。 */
  listImageCatalog(): Promise<ImageCatalogRow[]>
  /** 拉一遍注册表并整批重建 catalog。到注册表那一跳失败会抛 `RegistryError`。 */
  syncImages(): Promise<SyncImagesResult>
  /** 打开 `docker pull` 的进度流（SSE 用，实现负责 hijack）。 */
  pullImageStream(ref: string): Promise<Readable>
  /**
   * 发布一个平台镜像。**不要求宿主已缓存**——上游存在即可，运行时按需拉取。
   *
   * `defaultIfFirst` 为真且平台当前没有任何默认版本时，这一版自动成为默认。
   * 判据在仓储层的事务里算（不能读完再传，那是 TOCTOU）。
   */
  publishImage(ref: string, defaultIfFirst?: boolean): Promise<'ok' | 'exists'>
  /** 下架。默认版本不能下架（返回 `'default'`）。 */
  unpublishImage(ref: string): Promise<'ok' | 'missing' | 'default'>
  /** 设为新建实例用的默认版本。未发布返回 false。 */
  setDefaultImage(ref: string): Promise<boolean>
  /** 升级前快照的实占（MB）。没有快照 / 读不到都返回 undefined。 */
  readSnapshot(slug: string): Promise<number | undefined>
  /** 列表用：一次拿到所有实例的磁盘（key → 用量 + 是否真配额）。读不到返回 undefined。 */
  readDiskAll(): Promise<Map<string, DiskUsed> | undefined>
  /** 换镜像 / 回滚。实例不存在 → false。失败会抛（见 isImageFailure）。 */
  setInstanceImage(id: string, image: string): Promise<boolean>
  rollbackInstanceImage(id: string): Promise<boolean>
  /** 取实例的容器 id（看日志用）。实例不存在 → undefined；还没容器 → null。 */
  findInstanceContainer(id: string): Promise<string | null | undefined>
  /** 把容器日志推成 SSE。**实现负责 hijack**（见 log-stream.ts）。 */
  streamLogs(
    req: FastifyRequest,
    reply: FastifyReply,
    containerId: string,
    opts: LogStreamOptions,
  ): Promise<void>
  /** 从请求解析登录者（含 role）；未登录返回 undefined。 */
  getSessionUser(req: FastifyRequest): Promise<{ id: string; role: string } | undefined>

  /**
   * 直接建号（设账密）。邮箱已被占时抛 `AccountExistsError`。
   * 路由负责把「邮箱或用户名」收成规范邮箱后再进来。
   */
  createUser(input: {
    email: string
    password: string
    name?: string
    role?: 'user' | 'admin'
  }): Promise<{ id: string; email: string }>

  /**
   * 生成一条邀请链接。**明文 token 只在这一刻存在**——库里存的是哈希，
   * 调用方（路由）必须当场把它返回给 owner，之后再也要不回来。
   *
   * `exists` = 这个邮箱已经有账号；`pending` = 已经有一条还没被接受的邀请。
   */
  createInvite(
    email: string,
    createdBy: string,
  ): Promise<
    { ok: true; url: string; expiresAt: Date } | { ok: false; reason: 'exists' | 'pending' }
  >
  listInvites(): Promise<InvitationRow[]>
  /** 撤销一条**还没被接受**的邀请。已接受 / 不存在 → false。 */
  revokeInvite(id: string): Promise<boolean>
}

interface AuthedRequest extends FastifyRequest {
  adminId?: string
}

/**
 * 平台管理面。**只有 role='admin' 能进**——管理员是平台运营方，不是实例 owner。
 *
 * 这里能改的是**账号与配额**（封禁、实例数上限、看全站实例状态），
 * 也能**看容器日志**（排障必需，日志里可能带用户内容——用户已确认可以）。
 * **不能**做的是直接浏览用户的 `/data` 卷：跨实例隔离是对客户的承诺，
 * 给管理员开个「进卷里翻文件」的按钮就破功了；真需要看数据走宿主，不在这里开按钮
 * （ARCHITECTURE §四）。
 */
export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: AdminRouteDeps,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook('preHandler', async (req: AuthedRequest, reply) => {
      const user = await deps.getSessionUser(req)
      if (user === undefined) {
        await reply.code(401).send({ error: '未登录' })
        return
      }
      // 非管理员一律 403。**每一条路由都过这个钩子**——漏一条就是一个洞。
      if (user.role !== 'admin') {
        await reply.code(403).send({ error: '需要管理员权限' })
        return
      }
      req.adminId = user.id
    })

    scope.get('/api/admin/users', async () => ({
      users: await deps.listUsers(),
      maxInstancesPerUser: deps.env.MAX_INSTANCES_PER_USER,
      // 用户页要拿它当「留空 = 这个数」的 hint，并挡住写得比平台还高的输入。
      platformCaps: platformCaps(deps.env),
    }))

    scope.post('/api/admin/users', async (req, reply) => {
      const parsed = CreateUserBodySchema.safeParse(req.body)
      if (!parsed.success) {
        const [first] = parsed.error.issues
        return reply.code(400).send({ error: first?.message ?? '参数不合法' })
      }
      const email = canonicalLoginEmail(parsed.data.account, deps.env.BASE_DOMAIN)
      if (email === undefined) {
        return reply.code(400).send({ error: '邮箱或用户名不合格' })
      }
      try {
        const user = await deps.createUser({
          email,
          password: parsed.data.password,
          ...(parsed.data.name ? { name: parsed.data.name } : {}),
          ...(parsed.data.role === undefined ? {} : { role: parsed.data.role }),
        })
        return reply.code(201).send({ user })
      } catch (err) {
        if (err instanceof AccountExistsError) {
          return reply.code(409).send({ error: '账号已存在' })
        }
        throw err
      }
    })

    scope.get('/api/admin/instances', async (req) => {
      const rows = await deps.listInstances()
      // 状态以 Docker 为准，DB 的 status 只是意图（见 instance/runtime-status.ts）
      let states: ContainerStates | undefined
      try {
        states = await deps.listContainerStates()
      } catch (err) {
        req.log.warn({ err }, '读容器实时状态失败，本次回退到 DB 快照')
      }
      // 磁盘一次读全：舰队页每行都要显示它，逐行读就是 N 次调用。
      const disks = await deps.readDiskAll().catch((): undefined => undefined)
      const caps = platformCaps(deps.env)
      return {
        instances: rows.map((row) => {
          const { status, statusText } = resolveRuntimeStatus(row, states)
          const disk = disks?.get(row.storageKey)
          return {
            ...row,
            status,
            statusText,
            /** 缺省 = 读不到，**不是 0**。 */
            diskUsedMb: disk?.usedMb,
            /** `false` 时 UI 必须显示「无上限」，别显示那个没生效的 diskMb。 */
            diskEnforced: disk?.enforced ?? false,
          }
        }),
        // 闸门口径：DB status==='running'，不是 Docker 瞬时态
        runningCount: await deps.countRunning(),
        maxRunning: caps.maxRunning,
        platformCaps: caps,
      }
    })

    scope.post('/api/admin/users/:id/ban', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const parsed = BanBodySchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })
      // 封自己 = 把自己锁在门外，没有恢复路径，直接拒绝
      if (id === req.adminId) return reply.code(400).send({ error: '不能封禁自己' })

      if (!(await deps.ban(id, parsed.data.reason ?? null))) {
        return reply.code(404).send({ error: '用户不存在' })
      }
      return { ok: true }
    })

    scope.post('/api/admin/users/:id/unban', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      if (!(await deps.unban(id))) return reply.code(404).send({ error: '用户不存在' })
      return { ok: true }
    })

    scope.patch('/api/admin/users/:id/quota', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const caps = platformCaps(deps.env)
      const parsed = userQuotaBodySchema(caps).safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({
          error: '参数不合法',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        })
      }
      const patch: UserQuotaPatch = {}
      if (parsed.data.quota !== undefined) patch.instanceQuota = parsed.data.quota
      if (parsed.data.cpuQuota !== undefined) patch.cpuQuota = parsed.data.cpuQuota
      if (parsed.data.memoryMbQuota !== undefined) patch.memoryMbQuota = parsed.data.memoryMbQuota
      if (parsed.data.pidsQuota !== undefined) patch.pidsQuota = parsed.data.pidsQuota
      if (parsed.data.diskMbQuota !== undefined) patch.diskMbQuota = parsed.data.diskMbQuota
      if (!(await deps.setQuota(id, patch))) {
        return reply.code(404).send({ error: '用户不存在' })
      }
      return { ok: true }
    })

    /**
     * 授予 / 撤销管理员。**不能降级最后一名管理员**——那会把所有人锁在管理台外面，
     * 只能靠 db:seed 恢复。降自己（还有别的管理员时）是允许的，改完下一个请求即生效。
     */
    scope.patch('/api/admin/users/:id/role', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const parsed = RoleBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })

      const result = await deps.setRole(id, parsed.data.role)
      if (result === 'missing') return reply.code(404).send({ error: '用户不存在' })
      if (result === 'last-admin') return reply.code(400).send({ error: '不能降级最后一名管理员' })
      return { ok: true }
    })

    /**
     * 设置用户级默认模型 Key。响应只有「配了哪些 ref」，没有明文。
     * 校验失败也不把请求体回显出去——空串、非法字符都是同一句。
     */
    scope.put('/api/admin/users/:id/model-credentials', async (req: AuthedRequest, reply) => {
      const adminId = req.adminId
      if (adminId === undefined) return reply.code(401).send({ error: '未登录' })
      const { id } = req.params as { id: string }
      const parsed = PutModelCredentialsSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: '模型 Key 不合法' })
      for (const ref of Object.keys(parsed.data.refs)) {
        if (FORBIDDEN_CREDENTIAL_REFS.has(ref)) return reply.code(400).send({ error: '模型 Key 不合法' })
      }
      try {
        const result = await deps.putModelCredentials(id, adminId, parsed.data.refs)
        if (result === 'missing') return reply.code(404).send({ error: '用户不存在' })
        return { modelCredentials: result }
      } catch (err) {
        if (err instanceof ModelCredentialRejectedError) {
          return reply.code(400).send({ error: '模型 Key 不合法' })
        }
        req.log.error({ name: err instanceof Error ? err.name : 'Error' }, '保存模型凭据失败')
        return reply.code(500).send({ error: '保存模型 Key 失败' })
      }
    })

    scope.delete('/api/admin/users/:id/model-credentials', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const result = await deps.clearModelCredentials(id)
      if (result === 'missing') return reply.code(404).send({ error: '用户不存在' })
      return { modelCredentials: result }
    })

    /**
     * 邀请列表。**不回显链接**——明文 token 早就不在库里了（只存哈希），
     * owner 只能在生成那一刻复制走；这里能看到的是「发给谁、什么时候过期、接受了没」。
     */
    scope.get('/api/admin/invitations', async () => ({
      invitations: await deps.listInvites(),
      ttlHours: INVITE_TTL_HOURS,
    }))

    scope.post('/api/admin/invitations', async (req: AuthedRequest, reply) => {
      const adminId = req.adminId
      if (adminId === undefined) return reply.code(401).send({ error: '未登录' })

      const parsed = InviteBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: '邮箱不合法' })

      const result = await deps.createInvite(parsed.data.email, adminId)
      if (!result.ok) {
        return reply.code(409).send({
          error:
            result.reason === 'exists'
              ? '这个邮箱已经有账号了'
              : '这个邮箱已经有一条待接受的邀请',
        })
      }
      // 明文链接**只在这里**出现一次
      return { url: result.url, expiresAt: result.expiresAt }
    })

    scope.delete('/api/admin/invitations/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      // 只撤销还没被接受的。已接受的那条是历史记录，删掉返回 404
      if (!(await deps.revokeInvite(id))) {
        return reply.code(404).send({ error: '邀请不存在，或者已经被接受' })
      }
      return { ok: true }
    })

    /**
     * 改实例资源配额（D17）。会重建容器——前端要提示「有几秒不可用」。
     * 先按平台封顶，再收到 owner 的每用户封顶（更严的那边）。实例不存在时没有 owner，直接 404。
     */
    scope.patch('/api/admin/instances/:id/quota', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const ownerQuotas = await deps.findOwnerResourceQuotas(id)
      if (ownerQuotas === undefined) return reply.code(404).send({ error: '实例不存在' })
      const parsed = instanceQuotaBodySchema(
        effectiveInstanceCaps(platformCaps(deps.env), ownerQuotas),
      ).safeParse(req.body)
      if (!parsed.success) {
        return reply.code(400).send({
          error: '参数不合法',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        })
      }
      try {
        if (!(await deps.setInstanceQuota(id, parsed.data))) {
          return reply.code(404).send({ error: '实例不存在' })
        }
      } catch (err) {
        // 改盘失败（配额设不上：缺 CAP_SYS_ADMIN / 池子没就绪）是**服务端**故障，不是请求问题 ——
        // 池化之后扩和缩都合法，没有"改不了"这个请求侧错误了。交给默认错误处理。
        throw err
      }
      return { ok: true }
    })

    /**
     * 版本信息。管理员看到的 `local` 是宿主上**平台仓库**的全部 tag（含未发布的）——
     * 用户面只有已发布的版本。
     */
    scope.get('/api/admin/instances/:id/image', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const info = await deps.findInstanceImage(id)
      if (info === undefined) return reply.code(404).send({ error: '实例不存在' })

      const base = (await deps.listImageReleases()).find((r) => r.isDefault)?.ref ?? null
      const local =
        base === null
          ? []
          : platformTags(await deps.listLocalImages().catch((): string[] => []), base)
      const snapshotMb = await deps.readSnapshot(info.storageKey).catch(() => undefined)
      return {
        image: info.image,
        previousImage: info.previousImage,
        local,
        snapshotMb: snapshotMb ?? null,
      }
    })

    /** 换镜像（升级 / 降级）。**先给数据打快照**，会停机——见 provisioner.setImage。 */
    scope.patch('/api/admin/instances/:id/image', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const parsed = ImageBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })

      try {
        if (!(await deps.setInstanceImage(id, parsed.data.image))) {
          return reply.code(404).send({ error: '实例不存在' })
        }
      } catch (err) {
        if (isImageFailure(err)) return reply.code(400).send({ error: err.message })
        throw err
      }
      return { ok: true }
    })

    scope.post('/api/admin/instances/:id/image/rollback', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      try {
        if (!(await deps.rollbackInstanceImage(id))) {
          return reply.code(404).send({ error: '实例不存在' })
        }
      } catch (err) {
        if (isImageFailure(err)) return reply.code(400).send({ error: err.message })
        throw err
      }
      return { ok: true }
    })

    // ─── 镜像版本管理（D21）───

    /**
     * 镜像总览（D23）：catalog ∪ 已发布 ∪ 宿主上本仓库的 tag，每行带**派生**的三态。
     *
     * 「宿主上有没有」是运行时事实，不落库——所以每次请求都重新 `docker images`。
     * `syncedAt` 是 catalog 里最新的同步时间（表空 = 从没同步过 / 上游没 tag），
     * 前端据此提示「先同步」。
     */
    scope.get('/api/admin/images', async () => {
      const [releases, catalog] = await Promise.all([
        deps.listImageReleases(),
        deps.listImageCatalog(),
      ])
      const local = platformTags(
        await deps.listLocalImages().catch((): string[] => []),
        deps.env.INSTANCE_IMAGE_REPO,
      )
      const syncedAt = catalog.reduce<Date | null>(
        (max, row) => (max === null || row.syncedAt > max ? row.syncedAt : max),
        null,
      )
      return { images: shapeImages(releases, catalog, local), syncedAt }
    })

    /**
     * 同步注册表的 tag 进库（D23）。慢——每个 tag 一次 HEAD，前端要显示 pending。
     * 到注册表那一跳失败是**上游故障**（502），不是平台内部错误。
     */
    scope.post('/api/admin/images/sync', async (_req, reply) => {
      try {
        return await deps.syncImages()
      } catch (err) {
        if (err instanceof RegistryError) return reply.code(502).send({ error: err.message })
        throw err
      }
    })

    /**
     * 预热：把镜像提前拉到宿主缓存，SSE 推行级进度（D23）。
     *
     * **不是上架的前提** —— 运行时按需拉取，上架后才预热也行、不预热也行。
     * 它只为「用户第一次创建这个版本时不用等下载」服务。
     *
     * 校验全部在 hijack 之前（hijack 之后只能自己写响应）。这里**不查 catalog**：
     * 管理员有权预热平台仓库里任何形状合法的 tag，包括刚推上来还没同步过的那一版。
     */
    scope.get('/api/admin/images/pull', async (req: AuthedRequest, reply) => {
      const parsed = PullQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })
      const { ref } = parsed.data

      if (!ImageRefSchema.safeParse(ref).success) {
        return reply.code(400).send({ error: `镜像引用不合法：${ref}` })
      }
      const platform = deps.env.INSTANCE_IMAGE_REPO
      if (imageRepo(ref) !== platform) {
        return reply.code(400).send({ error: `只能拉平台自己的镜像（${platform}），收到 ${ref}` })
      }
      if (!isReleaseTag(ref)) {
        return reply
          .code(400)
          .send({ error: `镜像 tag 不符合发布序列（<dsh版本>_<修订号>）：${ref}` })
      }

      return streamImagePull(req, reply, () => deps.pullImageStream(ref))
    })

    /**
     * 上架一个平台版本。已发布 → 409。
     *
     * 平台还没有任何默认版本时，这一版自动成为默认 —— 否则会出现「已上架但没有默认」
     * 的死状态：用户看得见版本，却创建不了实例。
     */
    scope.post('/api/admin/images', async (req: AuthedRequest, reply) => {
      const parsed = ImageRefBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })
      const { ref } = parsed.data

      if (!ImageRefSchema.safeParse(ref).success) {
        return reply.code(400).send({ error: `镜像引用不合法：${ref}` })
      }

      const platform = deps.env.INSTANCE_IMAGE_REPO
      if (imageRepo(ref) !== platform) {
        return reply.code(400).send({ error: `只能发布平台自己的镜像（${platform}），收到 ${ref}` })
      }
      // 仓库是公开的，`:latest` 之类的 tag 谁都能推——只让发布序列的形状进库
      if (!isReleaseTag(ref)) {
        return reply
          .code(400)
          .send({ error: `镜像 tag 不符合发布序列（<dsh版本>_<修订号>）：${ref}` })
      }
      // **不要求宿主上已经有**：运行时按需拉取（`DockerDriver.ensureImage`），
      // 「先下载」并不是建实例的前提 —— 镜像是在建容器那一刻才真的落到宿主上的。
      // 判据改成「上游有没有」：同步见过的 tag 才算数，挡住手输的、上游不存在的 ref。
      // 宿主已缓存的当然也算（离线预热过的情况）。
      const [catalog, onHost] = await Promise.all([
        deps.listImageCatalog().catch((): ImageCatalogRow[] => []),
        deps.listLocalImages().catch((): string[] => []),
      ])
      if (!catalog.some((c) => c.ref === ref) && !onHost.includes(ref)) {
        return reply.code(400).send({ error: `上游没有镜像 ${ref}，先点「同步」` })
      }

      if ((await deps.publishImage(ref, true)) === 'exists') {
        return reply.code(409).send({ error: `${ref} 已经发布过了` })
      }
      return { ok: true }
    })

    /** 下架。默认版本不能下架——否则新建实例就没镜像可用了。 */
    scope.delete('/api/admin/images', async (req: AuthedRequest, reply) => {
      const parsed = ImageRefBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })

      const result = await deps.unpublishImage(parsed.data.ref)
      if (result === 'missing') return reply.code(404).send({ error: '这个版本没有发布过' })
      if (result === 'default') {
        return reply.code(400).send({ error: '默认版本不能下架，先把别的版本设为默认' })
      }
      return { ok: true }
    })

    /** 设为新建实例用的默认版本。 */
    scope.patch('/api/admin/images/default', async (req: AuthedRequest, reply) => {
      const parsed = ImageRefBodySchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })
      if (!(await deps.setDefaultImage(parsed.data.ref))) {
        return reply.code(404).send({ error: '这个版本还没有发布' })
      }
      return { ok: true }
    })

    /** 容器日志（SSE），排障用。与实例面同一实现——鉴权在 hijack 之前。 */
    scope.get('/api/admin/instances/:id/logs', async (req: AuthedRequest, reply) => {
      const { id } = req.params as { id: string }
      const containerId = await deps.findInstanceContainer(id)
      if (containerId === undefined) return reply.code(404).send({ error: '实例不存在' })
      if (containerId === null) return reply.code(409).send({ error: '实例还没有容器' })

      const parsed = LogsQuerySchema.safeParse(req.query)
      if (!parsed.success) return reply.code(400).send({ error: '参数不合法' })

      return deps.streamLogs(req, reply, containerId, { tail: parsed.data.tail })
    })
  })
}
