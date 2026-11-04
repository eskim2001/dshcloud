import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { RESERVED_SLUGS } from '@dsh-cloud/instance-spec'
import { CONSOLE_LABEL } from '../env.js'
import {
  buildBootstrapConfig,
  buildConsoleConfig,
  buildRedirectConfig,
  projectPlatformRoutes,
} from './platform-routes.js'

/**
 * 平台自己的三条路由由**控制面**写（不再是安装脚本渲染的静态文件）。
 *
 * 盯三件事：控制台 router 的安全不变式、引导口只在引导态存在、以及**投影的幂等与对齐**
 * —— 「配完域名就把明文引导口摘掉」全靠它。
 */

const BASE = {
  selfPort: 3000,
  entryPoint: 'websecure',
  httpEntryPoint: 'web',
  upstreamHost: '127.0.0.1',
  tls: { certResolver: 'le' },
}

/** 把 Traefik 认的那份 YAML 读回来。 */
async function readYaml(dir: string, name: string): Promise<any> {
  return parseYaml(await readFile(join(dir, name), 'utf8'))
}

describe('控制台 router 的不变量', () => {
  it('显式设 priority，主机名首段是保留字，且**不**挂 forward-auth', () => {
    const cfg = buildConsoleConfig({
      consoleDomain: 'console.app.example.com',
      selfPort: 3000,
      entryPoint: 'websecure',
      tls: { certResolver: 'le' },
    }) as any

    const [name, router] = Object.entries<any>(cfg.http.routers)[0]!
    expect(name).toBe('platform-web')
    // 显式优先级：不依赖 Traefik「规则长度相同则行为未定义」的平手判定
    expect(router.priority).toBeGreaterThan(0)
    expect(router.rule).toBe('Host(`console.app.example.com`)')
    // 控制台走自己的会话认证，不经过实例那道门
    expect(router).not.toHaveProperty('middlewares')
    expect(router.tls).toEqual({ certResolver: 'le' })

    // 控制台 label 必须在保留字表里 —— 「租户抢不到这个主机名」的第一道防线
    const host = /Host\(`([^`]+)`\)/.exec(router.rule)?.[1]
    expect(host).toBeDefined()
    expect(RESERVED_SLUGS).toContain(host!.split('.')[0])
  })

  it('上游指向控制面自己（宿主回环 + 自己的端口）', () => {
    const cfg = buildConsoleConfig({
      consoleDomain: 'console.example.com',
      selfPort: 3000,
      entryPoint: 'websecure',
    }) as any
    expect(cfg.http.services['platform-web'].loadBalancer.servers[0].url).toBe(
      'http://127.0.0.1:3000',
    )
  })

  it('父域顶点：实例 Host 对不上控制台，console. 只是跳回顶点的别名', () => {
    const apex = 'example.com'
    const cfg = buildConsoleConfig({
      consoleDomain: apex,
      baseDomain: apex,
      selfPort: 3000,
      entryPoint: 'websecure',
      tls: { certResolver: 'le' },
    }) as any

    const primary = cfg.http.routers['platform-web']
    expect(primary.rule).toBe('Host(`example.com`)')
    expect(primary.priority).toBe(1000)
    expect(primary).not.toHaveProperty('middlewares')

    // `<slug>.example.com` 不可能等于顶点。即便 slug 取父域的首段也多一个标签。
    for (const slug of ['alice', 'example', 'console']) {
      expect(`Host(\`${slug}.${apex}\`)`).not.toBe(primary.rule)
    }

    const alias = cfg.http.routers['platform-console-alias']
    expect(alias.rule).toBe(`Host(\`${CONSOLE_LABEL}.${apex}\`)`)
    expect(alias.priority).toBe(1000)
    expect(alias.service).toBe('noop@internal')
    expect(alias.middlewares).toEqual(['console-alias-redirect'])
    expect(RESERVED_SLUGS).toContain(CONSOLE_LABEL)
    expect(cfg.http.middlewares['console-alias-redirect'].redirectRegex.replacement).toBe(
      'https://example.com${1}',
    )
  })

  it('控制台仍是子域时不另写别名（那台主机自己就是规范入口）', () => {
    const cfg = buildConsoleConfig({
      consoleDomain: 'console.example.com',
      baseDomain: 'example.com',
      selfPort: 3000,
      entryPoint: 'websecure',
      tls: {},
    }) as any
    expect(Object.keys(cfg.http.routers)).toEqual(['platform-web'])
    expect(cfg.http.middlewares).toBeUndefined()
  })
})

describe('引导口与跳转的形态', () => {
  it('引导口是 :80 上的 catch-all，直接打到控制面自己', () => {
    const cfg = buildBootstrapConfig({ selfPort: 3000, httpEntryPoint: 'web' }) as any
    const router = cfg.http.routers.bootstrap
    expect(router.rule).toBe('PathPrefix(`/`)')
    expect(router.entryPoints).toEqual(['web'])
    expect(cfg.http.services.bootstrap.loadBalancer.servers[0].url).toBe('http://127.0.0.1:3000')
  })

  it('跳转用 redirectScheme + noop@internal（不能写回静态配置，见模块注释）', () => {
    const cfg = buildRedirectConfig({ httpEntryPoint: 'web' }) as any
    expect(cfg.http.middlewares['redirect-to-https'].redirectScheme).toEqual({
      scheme: 'https',
      permanent: true,
    })
    expect(cfg.http.routers['http-redirect'].service).toBe('noop@internal')
    expect(cfg.http.routers['http-redirect'].middlewares).toEqual(['redirect-to-https'])
  })
})

describe('projectPlatformRoutes：按状态对齐，且幂等', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-platform-routes-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('引导态：写引导口，**摘掉**控制台与跳转（哪怕它们在）', async () => {
    await writeFile(join(dir, 'platform.yml'), 'stale: true')
    await writeFile(join(dir, 'redirect.yml'), 'stale: true')

    const removed = await projectPlatformRoutes({ dir, ...BASE })

    expect(existsSync(join(dir, 'bootstrap.yml'))).toBe(true)
    expect(existsSync(join(dir, 'platform.yml'))).toBe(false)
    expect(existsSync(join(dir, 'redirect.yml'))).toBe(false)
    expect(removed.sort()).toEqual(['platform.yml', 'redirect.yml'])
    // 明文 catch-all 真的指向控制面
    const yml = await readYaml(dir, 'bootstrap.yml')
    expect(yml.http.routers.bootstrap.service).toBe('bootstrap')
  })

  it('已配置：写控制台与跳转，**摘掉引导口**（暴露当场关闭）', async () => {
    await writeFile(join(dir, 'bootstrap.yml'), 'stale: true')

    const removed = await projectPlatformRoutes({
      dir,
      ...BASE,
      consoleDomain: 'example.com',
      baseDomain: 'example.com',
    })

    expect(existsSync(join(dir, 'bootstrap.yml'))).toBe(false)
    expect(removed).toEqual(['bootstrap.yml'])
    const console = await readYaml(dir, 'platform.yml')
    expect(console.http.routers['platform-web'].rule).toBe('Host(`example.com`)')
    expect(console.http.routers['platform-console-alias'].rule).toBe('Host(`console.example.com`)')
    expect(console.http.middlewares['console-alias-redirect'].redirectRegex.replacement).toBe(
      'https://example.com${1}',
    )
    expect((await readYaml(dir, 'redirect.yml')).http.routers['http-redirect'].service).toBe(
      'noop@internal',
    )
  })

  it('连跑两次结果一致，且不留 .tmp（Traefik 会读到写了一半的文件）', async () => {
    await projectPlatformRoutes({ dir, ...BASE, consoleDomain: 'console.example.com' })
    const first = await readFile(join(dir, 'platform.yml'), 'utf8')
    const removed = await projectPlatformRoutes({ dir, ...BASE, consoleDomain: 'console.example.com' })
    expect(await readFile(join(dir, 'platform.yml'), 'utf8')).toBe(first)
    expect(removed).toEqual([])
    expect(existsSync(join(dir, 'platform.yml.tmp'))).toBe(false)
  })

  it('明文部署（没 tls 块）**不写跳转** —— 那会把人送到没人听 443 的地方', async () => {
    await projectPlatformRoutes({
      dir,
      selfPort: 3000,
      entryPoint: 'web',
      httpEntryPoint: 'web',
      consoleDomain: 'console.example.com',
    })
    expect(existsSync(join(dir, 'redirect.yml'))).toBe(false)
    expect(existsSync(join(dir, 'platform.yml'))).toBe(true)
  })
})
