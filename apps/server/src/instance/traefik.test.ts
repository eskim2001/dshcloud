import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { GATE_INSTANCE_HEADER, GATE_TOKEN_HEADER, RESERVED_SLUGS } from '@dsh-cloud/instance-spec'
import { buildTraefikConfig, renderTraefikConfig, type TraefikOptions } from './traefik.js'

const ROUTES = [
  { instance: 'alice', hostname: 'alice.app.example.com', hostPort: 20001 },
  { instance: 'bob', hostname: 'bob.app.example.com', hostPort: 20002 },
]

function render(over: Partial<TraefikOptions> = {}) {
  return buildTraefikConfig(ROUTES, {
    forwardAuthAddress: 'http://127.0.0.1:3000/auth/verify',
    ...over,
  })
}

describe('renderTraefikConfig', () => {
  it('gateway mode routes every workspace through the authenticating proxy', () => {
    const cfg = render({ gatewayAddress: 'http://127.0.0.1:32100' })
    for (const service of Object.values(cfg.http.services!)) {
      expect(service.loadBalancer.servers).toEqual([{ url: 'http://127.0.0.1:32100' }])
    }
    // The gateway needs the original cookie to authenticate; it strips it itself.
    for (const router of Object.values(cfg.http.routers!)) expect(router.middlewares).toEqual([])
  })
  it('每条路由都挂了 forward-auth（漏挂就是洞，且不会报错）', () => {
    const cfg = render()
    const routers = Object.values(cfg.http.routers!)
    expect(routers).toHaveLength(2)
    for (const r of routers) expect(r.middlewares).toContain('platform-auth')
  })

  it('回注桥需要的两个 header', () => {
    const cfg = render()
    expect(cfg.http.middlewares['platform-auth']?.forwardAuth.authResponseHeaders).toEqual([
      GATE_INSTANCE_HEADER,
      GATE_TOKEN_HEADER,
      'Cookie',
    ])
  })

  it('后端是宿主回环端口（实例发布到 127.0.0.1，入口按端口转发）', () => {
    const cfg = render()
    expect(cfg.http.services!['instance-alice']?.loadBalancer.servers[0]?.url).toBe(
      'http://127.0.0.1:20001',
    )
  })

  it('Host 规则用完整主机名', () => {
    const cfg = render()
    expect(cfg.http.routers!['instance-alice']?.rule).toBe('Host(`alice.app.example.com`)')
  })

  it('默认挂 websecure（线上 TLS 在 Traefik 终结）', () => {
    const cfg = render()
    expect(cfg.http.routers!['instance-alice']?.entryPoints).toEqual(['websecure'])
  })

  it('entryPoint 可覆盖', () => {
    const cfg = render({ entryPoint: 'web' })
    expect(cfg.http.routers!['instance-alice']?.entryPoints).toEqual(['web'])
  })

  it('默认不挂 tls（明文档不该有 tls 块）', () => {
    const cfg = render()
    expect(cfg.http.routers!['instance-alice']?.tls).toBeUndefined()
  })

  it('tls: {} = 用 file provider 的静态证书', () => {
    const cfg = render({ tls: {} })
    expect(cfg.http.routers!['instance-alice']?.tls).toEqual({})
  })

  it('tls 带 certResolver = ACME 自动签发（线上）', () => {
    const cfg = render({ tls: { certResolver: 'letsencrypt' } })
    expect(cfg.http.routers!['instance-alice']?.tls).toEqual({ certResolver: 'letsencrypt' })
  })

  it('落盘是 YAML 且能原样读回（file provider 只认 yml/yaml/toml，json 会被静默忽略）', () => {
    const text = renderTraefikConfig(ROUTES, {
      forwardAuthAddress: 'http://127.0.0.1:3000/auth/verify',
    })
    expect(text).not.toMatch(/^\s*\{/)
    expect(parseYaml(text)).toEqual(
      render() as unknown as Record<string, unknown>,
    )
  })

  it('没有实例时不输出空的 routers/services（Traefik v3.5 会整份文件拒收，中间件跟着丢）', () => {
    const cfg = buildTraefikConfig([], { forwardAuthAddress: 'http://127.0.0.1:3000/auth/verify' })
    expect(cfg.http.routers).toBeUndefined()
    expect(cfg.http.services).toBeUndefined()
    expect(cfg.http.middlewares['platform-auth']).toBeDefined()
  })

  it('实例 router **不**设 priority——控制台那条约定的高优先级才不会被顶掉', () => {
    for (const router of Object.values(render().http.routers!)) {
      expect(router).not.toHaveProperty('priority')
    }
  })
})

/**
 * 控制台的 router 在 docker/traefik/dynamic-dev/platform.yml（不在这个模块里，
 * 它是开发态静态配置）。但两者的**关系**是安全不变量，所以要在这里一起测。
 */
describe('platform.yml 的不变量', () => {
  const PLATFORM_YML = new URL(
    '../../../../docker/traefik/dynamic-dev/platform.yml',
    import.meta.url,
  )

  it('顶点控制台 priority 显式，别名主机的首段是保留字', async () => {
    const doc = parseYaml(await readFile(PLATFORM_YML, 'utf8')) as {
      http: { routers: Record<string, { rule: string; priority?: number; middlewares?: string[] }> }
    }
    const primary = doc.http.routers['platform-web']
    const alias = doc.http.routers['platform-console-alias']
    expect(primary?.rule).toBe('Host(`lvh.me`)')
    expect(alias?.rule).toBe('Host(`console.lvh.me`)')
    // 显式优先级：不依赖 Traefik 的「规则长度相同则行为未定义」平手判定
    expect(primary?.priority).toBeGreaterThan(0)
    expect(alias?.priority).toBeGreaterThan(0)
    // 顶点不是 `<slug>.lvh.me`。别名的首段必须在保留字里，实例抢不到这条跳转。
    expect(`Host(\`alice.lvh.me\`)`).not.toBe(primary?.rule)
    expect(RESERVED_SLUGS).toContain('console')
    expect(primary?.middlewares).toBeUndefined()
  })
})
