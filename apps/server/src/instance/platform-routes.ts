import { join } from 'node:path'
import { CONSOLE_LABEL } from '../env.js'
import { removeDynamicConfig, writeDynamicConfig } from './dynamic-config.js'

/**
 * 平台自己的那几条路由 —— 控制面是它们的**唯一写者**（file provider 只看目录）。
 *
 * 三个文件，两套状态：
 *
 * | 文件 | 已配置 | 引导态 | 作用 |
 * |---|---|---|---|
 * | `platform.yml` | 写 | **删** | 控制台：`Host(console.<域>)` + 证书 |
 * | `redirect.yml` | 写 | **删** | :80 → :443 跳转（**不能**写在静态配置里，见下） |
 * | `bootstrap.yml` | **删** | 写 | 引导口：:80 上一条 catch-all → 控制面自己 |
 *
 * **为什么跳转不能留在静态配置**：静态的 `entryPoints.web.http.redirections` 会把 :80 上
 * **所有**请求 301 掉，包括引导期的 catch-all —— 实测 2026-09-13（真 Traefik v3.5.6），
 * 而静态配置一改就得重启 Traefik。改成动态 router（`redirectScheme` + `noop@internal`）之后，
 * 「引导期没有跳转 / 配好后出现」都是写文件的事，**全程不重启**。
 *
 * 引导态与已配置态的投影**每次启动都跑一遍**（幂等）：这样即使上一轮半途挂了，
 * 也不会把一条明文 catch-all 留在 :80 上。
 */

export interface PlatformRoutesOptions {
  /** Traefik file provider 监视的目录。 */
  dir: string
  /** 控制面自己在宿主回环上的端口 —— 引导期的 catch-all 指向它。 */
  selfPort: number
  /** 控制台主机名。**省略 = 引导态**（还没配域名），写引导口、删控制台那两条。 */
  consoleDomain?: string
  /**
   * 父域。与 `consoleDomain` **相同**时，控制面落在顶点（同域 `/admin`），
   * 并多写一条 `console.<父域>` → 顶点的跳转。省略则只投影控制台主机本身。
   */
  baseDomain?: string
  /** 控制台 router 挂的 entryPoint（生产是 `websecure`）。 */
  entryPoint: string
  /** 承载明文的那条 entryPoint（`:80`）。跳转与引导口都用它。 */
  httpEntryPoint: string
  /** 后端上游主机名（见 `Env.INSTANCE_UPSTREAM_HOST`）。 */
  upstreamHost?: string
  /** 挂给控制台 router 的 `tls` 块（见 `TraefikOptions.tls`）。 */
  tls?: { certResolver?: string }
}

const PLATFORM_FILE = 'platform.yml'
const REDIRECT_FILE = 'redirect.yml'
const BOOTSTRAP_FILE = 'bootstrap.yml'

/**
 * 承载明文的那条 entryPoint 名。**由静态配置定死**（`docker/traefik/*.yml` 里的 `web`），
 * 所以这里是个常量而不是配置项 —— 改它就得同时改静态配置，那不是"配置"能表达的关系。
 */
export const platformRoutesHttpEntryPoint = 'web'

/** 把主机名放进正则时转义点号，免得 `console.example.com` 匹配到别的标签。 */
function escapeHost(host: string): string {
  return host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 控制台自己的 router。**不挂 forward-auth** —— 它自己走会话认证（better-auth），
 * 与实例路由是两回事。
 *
 * 规范主机是 `Host(`控制台`)`，priority 1000。实例子域是 `Host(`<slug>.<父域>`)`：
 * 控制台若就是父域顶点，这两条规则不可能相同（slug 总会多一个标签）。
 * 控制台若是 `<label>.<父域>`，同长度的碰撞靠 priority + 保留字挡住。
 *
 * 顶点模式下另加 `Host(`console.<父域>`)` → 302 到规范主机（兼容旧书签）。
 * 这条同样 priority 1000，且 `console` 在保留字里，实例抢不到这个别名。
 */
export function buildConsoleConfig(opts: {
  consoleDomain: string
  baseDomain?: string
  upstreamHost?: string
  selfPort: number
  entryPoint: string
  tls?: { certResolver?: string }
}): unknown {
  const upstream = opts.upstreamHost ?? '127.0.0.1'
  const tls = opts.tls === undefined ? {} : { tls: opts.tls }
  const routers: Record<string, unknown> = {
    'platform-web': {
      rule: `Host(\`${opts.consoleDomain}\`)`,
      // 显式优先级：Traefik 默认按规则长度排序，长度相同则行为未定义。实例规则的长度随
      // slug 变化，不能靠"刚好更长"。有这条，slug 撞上控制台 label 时控制台也稳赢。
      priority: 1000,
      service: 'platform-web',
      entryPoints: [opts.entryPoint],
      ...tls,
    },
  }
  const middlewares: Record<string, unknown> = {}

  if (opts.baseDomain !== undefined && opts.consoleDomain === opts.baseDomain) {
    const alias = `${CONSOLE_LABEL}.${opts.baseDomain}`
    // 入口已经终结 TLS 时跳到 https；明文部署不能把人送去没人听的 443。
    const scheme = opts.tls === undefined ? 'http' : 'https'
    middlewares['console-alias-redirect'] = {
      redirectRegex: {
        regex: `^https?://${escapeHost(alias)}(.*)`,
        replacement: `${scheme}://${opts.consoleDomain}\${1}`,
        permanent: false,
      },
    }
    routers['platform-console-alias'] = {
      rule: `Host(\`${alias}\`)`,
      priority: 1000,
      service: 'noop@internal',
      middlewares: ['console-alias-redirect'],
      entryPoints: [opts.entryPoint],
      ...tls,
    }
  }

  return {
    http: {
      ...(Object.keys(middlewares).length === 0 ? {} : { middlewares }),
      routers,
      services: {
        'platform-web': {
          loadBalancer: { servers: [{ url: `http://${upstream}:${opts.selfPort}` }] },
        },
      },
    },
  }
}

/** :80 上一条 catch-all 跳转到 https。`noop@internal` 是 Traefik 内置的空服务，跳转只要它。 */
export function buildRedirectConfig(opts: { httpEntryPoint: string }): unknown {
  return {
    http: {
      middlewares: {
        'redirect-to-https': { redirectScheme: { scheme: 'https', permanent: true } },
      },
      routers: {
        'http-redirect': {
          rule: 'PathPrefix(`/`)',
          priority: 1,
          service: 'noop@internal',
          middlewares: ['redirect-to-https'],
          entryPoints: [opts.httpEntryPoint],
        },
      },
    },
  }
}

/** 引导口：:80 上一条 catch-all 直接打到控制面自己（token 门在应用层）。 */
export function buildBootstrapConfig(opts: {
  upstreamHost?: string
  selfPort: number
  httpEntryPoint: string
}): unknown {
  const upstream = opts.upstreamHost ?? '127.0.0.1'
  return {
    http: {
      routers: {
        bootstrap: {
          rule: 'PathPrefix(`/`)',
          priority: 1,
          service: 'bootstrap',
          entryPoints: [opts.httpEntryPoint],
        },
      },
      services: {
        bootstrap: {
          loadBalancer: { servers: [{ url: `http://${upstream}:${opts.selfPort}` }] },
        },
      },
    },
  }
}

/**
 * 按当前状态把三个文件投影成该有的样子。**幂等**，每次启动都跑。
 *
 * 返回这一轮**实际删掉**的文件名（排障用；正常启动应为空）。
 */
export async function projectPlatformRoutes(opts: PlatformRoutesOptions): Promise<string[]> {
  // 先取成局部量：布尔判断没法把 `opts.consoleDomain` 收窄，后面那次 `buildConsoleConfig` 要用
  const consoleDomain = opts.consoleDomain
  const removed: string[] = []

  const drop = async (name: string): Promise<void> => {
    if (await removeDynamicConfig(join(opts.dir, name))) removed.push(name)
  }

  if (consoleDomain === undefined) {
    await writeDynamicConfig(
      join(opts.dir, BOOTSTRAP_FILE),
      buildBootstrapConfig({
        ...(opts.upstreamHost === undefined ? {} : { upstreamHost: opts.upstreamHost }),
        selfPort: opts.selfPort,
        httpEntryPoint: opts.httpEntryPoint,
      }),
    )
    await drop(PLATFORM_FILE)
    await drop(REDIRECT_FILE)
    return removed
  }

  await writeDynamicConfig(
    join(opts.dir, PLATFORM_FILE),
    buildConsoleConfig({
      consoleDomain,
      ...(opts.baseDomain === undefined ? {} : { baseDomain: opts.baseDomain }),
      ...(opts.upstreamHost === undefined ? {} : { upstreamHost: opts.upstreamHost }),
      selfPort: opts.selfPort,
      entryPoint: opts.entryPoint,
      ...(opts.tls === undefined ? {} : { tls: opts.tls }),
    }),
  )
  // 只有真的在终结 TLS 时才写跳转：`tls` 缺省意味着这是个明文部署（局域网那档），
  // 那时把请求 301 到 443 等于送进没人监听的地方。
  if (opts.tls !== undefined) {
    await writeDynamicConfig(
      join(opts.dir, REDIRECT_FILE),
      buildRedirectConfig({ httpEntryPoint: opts.httpEntryPoint }),
    )
  } else {
    await drop(REDIRECT_FILE)
  }
  await drop(BOOTSTRAP_FILE)
  return removed
}
