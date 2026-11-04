export interface SessionUser {
  id: string
  email: string
  name: string
  /** 'user' | 'admin'。管理员是平台运营方。 */
  role: string
}

export interface InstanceSummary {
  id: string
  slug: string
  /** provisioning | running | restarting | paused | stopped | error | removing */
  status: string
  /** Docker 的原文描述（如 `Restarting (3) 20 seconds ago`）；取不到就是 null。 */
  statusText: string | null
  image: string
  /** 非空 = 有一份升级前的数据快照，可以回滚到这一版。 */
  previousImage: string | null
  cpus: number
  memoryMb: number
  /** 声明的磁盘容量（MiB）。**只是声明** —— 到底管不管用看 `diskEnforced`。 */
  diskMb: number
  /** 已用磁盘（MiB）。**缺省 = 读不到**（不是 0）。 */
  diskUsedMb?: number
  /**
   * 这份配额**真的在生效**吗。
   *
   * `false` 时必须显示「无上限」而不是 `diskMb` —— 开发机内核不支持配额、或实例没有池子时就是这样。
   * 显示一个没生效的上限，比不显示更糟。
   */
  diskEnforced: boolean
  lastError: string | null
  /** 最后一次变成「已停止」的时刻；运行中为 null。 */
  stoppedAt: string | null
  /** 容器是否已经建出来（没建出来的实例没有日志可看）。 */
  hasContainer: boolean
  createdAt: string
  /** 「打开 dsh」入口（桥会在这条路径注入入口 token）。 */
  url: string
}

export interface InstanceUsage {
  /** 100 = 用满一个核，多核实例可以超过 100。 */
  cpuPercent: number
  memMb: number
}

/** 数据文件系统的实时占用。容器停着也能读——文件系统还挂着。 */
export interface InstanceDiskUsage {
  usedMb: number
  quotaMb: number
}

/** `/stats` 的一次快照：容器不在时 `usage` 为 null，磁盘通常仍然有值。 */
export interface InstanceSnapshot {
  usage: InstanceUsage | null
  disk: InstanceDiskUsage | null
}

export interface InstanceMetricPoint extends InstanceUsage {
  sampledAt: string
  diskUsedMb: number
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * 机器可读的错误码（better-auth 的 `INVALID_PASSWORD` 之类）。
     *
     * 有它才能把「当前密码不对」这种话**翻译成本地文案**——better-auth 的 message
     * 是英文的（"Invalid password"），直接摆给中文用户看很别扭。平台自己的接口一般不返回。
     */
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // 会话 cookie 必须带上；不能依赖默认行为
    credentials: 'same-origin',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  })

  const text = await res.text()
  const body: unknown = text === '' ? null : safeJson(text)

  if (!res.ok) {
    throw new ApiError(
      errorMessage(body) ?? `请求失败（${res.status}）`,
      res.status,
      errorCode(body),
    )
  }
  return body as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function errorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const b = body as { message?: string; error?: string }
  return b.message ?? b.error
}

function errorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const code = (body as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

// ─── 认证（better-auth）───────────────────────────────────────────────────

export async function getSession(): Promise<SessionUser | null> {
  const res = await request<{ user?: SessionUser } | null>('/api/auth/get-session')
  return res?.user ?? null
}

export async function signIn(email: string, password: string): Promise<SessionUser> {
  const res = await request<{ user: SessionUser }>('/api/auth/sign-in/email', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  return res.user
}

/**
 * 兑换一条邀请：设密码、把账号建出来。**这一步不建会话**——拿到 email 之后
 * 走正常的 `signIn`，认证路径只保留一条。
 *
 * 公开注册已关闭（服务端 `disableSignUp`），所以这是除 seed 外唯一的建号入口。
 */
export async function acceptInvitation(input: {
  token: string
  password: string
  name?: string
}): Promise<{ email: string }> {
  return request('/api/invitations/accept', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function signOut(): Promise<void> {
  await request('/api/auth/sign-out', { method: 'POST', body: '{}' })
}

/** 改昵称。better-auth 的 update-user 接管（cookie 会话即授权）。 */
export async function updateUserName(name: string): Promise<void> {
  await request('/api/auth/update-user', { method: 'POST', body: JSON.stringify({ name }) })
}

/**
 * 改密码。要带**当前密码**——这是防止「会话被人拿到后直接改密码锁死账号」的那道锁。
 *
 * `revokeOtherSessions` 打开时其余设备立刻下线（当前这台保留）。
 * 邮箱改不了：better-auth 的换邮箱要求先发验证信，平台没配邮件通道（见设置页的说明）。
 */
export async function changePassword(input: {
  currentPassword: string
  newPassword: string
  revokeOtherSessions: boolean
}): Promise<void> {
  await request('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

// ─── 实例（平台 API）─────────────────────────────────────────────────────

/** 平台级资源 / 并发封顶（只读；创建表单据此裁选项）。 */
export interface PlatformCaps {
  maxCpus: number
  maxMemoryMb: number
  maxPids: number
  maxDiskMb: number
  /** `0` = 不限制同时 running 数。 */
  maxRunning: number
  /** `0` = 关闭空闲回收。 */
  idleCullMinutes: number
}

/** 我的实例 + **我能开几个**（额度一起返回：页面要显示「2 / 3」，别让用户撞墙才知道）。 */
export interface MyInstances {
  instances: InstanceSummary[]
  maxInstances: number
  platformCaps: PlatformCaps
}

export async function listInstances(): Promise<MyInstances> {
  return request<MyInstances>('/api/instances')
}

export async function createInstance(input: {
  slug: string
  cpus?: number
  memoryMb?: number
  /** 进程数上限（PIDs cgroup 上限）。默认 512，够跑 dsh 本身。 */
  pidsLimit?: number
  diskMb?: number
  /** 留空用平台默认版本。 */
  image?: string
}): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>('/api/instances', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return res.instance
}

/** 建实例可选的版本。`published` 是**全部已发布**的版本（新的在前）——宿主上没有的也会自动拉。 */
export interface CreateImageOptions {
  /** 不选版本时用的那一版；平台还没发布过就是 null。 */
  default: string | null
  published: string[]
}

export async function listImages(): Promise<CreateImageOptions> {
  return request<CreateImageOptions>('/api/images')
}

export async function restartInstance(id: string): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>(`/api/instances/${id}/restart`, {
    method: 'POST',
    body: '{}',
  })
  return res.instance
}

export async function stopInstance(id: string): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>(`/api/instances/${id}/stop`, {
    method: 'POST',
    body: '{}',
  })
  return res.instance
}

export async function startInstance(id: string): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>(`/api/instances/${id}/start`, {
    method: 'POST',
    body: '{}',
  })
  return res.instance
}

/** 默认保留数据文件系统；`purge` + 子域名确认才连它一起删。 */
/**
 * 永久删除实例（数据一起删，不可恢复）。
 *
 * `confirmSlug` 是必填的：服务端要求回填子域名才肯删，前端也必须让用户真打一遍 ——
 * 这是这条路上唯一一道确认。
 */
export async function removeInstance(id: string, confirmSlug: string): Promise<void> {
  const params = new URLSearchParams({ confirmSlug })
  await request<void>(`/api/instances/${id}?${params.toString()}`, { method: 'DELETE' })
}

export async function getInstance(id: string): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>(`/api/instances/${id}`)
  return res.instance
}

/** 当前用量快照。容器没跑或首帧没差值时 `usage` 是 null（页面显示「暂无数据」）。 */
export async function getInstanceStats(id: string): Promise<InstanceSnapshot> {
  const res = await request<{ stats: InstanceUsage | null; disk?: InstanceDiskUsage }>(
    `/api/instances/${id}/stats`,
  )
  return { usage: res.stats, disk: res.disk ?? null }
}

export async function getInstanceMetrics(
  id: string,
  limit = 120,
): Promise<InstanceMetricPoint[]> {
  const res = await request<{ metrics: InstanceMetricPoint[] }>(
    `/api/instances/${id}/metrics?limit=${limit}`,
  )
  return res.metrics
}

/** 用户面的版本信息：只能选平台**已发布**的版本（且宿主上已有）。 */
export interface InstanceImageInfo {
  image: string
  previousImage: string | null
  /** 可选版本 = 已发布列表 ∩ 宿主上已有。空 = 不能自助升级。 */
  stable: string[]
  /** 升级前快照的实占（MB）；null = 没有快照。 */
  snapshotMb: number | null
}

export async function getInstanceImage(id: string): Promise<InstanceImageInfo> {
  return request<InstanceImageInfo>(`/api/instances/${id}/image`)
}

/**
 * 升级 / 降级到某个已发布版本。**会停机**——先给数据打快照再换镜像，
 * 停机时间 = 停容器 + 复制已用数据 + 启动。新镜像起不来会自动回滚。
 */
export async function setInstanceImage(id: string, image: string): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>(`/api/instances/${id}/image`, {
    method: 'POST',
    body: JSON.stringify({ image }),
  })
  return res.instance
}

/** 回滚到上一版：用升级前的快照覆盖数据，再按旧镜像重建。快照就此消费掉。 */
export async function rollbackInstanceImage(id: string): Promise<InstanceSummary> {
  const res = await request<{ instance: InstanceSummary }>(
    `/api/instances/${id}/image/rollback`,
    { method: 'POST', body: '{}' },
  )
  return res.instance
}

// ─── 会话（设备管理）──────────────────────────────────────────────────────

export interface SessionSummary {
  id: string
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
  expiresAt: string
  /** 当前这台设备。它不能撤销自己——那样会立刻把自己踢下线。 */
  current: boolean
}

export async function listSessions(): Promise<SessionSummary[]> {
  const res = await request<{ sessions: SessionSummary[] }>('/api/sessions')
  return res.sessions
}

export async function revokeSession(id: string): Promise<void> {
  await request(`/api/sessions/${id}`, { method: 'DELETE' })
}

// ─── 平台管理面（仅管理员）────────────────────────────────────────────────

export interface AdminUser {
  id: string
  email: string
  name: string
  role: string
  banned: boolean
  banReason: string | null
  /** null = 用平台默认上限（maxInstancesPerUser）。 */
  instanceQuota: number | null
  /** 单实例资源封顶。null = 用平台封顶。 */
  cpuQuota: number | null
  memoryMbQuota: number | null
  pidsQuota: number | null
  diskMbQuota: number | null
  instanceCount: number
  createdAt: string
}

export interface AdminInstance {
  id: string
  slug: string
  /** 和实例面同一套状态（见 InstanceSummary.status）。 */
  status: string
  statusText: string | null
  image: string
  /** 非空 = 有一份升级前的数据快照，可以回滚到这一版。 */
  previousImage: string | null
  cpus: number
  memoryMb: number
  pidsLimit: number
  /** 声明的磁盘容量（MiB）。**只是声明** —— 到底管不管用看 `diskEnforced`。 */
  diskMb: number
  /** 已用磁盘（MiB）。**缺省 = 读不到**（不是 0）。 */
  diskUsedMb?: number
  /** `false` 时必须显示「无上限」而不是 `diskMb`。 */
  diskEnforced: boolean
  lastError: string | null
  createdAt: string
  ownerEmail: string
}

export async function listAdminUsers(): Promise<{
  users: AdminUser[]
  maxInstancesPerUser: number
  /** 平台单实例封顶。用户页用它做 placeholder，并挡住写得更高的值。 */
  platformCaps: PlatformCaps
}> {
  return request('/api/admin/users')
}

/**
 * 管理员直接设账密建号。`account` 是邮箱，或用户名（服务端收成 `<用户名>@父域`）。
 * 返回的 `email` 就是之后登录框里要填的地址。
 */
export async function createAdminUser(input: {
  account: string
  password: string
  name?: string
  role?: 'user' | 'admin'
}): Promise<{ user: { id: string; email: string } }> {
  return request('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export interface AdminInstancesResult {
  instances: AdminInstance[]
  /** DB status==='running' 的活实例数（与 max-running 闸门同一口径）。 */
  runningCount: number
  /** `0` = 不限制。 */
  maxRunning: number
  platformCaps: PlatformCaps
}

export async function listAdminInstances(): Promise<AdminInstancesResult> {
  return request<AdminInstancesResult>('/api/admin/instances')
}

export async function banUser(id: string, reason: string): Promise<void> {
  await request(`/api/admin/users/${id}/ban`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason === '' ? undefined : reason }),
  })
}

export async function unbanUser(id: string): Promise<void> {
  await request(`/api/admin/users/${id}/unban`, { method: 'POST', body: '{}' })
}

/** `quota` 是实例个数（旧字段）。资源四项 null = 清掉个人覆盖、回落平台封顶。缺省的键不改。 */
export interface UserQuotaPatch {
  quota?: number | null
  cpuQuota?: number | null
  memoryMbQuota?: number | null
  pidsQuota?: number | null
  diskMbQuota?: number | null
}

export async function setUserQuota(id: string, patch: UserQuotaPatch): Promise<void> {
  await request(`/api/admin/users/${id}/quota`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/** 授予 / 撤销管理员。最后一名管理员不能降级（后端 400）。 */
export async function setUserRole(id: string, role: 'user' | 'admin'): Promise<void> {
  await request(`/api/admin/users/${id}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  })
}

// ─── 邀请（owner 生成 → 熟人兑换）─────────────────────────────────────────

export interface Invitation {
  id: string
  email: string
  createdAt: string
  expiresAt: string
  /** 非空 = 已经兑换过了。 */
  acceptedAt: string | null
}

export async function listInvitations(): Promise<{
  invitations: Invitation[]
  /** 有效期（小时）。界面要告诉 owner「这条链接多久失效」。 */
  ttlHours: number
}> {
  return request('/api/admin/invitations')
}

/**
 * 生成一条邀请链接。
 *
 * ⚠️ **返回的 `url` 只出现这一次**——服务端只存 token 的哈希，关掉弹窗就再也拿不回来了。
 */
export async function createInvitation(email: string): Promise<{
  url: string
  expiresAt: string
}> {
  return request('/api/admin/invitations', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

/** 撤销一条**还没被兑换**的邀请。已兑换的删不掉（后端 404）。 */
export async function revokeInvitation(id: string): Promise<void> {
  await request(`/api/admin/invitations/${id}`, { method: 'DELETE' })
}

/**
 * 改实例的 CPU / 内存 / pids / 磁盘。CPU、内存、pids 变化会**重建容器**（有几秒不可用）；
 * 磁盘**扩容不停机**，缩容要停机重建（D17 / D18）。
 */
export async function setInstanceQuota(
  id: string,
  quota: { cpus: number; memoryMb: number; pidsLimit: number; diskMb: number },
): Promise<void> {
  await request(`/api/admin/instances/${id}/quota`, {
    method: 'PATCH',
    body: JSON.stringify(quota),
  })
}

/** 管理面的版本信息：`local` 是宿主上**平台仓库**的全部 tag（含未发布的），管理员可任选。 */
export interface AdminInstanceImageInfo {
  image: string
  previousImage: string | null
  local: string[]
  snapshotMb: number | null
}

export async function getAdminInstanceImage(id: string): Promise<AdminInstanceImageInfo> {
  return request<AdminInstanceImageInfo>(`/api/admin/instances/${id}/image`)
}

/** 换镜像（升级 / 降级）。**会停机**（先打数据快照）；失败自动回滚。 */
export async function setAdminInstanceImage(id: string, image: string): Promise<void> {
  await request(`/api/admin/instances/${id}/image`, {
    method: 'PATCH',
    body: JSON.stringify({ image }),
  })
}

export async function rollbackAdminInstanceImage(id: string): Promise<void> {
  await request(`/api/admin/instances/${id}/image/rollback`, { method: 'POST', body: '{}' })
}

// ─── 版本管理（仅管理员，D21 / D23）───────────────────────────────────────
//
// HTTP 路径仍是 `/api/admin/images`：接口描述的是技术对象（镜像），页面表达的是产品
// 概念（版本），两者本来就不同层——为改 UI 命名去动接口要连带路由白名单和一批测试。

export interface AdminImage {
  ref: string
  /** 在 `image_release` 里。用户面的「换版本」列表和新建实例都按它来。 */
  published: boolean
  /** 本机缓存了没有（运行时事实）。与 `published` 独立：上架了但没缓存是正常状态。 */
  onHost: boolean
  /** 新建实例用这一版。至多一个（数据库部分唯一索引兜住）。 */
  isDefault: boolean
  publishedAt: string | null
  /** 注册表给的 manifest digest；没同步过或只在宿主上就是 null。 */
  digest: string | null
}

export interface AdminImages {
  /** 新版本在前。 */
  images: AdminImage[]
  /** catalog 最近一次同步时间；从没同步过 → null。 */
  syncedAt: string | null
}

export interface AdminImagesSyncResult {
  count: number
  skipped: number
  syncedAt: string
}

export async function getAdminImages(): Promise<AdminImages> {
  return request<AdminImages>('/api/admin/images')
}

/** 跑一遍注册表，刷新「上游有哪些版本」的快照。慢——每个 tag 一次 HEAD，页面上要显示 pending。 */
export async function syncAdminImages(): Promise<AdminImagesSyncResult> {
  return request<AdminImagesSyncResult>('/api/admin/images/sync', {
    method: 'POST',
    body: '{}',
  })
}

/** 预热进度流的地址（SSE，`EventSource` 只支持 GET）。 */
export function adminImagePullUrl(ref: string): string {
  return `/api/admin/images/pull?ref=${encodeURIComponent(ref)}`
}

/** 上架一个版本。平台还没有默认版本时，这一版自动成为默认（后端保证）。 */
export async function publishAdminImage(ref: string): Promise<void> {
  await request('/api/admin/images', { method: 'POST', body: JSON.stringify({ ref }) })
}

/** 下架。默认版本不能下架（后端 400）。 */
export async function unpublishAdminImage(ref: string): Promise<void> {
  await request('/api/admin/images', { method: 'DELETE', body: JSON.stringify({ ref }) })
}

/** 设为新建实例用的默认版本。 */
export async function setDefaultAdminImage(ref: string): Promise<void> {
  await request('/api/admin/images/default', { method: 'PATCH', body: JSON.stringify({ ref }) })
}

// ─── 装机引导（平台还没配域名时）────────────────────────────────────────────

/**
 * 平台配好域名没有。控制台启动时问一次，决定显示 setup 页还是正常界面。
 *
 * 这个端点在**两个模式都注册**：已配置时它就是一句 `{ configured: true }`，
 * 控制台据此走正常界面，不必去猜 404 的含义。
 *
 * `demo` 是演示站的共享账号，**只有运营方设了环境变量才有**；登录页拿它显示一条提示。
 */
export interface SetupState {
  configured: boolean
  demo: { email: string; password: string } | null
}

export async function getSetupState(): Promise<SetupState> {
  return request<SetupState>('/api/setup/state')
}

/**
 * 向导页边打字边问：这个父域的泛解析配好了没。
 *
 * **只读**，不改任何状态。存在的理由是提交那一步有风险：域名一旦落库，控制面就带着它重启，
 * 解析不了的话控制台就进不去了。所以要在提交**之前**把这件事摆出来，而不是之后再报错。
 */
export async function probeSetupDomain(
  token: string,
  baseDomain: string,
  consoleDomain?: string,
): Promise<{ resolved: boolean; consoleDomain: string; workspaceResolved: boolean; consoleResolved: boolean }> {
  const query = new URLSearchParams({ baseDomain })
  if (consoleDomain) query.set('consoleDomain', consoleDomain)
  return request<{ resolved: boolean; consoleDomain: string; workspaceResolved: boolean; consoleResolved: boolean }>(`/api/setup/probe?${query}`, {
    // token 走 header：放 query 里会被服务端原样记进访问日志，而这枚 token 引导期就是唯一凭证
    headers: { 'x-setup-token': token },
  })
}

/**
 * 提交**首个管理员账号**和父域。凭证是安装脚本打印的**一次性 token**（在 URL 里带过来的）。
 *
 * 服务端会建号 → 控制台主机名（默认同父域）落库 → **立刻摘掉引导口**，然后重启自己。
 * 建号在落域名**之前**：邮箱被占时回 409 `account-exists`，此时什么都没改，换个邮箱重来即可。
 *
 * `dns` 是一次粗检的结果（随机子域解不解得出来）—— **只作提示，不拦**：解析可能是反代、
 * 也可能还在生效，平台判不了。文案由 UI 组（这里只回事实）。
 */
export async function submitSetup(body: {
  token: string
  baseDomain: string
  consoleDomain?: string
  email: string
  password: string
}): Promise<{ consoleDomain: string; email: string; dns: { probe: string; resolved: boolean } }> {
  return request<{
    consoleDomain: string
    email: string
    dns: { probe: string; resolved: boolean }
  }>('/api/setup', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
