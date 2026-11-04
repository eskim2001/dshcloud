import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { machineName } from '@dsh-cloud/instance-spec'
import type { InstanceRow } from '../db/schema.js'
import type { ContainerStates } from './runtime-status.js'
import { routableInstances, syncRoutesFromInstances } from './routes-sync.js'

/** 只给状态的实时表——路由判据只看 state。 */
function states(entries: Array<[slug: string, state: string]>): ContainerStates {
  return new Map(entries.map(([slug, state]) => [machineName(slug), { state, statusText: '' }]))
}

function row(over: Partial<InstanceRow> & { slug: string }): InstanceRow {
  return {
    id: `t-${over.slug}`,
    storageKey: over.slug,
    deletedAt: null,
    ownerId: 'u1',
    status: 'running',
    image: 'dsh-instance:0.1.0',
    previousImage: null,
    containerId: null,
    hostPort: 20000,
    cpus: 1,
    memoryMb: 2048,
    pidsLimit: 512,
    diskMb: 10_240,
    lastError: null,
    stoppedAt: null,
    lastActiveAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }
}

describe('syncRoutesFromInstances', () => {
  let dir: string
  let configPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-routes-'))
    configPath = join(dir, 'nested', 'routes.yml')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const opts = {
    baseDomain: 'app.example.com',
    forwardAuthAddress: 'http://127.0.0.1:3000/auth/verify',
  }

  it('不传容器状态时按 DB 意图兜底（容器没起来给路由只会 502，漏挂认证才是洞）', async () => {
    await syncRoutesFromInstances(
      [
        row({ slug: 'alice' }),
        row({ slug: 'bob', status: 'provisioning' }),
        row({ slug: 'carol', status: 'error' }),
        row({ slug: 'dave', status: 'stopped' }),
        row({ slug: 'erin', status: 'removing' }),
      ],
      { ...opts, configPath },
    )

    const cfg = parseYaml(await readFile(configPath, 'utf8')) as {
      http: {
        routers: Record<string, unknown>
        services: Record<string, { loadBalancer: { servers: Array<{ url: string }> } }>
      }
    }
    expect(Object.keys(cfg.http.routers)).toEqual(['instance-alice'])
    // 后端是宿主回环端口（`upstreamHost` 默认 127.0.0.1；容器里的 Traefik 走 host.docker.internal）
    expect(cfg.http.services['instance-alice']?.loadBalancer.servers[0]?.url).toBe(
      'http://127.0.0.1:20000',
    )
  })

  it('目录不存在会自建（首次启动时动态目录还没建）', async () => {
    await syncRoutesFromInstances([row({ slug: 'alice' })], { ...opts, configPath })
    expect(parseYaml(await readFile(configPath, 'utf8'))).toBeDefined()
  })

  it('不留临时文件', async () => {
    await syncRoutesFromInstances([row({ slug: 'alice' })], { ...opts, configPath })
    await expect(readFile(`${configPath}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('tls 透传到每条 router（443 上的 router 不写 tls 就收不到请求）', async () => {
    await syncRoutesFromInstances([row({ slug: 'alice' })], {
      ...opts,
      configPath,
      tls: { certResolver: 'letsencrypt' },
    })

    const cfg = parseYaml(await readFile(configPath, 'utf8')) as {
      http: { routers: Record<string, { tls?: unknown }> }
    }
    expect(cfg.http.routers['instance-alice']?.tls).toEqual({ certResolver: 'letsencrypt' })
  })

  it('返回被投影的 slug（调用方拿去把入口接回这些实例网络）', async () => {
    const slugs = await syncRoutesFromInstances(
      [row({ slug: 'alice' }), row({ slug: 'bob', status: 'stopped' })],
      { ...opts, configPath, containerStates: states([['alice', 'running']]) },
    )
    expect(slugs).toEqual(['alice'])
  })
})

describe('routableInstanceSlugs', () => {
  const slugsOf = (rows: InstanceRow[], s?: ContainerStates): string[] =>
    routableInstances(rows, s).map((r) => r.slug)

  it('操作失败（error）但容器还跑着 → 照样投影', () => {
    // 一次失败的操作会把 status 写成 error，容器却可能毫发无伤。照 status 判的话，
    // 这条路由被摘掉之后就再也没人加回来（对账器也跳过 error）——实例从此打不开。
    const routed = slugsOf(
      [row({ slug: 'alice', status: 'error' })],
      states([['alice', 'running']]),
    )
    expect(routed).toEqual(['alice'])
  })

  it('容器真的没了 → 不投影（点「启动」重建）', () => {
    expect(slugsOf([row({ slug: 'alice', status: 'error' })], states([]))).toEqual([])
  })

  it('编排进行中（provisioning / removing）一律不投影，哪怕容器活着', () => {
    // remove 的第一步就是「先摘路由再删容器」——早摘才对，不能等容器真没了才摘
    const routed = slugsOf(
      [
        row({ slug: 'alice', status: 'provisioning' }),
        row({ slug: 'bob', status: 'removing' }),
      ],
      states([
        ['alice', 'running'],
        ['bob', 'running'],
      ]),
    )
    expect(routed).toEqual([])
  })

  it('restarting 也算在服务（crash-loop 会自己回来，摘了反而回不来）', () => {
    const routed = slugsOf(
      [row({ slug: 'alice' })],
      states([['alice', 'restarting']]),
    )
    expect(routed).toEqual(['alice'])
  })

  it('容器 exited → 不投影', () => {
    expect(slugsOf([row({ slug: 'alice' })], states([['alice', 'exited']]))).toEqual([])
  })

  it('DB 记 stopped 但容器在跑 → 投影（有事实就按事实）', () => {
    expect(
      slugsOf([row({ slug: 'alice', status: 'stopped' })], states([['alice', 'running']])),
    ).toEqual(['alice'])
  })

  it('取不到容器状态（Docker 抖了）→ 退回 DB 意图，失败即关闭', () => {
    // 宁可少投影一条（用户看到 404、对账下一轮修回来），也不要多投影一条裸路由
    const routed = slugsOf(
      [
        row({ slug: 'alice', status: 'running' }),
        row({ slug: 'bob', status: 'error' }),
        row({ slug: 'carol', status: 'stopped' }),
      ],
      undefined,
    )
    expect(routed).toEqual(['alice'])
  })
})
