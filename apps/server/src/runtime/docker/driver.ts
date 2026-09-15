import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import net from 'node:net'
import type Docker from 'dockerode'
import type { InstanceSpec, RenderContext, RenderedInstance } from '@dsh-cloud/instance-spec'
import { MACHINE_PREFIX, networkName, renderInstance } from '@dsh-cloud/instance-spec'
import { createDocker, demuxFrames, isNotFound, isNotModified } from '../../docker/client.js'
import { LXCFS_FILES } from './lxcfs.js'
import {
  ProjectRegistry,
  assertStorageKey,
  clearProject,
  inodeLimitOf,
  reportProjects,
  setProjectQuota,
  updateProjectQuota,
  type StoragePool,
} from '../../instance/pool.js'
import {
  StorageExistsError,
  StorageNotFoundError,
  type InstanceLiveState,
  type InstanceUsage,
  type RuntimeDriver,
} from '../driver.js'

export interface DockerDriverOptions {
  /** 注入的 docker 客户端（测试用）。省略则走本机 socket。 */
  docker?: Docker
  /**
   * 数据池（`ensureStoragePool` 的产物）。**省略 = 没有池子** —— 退回 Docker 命名卷，
   * 实例照常能用但**没有硬限**。这只应出现在开发机（macOS / Docker Desktop 内核没编配额）。
   */
  pool?: StoragePool
  /** 跑辅助容器（`du` / `cp`）用的镜像。**只有命名卷那条退路还在用。** */
  helperImage?: string
  /**
   * 宿主上 lxcfs 的 `proc` 目录（`detectLxcfsProc` 的产物）。**省略 = 宿主没有 lxcfs** ——
   * 实例容器不挂那几个假文件，`/proc` 照旧透传宿主值。缺席是常态，见 `lxcfs.ts`。
   */
  lxcfsProcDir?: string
}

/**
 * Docker 运行时驱动。
 *
 * 模型对齐 `docker/`（那份是铁律，本文件围绕它实现）：
 * - 实例 = 用 `docker/instance-image` 构建出来的镜像起的**容器**，名字 `dsh-instance-<slug>`；
 * - 实例各占一个自己的网络 `dsh-net-<slug>`，**不共用默认 bridge** —— 共享一个广播域等于没隔离：
 *   同网段容器能直连邻居的端口、能扫，也能 ARP 欺骗，而桥上转发的是明文。见 `ensureNetwork`；
 * - 入口（Traefik 跑在容器里）够容器的方式是**宿主回环上发布的端口**
 *   （`docker/compose/local.yml` 里写着 Traefik 走 `host.docker.internal:<hostPort>`），
 *   所以这里发布 `127.0.0.1:<hostPort> -> <guestPort>`；
 * - `/data` 是**池子里的一个目录 + 一个 XFS project ID**（硬限额），删容器不删目录 → 实例重建不丢数据；
 *   没有池子时（开发机）退回命名卷，那种情况**没有硬限**，见 `createStorage`；
 * - 宿主装了 lxcfs 时，容器里的 `/proc/{meminfo,uptime,swaps}` 换成 lxcfs 的假文件，**藏住宿主的内存
 *   大小这类形状**（哪些真藏得住、哪些藏不住都逐个量过，见 `lxcfs.ts`）；没装就一个都不挂。
 *
 * 和上一个运行时（microVM）比，三处约束**松掉了**，别把旧的绕法搬过来：
 * 1. Docker 的 `create` 之后 `start` 就会跑镜像的 ENTRYPOINT —— 不需要"补一次 exec 才开机"。
 * 2. WORKDIR 不存在时 Docker 会**自己建**，不像 microVM 那样校验后拒绝。
 * 3. 没有"必须持有流句柄否则工作负载被杀"这种事。
 */
export class DockerDriver implements RuntimeDriver {
  readonly runtime = 'docker'
  readonly canReportLocalImages = true

  private readonly docker: Docker
  private readonly helperImage: string
  private readonly pool: StoragePool | undefined
  private readonly registry: ProjectRegistry | undefined
  private readonly lxcfsProcDir: string | undefined

  constructor(opts: DockerDriverOptions = {}) {
    this.docker = opts.docker ?? createDocker()
    this.helperImage = opts.helperImage ?? 'alpine'
    this.pool = opts.pool
    this.registry = opts.pool === undefined ? undefined : new ProjectRegistry(opts.pool.root)
    this.lxcfsProcDir = opts.lxcfsProcDir
  }

  /** 有没有**真的**硬配额。false = 走命名卷退路（开发机）。 */
  private get enforced(): boolean {
    return this.pool?.enforced === true
  }

  private get poolRoot(): string {
    if (this.pool === undefined) throw new Error('docker 驱动：没有数据池，不该走到池化路径')
    return this.pool.root
  }

  /** 一个 key 在池子里的目录。**宿主路径不进 spec**（spec 只带不透明的 key）。 */
  private dirOf(key: string): string {
    return join(this.poolRoot, key)
  }

  /**
   * lxcfs 那几个假文件的挂载项（`<宿主>/proc/<f>` → `/proc/<f>`，只读）。宿主的那个路径由
   * **daemon** 解析，控制面只是把字符串传过去 —— 所以控制面看不见它也不影响挂载，探测只是为了
   * 知道**该不该**挂：源不存在时 Docker 会把它建成一个**目录**，而 `/proc/meminfo` 是文件，
   * 于是容器**起不来**（`not a directory`，2026-09-16 实测）—— 比不挂糟得多。
   */
  private procBinds(): string[] {
    const dir = this.lxcfsProcDir
    if (dir === undefined) return []
    return LXCFS_FILES.map((f) => `${dir}/${f}:/proc/${f}:ro`)
  }

  // ---------------- 镜像 ----------------

  /**
   * 确认镜像在本机。不在就拉。
   *
   * 和 microVM 那版不同：那时 `ensureImage` 是空操作（拉取归 create 的策略管），
   * 因为 SDK 没有独立的 pull。Docker 有，所以这里就该**真的**把镜像准备好 ——
   * 编排层「先确认镜像、再建实例」那个顺序才名副其实。
   */
  async ensureImage(ref: string): Promise<void> {
    if (await this.imageExists(ref)) return
    const stream = await this.docker.pull(ref)
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (err: Error | null) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async imageExists(ref: string): Promise<boolean> {
    try {
      await this.docker.getImage(ref).inspect()
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  async listImageTags(): Promise<string[]> {
    const images = await this.docker.listImages()
    return images.flatMap((i) => i.RepoTags ?? []).filter((t) => t !== undefined && t !== '<none>:<none>')
  }

  /**
   * 拉镜像并把进度吐成给人看的一行行。
   *
   * Docker 的进度是 JSON 事件流（`{"status":"Downloading","id":"…","progressDetail":{…}}`），
   * 这里拍成 `status id progress` 一行；同内容去重，免得逐字节刷屏。
   */
  async openImagePull(ref: string): Promise<Readable> {
    const stream = await this.docker.pull(ref)
    return Readable.from(this.pullLines(stream))
  }

  private async *pullLines(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
    let last = ''
    for await (const chunk of stream) {
      for (const raw of String(chunk).split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        let text: string
        try {
          const ev = JSON.parse(line) as {
            status?: string
            id?: string
            progress?: string
            error?: string
          }
          if (ev.error !== undefined) text = `拉取失败：${ev.error}`
          else text = [ev.status, ev.id, ev.progress].filter((p) => p !== undefined).join(' ')
        } catch {
          text = line
        }
        if (text === '' || text === last) continue
        last = text
        yield `${text}\n`
      }
    }
  }

  // ---------------- 存储（实例数据）----------------

  /**
   * 建实例数据。**池化形态**：池子里一个目录 + 一个 project ID + 硬限额（**字节和 inode 都设**）。
   *
   * 同名已存在 → `StorageExistsError`（D18「绝不静默覆盖」）。**建只走这里，挂载只认已存在的**
   * —— 挂载时顺手建会把这条数据保护抵消掉。
   *
   * 没有池子时（开发机 → `enforced === false`）退回 Docker 命名卷：实例照常能用，
   * 但**没有硬限**，声明容量只记进 label。上层必须把"无硬配额"呈现给用户，别让它看着像上限。
   */
  async createStorage(key: string, sizeMb: number): Promise<void> {
    if (!this.enforced) return await this.createVolume(key, sizeMb)

    assertStorageKey(key)
    const dir = this.dirOf(key)
    if (await pathExists(dir)) {
      throw new StorageExistsError(`数据卷 ${key} 已存在，拒绝当作新建（数据保护）`)
    }
    await mkdir(dir, { recursive: true })
    const rec = await this.registry!.allocate(key, sizeMb, inodeLimitOf(sizeMb))
    await setProjectQuota(this.poolRoot, dir, rec.projid, rec.sizeMb, rec.inodeLimit)
  }

  /**
   * 数据在不在。不在 → `StorageNotFoundError`，**绝不新建**。
   *
   * 池化形态下**目录和注册表都要在**：只有目录、没有 projid = 没有配额 —— 那正是这条要防的
   * 「看起来有、其实没有」。
   */
  async ensureStorage(key: string): Promise<void> {
    if (!this.enforced) {
      if (!(await this.volumeExists(key))) {
        throw new StorageNotFoundError(
          `数据卷 ${key} 不存在（拒绝静默新建：那会把「数据丢了」伪装成正常）`,
        )
      }
      return
    }
    assertStorageKey(key)
    if (!(await pathExists(this.dirOf(key))) || (await this.registry!.get(key)) === undefined) {
      throw new StorageNotFoundError(
        `数据卷 ${key} 不存在（拒绝静默新建：那会把「数据丢了」伪装成正常）`,
      )
    }
  }

  /** 删掉这一份数据。幂等。**只删这一个 key** —— 快照由 `DataStore` 按 `.prev` 命名去删。 */
  async removeStorage(key: string): Promise<void> {
    if (!this.enforced) {
      try {
        await this.docker.getVolume(key).remove()
      } catch (err) {
        if (!isNotFound(err)) throw err
      }
      return
    }
    assertStorageKey(key)
    const dir = this.dirOf(key)
    const rec = await this.registry!.get(key)
    await rm(dir, { recursive: true, force: true })
    if (rec !== undefined) {
      await clearProject(this.poolRoot, rec.projid, dir)
      await this.registry!.release(key)
    }
  }

  /**
   * 改这一个 key 的容量上限（扩容 / 缩容都走这里）。
   *
   * **缩容也支持**：把 `bhard` 改小，已用超了新上限时表现为"拒绝再写"、数据不丢。
   * （对比：每实例一个 ext4 镜像那套 —— ext4 缩不了，只能重建 + 迁移。）
   */
  async resizeStorage(key: string, sizeMb: number): Promise<void> {
    if (!this.enforced) return // 命名卷没有限额可改
    assertStorageKey(key)
    const rec = await this.registry!.get(key)
    if (rec === undefined) throw new StorageNotFoundError(`数据卷 ${key} 不存在，无法改配额`)
    const inodeLimit = inodeLimitOf(sizeMb)
    await updateProjectQuota(this.poolRoot, rec.projid, sizeMb, inodeLimit)
    await this.registry!.update(key, sizeMb, inodeLimit)
  }

  /**
   * 已用容量（MiB）。**停机时也可读** —— 配额是文件系统的账，不依赖容器在跑。
   *
   * 池化形态直接读 `xfs_quota report`（不需要容器）；命名卷那条退路只能起一次性容器 `du`
   * —— 卷的挂载点在 Docker 的虚拟机里，宿主看不到。
   */
  async storageUsageMb(key: string): Promise<number | undefined> {
    if (!this.enforced) {
      if (!(await this.volumeExists(key))) return undefined
      const out = await this.runHelper(['du', '-sm', HELPER_MOUNT], { [key]: HELPER_MOUNT })
      const mib = /^\s*(\d+)/.exec(out)
      return mib === null ? undefined : Number(mib[1])
    }
    assertStorageKey(key)
    const rec = await this.registry!.get(key)
    if (rec === undefined) return undefined
    return (await reportProjects(this.poolRoot)).get(rec.projid)?.usedMb ?? 0
  }

  /**
   * 这个 key 的数据**实际**有没有硬配额。
   *
   * 判断是"宿主有池子 **且** 这个 key 在池子的注册表里"——后者挡的是"有目录但没配额"那种
   * 半截状态；UI 必须**如实**呈现（显示一个没生效的上限，比不显示更糟）。
   */
  async storageEnforced(key: string): Promise<boolean> {
    if (!this.enforced) return false
    assertStorageKey(key)
    return (await this.registry!.get(key)) !== undefined
  }

  /**
   * 一次读**所有**数据的用量（key → MiB）。命名卷那条退路读不了（每卷得起一个容器）→ `undefined`。
   *
   * 存在的理由：列表页每一行都要显示磁盘，逐行读就是 N 次 `xfs_quota`；池化形态下
   * 一次 `report` 就有全部答案。
   */
  async storageUsageAll(): Promise<Map<string, number> | undefined> {
    if (!this.enforced) return undefined
    const byProjid = await reportProjects(this.poolRoot)
    const out = new Map<string, number>()
    for (const key of await this.registry!.keys()) {
      const rec = await this.registry!.get(key)
      out.set(key, rec === undefined ? 0 : (byProjid.get(rec.projid)?.usedMb ?? 0))
    }
    return out
  }

  /**
   * 整份复制成另一份（升级 / 回退的唯一保险）。
   *
   * 池化形态下就是宿主上两个目录之间的 `cp -a`。**目标必须有自己的 project ID**：
   * 共用源的 id 会让快照算进实例的账，实例接近限额时快照直接失败。
   * **先给目标设好 project（带继承标志）再拷** —— `cp -a` 不会把 inode 的 projid 带过去，
   * 靠的是继承。
   *
   * 前提：源已经没有容器在写（调用方 `provisioner.setImage` 保证先停了）。
   */
  async copyStorage(fromKey: string, toKey: string): Promise<void> {
    if (!this.enforced) {
      if (!(await this.volumeExists(fromKey))) {
        throw new StorageNotFoundError(`数据卷 ${fromKey} 不存在，无法复制`)
      }
      const sizeMb = await this.volumeSizeMb(fromKey)
      await this.createVolume(toKey, sizeMb)
      await this.runHelper(['cp', '-a', `${HELPER_MOUNT}/.`, `${HELPER_TARGET}/`], {
        [fromKey]: HELPER_MOUNT,
        [toKey]: HELPER_TARGET,
      })
      return
    }

    assertStorageKey(fromKey)
    assertStorageKey(toKey)
    const src = await this.registry!.get(fromKey)
    if (src === undefined) throw new StorageNotFoundError(`数据卷 ${fromKey} 不存在，无法复制`)
    const from = this.dirOf(fromKey)
    const to = this.dirOf(toKey)
    if (await pathExists(to)) {
      throw new StorageExistsError(`数据卷 ${toKey} 已存在，拒绝覆盖`)
    }
    await mkdir(to, { recursive: true })
    const rec = await this.registry!.allocate(toKey, src.sizeMb, inodeLimitOf(src.sizeMb))
    await setProjectQuota(this.poolRoot, to, rec.projid, rec.sizeMb, rec.inodeLimit)
    try {
      await execFileAsync('cp', ['-a', '--sparse=always', `${from}/.`, `${to}/`])
    } catch (err) {
      // 拷到一半失败（多半是配额不够 / ENOSPC）：别留半截目录，连 project 一起清掉。
      await rm(to, { recursive: true, force: true }).catch(() => undefined)
      await clearProject(this.poolRoot, rec.projid, to)
      await this.registry!.release(toKey)
      throw err
    }
  }

  // ---- 命名卷退路（只在开发机用；没有硬配额）----

  private async createVolume(key: string, sizeMb: number): Promise<void> {
    if (await this.volumeExists(key)) {
      throw new StorageExistsError(`数据卷 ${key} 已存在，拒绝当作新建（数据保护）`)
    }
    await this.docker.createVolume({
      Name: key,
      Labels: { 'dsh.cloud/managed': 'true', 'dsh.cloud/size-mb': String(sizeMb) },
    })
  }

  private async volumeExists(key: string): Promise<boolean> {
    try {
      await this.docker.getVolume(key).inspect()
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  /** 卷上记录的声明容量。没有（老卷 / 手工建的）就给个下限，别把新的建得比它还小。 */
  private async volumeSizeMb(key: string): Promise<number> {
    const info = await this.docker.getVolume(key).inspect()
    const declared = Number(info.Labels?.['dsh.cloud/size-mb'] ?? '')
    return Number.isFinite(declared) && declared > 0 ? declared : 128
  }

  // ---------------- 网络 ----------------

  /**
   * 确保这个实例自己的网络在。幂等：先 inspect，在就直接用。
   *
   * **不能"建失败就当有"**：同名再建时 Docker 回的是 409（不是静默复用），把它当成功就等于
   * 把"网络没建出来"记成建好了。
   *
   * 建不出来就**抛错，不退回默认 bridge**：那种降级是静默的，而降的正好是隔离本身 ——
   * 实例看起来建好了、其实又跟所有实例同处一个广播域。
   */
  private async ensureNetwork(slug: string): Promise<string> {
    const name = networkName(slug)
    try {
      await this.docker.getNetwork(name).inspect()
      return name
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    try {
      await this.docker.createNetwork({
        Name: name,
        Driver: 'bridge',
        Labels: { 'dsh.cloud/managed': 'true', 'dsh.cloud/instance': slug },
      })
    } catch (err) {
      throw networkCreateError(name, err)
    }
    return name
  }

  /**
   * 删这个实例的网络。幂等。
   *
   * **必须在容器删掉之后调**：还有端点连着时 Docker 会拒绝删（那是正确的信号，别吞）。
   * 一个实例一个网络，所以删实例就是删网络 —— 留着会一直占着 Docker 的地址池。
   */
  private async removeNetwork(slug: string): Promise<void> {
    try {
      await this.docker.getNetwork(networkName(slug)).remove()
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  // ---------------- 生命周期 ----------------

  /**
   * 建并启动实例。**幂等：同名残留先清掉再建**（和上一个运行时同语义）。
   *
   * 挂载一律要求卷**已存在**（先 `ensureStorage`）：Docker 在挂载不存在的命名卷时会
   * **默默建一个**，那正好抵消 `createStorage` 里「同名就拒」那条数据保护。
   */
  async create(spec: InstanceSpec, ctx: RenderContext): Promise<RenderedInstance> {
    const r = renderInstance(spec, ctx)

    for (const m of r.mounts) await this.ensureStorage(m.storageKey)

    // **先确保网络、再动旧容器**：网络建不出来时（例如 Docker 地址池用尽）旧容器还在跑，
    // 不会留下"旧的删了、新的没起来"的半截状态。
    const network = await this.ensureNetwork(spec.slug)

    await this.removeContainer(r.machineName)

    const container = await this.docker.createContainer({
      name: r.machineName,
      Image: r.image,
      Env: r.env,
      Labels: r.labels,
      User: r.user,
      WorkingDir: r.workingDir,
      ExposedPorts: { [`${r.guestPort}/tcp`]: {} },
      HostConfig: {
        // 每个实例各占一个网络 = 各占一个广播域。**只设 NetworkMode 就够**（实测：容器真的
        // 落到这个网络上，inspect 出来的 NetworkMode 与事实一致）；不需要 NetworkingConfig，
        // 别名也不用给 —— Docker 自己会把容器名加进这个网络的 DNS 名里。
        NetworkMode: network,
        // 只发到宿主回环：入口够得着，局域网够不着。
        PortBindings: {
          [`${r.guestPort}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(r.hostPort) }],
        },
        // 池化形态挂宿主目录（`<pool>/<key>`）；没有池子时挂命名卷 —— Docker 两者共用同一套
        // `Binds` 语法，区别只在左边是路径还是卷名。
        Binds: [
          ...r.mounts.map(
            (m) => `${this.enforced ? this.dirOf(m.storageKey) : m.storageKey}:${m.guest}:${m.mode}`,
          ),
          ...this.procBinds(),
        ],
        // 宿主指纹的另一半（lxcfs 管不了的那半）：DMI。见 MASKED_PATHS 的注释。
        MaskedPaths: MASKED_PATHS,
        // 资源上限来自**渲染结果**（不回去翻 spec）：机器定义里有什么，这里就落什么。
        Memory: r.memoryMb * 1024 * 1024,
        NanoCpus: r.cpus * 1e9,
        // pids cgroup 上限。**别省**：这是 fork bomb 的唯一护栏（`spec.quota` 里一直有它，
        // 但驱动曾经没往下带 —— 于是"进程数上限"在界面上可调、在容器里完全不生效）。
        PidsLimit: r.pidsLimit,
        // 生命周期归平台管：宿主重启后由对账器决定该不该起来，别让 Docker 自己拉。
        RestartPolicy: { Name: 'no' },
      },
    })
    await container.start()
    return r
  }

  async start(machineName: string): Promise<void> {
    try {
      await this.docker.getContainer(machineName).start()
    } catch (err) {
      // 304 = 已经在跑，算成功。
      if (!isNotModified(err)) throw err
    }
  }

  /**
   * 停实例。**必须优雅** —— Docker 的 `stop` 是 SIGTERM 再等一段时间才 SIGKILL，
   * 正是我们要的（容器里的 dsh 需要时间把会话落盘）。禁止用 `remove` 代替。
   */
  async stop(machineName: string): Promise<void> {
    try {
      await this.docker.getContainer(machineName).stop({ t: STOP_TIMEOUT_SECONDS })
    } catch (err) {
      // 304 = 已经停了；404 = 不存在。幂等语义下都算成功。
      if (!isNotModified(err) && !isNotFound(err)) throw err
    }
  }

  /**
   * 删容器**和它自己的网络**。幂等。
   *
   * 顺序不能反：还有端点连着时 Docker 会拒绝删网络。机器名去掉前缀就是 slug，网络名由 slug
   * 派生 —— 一个 slug 恰好一个网络，所以这里不用再回 Docker 查一遍。
   */
  async remove(machineName: string): Promise<void> {
    await this.removeContainer(machineName)
    await this.removeNetwork(machineName.slice(MACHINE_PREFIX.length))
  }

  /**
   * 只删容器。**`create` 必须走这条，不能走上面的 `remove`** —— 它在删旧容器之前刚
   * `ensureNetwork` 过，网络被一起删掉的话，紧跟着的 `createContainer` 会因为
   * "网络不存在"直接失败。
   */
  private async removeContainer(machineName: string): Promise<void> {
    try {
      await this.docker.getContainer(machineName).remove({ force: true })
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
  }

  // ---------------- 观测 ----------------

  async status(machineName: string): Promise<InstanceLiveState | undefined> {
    let info: Docker.ContainerInspectInfo
    try {
      info = await this.docker.getContainer(machineName).inspect()
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw err
    }
    const raw = info.State.Status
    return { state: normalizeState(raw), statusText: `docker: ${raw}` }
  }

  async listInstanceNames(): Promise<string[]> {
    const list = await this.docker.listContainers({ all: true })
    return list.flatMap((c) => c.Names ?? []).map((n) => n.replace(/^\//, '')).filter((n) => n.startsWith(MACHINE_PREFIX))
  }

  /**
   * 探**服务本身**，不是探容器状态。
   *
   * 容器 running 不等于工作负载活着（entrypoint 里 dsh 或 caddy 崩了，容器会跟着停；
   * 但启动过程中的窗口期里容器是 running 而端口还没人听）。所以这里**真的去连入口端口** ——
   * 也就是入口待会儿要转发到的那个 `127.0.0.1:<hostPort>`。
   */
  async probeHealthy(machineName: string, hostPort: number): Promise<boolean> {
    const state = await this.status(machineName)
    if (state?.state !== 'running') return false
    return await tcpProbe(hostPort, PROBE_TIMEOUT_MS)
  }

  async logs(machineName: string, tail: number): Promise<string> {
    try {
      const buf = (await this.docker
        .getContainer(machineName)
        .logs({ stdout: true, stderr: true, tail })) as unknown as Buffer
      // 没开 TTY 时日志是 8 字节头 + 负载的多路复用帧，直接 toString 会把头混进正文。
      return buf.length >= 8 && buf.subarray(0, 8)[1] !== undefined ? demuxFrames(buf) : buf.toString('utf8')
    } catch (err) {
      if (isNotFound(err)) return ''
      throw err
    }
  }

  async exec(machineName: string, argv: string[]): Promise<{ code: number; stdout: string }> {
    const container = this.docker.getContainer(machineName)
    const exec = await container.exec({
      Cmd: argv,
      AttachStdout: true,
      AttachStderr: true,
    })
    const stream = (await exec.start({})) as unknown as NodeJS.ReadableStream
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk))
    const info = await exec.inspect()
    return { code: info.ExitCode ?? 0, stdout: demuxFrames(Buffer.concat(chunks)) }
  }

  /** 容器的 CPU / 内存用量。Docker 原生就有，不需要自己凑。 */
  async stats(machineName: string): Promise<InstanceUsage | undefined> {
    try {
      const s = (await this.docker.getContainer(machineName).stats({ stream: false })) as unknown as DockerStats
      return { cpuPercent: cpuPercentOf(s), memMb: (s.memory_stats?.usage ?? 0) / 1024 / 1024 }
    } catch (err) {
      if (isNotFound(err)) return undefined
      throw err
    }
  }

  /**
   * 回收孤儿。
   *
   * 上一个运行时这里要收的是**预热的沙箱**（一次性资源，进程被打断会留下，而对账器
   * 只认实例前缀、看不见它们）。Docker 下没有对应物：辅助容器都是 `runHelper` 自己
   * 建自己删的，不会有跨进程残留。所以这里是**有意的空操作** —— 真·孤儿容器
   * （DB 里没有的）归对账器，它只告警不删，这是既有策略，不在这一层推翻。
   */
  async heal(): Promise<void> {
    // 无残留可收：见上面的注释。
  }

  // ---------------- 辅助容器（**只在命名卷退路上用**）----------------

  /**
   * 起一个一次性容器跑命令，拿 stdout，然后拆掉。
   *
   * 用途：`du`（量卷）和 `cp`（复制卷）—— 卷的挂载点在 Docker 的虚拟机里，宿主看不到，
   * 只能进容器做。**池化那条路不需要它**（池子是宿主上的目录，直接 `cp` / `xfs_quota`）。
   */
  private async runHelper(argv: string[], binds: Record<string, string>): Promise<string> {
    await this.ensureImage(this.helperImage)
    const name = `dsh-helper-${randomUUID().slice(0, 8)}`
    const container = await this.docker.createContainer({
      name,
      Image: this.helperImage,
      Cmd: argv,
      HostConfig: {
        Binds: Object.entries(binds).map(([key, guest]) => `${key}:${guest}`),
        // 它只挂卷跑 `du` / `cp`，不需要网络。不给网络，也就没有"辅助容器能当跳板"这一说；
        // 默认 bridge 上待着反而会跟降级/历史容器同处一个广播域。
        NetworkMode: 'none',
      },
    })
    try {
      await container.start()
      const wait = (await container.wait()) as { StatusCode?: number }
      const buf = (await container.logs({ stdout: true, stderr: true })) as unknown as Buffer
      if ((wait.StatusCode ?? 0) !== 0) {
        throw new Error(`辅助容器 ${argv.join(' ')} 失败（退出码 ${wait.StatusCode}）：${buf.toString('utf8').slice(0, 500)}`)
      }
      return buf.toString('utf8')
    } finally {
      await container.remove({ force: true }).catch(() => undefined)
    }
  }
}

/** 辅助容器里挂卷的路径。 */
const HELPER_MOUNT = '/_src'
const HELPER_TARGET = '/_dst'

const execFileAsync = promisify(execFile)

/** 路径在不在（`stat` 一次）。 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * 建实例网络失败的报错。
 *
 * **Docker 的原文必须带出去** —— 最常见的那种失败（地址池用尽）只能从原文里认出来，而它的原文
 * 是句底层黑话，操作者拿到手不知道该改哪个文件。所以这里既保留原文，又补一句可照做的动作。
 */
function networkCreateError(name: string, err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err)
  // 一个实例一个网络 → 网络数 = 实例数，地址池用尽是迟早的事（默认池能分的网络数很少）。
  const hint = /fully subnetted|address pool/i.test(raw)
    ? '\n→ Docker 的地址池用完了。在 /etc/docker/daemon.json 里把 default-address-pools 的 size 调小' +
      '（例如 {"base":"172.16.0.0/12","size":24}，按 /24 切就是 4096 个）再重启 docker。'
    : ''
  return new Error(`建实例网络 ${name} 失败：${raw}${hint}`)
}

/** `docker stop` 的宽限期（秒）：够 dsh 把会话落盘。 */
const STOP_TIMEOUT_SECONDS = 10

/**
 * `HostConfig.MaskedPaths` 的**完整**列表 —— 设了它就是**整份替换** Docker 的默认遮罩，
 * 所以前 12 条必须原样抄着，否则等于悄悄把 `/proc/kcore`、`/sys/firmware` 这些又敞开。
 * 抄的是真机 dockerd 29.8.0 的默认值（12 条）；开发机那个 daemon 的默认少一条
 * `/proc/interrupts`（11 条）—— 即**默认表本身就随 daemon 版本变**，所以不能只靠"不设就是默认"。
 * 最后一条是本驱动加的。
 *
 * 加 `/sys/devices/virtual/dmi` 的理由：那下面写着宿主是不是虚拟机、机型是什么（`product_name`
 * 实测报 `KVM`），实例读一眼就能给宿主归类 —— 它是**宿主全局**的，跟 `/proc/meminfo` 同一类问题。
 * 实证：遮掉之后容器里这个目录直接不存在；**换 gVisor 也照样漏**，所以这条与运行时选择无关。
 */
const MASKED_PATHS = [
  '/proc/acpi',
  '/proc/asound',
  '/proc/interrupts',
  '/proc/kcore',
  '/proc/keys',
  '/proc/latency_stats',
  '/proc/sched_debug',
  '/proc/scsi',
  '/proc/timer_list',
  '/proc/timer_stats',
  '/sys/devices/virtual/powercap',
  '/sys/firmware',
  '/sys/devices/virtual/dmi',
]

/** 探活的 TCP 超时。入口转发是本地回环，超过这个数就是没起来。 */
const PROBE_TIMEOUT_MS = 2000

/** Docker 的原始状态 → 运行时中立的状态枚举（`InstanceLiveState.state`）。 */
function normalizeState(raw: string): string {
  switch (raw.toLowerCase()) {
    case 'running':
      return 'running'
    case 'exited':
    case 'dead':
      return 'stopped'
    case 'created':
      return 'created'
    case 'restarting':
      return 'restarting'
    default:
      return 'unknown'
  }
}

/** `docker stats` 响应里我们用到的那几个字段（类型来自 dockerode 的 loose 类型）。 */
interface DockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number }
    system_cpu_usage?: number
    online_cpus?: number
  }
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number }
  memory_stats?: { usage?: number; limit?: number }
}

/** Docker 的标准 CPU 百分比公式：本段用量 / 本段系统时间 × 核数 × 100。 */
function cpuPercentOf(s: DockerStats): number {
  const cpu = s.cpu_stats?.cpu_usage?.total_usage ?? 0
  const pre = s.precpu_stats?.cpu_usage?.total_usage ?? 0
  const sys = s.cpu_stats?.system_cpu_usage ?? 0
  const preSys = s.precpu_stats?.system_cpu_usage ?? 0
  const cpus = s.cpu_stats?.online_cpus ?? 1
  const cpuDelta = cpu - pre
  const sysDelta = sys - preSys
  if (cpuDelta <= 0 || sysDelta <= 0) return 0
  return (cpuDelta / sysDelta) * cpus * 100
}

/** 探一个本地回环端口通不通。 */
function tcpProbe(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}
