import { describe, expect, it } from 'vitest'
import type Docker from 'dockerode'
import type { InstanceSpec, RenderContext } from '@dsh-cloud/instance-spec'
import { DockerDriver, type DockerDriverOptions } from './driver.js'

const SPEC: InstanceSpec = {
  slug: 'alice',
  image: 'ghcr.io/eskim2001/dsh-instance:0.1.2-rc.1_2',
  quota: { cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 },
  env: {},
}

const CTX: RenderContext = {
  baseImage: SPEC.image,
  baseDomain: 'app.example.com',
  gateToken: 'tok',
  storageKey: 'vol-alice',
  hostPort: 20001,
}

const NET = 'dsh-net-alice'
const MACHINE = 'dsh-instance-alice'

/** Docker 的 404 形状（`client.ts` 的 `isNotFound` 认 `statusCode`）。 */
function notFound(): Error {
  return Object.assign(new Error('not found'), { statusCode: 404 })
}

/** 建容器时我们真正读的那几个字段。 */
interface CreateArgs {
  name: string
  HostConfig?: { NetworkMode?: string; Binds?: string[]; MaskedPaths?: string[] }
}

interface FakeOptions {
  networks?: string[]
  containers?: string[]
  volumes?: string[]
  createNetworkError?: Error
}

/**
 * 假 dockerode：只记**调用顺序**，不碰真 Docker。
 *
 * 这里要断言的是"谁先谁后"和"失败了会不会把旧容器带下水"，那两件事只有按调用序列才看得出来；
 * 真 Docker 在单测里既慢又不可控。真的链路留给真机验收（见 PLAN 的验收表）。
 */
function fakeDocker(opts: FakeOptions = {}) {
  const calls: string[] = []
  const networks = new Set(opts.networks ?? [])
  const containers = new Set(opts.containers ?? [])
  const volumes = new Set(opts.volumes ?? ['vol-alice'])
  let lastCreate: CreateArgs | undefined
  let lastNetwork: { Name: string; Labels?: Record<string, string> } | undefined

  const raw = {
    getNetwork: (name: string) => ({
      inspect: async () => {
        calls.push(`network.inspect:${name}`)
        if (!networks.has(name)) throw notFound()
        return { Id: 'netid', Labels: {} }
      },
      remove: async () => {
        calls.push(`network.remove:${name}`)
        if (!networks.has(name)) throw notFound()
        networks.delete(name)
      },
    }),
    createNetwork: async (o: { Name: string; Labels?: Record<string, string> }) => {
      calls.push(`network.create:${o.Name}`)
      if (opts.createNetworkError !== undefined) throw opts.createNetworkError
      networks.add(o.Name)
      lastNetwork = o
      return { id: 'netid' }
    },
    getVolume: (name: string) => ({
      inspect: async () => {
        if (!volumes.has(name)) throw notFound()
        return { Name: name, Labels: {} }
      },
    }),
    getContainer: (name: string) => ({
      remove: async () => {
        calls.push(`container.remove:${name}`)
        containers.delete(name)
      },
      start: async () => {
        calls.push(`container.start:${name}`)
      },
    }),
    createContainer: async (o: CreateArgs) => {
      calls.push(`container.create:${o.name}`)
      lastCreate = o
      return {
        start: async () => calls.push(`container.start:${o.name}`),
        wait: async () => ({ StatusCode: 0 }),
        logs: async () => Buffer.from('123\n'),
        remove: async () => calls.push(`container.remove:${o.name}`),
      }
    },
  }

  return {
    raw,
    docker: raw as unknown as Docker,
    calls,
    lastCreate: () => lastCreate,
    lastNetwork: () => lastNetwork,
  }
}

/** 没有池子 = 命名卷退路（开发机形态），建实例时不用碰宿主文件系统。 */
function driverOf(
  f: ReturnType<typeof fakeDocker>,
  opts: DockerDriverOptions = {},
): DockerDriver {
  return new DockerDriver({ docker: f.docker, helperImage: 'alpine', ...opts })
}

describe('DockerDriver 的网络隔离', () => {
  it('建实例：网络名与标签对，容器落在这个网络上而不是默认 bridge', async () => {
    const f = fakeDocker()
    await driverOf(f).create(SPEC, CTX)

    expect(f.lastNetwork()).toEqual({
      Name: NET,
      Driver: 'bridge',
      Labels: { 'dsh.cloud/managed': 'true', 'dsh.cloud/instance': 'alice' },
    })
    expect(f.lastCreate()?.HostConfig?.NetworkMode).toBe(NET)
    expect(f.lastCreate()?.HostConfig?.NetworkMode).not.toBe('bridge')
  })

  it('建网络**早于**删旧容器：网络建不出来时旧容器原封不动', async () => {
    const poolExhausted = Object.assign(new Error('all predefined address pools have been fully subnetted'), {
      statusCode: 400,
    })
    const f = fakeDocker({ containers: [MACHINE], createNetworkError: poolExhausted })

    await expect(driverOf(f).create(SPEC, CTX)).rejects.toThrow(/地址池/)
    expect(f.calls).not.toContain(`container.remove:${MACHINE}`)
    expect(f.calls.some((c) => c.startsWith('container.create'))).toBe(false)
  })

  it('建实例：顺序是 建网络 → 删旧容器 → 建新容器', async () => {
    const f = fakeDocker({ containers: [MACHINE] })
    await driverOf(f).create(SPEC, CTX)

    expect(f.calls).toEqual([
      `network.inspect:${NET}`,
      `network.create:${NET}`,
      `container.remove:${MACHINE}`,
      `container.create:${MACHINE}`,
      `container.start:${MACHINE}`,
    ])
  })

  it('网络已经在就复用，不重复建（幂等）', async () => {
    const f = fakeDocker({ networks: [NET] })
    await driverOf(f).create(SPEC, CTX)

    expect(f.calls.filter((c) => c.startsWith('network.create'))).toEqual([])
    expect(f.lastCreate()?.HostConfig?.NetworkMode).toBe(NET)
  })

  it('建实例**不删**网络：create 走的是只删容器那条路', async () => {
    const f = fakeDocker({ networks: [NET], containers: [MACHINE] })
    await driverOf(f).create(SPEC, CTX)

    expect(f.calls.filter((c) => c.startsWith('network.remove'))).toEqual([])
  })

  it('删实例：先删容器、再删网络（反了会被 Docker 拒）', async () => {
    const f = fakeDocker({ networks: [NET], containers: [MACHINE] })
    await driverOf(f).remove(MACHINE)

    expect(f.calls).toEqual([`container.remove:${MACHINE}`, `network.remove:${NET}`])
  })

  it('删实例：容器和网络都不在也算成功（幂等）', async () => {
    const f = fakeDocker()
    await expect(driverOf(f).remove(MACHINE)).resolves.toBeUndefined()
    expect(f.calls).toEqual([`container.remove:${MACHINE}`, `network.remove:${NET}`])
  })

  it('地址池用完：错误里要能照着做，不能只甩 Docker 的黑话', async () => {
    const f = fakeDocker({
      createNetworkError: Object.assign(
        new Error('all predefined address pools have been fully subnetted'),
        { statusCode: 400 },
      ),
    })

    await expect(driverOf(f).create(SPEC, CTX)).rejects.toThrow(/default-address-pools/)
  })

  it('辅助容器（du / cp）不给网络', async () => {
    const f = fakeDocker()
    const driver = driverOf(f)
    Object.assign(f.raw, {
      getImage: () => ({ inspect: async () => { throw notFound() } }),
      pull: async () => ({}),
      modem: { followProgress: (_s: unknown, cb: (e: Error | null) => void) => cb(null) },
    })

    expect(await driver.storageUsageMb('vol-alice')).toBe(123)
    expect(f.lastCreate()?.HostConfig?.NetworkMode).toBe('none')
  })
})

describe('DockerDriver 的宿主指纹加固', () => {
  it('宿主有 lxcfs：三个量过**真生效**的假文件挂进来，原有存储挂载不动', async () => {
    const f = fakeDocker()
    await driverOf(f, { lxcfsProcDir: '/var/lib/lxcfs/proc' }).create(SPEC, CTX)

    // 列表是逐个文件量出来的（见 lxcfs.ts）—— 这里钉死，防它被"顺手补全"成 lxcfs 提供的全套
    expect(f.lastCreate()?.HostConfig?.Binds).toEqual([
      'vol-alice:/data:rw',
      '/var/lib/lxcfs/proc/meminfo:/proc/meminfo:ro',
      '/var/lib/lxcfs/proc/uptime:/proc/uptime:ro',
      '/var/lib/lxcfs/proc/swaps:/proc/swaps:ro',
    ])
  })

  it('宿主没有 lxcfs：一个 proc 挂载都不加（缺席是常态；源不存在时 Docker 会把那些文件顶成目录、容器起不来）', async () => {
    const f = fakeDocker()
    await driverOf(f).create(SPEC, CTX)

    expect(f.lastCreate()?.HostConfig?.Binds).toEqual(['vol-alice:/data:rw'])
  })

  it('DMI 一律遮掉，且遮罩是**整份**给出、没把 Docker 默认那几条挤没', async () => {
    const f = fakeDocker()
    await driverOf(f).create(SPEC, CTX)

    const masked = f.lastCreate()?.HostConfig?.MaskedPaths ?? []
    expect(masked).toContain('/sys/devices/virtual/dmi')
    // 设了 MaskedPaths 就是**替换**默认值：这两条是默认里的，漏一条就是悄悄放开一块
    expect(masked).toContain('/proc/kcore')
    expect(masked).toContain('/sys/firmware')
  })
})
