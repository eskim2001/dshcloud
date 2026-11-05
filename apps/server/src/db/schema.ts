import { sql } from 'drizzle-orm'
import { boolean, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

// ─── better-auth 管理的表 ────────────────────────────────────────────────
// 字段名与 better-auth 1.7 的默认 drizzle schema 一致；改这里等于改认证。
// `role` / `banned` / `banReason` / `banExpires` 来自 admin 插件，
// `impersonatedBy` 同理——不装插件时这些列不会被写。

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull(),
  image: text('image'),
  /** 'user' | 'admin'。管理员是**平台运营方**，不是实例的 owner（见 admin-routes）。 */
  role: text('role').notNull().default('user'),
  banned: boolean('banned').notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
  /**
   * 这个用户最多能开几个实例。NULL = 用平台默认值（MAX_INSTANCES_PER_USER）。
   * 平台自己的字段，better-auth 不认——但同表存着最省事。
   */
  instanceQuota: integer('instance_quota'),
  /**
   * 该用户**单个**实例的资源上限。NULL = 用平台 `PLATFORM_MAX_*`。
   * 与 `instanceQuota`（能开几个）分开：这里封的是一档实例的 CPU / 内存 / pids / 磁盘，
   * 写入时不得高于平台封顶，生效时再取 min。
   */
  cpuQuota: real('cpu_quota'),
  memoryMbQuota: integer('memory_mb_quota'),
  pidsQuota: integer('pids_quota'),
  diskMbQuota: integer('disk_mb_quota'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** 管理员代入（impersonate）时记下是谁代入的。 */
    impersonatedBy: text('impersonated_by'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
)

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
)

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)

// ─── 平台自己的表 ────────────────────────────────────────────────────────

/**
 * 一个实例 = 一个容器 + 一个卷 + 一个网络 + 一条 Traefik 路由。
 *
 * `slug` 是**唯一**的对外标识，也是容器/卷/网络名的来源——它已过
 * `InstanceSlugSchema` 白名单，所以拼名字是安全的（见 orchestrator 注释）。
 */
export const instance = pgTable(
  'instance',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    storageKey: text('storage_key').notNull().unique().default(sql`replace(gen_random_uuid()::text, '-', '')`),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** 谁能打开它。授权判定的唯一依据（D8 ②）。 */
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /** provisioning | running | stopped | error | removing */
    status: text('status').notNull().default('provisioning'),
    image: text('image').notNull(),
    /**
     * 上一版镜像。**非空 = 有一份升级前的数据快照可回滚**（快照本身是一块 `.prev` 命名卷，
     * 不进库）。回滚成功后置回 NULL。
     */
    previousImage: text('previous_image'),
    containerId: text('container_id'),
    /**
     * 该实例在**宿主回环**上发布的端口，入口（Traefik）按它转发。
     *
     * 为什么必须有：实例只把桥端口发布到**宿主回环**，入口不按容器名解析、只认这个端口。
     * 所以它是实例在宿主上的**地址**，不是可选配置。
     *
     * 唯一约束由数据库兜底，但**只在活着的行之间**成立（部分唯一索引，见文件末尾）——
     * 跨实例冲突会让启动直接失败，所以分配前必须真探端口。
     * 可为空 —— 存量行没有这个值，重建时才会分配。
     */
    hostPort: integer('host_port'),
    cpus: real('cpus').notNull(),
    memoryMb: integer('memory_mb').notNull(),
    pidsLimit: integer('pids_limit').notNull().default(512),
    /**
     * 磁盘配额。**语义已变**：现在它只是数据卷**声明的容量**，记进卷的 label，用于展示和
     * 按同容量重建 —— Docker 命名卷**没有硬配额**。
     *
     * ⚠️ 真要上限得靠宿主文件系统的 project quota（XFS / ext4），**仅 Linux**；开发机
     * （macOS / Docker Desktop）上**连这条路都没有** —— 实测它的 linuxkit 内核把配额整块裁了
     * （`CONFIG_XFS_QUOTA`、`QFMT_V1/V2` 均未设，`mount -o pquota` 一律 EINVAL）。
     * 见 `DockerDriver.createStorage` 与 docs/RUNTIME-CONTAINER-EVAL.md。
     *
     * 仍是 MB 粒度（对外接口不变）。
     */
    diskMb: integer('disk_mb').notNull().default(10_240),
    /** 最近一次编排失败的原因，供管理台显示。 */
    lastError: text('last_error'),
    /**
     * 最后一次变成 stopped 的时刻。由 `updateInstance` 按 status 自动维护，
     * 调用方不用管——详情页用它显示「已停止多久」。
     */
    stoppedAt: timestamp('stopped_at', { withTimezone: true }),
    /**
     * 工作空间最近一次被授权访问（或启动成功）的时刻。
     * 空闲回收靠它判「多久没人用」；start/create 成功与 forward-auth 放行会刷新。
     */
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('instance_owner_id_idx').on(t.ownerId),
    // 这两个唯一性**只约束活着的行**：软删除留的是墓碑，墓碑不该继续占着 slug 或端口。
    //
    // 踩过的坑：`host_port` 原本是全表 `.unique()`，而分配器（`listAllInstances`）只看活着的行 ——
    // 于是它会把墓碑占着的端口分给新实例，落库时违反唯一约束，症状是那条
    // `Failed query: update "instance" set ... "host_port" ...`。分配器看不见的东西，
    // 数据库也不该拿它卡人。
    uniqueIndex('instance_slug_unique').on(t.slug).where(sql`${t.deletedAt} IS NULL`),
    uniqueIndex('instance_host_port_unique').on(t.hostPort).where(sql`${t.deletedAt} IS NULL`),
  ],
)

/**
 * 用量采样。一分钟一条，按实例维度存——**跨实例聚合是错的**（铁律 7），
 * 查询永远带 `instanceId`。
 *
 * 保留 30 天，由采样任务顺带清理。
 */
export const instanceMetric = pgTable(
  'instance_metric',
  {
    id: text('id').primaryKey(),
    /** 实例记录删了就跟着删——指标属于记录，不属于数据卷。 */
    instanceId: text('instance_id')
      .notNull()
      .references(() => instance.id, { onDelete: 'cascade' }),
    sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull().defaultNow(),
    /** CPU 占用百分比（100 = 用满一个核，可以超过 100）。 */
    cpuPercent: real('cpu_percent').notNull(),
    memMb: integer('mem_mb').notNull(),
    /**
     * 已用磁盘 MB。读的是**文件系统超级块**（`df` 口径），不是 `du` 估算——
     * 后者会跳会偏，还会漏掉已删除但仍被打开的文件。
     */
    diskUsedMb: integer('disk_used_mb').notNull().default(0),
  },
  (t) => [index('instance_metric_instance_sampled_idx').on(t.instanceId, t.sampledAt)],
)

/**
 * 平台发布的镜像版本（D21）。**运行时唯一真相**：新建实例用 `is_default` 那一版，
 * 用户面能自助升到的版本 = 这张表 ∩ 宿主上真有。
 *
 * 「至多一个默认」由部分唯一索引兜住——不靠应用层自觉。
 */
export const imageRelease = pgTable(
  'image_release',
  {
    id: text('id').primaryKey(),
    /** 完整镜像引用，如 `dsh-instance:0.1.0`（也可以带 registry）。 */
    ref: text('ref').notNull().unique(),
    isDefault: boolean('is_default').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('image_release_default_unique').on(t.isDefault).where(sql`${t.isDefault}`)],
)

/**
 * 注册表上有什么（D23）：GHCR tag 的**本地快照**，每次「同步」整批重建。
 *
 * 刻意与 `image_release` 分开：这里只放**上游事实**，可以随时丢弃重来；发布决定在
 * `image_release` 里。合表的话，同步的删除语句必须豁免已发布行——漏一处就删掉默认版本。
 * 宿主上有没有这个镜像**不存**：那是运行时事实（`docker rmi` 随时会变），存了必漂。
 */
export const imageCatalog = pgTable('image_catalog', {
  /** 完整镜像引用（含仓库与 tag）。 */
  ref: text('ref').primaryKey(),
  /** manifest list 的 digest（`Docker-Content-Digest`），只用于展示/比对。 */
  digest: text('digest').notNull(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * 平台自己的设置，**单行**（`id = 'singleton'`）。
 *
 * 眼下只有一样东西：域名。装机不往 env 里写域名（那两项恒为空），所以它**总是**由操作者在
 * 引导页里填、落到这张表；之后控制面每次启动都从这里读，读不到才是引导态。
 * （env 里写了会压过这张表 —— 那条留给本地开发和手工覆盖，见 `withPlatformDomains`。）
 *
 * **为什么用固定主键而不是"唯一约束保证只有一行"**：单例就该在键上直说，别让读的人去
 * 猜「会不会有两行、以哪一行为准」。
 */
export const platformSetting = pgTable('platform_setting', {
  /** 永远是 `'singleton'`。 */
  id: text('id').primaryKey(),
  /** 父域（`<slug>.<base>`）。空串 = 还没配。 */
  baseDomain: text('base_domain').notNull().default(''),
  /** 控制台主机名，必须是父域的子域。 */
  consoleDomain: text('console_domain').notNull().default(''),
  /** 第一次配好域名的时刻（展示与排障用）。 */
  configuredAt: timestamp('configured_at', { withTimezone: true }),
})

/**
 * 一次性邀请链接。owner 生成、复制，自己发给熟人——**平台不发邮件**，所以这里
 * 只有「链接」，没有投递状态。
 *
 * **只存 token 的哈希**：明文只在生成那一刻返回一次，之后谁也恢复不出来，包括
 * 拿到库的人。兑换成功写 `acceptedAt`，同一条链接不能再用。
 */
export const invitation = pgTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    /** SHA-256(token)。明文不落库。 */
    tokenHash: text('token_hash').notNull().unique(),
    /**
     * 被邀者的邮箱。**必填**——生成时先查有没有账号，有就直接拒绝。
     * 链接因此不是「谁捡到谁能用」，捡到的人还得知道是发给哪个邮箱的。
     */
    email: text('email').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    /** 兑换后指向新账号。账号被删就置空，但这一行留着——token 不能复活。 */
    acceptedBy: text('accepted_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('invitation_email_idx').on(t.email),
    index('invitation_created_by_idx').on(t.createdBy),
  ],
)

/**
 * 管理员为某个用户配置的默认模型凭据。库里只有密文。
 *
 * 这不是 gate token，也不是 dsh 启动时打印的入口 token，更不是会话 cookie。
 * 那些材料继续走原来的派生 / stdout / session，不进这张表。
 * `user_id` 级联删除：人没了，默认密文一起没。
 * `updated_by_admin_id` 只是审计戳，管理员账号被删时置空，不能把被配置用户的默认一起删掉。
 */
export const userModelCredential = pgTable(
  'user_model_credential',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** CredentialRef，例如 `DEEPSEEK_API_KEY`。与容器 env 不是同一条通道。 */
    providerRef: text('provider_ref').notNull(),
    /** `v1.` + base64(iv ‖ tag ‖ ciphertext)。算法见 model-credentials/crypto.ts。 */
    ciphertext: text('ciphertext').notNull(),
    /** 与密文前缀一致。v1 = PLATFORM_SECRET 经 HKDF 得到的 AES-256-GCM 密钥。 */
    keyVersion: integer('key_version').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByAdminId: text('updated_by_admin_id').references(() => user.id, { onDelete: 'set null' }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.providerRef] }),
    index('user_model_credential_user_id_idx').on(t.userId),
  ],
)

/**
 * 管理员为某个用户配置的默认 Custom 模型通道（非密）。
 *
 * 每用户至多一行。Key 不在这里：bearer 仍进 `user_model_credential`，ref 与 `api_key_env` 对齐。
 * base URL 由管理员按用户填写，不写成全站常量。已有工作区不回读、不回写。
 * `user_id` 级联删除；`updated_by_admin_id` 只是审计戳，管理员账号被删时置空。
 */
export const userModelProvider = pgTable('user_model_provider', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  /** 永久 Provider ID，小写。默认 `cliproxy`。 */
  providerId: text('provider_id').notNull(),
  /** 空则注入时用 `CLIProxyAPI`。 */
  displayName: text('display_name'),
  /** 完整 URL，含协议与路径前缀。 */
  baseUrl: text('base_url').notNull(),
  /** MVP 只接受 `openai-completions`。 */
  api: text('api').notNull(),
  /** CredentialRef，须与凭据表的 provider_ref 一致。默认 `CLIPROXY_API_KEY`。 */
  apiKeyEnv: text('api_key_env').notNull(),
  /** 空数组表示注入占位 model id，不在这里钉死对话默认模型。 */
  modelIds: jsonb('model_ids').$type<string[]>().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedByAdminId: text('updated_by_admin_id').references(() => user.id, { onDelete: 'set null' }),
})

export type InstanceRow = typeof instance.$inferSelect
export type InstanceStatus = InstanceRow['status']
export type InstanceMetricRow = typeof instanceMetric.$inferSelect
export type ImageReleaseRow = typeof imageRelease.$inferSelect
export type ImageCatalogRow = typeof imageCatalog.$inferSelect
export type PlatformSettingRow = typeof platformSetting.$inferSelect
export type InvitationRow = typeof invitation.$inferSelect
export type UserModelCredentialRow = typeof userModelCredential.$inferSelect
export type UserModelProviderRow = typeof userModelProvider.$inferSelect

// Workspace credentials never contain the console session token.
export const workspaceGrant = pgTable('workspace_grant', {
  codeHash: text('code_hash').primaryKey(),
  stateHash: text('state_hash').notNull(),
  instanceId: text('instance_id').notNull().references(() => instance.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => session.id, { onDelete: 'cascade' }),
  callbackUrl: text('callback_url').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, t => [index('workspace_grant_expiry_idx').on(t.expiresAt)])

export const workspaceSession = pgTable('workspace_session', {
  tokenHash: text('token_hash').primaryKey(),
  instanceId: text('instance_id').notNull().references(() => instance.id, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull().references(() => session.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, t => [index('workspace_session_expiry_idx').on(t.expiresAt), index('workspace_session_parent_idx').on(t.sessionId)])
