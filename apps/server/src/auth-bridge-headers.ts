import type { IncomingHttpHeaders } from 'node:http'
import { isIP } from 'node:net'
import { fromNodeHeaders } from 'better-auth/node'

/**
 * 客户端自己能写、而 better-auth 会拿来分限速桶的地址头。
 *
 * 桥接层一律删掉，只留下面写入的那一个 `x-forwarded-for`。
 * `Headers` 的名字不区分大小写，这里用小写即可盖住 `X-Forwarded-For` 这类写法。
 */
const SPOOFABLE_IP_HEADERS = [
  'cf-connecting-ip',
  'true-client-ip',
  'x-real-ip',
  'x-forwarded-for',
] as const

/**
 * 没有合法 `request.ip` 时仍要落到同一只桶。
 *
 * 必须是 `getIP` 认的单个地址：空头在生产得到 null（整站挤进 `no-trusted-ip`），
 * 在 `NODE_ENV=test` 又偷偷变成 `127.0.0.1`。两种环境各算各的，限速等于没测到。
 */
export const CONSERVATIVE_CLIENT_IP = '0.0.0.0'

/** Fastify `request.ip` 里拿不到单个合法地址时，改用保守桶。 */
export function clientIpForAuth(ip: string | undefined | null): string {
  if (typeof ip === 'string' && isIP(ip) !== 0) return ip
  return CONSERVATIVE_CLIENT_IP
}

/**
 * 交给 `auth.handler` 的头。
 *
 * Fastify（`trustProxy: true`）已经把代理链收成 `request.ip`。better-auth 若再读
 * 客户端带来的转发头，换一个值就是另一只桶；逗号链还会让 `getIP` 得到 null。
 * 其余头（cookie、origin、content-type）原样保留。
 */
export function authBridgeHeaders(
  nodeHeaders: IncomingHttpHeaders,
  clientIp: string | undefined | null,
): Headers {
  const headers = fromNodeHeaders(nodeHeaders)
  for (const name of SPOOFABLE_IP_HEADERS) headers.delete(name)
  headers.set('x-forwarded-for', clientIpForAuth(clientIp))
  return headers
}

/**
 * 把 pathname 解成 better-auth 限速会看到的那条路径。
 *
 * `new URL().pathname` 留下 `%2F`，通配 `/sign-in/*` 对不上，编码一下就换桶。
 * 解一次后仍有 `%`（双重编码）、或含 `\` / NUL 的，拒绝，而不是再解。
 * 返回 undefined 表示这条路径不能交给认证。
 */
export function canonicalAuthUrl(requestUrl: string, base: string): URL | undefined {
  let url: URL
  try {
    url = new URL(requestUrl, base)
  } catch {
    return undefined
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return undefined
  }
  if (!decoded.startsWith('/') || decoded.includes('%') || decoded.includes('\\') || decoded.includes('\0')) {
    return undefined
  }
  // setter 会把 `..` 段折掉，管理端点的编码绕过和限速前缀用的是同一条路径。
  if (decoded !== url.pathname) url.pathname = decoded
  return url
}
