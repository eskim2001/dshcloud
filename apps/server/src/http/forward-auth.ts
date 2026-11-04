import {
  GATE_INSTANCE_HEADER,
  GATE_TOKEN_HEADER,
  InstanceSlugSchema,
} from '@dsh-cloud/instance-spec'
import { gateToken } from '../instance/gate-token.js'
import { parse, serialize } from 'cookie'

export interface InstanceLookup {
  id: string
  slug: string
  ownerId: string
}

export interface ForwardAuthDeps {
  /** **父域**：实例子域挂在它下面（`<slug>.<baseDomain>`）。控制台不在其中。 */
  baseDomain: string
  /** 控制台主机名（`console.<baseDomain>`）。登录页在它上面。 */
  consoleDomain: string
  /** 控制面自己的对外 scheme；登录页在控制台域上。 */
  publicScheme: 'http' | 'https'
  gateSecret: string
  findInstanceBySlug(slug: string): Promise<InstanceLookup | undefined>
  /** 从 Cookie 解析出用户；无有效会话返回 undefined。 */
  resolveUserId(cookie: string | undefined, slug?: string): Promise<string | undefined>
  /**
   * 授权成功后的钩子（刷新 `lastActiveAt`）。应是**节流后的 fire-and-forget**，
   * 别在这里 await 写库——forward-auth 是热路径。
   */
  onAuthorized?(instance: InstanceLookup): void
}

export interface ForwardAuthInput {
  /** 原始请求的 Host（可带端口）。 */
  host: string | undefined
  cookie: string | undefined
  /** 原始请求的完整 URL，用于登录后跳回。 */
  originalUrl: string
  method?: string
  origin?: string
}

export type ForwardAuthResult =
  | { status: 200; headers: Record<string, string> }
  | { status: 302; location: string }
  | { status: 403 | 404 }

/**
 * 从 Host 里取出实例 slug。只接受**单标签**子域，避免
 * `a.b.app.example.com` 这类多级子域绕过前缀判断。
 */
export function instanceSlugFromHost(
  host: string | undefined,
  baseDomain: string,
): string | undefined {
  if (host === undefined || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host)) return undefined
  let hostname: string
  try {
    const authority = new URL(`http://${host}`)
    if (authority.port === '0') return undefined
    hostname = authority.hostname
  } catch {
    return undefined
  }

  const suffix = `.${baseDomain.toLowerCase()}`
  if (!hostname.endsWith(suffix)) return undefined

  const slug = hostname.slice(0, -suffix.length)
  if (slug.includes('.')) return undefined

  const parsed = InstanceSlugSchema.safeParse(slug)
  return parsed.success ? parsed.data : undefined
}

/**
 * forward-auth 判定（D8 ②）。
 *
 * 三道结果：未登录 → 302 回登录页；登录了但**不是该实例的 owner** → 403；
 * 通过 → 200 + 桥要的两个 header。**授权必须在这里做**——只认证不授权，
 * 任何登录用户都能开别人的实例。
 */
export async function decideForwardAuth(
  input: ForwardAuthInput,
  deps: ForwardAuthDeps,
): Promise<ForwardAuthResult> {
  const slug = instanceSlugFromHost(input.host, deps.baseDomain)
  if (slug === undefined) return { status: 404 }

  // Sibling subdomains are same-site, so SameSite cookies do not stop their CSRF.
  const expectedOrigin = `${deps.publicScheme}://${input.host?.toLowerCase()}`
  if (input.origin !== undefined && input.origin !== expectedOrigin) return { status: 403 }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(input.method ?? 'GET') && input.origin === undefined) {
    return { status: 403 }
  }

  const instance = await deps.findInstanceBySlug(slug)
  if (instance === undefined) return { status: 404 }

  const userId = await deps.resolveUserId(input.cookie, slug)
  if (userId === undefined) {
    const next = encodeURIComponent(input.originalUrl)
    return {
      status: 302,
      location: `${deps.publicScheme}://${deps.consoleDomain}/login?next=${next}`,
    }
  }

  if (userId !== instance.ownerId) return { status: 403 }

  deps.onAuthorized?.(instance)

  return {
    status: 200,
    headers: {
      [GATE_INSTANCE_HEADER]: instance.slug,
      [GATE_TOKEN_HEADER]: gateToken(instance.slug, deps.gateSecret),
      Cookie: Object.entries(parse(input.cookie ?? ''))
        .filter(([name]) => !/^(?:__Secure-|__Host-)?dsh_cloud(?:[._]|$)/i.test(name))
        .map(([name, value]) => serialize(name, value ?? ''))
        .join('; '),
    },
  }
}
