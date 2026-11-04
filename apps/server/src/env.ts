import { z } from 'zod'
import { DomainSchema } from './domain.js'

/**
 * 平台运行时配置。**全部来自环境变量**，启动时校验一次，缺了就起不来。
 *
 * `PLATFORM_SECRET` 和 `BETTER_AUTH_SECRET` 故意分开：前者派生实例桥的
 * gate token（D8 ③），后者签会话。密钥轮换的影响面不同，不该共用一把。
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, '缺 DATABASE_URL'),

  /**
   * **父域**：实例子域挂在它下面（`<slug>.<BASE_DOMAIN>`），会话 cookie 也种在它上面
   * （`Domain=.<BASE_DOMAIN>`），所以它必须同时覆盖控制台和实例。
   *
   * **可以为空**：空 = 还没配域名（**引导态**）—— 那时控制面只暴露引导页，
   * 操作者在上面建管理员、填域名，域名写进 `platform_setting` 后重启生效。
   *
   * 非空会**压过**那份 DB 记录。装机不再写它（.env 里那两行恒为空），这条只服务
   * **本地开发**（`BASE_DOMAIN=lvh.me`）和手工覆盖。见 DECISIONS 的引导态装机那条。
   */
  BASE_DOMAIN: z.union([z.literal(''), DomainSchema]).default(''),

  /**
   * 控制台自己的主机名。它决定 better-auth 的 baseURL、受信 Origin 和未登录时的跳转目标。
   * 与 `BASE_DOMAIN` 同为空。
   *
   * **可以等于父域**（同域入口，如 `dsh.example.com/admin`）。实例子域永远是
   * `<slug>.<父域>`，对不上顶点 `Host(`父域`)`，所以父域当控制台主机名抢不走。
   * 也可以仍是父域下的独立主机（`console.<父域>`）；那种部署里 `console.` 不是唯一入口的前提
   * 不成立，见 `platform-routes.ts` 的别名跳转——只有顶点模式才会把 `console.<父域>` 指回顶点。
   */
  CONSOLE_DOMAIN: z.union([z.literal(''), DomainSchema]).default(''),

  /** 派生实例 gate token。轮换后**必须重建实例容器**，否则桥 403。 */
  PLATFORM_SECRET: z.string().min(32, 'PLATFORM_SECRET 至少 32 字符'),

  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET 至少 32 字符'),

  /**
   * 控制面监听端口。绑定地址见 `CONTROL_PLANE_LISTEN_HOST`；
   * 生产仍应由反向代理（Traefik）对外，别把控制面业务口直接暴露公网。
   */
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * 控制面 listen 地址。默认 `0.0.0.0`。
   *
   * **为什么不是 127.0.0.1**：本地开发里 Traefik 跑在容器、控制面跑在宿主。
   * Docker Desktop 上 `host.docker.internal` 能摸到宿主回环；Linux 的 host-gateway
   *（如 `172.17.0.1`）**到不了**宿主 loopback —— 绑 `127.0.0.1` 时容器侧 forward-auth
   * / 控制台代理会连不上。workspace-gateway 共用此绑定（Traefik →
   * `host.docker.internal:gatewayPort`）。需要更严时再显式设回 `127.0.0.1`（仅 Docker Desktop / 同宿主
   * 反代场景）。见 docs/FORK.md。
   */
  CONTROL_PLANE_LISTEN_HOST: z.string().min(1).default('0.0.0.0'),

  /**
   * 平台级资源封顶（对齐小机）。创建 / 改档超过即拒；UI 选项也会裁到 ≤ 这些值。
   * **全局**上限——本版不做每用户资源封顶（每用户仍只有实例**个数**配额）。
   */
  PLATFORM_MAX_CPUS: z.coerce.number().positive().default(2),
  PLATFORM_MAX_MEMORY_MB: z.coerce.number().int().positive().default(2048),
  PLATFORM_MAX_PIDS: z.coerce.number().int().positive().default(512),
  PLATFORM_MAX_DISK_MB: z.coerce.number().int().positive().default(10_240),

  /**
   * 全局同时 `running` 的实例上限。启动（create / start / restart 从非 running 转入）前检查。
   * **`0` = 不限制**。
   */
  PLATFORM_MAX_RUNNING: z.coerce.number().int().min(0).default(3),

  /**
   * 空闲回收：`running` 且 `last_active_at` 早于「现在 − N 分钟」的实例会被 stop。
   * **`0` = 关闭**空闲回收。
   */
  PLATFORM_IDLE_CULL_MINUTES: z.coerce.number().int().min(0).default(45),

  /** 生成对外 URL 用（本地开发是 http，线上是 https）。 */
  PUBLIC_SCHEME: z.enum(['http', 'https']).default('https'),

  /**
   * 管理台静态文件目录。**留空 = 不 serve** —— 本地开发由 Vite dev server 提供，
   * 这条路根本不注册（路由面测试因此不受影响）。
   *
   * 平台镜像里设成 `/app/web`：控制面同源提供管理台，不需要第二个容器或 nginx，
   * 也就没有了 dev 里那个 `/api` 反向代理。
   */
  WEB_DIST_DIR: z.string().default(''),

  /**
   * 额外受信来源，逗号分隔。better-auth 会校验请求的 Origin；
   * 生产就是 `CONSOLE_DOMAIN` 本身，开发时前端跑在 :5173，需要显式放行。
   */
  EXTRA_TRUSTED_ORIGINS: z.string().default(''),

  /**
   * 实例路由挂的 entryPoint。生产是 `websecure`（TLS 终结在 Traefik）；
   * 本地也是 `websecure`（没配静态证书，回落到 Traefik 的默认自签证书）。
   */
  TRAEFIK_ENTRYPOINT: z.string().default('websecure'),

  /**
   * 实例 router 用的 ACME resolver 名（对应 traefik.yml 里的 certificatesResolvers）。
   * 留空 = 不挂 resolver，证书走 file provider 的静态证书按 SNI 匹配。
   * 本地没有静态证书，落到 Traefik 的默认自签证书；生产是把 Cloudflare Origin Certificate
   * 之类的证书放进 file provider（TLS 在边缘终结时也是这一档）。
   */
  TRAEFIK_CERT_RESOLVER: z.string().default(''),

  /** 每个用户默认能开几个实例；单个用户的覆盖值在 user.instance_quota。 */
  MAX_INSTANCES_PER_USER: z.coerce.number().int().positive().default(3),

  /**
   * **实例数据池的根**。池化之后实例数据不再是一块块 Docker 命名卷，而是这个目录下
   * **每个实例一个子目录 + 一个 XFS project ID**（硬配额）。
   *
   * 要求它落在一块 **XFS 且以 `pquota` 挂载**的文件系统上；不是的话平台会**自己建一块
   * loopback XFS 镜像**（`<root>.img`）并挂上来当池子 —— 那一步要宿主的 `CAP_SYS_ADMIN`。
   * 两条都做不到时：Linux 上**拒绝启动**（池化的隔离是逻辑隔离，没有真配额就不该跑），
   * macOS 上退化为"不强制 + 一行警告"（它的内核没编配额）。
   */
  HOST_STORAGE_ROOT: z.string().min(1).default('/var/lib/dsh'),

  /**
   * 池子大小（MiB）—— **只在平台自动建 loopback 镜像时用**，且**只在首次建池生效**
   * （之后绝不自动改大小）。省略则取宿主该文件系统的 80%。
   */
  HOST_POOL_SIZE_MB: z.coerce.number().int().positive().optional(),

  /**
   * 实例后端的**上游主机名** —— Traefik 用它去连实例发布的宿主回环端口。
   *
   * 默认 `127.0.0.1`（Traefik 跑在**宿主上**时正确）。但本地开发里 Traefik 是**容器**，
   * 它自己的 `127.0.0.1` 跟宿主不是一回事 —— 实测那样会得到 **502 Bad Gateway**。
   * 容器场景要改成 `host.docker.internal`（compose 里已经配了 `extra_hosts`，
   * 控制台那条路由就是靠它连宿主回环的）。
   */
  INSTANCE_UPSTREAM_HOST: z.string().min(1).default('127.0.0.1'),

  /**
   * 平台自己的实例镜像仓库（D22）。发布准入和「宿主上可发布」都按它过滤——
   * 不再从默认版本推断（那样表一空就没法发布第一版）。本地 build.sh 打的是同一个全名。
   */
  INSTANCE_IMAGE_REPO: z.string().min(1).default('ghcr.io/eskim2001/dsh-instance'),

  /**
   * 同步 GHCR tag 用的凭据（D23）。包是**公开**的，不设也能匿名读；
   * 换成私有包时两个都要设，只设一个会被忽略（免得出现半截 Basic 头）。
   */
  INSTANCE_IMAGE_REGISTRY_USER: z.string().default(''),
  INSTANCE_IMAGE_REGISTRY_TOKEN: z.string().default(''),

  /**
   * **引导态的唯一凭证**。装机没给域名时由安装脚本生成并打印，操作者带着它打开
   * `http://<ip>/setup?token=…`。配好域名后它自然失效（引导态结束，那个端点不再注册）。
   */
  SETUP_TOKEN: z.string().default(''),

  /**
   * 控制面**自己的容器名**。配完域名要重启自己一次（cookie 域与 baseURL 都是启动期配置），
   * 重启靠它定位容器 —— 不依赖 `os.hostname()` 恰好等于容器短 ID 这种事。
   */
  SELF_CONTAINER: z.string().default(''),

  /**
   * **演示站的共享账号**，两个都填才会在登录页显示一条提示（点一下直接填进表单）。
   *
   * 之所以是环境变量、而不是写死在页面里：登录页是**所有部署共用的一份代码**，
   * 写死了每个自托管的人都会在自己登录页上看到这个演示账号。不设 = 什么都不多出来。
   *
   * 只填一个按没配处理（别把半截凭据显示出去）。**密码会经公开端点原样发给任何访客** ——
   * 它天生就是公开的，这里只放演示账号，别塞真账号。
   */
  DEMO_EMAIL: z.string().default(''),
  DEMO_PASSWORD: z.string().default(''),
}).superRefine((env, ctx) => {
  // 引导态：两个都空是**合法**的（域名还没配）。只填一个才是配置错误。
  if (env.BASE_DOMAIN === '' || env.CONSOLE_DOMAIN === '') {
    if (env.BASE_DOMAIN !== env.CONSOLE_DOMAIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CONSOLE_DOMAIN'],
        message: 'BASE_DOMAIN 与 CONSOLE_DOMAIN 要么都填、要么都空（都空 = 引导态，域名稍后在面板里配）',
      })
    }
    return
  }
  // 相等是同域入口（父域顶点 = 控制台），不是配置错误。实例子域多一个标签，对不上这个 Host。
})

export type Env = z.infer<typeof EnvSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    throw new Error(`环境变量不合法：\n${lines.join('\n')}`)
  }
  return parsed.data
}

/** better-auth 的受信来源：**控制台**自己的 origin + 额外放行项。实例子域不在其中。 */
export function trustedOrigins(env: Env): string[] {
  // 引导态没有控制台域名，也就**没有**可信来源 —— 返回空表，别造一个 `https://` 出来
  // （那会让 Origin 钩子永远不匹配，看起来像"配好了也写不进东西"）。
  const base = env.CONSOLE_DOMAIN === '' ? [] : [`${env.PUBLIC_SCHEME}://${env.CONSOLE_DOMAIN}`]
  const extra = env.EXTRA_TRUSTED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  return [...base, ...extra]
}

/**
 * `console.<父域>` 兼容别名的标签。同域模式下入口把这个主机 302 到父域顶点。
 *
 * 这个字面量在**三处**出现，改一处就得改另两处：这里、`RESERVED_SLUGS`（租户不能抢它，
 * 见 `packages/instance-spec`）、安装脚本的 `CONSOLE_LABEL`。前两者的关系有测试盯着
 * （`env.test.ts`），第三方（bash）只能靠注释和 review。
 */
export const CONSOLE_LABEL = 'console'

/**
 * 请求头 `Host` 的主机名，去掉端口。
 *
 * `lvh.me:443` 与 `lvh.me` 是同一台控制台。IPv6 的方括号主机原样留下（平台不用它当控制台）。
 */
export function hostnameOf(hostHeader: string | undefined): string {
  if (hostHeader === undefined || hostHeader === '') return ''
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1)
  }
  return hostHeader.replace(/:\d+$/u, '')
}

/**
 * 这个 Host 是不是控制面自己（含同域模式下的 `console.<父域>` 跳转别名）。
 *
 * 别名只为了清旧 cookie / 识别「这是平台流量」。写请求的 Origin 仍然只信
 * `trustedOrigins` 里的**规范主机**——别名在入口被 302 走，不在上面建会话。
 */
export function isPlatformHost(env: Env, hostHeader: string | undefined): boolean {
  const host = hostnameOf(hostHeader)
  if (host === '' || env.CONSOLE_DOMAIN === '') return false
  if (host === env.CONSOLE_DOMAIN) return true
  return (
    env.BASE_DOMAIN !== '' &&
    env.CONSOLE_DOMAIN === env.BASE_DOMAIN &&
    host === `${CONSOLE_LABEL}.${env.BASE_DOMAIN}`
  )
}

/**
 * 能被实例 slug 抢到的那一截标签。
 *
 * 只有控制台主机**恰好**是 `<label>.<父域>` 时，slug = label 才会渲染出同一条
 * `Host` 规则。父域顶点（`CONSOLE_DOMAIN === BASE_DOMAIN`）不是这种形状，返回空串——
 * 没有可抢的标签。引导态也是空串。
 */
export function consoleLabel(env: Env): string {
  const { CONSOLE_DOMAIN: consoleDomain, BASE_DOMAIN: base } = env
  if (consoleDomain === '' || base === '' || consoleDomain === base) return ''
  const suffix = `.${base}`
  if (!consoleDomain.endsWith(suffix)) return ''
  const label = consoleDomain.slice(0, -suffix.length)
  if (label === '' || label.includes('.')) return ''
  return label
}

/**
 * 登录页要展示的演示账号。两个都填才有值 —— 只填一个当没配（见 `DEMO_EMAIL` 的说明）。
 * 返回 `null` 时就当这个功能不存在，登录页上不多出任何东西。
 */
export function demoAccount(env: Env): { email: string; password: string } | null {
  const { DEMO_EMAIL: email, DEMO_PASSWORD: password } = env
  // 空 == 没配（`Env` 上这两个有默认值，但测试里手写的 env fixture 未必带）
  if (!email || !password) return null
  return { email, password }
}

/**
 * 把「env 里写的域名」与「DB 里存的域名」合成一份**生效的** Env，并说明当前是不是引导态。
 *
 * 优先级：**env 优先**（本地开发 / 手工覆盖走这档），env 空才用 DB；
 * 都没有 ⇒ 引导态（只暴露引导页，见 DECISIONS 的引导态装机）。
 *
 * 用法：**在 `createAuth` 和 `buildApp` 之前解析一次**，之后全用它 —— 否则
 * `trustedOrigins` 之类会拿空域名算出废值。
 */
export function withPlatformDomains(
  env: Env,
  stored?: { baseDomain: string; consoleDomain: string },
): { env: Env; bootstrap: boolean } {
  if (env.BASE_DOMAIN !== '') return { env, bootstrap: false }
  const baseDomain = stored?.baseDomain ?? ''
  const consoleDomain = stored?.consoleDomain ?? ''
  // 存的这一对也要过同一道规则；不过就当没配（fail closed，宁可停在引导态也不要拿它拼 URL）
  const configured = EnvSchema.safeParse({ ...env, BASE_DOMAIN: baseDomain, CONSOLE_DOMAIN: consoleDomain })
  if (baseDomain === '' || !configured.success) {
    return { env, bootstrap: true }
  }
  return { env: configured.data, bootstrap: false }
}
