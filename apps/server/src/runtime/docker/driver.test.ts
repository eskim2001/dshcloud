import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  Cmd?: string[]
  Env?: string[]
  HostConfig?: {
    NetworkMode?: string
    Binds?: string[]
    MaskedPaths?: string[]
    SecurityOpt?: string[]
  }
}

interface FakeOptions {
  liveMounts?: Array<{ State: string; Mounts: Array<{ Source?: string; Name?: string }> }>
  containerLabels?: Record<string, string>
  networkInspect?: { Driver: string; Labels: Record<string, string> }
  networks?: string[]
  containers?: string[]
  volumes?: string[]
  createNetworkError?: Error
  execExit?: number
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
  let execExit = opts.execExit ?? 0
  const execs: string[][] = []
  const archives: Buffer[] = []

  const raw = {
    listContainers: async () => opts.liveMounts ?? [],
    getNetwork: (name: string) => ({
      inspect: async () => {
        calls.push(`network.inspect:${name}`)
        if (!networks.has(name)) throw notFound()
        return { Id: 'netid', ...(opts.networkInspect ?? { Driver: 'bridge', Labels: { 'dsh.cloud/managed': 'true', 'dsh.cloud/instance': 'alice' } }) }
      },
      remove: async () => {
        calls.push(`network.remove:${name}`)
        const target = name === 'netid' ? NET : name
        if (!networks.has(target)) throw notFound()
        networks.delete(target)
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
      inspect: async () => {
        if (!containers.has(name)) throw notFound()
        return { Id: name, Name: `/${name}`, Config: { Labels: opts.containerLabels ?? {
          'dsh.cloud/managed': 'true', 'dsh.cloud/instance': 'alice',
        } }, State: { Status: 'running' } }
      },
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
        exec: async (spec: { Cmd: string[] }) => {
          execs.push(spec.Cmd)
          return {
            start: async () => ({ async *[Symbol.asyncIterator]() { /* 不产生输出 */ } }),
            inspect: async () => ({ ExitCode: execExit }),
          }
        },
        putArchive: async (file: Buffer) => { archives.push(file) },
      }
    },
  }

  return {
    raw,
    docker: raw as unknown as Docker,
    calls,
    lastCreate: () => lastCreate,
    lastNetwork: () => lastNetwork,
    execs,
    archives,
    setExecExit: (code: number) => { execExit = code },
  }
}

/** 没有池子 = 命名卷退路（开发机形态），建实例时不用碰宿主文件系统。 */
function driverOf(
  f: ReturnType<typeof fakeDocker>,
  opts: DockerDriverOptions = {},
): DockerDriver {
  return new DockerDriver({ docker: f.docker, helperImage: 'alpine', ...opts })
}

/** 让辅助镜像"本地已有"，顺带把 pull 也接上 —— 免得每次跑辅助容器都真去拉 alpine。 */
function withHelperImage(f: ReturnType<typeof fakeDocker>): void {
  Object.assign(f.raw, {
    getImage: () => ({
      inspect: async () => {
        throw notFound()
      },
    }),
    pull: async () => ({}),
    modem: { followProgress: (_s: unknown, cb: (e: Error | null) => void) => cb(null) },
  })
}

describe('DockerDriver 的网络隔离', () => {
  it.each(['start', 'stop', 'remove', 'status', 'stats'] as const)('拒绝对其他业务同名容器执行 %s', async method => {
    const f = fakeDocker({ containers: [MACHINE], containerLabels: { 'dsh.cloud/managed': 'true', 'dsh.cloud/instance': 'bob' } })
    await expect(driverOf(f)[method](MACHINE)).rejects.toThrow('ownership')
    expect(f.calls).toEqual([])
  })
  it.each([
    { Driver: 'bridge', Labels: {} },
    { Driver: 'bridge', Labels: { 'dsh.cloud/managed': 'true', 'dsh.cloud/instance': 'bob' } },
    { Driver: 'host', Labels: { 'dsh.cloud/managed': 'true', 'dsh.cloud/instance': 'alice' } },
  ])('拒绝复用归属或驱动不匹配的同名网络 %#', async networkInspect => {
    const f = fakeDocker({ networks: [NET], containers: [MACHINE], networkInspect })
    await expect(driverOf(f).create(SPEC, CTX)).rejects.toThrow('归属或驱动不匹配')
    expect(f.calls.some(call => call.startsWith('container.remove:'))).toBe(false)
    expect(f.lastCreate()).toBeUndefined()
  })
  it('建实例：网络名与标签对，容器落在这个网络上而不是默认 bridge', async () => {
    const f = fakeDocker()
    await driverOf(f).create(SPEC, CTX)

    expect(f.lastNetwork()).toEqual({
      Name: NET,
      Driver: 'bridge',
      Options: { 'com.docker.network.bridge.name': 'dshw2bd806c97f0' },
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

    expect(f.calls).toEqual([`container.remove:${MACHINE}`, `network.inspect:${NET}`, 'network.remove:netid'])
  })

  it('删实例：容器和网络都不在也算成功（幂等）', async () => {
    const f = fakeDocker()
    await expect(driverOf(f).remove(MACHINE)).resolves.toBeUndefined()
    expect(f.calls).toEqual([`network.inspect:${NET}`])
  })

  it('删实例拒绝删除其他业务占用的同名网络', async () => {
    const f = fakeDocker({ networks: [NET], networkInspect: { Driver: 'bridge', Labels: {} } })
    await expect(driverOf(f).remove(MACHINE)).rejects.toThrow('拒绝删除')
    expect(f.calls.some(call => call.startsWith('network.remove:'))).toBe(false)
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
    withHelperImage(f)
    const driver = driverOf(f)

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

describe('DockerDriver 的提权加固', () => {
  it('建实例时置 no-new-privileges：容器里的 setuid 二进制与文件能力都不再提权', async () => {
    const f = fakeDocker()
    await driverOf(f).create(SPEC, CTX)

    // 钉死整份：这条一旦被"顺手"删掉或改名，容器照常起得来，出事才看得出来
    expect(f.lastCreate()?.HostConfig?.SecurityOpt).toEqual(['no-new-privileges'])
  })
})

describe('DockerDriver 的数据属主迁移', () => {
  const KEY = 'b'.repeat(32)
  it('refuses incomplete storage after restart, including use as a copy source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pending-copy-'))
    try {
      await mkdir(join(root, KEY))
      await writeFile(join(root, KEY, 'partial'), 'partial contents')
      await writeFile(join(root, '.dsh-projects.json'), JSON.stringify({
        [KEY]: { projid: 2, sizeMb: 1024, inodeLimit: 1000, pending: true },
      }))
      const driver = driverOf(fakeDocker(), { pool: { root, enforced: true, detail: 'test' } })
      await expect(driver.ensureStorage(KEY)).rejects.toThrow('incomplete')
      await expect(driver.chownStorage(KEY, 1000, 1000)).rejects.toThrow('incomplete')
      await expect(driver.resizeStorage(KEY, 2048)).rejects.toThrow('incomplete')
      await expect(driver.copyStorage(KEY, `${KEY}.prev`)).rejects.toThrow('incomplete')
      expect(await driver.storageEnforced(KEY)).toBe(false)
      expect(await readFile(join(root, KEY, 'partial'), 'utf8')).toBe('partial contents')
      await expect(stat(join(root, `${KEY}.prev`))).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it.each(['running', 'paused', 'restarting'])('拒绝修改 %s 容器正在使用的数据', async State => {
    const f = fakeDocker({ liveMounts: [{ State, Mounts: [{ Name: KEY }] }] })
    const driver = driverOf(f)
    await expect(driver.chownStorage(KEY, 1000, 1000)).rejects.toThrow('in use')
    await expect(driver.removeStorage(KEY)).rejects.toThrow('in use')
    await expect(driver.copyStorage(KEY, `${KEY}.prev`)).rejects.toThrow('in use')
    await expect(driver.copyStorage(`${KEY}.prev`, KEY)).rejects.toThrow('in use')
    expect(f.lastCreate()).toBeUndefined()
  })

  it('池化存储按宿主挂载源拒绝，不依赖使用者的平台标签', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-live-mount-'))
    try {
      const f = fakeDocker({ liveMounts: [{ State: 'running', Mounts: [{ Source: join(root, KEY) }] }] })
      const driver = driverOf(f, { pool: { root, enforced: true, detail: 'test' } })
      await expect(driver.removeStorage(KEY)).rejects.toThrow('in use')
      await expect(driver.chownStorage(KEY, 1000, 1000)).rejects.toThrow('in use')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it.each(['ensure', 'copy', 'create', 'dangling-create'])('拒绝数据根符号链接：%s', async operation => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-storage-boundary-'))
    try {
      await writeFile(join(root, '.dsh-projects.json'), '{}')
      const target = join(root, 'external')
      if (operation !== 'dangling-create') {
        await mkdir(target)
        await writeFile(join(target, 'sentinel'), 'unchanged')
      }
      await symlink(target, join(root, KEY))
      const driver = driverOf(fakeDocker(), { pool: { root, enforced: true, detail: 'test' } })
      const work = operation === 'ensure' ? driver.ensureStorage(KEY)
        : operation === 'copy' ? driver.copyStorage(KEY, `${KEY}.prev`)
        : driver.createStorage(KEY, 1024)
      await expect(work).rejects.toThrow(operation.includes('create') ? '已存在' : 'real directory')
      if (operation !== 'dangling-create') expect(await readFile(join(target, 'sentinel'), 'utf8')).toBe('unchanged')
      await expect(stat(join(root, `${KEY}.prev`))).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('拒绝顶层符号链接，即使链接目标属主已匹配', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-root-link-'))
    const target = join(root, 'external')
    await mkdir(target)
    await symlink(target, join(root, KEY))
    const st = await stat(target)
    const driver = driverOf(fakeDocker(), { pool: { root, enforced: true, detail: 'test' } })
    await expect(driver.chownStorage(KEY, st.uid, st.gid)).rejects.toThrow('拒绝迁移属主')
    expect((await stat(target)).uid).toBe(st.uid)
  })

  /** 池化形态：数据是**宿主上的一个目录**（这里拿 tmpdir 冒充池子根）。 */
  async function pooled(): Promise<{ driver: DockerDriver; root: string; dir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-chown-'))
    const dir = join(root, KEY)
    await writeFile(join(root, '.dsh-projects.json'), JSON.stringify({
      [KEY]: { projid: 2, sizeMb: 1024, inodeLimit: 1000 },
    }))
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'note.txt'), 'x')
    await writeFile(join(dir, '.hidden'), 'x')
    await symlink('/etc/hostname', join(dir, 'outward'))
    const f = fakeDocker()
    return { driver: driverOf(f, { pool: { root, enforced: true, detail: 'test' } }), root, dir }
  }

  it('命名卷退路：进辅助容器改，路径与 uid 走位置参数（不拼进脚本文本）', async () => {
    const f = fakeDocker({ volumes: [KEY] })
    withHelperImage(f)

    await driverOf(f).chownStorage(KEY, 1000, 1000)

    const cmd = f.lastCreate()?.Cmd ?? []
    expect(cmd.slice(0, 2)).toEqual(['sh', '-c'])
    // 第 4 个参数起才是数据：路径是 `$1`、uid/gid 是 `$2`/`$3`，都不进 shell 文本
    expect(cmd.slice(3)).toEqual(['dsh-chown', '/_src', '1000', '1000'])
    expect(cmd[2]).toContain('chown -hR')
    expect(f.lastCreate()?.HostConfig?.Binds).toEqual([`${KEY}:/_src`])
  })

  it('命名卷退路：卷不在就**先抛错**，不进辅助容器', async () => {
    // Docker 对不存在的卷名会**默默建一个空的**（不像目录那样报错）——
    // 那样这次"迁移成功"其实是把「数据没了」盖住了
    const f = fakeDocker()
    withHelperImage(f)

    await expect(driverOf(f).chownStorage(KEY, 1000, 1000)).rejects.toThrow(/不存在/)
    expect(f.calls.some((c) => c.startsWith('container.create'))).toBe(false)
  })

  it('池化：递归改属主，且**顶层最后**动（顶层属主是幂等快路径的判据）', async () => {
    const { driver, root, dir } = await pooled()
    const log = join(root, 'chown.log')
    // 目标故意不是当前用户：目录是测试建的，属主必然是当前用户，取一样的会走幂等快路径
    const [uid, gid] = [4242, 4242]
    expect((await stat(dir)).uid).not.toBe(uid)

    await withFakeChown(log, () => driver.chownStorage(KEY, uid, gid))

    const lines = (await readFile(log, 'utf8')).trim().split('\n')
    // 顶层必须是**最后**一行：整句 `chown -R` 会先动顶层，那样"顶层属主对了"就不再等价于
    // "整棵树都好了"，半途失败会被下一次当成已完成
    expect(lines.at(-1)).toBe(`-h ${uid}:${gid} ${dir}`)
    // 子项逐个改、都带 -h：不带它，`outward` 这种指向树外的软链会让 root 去改系统文件
    expect(lines.slice(0, -1).sort()).toEqual(
      [
        `-hR ${uid}:${gid} ${join(dir, '.hidden')}`,
        `-hR ${uid}:${gid} ${join(dir, 'note.txt')}`,
        `-hR ${uid}:${gid} ${join(dir, 'outward')}`,
        `-hR ${uid}:${gid} ${join(dir, 'sub')}`,
      ].sort(),
    )
  })

  it('池化：顶层属主已经是目标就一次都不跑（幂等，回退后重迁也走这里）', async () => {
    const { driver, root, dir } = await pooled()
    const log = join(root, 'chown.log')
    const st = await stat(dir)

    await withFakeChown(log, () => driver.chownStorage(KEY, st.uid, st.gid))

    // 文件压根没建 = 脚本一次都没执行过
    await expect(readFile(log, 'utf8')).rejects.toThrow()
  })

  it('池化：凭据文件不存在才写，0600，已存在或是符号链接都不覆盖', async () => {
    const { driver, root, dir } = await pooled()
    const fixture = 'fixture-model-key-alpha-9f3c'
    const body = Buffer.from(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${fixture}\nrecords: {}\n`)
    try {
      expect(await driver.seedCredentialsFileIfAbsent(KEY, body)).toBe(true)
      const path = join(dir, '.credentials.yaml')
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(await readFile(path, 'utf8')).toBe(body.toString('utf8'))
      expect(await driver.seedCredentialsFileIfAbsent(KEY, Buffer.from('version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-model-key-beta-9f3c\nrecords: {}\n'))).toBe(false)
      expect(await readFile(path, 'utf8')).toContain(fixture)
      expect(await readFile(path, 'utf8')).not.toContain('fixture-model-key-beta-9f3c')
    } finally {
      await rm(root, { recursive: true, force: true })
    }

    const again = await pooled()
    const outside = join(again.root, 'outside')
    await writeFile(outside, 'sentinel-outside')
    await symlink(outside, join(again.dir, '.credentials.yaml'))
    try {
      expect(await again.driver.seedCredentialsFileIfAbsent(KEY, body)).toBe(false)
      expect(await readFile(outside, 'utf8')).toBe('sentinel-outside')
    } finally {
      await rm(again.root, { recursive: true, force: true })
    }
  })

  it('池化：chown 会扫到 .credentials.yaml', async () => {
    const { driver, root, dir } = await pooled()
    await writeFile(join(dir, '.credentials.yaml'), 'version: 1\n', { mode: 0o600 })
    const log = join(root, 'chown.log')
    try {
      await withFakeChown(log, () => driver.chownStorage(KEY, 4242, 4242))
      const lines = (await readFile(log, 'utf8')).trim().split('\n')
      expect(lines).toContain(`-hR 4242:4242 ${join(dir, '.credentials.yaml')}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

/**
 * 把 `chown` 换成只记账的假命令。
 *
 * 池化路径是真的 `execFile('sh', …)`，没有注入点；而**把属主改成 1000 要 root**，
 * 单测里做不到。所以不动被测代码，改环境：临时往 `PATH` 前面塞一个假 `chown`，把参数记进文件。
 * 这样验的是**脚本真跑出来的调用序列** —— 顺序不变量正是靠它成立的 ——
 * 而不是把脚本文本当字符串比对。
 */
async function withFakeChown<T>(logPath: string, fn: () => Promise<T>): Promise<T> {
  const bin = join(dirname(logPath), 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(
    join(bin, 'chown'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$DSH_TEST_CHOWN_LOG"\n',
    { mode: 0o755 },
  )
  const savedPath = process.env.PATH
  const savedLog = process.env.DSH_TEST_CHOWN_LOG
  process.env.PATH = `${bin}:${savedPath ?? ''}`
  process.env.DSH_TEST_CHOWN_LOG = logPath
  try {
    return await fn()
  } finally {
    // `process.env.X = undefined` 会被写成字符串 "undefined"，清掉得用 delete
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    if (savedLog === undefined) delete process.env.DSH_TEST_CHOWN_LOG
    else process.env.DSH_TEST_CHOWN_LOG = savedLog
  }
}

describe('命名卷上的凭据文件', () => {
  const KEY = 'c'.repeat(32)
  const fixture = 'fixture-model-key-alpha-9f3c'

  it('不把 Key 放进容器参数；文件已在则不解包', async () => {
    const body = Buffer.from(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${fixture}\nrecords: {}\n`)
    const f = fakeDocker({ volumes: [KEY] })
    withHelperImage(f)
    expect(await driverOf(f).seedCredentialsFileIfAbsent(KEY, body)).toBe(true)
    const created = JSON.stringify(f.lastCreate())
    expect(created).not.toContain(fixture)
    expect(f.lastCreate()?.Env).toBeUndefined()
    expect(f.lastCreate()?.Cmd).toEqual(['sleep', '30'])
    expect(f.lastCreate()?.HostConfig?.NetworkMode).toBe('none')
    expect(f.lastCreate()?.HostConfig?.Binds).toEqual([`${KEY}:/_src`])
    expect(f.execs.some((cmd) => cmd.join(' ').includes(fixture))).toBe(false)
    expect(f.archives).toHaveLength(1)
    expect(f.archives[0]?.includes(body)).toBe(true)
    expect(f.execs.at(-1)?.slice(0, 2)).toEqual(['chmod', '0600'])

    f.setExecExit(3)
    f.archives.length = 0
    expect(await driverOf(f).seedCredentialsFileIfAbsent(KEY, Buffer.from(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-model-key-beta-9f3c\nrecords: {}\n`))).toBe(false)
    expect(f.archives).toHaveLength(0)
  })

  it('卷不存在就不建辅助容器', async () => {
    const f = fakeDocker({ volumes: [] })
    withHelperImage(f)
    await expect(driverOf(f).seedCredentialsFileIfAbsent(KEY, Buffer.from('version: 1\n'))).rejects.toThrow(/不存在/)
    expect(f.calls.some((call) => call.startsWith('container.create'))).toBe(false)
  })
})
