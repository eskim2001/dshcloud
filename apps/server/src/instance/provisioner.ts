import {
  ImageRefSchema,
  InstanceSpecSchema,
  machineName,
  type RenderContext,
  type InstanceSpec,
} from '@dsh-cloud/instance-spec'
import type { Db } from '../db/client.js'
import {
  countRunningInstances,
  createInstanceRecord,
  retainInstanceRecord,
  findInstanceById,
  listAllInstances,
  updateInstance,
  type NewInstance,
} from '../db/instance-repo.js'
import { findDefaultImageRelease, isImageRelease } from '../db/image-release-repo.js'
import { isImageInCatalog } from '../db/image-catalog-repo.js'
import type { InstanceRow } from '../db/schema.js'
import type { Env } from '../env.js'
import { renderCredentialsYaml } from '../model-credentials/document.js'
import { readOwnerModelRefs } from '../model-credentials/load.js'
import type { DataStore } from './data-store.js'
import { gateToken } from './gate-token.js'
import { imageRepo, isReleaseTag } from './image-catalog.js'
import type { InstanceOrchestrator } from './orchestrator.js'
import { allocateHostPort } from './port-allocator.js'
import { lifecycleOperations } from './operation-queue.js'

export interface ProvisionInput {
  slug: string
  ownerId: string
  cpus: number
  memoryMb: number
  pidsLimit: number
  diskMb: number
  /** 自选版本。不传就用平台默认版本（D21）。 */
  image?: string
}

export interface RemoveInput {
  /** 调用方回填的子域名。删除不可逆，用"打一遍名字"挡误操作。 */
  confirmSlug: string
}

/** 资源配额四元组。只由管理员改（D17）。 */
export type QuotaInput = Pick<ProvisionInput, 'cpus' | 'memoryMb' | 'pidsLimit' | 'diskMb'>

export class SlugConfirmMismatchError extends Error {
  constructor() {
    super('删除不可恢复：子域名没对上，请重新输入')
    this.name = 'SlugConfirmMismatchError'
  }
}

/** 目标镜像被拒：引用非法 / 不是平台自己的镜像仓库 / 不在可选范围 / 宿主上没有。 */
export class ImageRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageRejectedError'
  }
}

/** 没有可回滚的快照（`previous_image` 为空）。 */
export class NoRollbackError extends Error {
  constructor() {
    super('这个实例没有可回滚的版本')
    this.name = 'NoRollbackError'
  }
}

/** 换镜像后新容器起不来，数据与镜像已自动回滚到上一版。 */
export class ImageUpgradeFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageUpgradeFailedError'
  }
}

/**
 * 全局同时 running 已满。`PLATFORM_MAX_RUNNING=0` 时不会抛。
 * HTTP 映射 409——与配额撞墙同档：请求本身此刻做不到，不是服务端故障。
 */
export class MaxRunningExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly running: number,
  ) {
    super(
      `同时运行的工作空间已达上限（${running}/${limit}），请先停止闲置的工作空间后再试`,
    )
    this.name = 'MaxRunningExceededError'
  }
}

/**
 * 换镜像 / 回滚的**预期内**失败 → HTTP 400（请求本身做不到，不是服务端故障）。
 * 集中在这里，是因为实例面和管理面要给出同样的状态码，漏一处就是两套语义。
 */
export function isImageFailure(
  err: unknown,
): err is ImageRejectedError | NoRollbackError | ImageUpgradeFailedError {
  return (
    err instanceof ImageRejectedError ||
    err instanceof NoRollbackError ||
    err instanceof ImageUpgradeFailedError
  )
}

/**
 * 建实例 = 落库 → 起容器 → 更新状态 → 同步路由。
 *
 * 顺序有意如此：**先落库再起容器**，因为端口要落库才能防冲突；起容器失败
 * 就地把状态标成 `error`，管理台能看到原因，重试走 `restart`。
 */
export class InstanceProvisioner {
  constructor(
    private readonly db: Db,
    private readonly orchestrator: InstanceOrchestrator,
    private readonly dataStore: DataStore,
    private readonly env: Env,
    private readonly syncRoutes: () => Promise<void>,
  ) {}

  async create(input: ProvisionInput): Promise<InstanceRow> {
    return lifecycleOperations.run(() => this.createUnlocked(input))
  }

  private async createUnlocked(input: ProvisionInput): Promise<InstanceRow> {
    // 没自选就用库里的默认版本（D21）——没有就响亮失败，别拿一个过期 env 顶上
    const image = input.image ?? (await findDefaultImageRelease(this.db))?.ref
    if (image === undefined) {
      // 用户看得到这句。别再写"去「版本管理」上架一版"——他没有那个页面；
      // 该怎么做，写在管理面的版本页里就够了。
      throw new ImageRejectedError('平台还没有可用的镜像版本，暂时无法创建实例（请联系运营）')
    }
    // 自选版本走和升级一样的准入（平台仓库 + 发布序列 + 已发布），但**不要求宿主已有**：
    // 创建本来就会 ensureImage 自动拉（D23）。
    if (input.image !== undefined) {
      await this.assertImageAllowed(input.image, { requireLocal: false })
    }

    await this.assertCanStartRunning(false)

    const newInstance: NewInstance = {
      id: crypto.randomUUID(),
      slug: input.slug,
      ownerId: input.ownerId,
      image,
      cpus: input.cpus,
      memoryMb: input.memoryMb,
      pidsLimit: input.pidsLimit,
      diskMb: input.diskMb,
    }

    const row = await createInstanceRecord(this.db, newInstance, this.env.MAX_INSTANCES_PER_USER)

    try {
      // 新建：数据卷允许在这里第一次创建
      return await this.applyRuntime(row, { createData: true })
    } catch (err) {
      return await this.failWith(row.id, err)
    }
  }

  /** 用同一份规格重建容器（换镜像 / 修复崩溃）。**卷不动**，所以内容保留。 */
  async restart(id: string): Promise<InstanceRow> {
    return lifecycleOperations.run(() => this.restartUnlocked(id))
  }

  private async restartUnlocked(id: string): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)

    await this.assertCanStartRunning(row.status === 'running')

    try {
      return await this.applyRuntime(row)
    } catch (err) {
      return await this.failWith(row.id, err)
    }
  }

  /**
   * 停实例。可逆——机器和数据都留着，`start` 能原样起来。
   *
   * **顺带是一次落盘**：优雅停机让容器里的 dsh 有时间把会话写完，
   * 所以「停」不只是省资源，也是把最近一段写入变持久的手段。
   * 停下来的实例不进 Traefik 投影，所以同步一次路由把它摘掉。
   */
  async stop(id: string): Promise<InstanceRow> {
    return lifecycleOperations.run(() => this.stopUnlocked(id))
  }

  private async stopUnlocked(id: string): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)

    try {
      if (row.containerId !== null) await this.orchestrator.stopInstance(machineName(row.slug))
      const updated = await updateInstance(this.db, row.id, { status: 'stopped', lastError: null })
      await this.syncRoutes()
      return updated ?? row
    } catch (err) {
      return await this.failWith(row.id, err)
    }
  }

  /**
   * 启动实例。容器已经不在（被 prune / 手动删）就回落重建——数据不动，内容保留。
   *
   * **起容器前必须先确认数据卷在**：卷被删掉后 Docker 会默默建一个空卷顶上
   * （见 `DockerDriver.create`），用户看到「数据没了」（D18）。
   */
  async start(id: string): Promise<InstanceRow> {
    return lifecycleOperations.run(() => this.startUnlocked(id))
  }

  private async startUnlocked(id: string): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)

    await this.assertCanStartRunning(row.status === 'running')

    if (row.containerId === null) return this.applyRuntime(row)

    try {
      // 机器不在了（被 prune / 手动删）→ 回落重建。数据在卷里，内容保留。
      if ((await this.orchestrator.inspectStatus(row.containerId)) === 'unknown') {
        return await this.applyRuntime(row)
      }

      // 数据卷**只 ensure 不新建**：卷不见了就抛错，别静默建个空的把
      // 「数据丢了」伪装成正常——这条铁律从 D18 继承下来，是这一层最重要的一条。
      await this.dataStore.ensure(row.storageKey)
      await this.orchestrator.startInstance(row.containerId)

      const updated = await updateInstance(this.db, row.id, { status: 'running', lastError: null })
      await this.syncRoutes()
      return updated ?? row
    } catch (err) {
      return await this.failWith(row.id, err)
    }
  }

  /**
   * 全局 running 闸门。已在跑的（含宿主重启后 boot 拉起）不占新名额；
   * `PLATFORM_MAX_RUNNING=0` 关闭上限。
   */
  private async assertCanStartRunning(alreadyRunning: boolean): Promise<void> {
    if (alreadyRunning) return
    const limit = this.env.PLATFORM_MAX_RUNNING
    if (limit === 0) return
    const running = await countRunningInstances(this.db)
    if (running >= limit) throw new MaxRunningExceededError(limit, running)
  }

  /**
   * 删实例。**这一步真的删数据** —— 用户说"删除"就该是这个意思，别让他以为删了却还留着，
   * 也别留一份谁也够不到的残留占着宿主空间。
   *
   * 仍然要手打子域名：不可逆的动作必须过一道明确的确认。
   *
   * 唯一留下的是**主机名**：那一行不删，改成"退役"占位并继续绑定原 owner —— 域名一旦回收给
   * 另一个租户，上一个租户留在这个域名下的浏览器状态（cookie / localStorage / service worker）
   * 就被继承过去了（D24 / D31）。所以**数据没了、名字还是他的**：本人可以同名重建（拿到一份
   * 空的新文件系统），别人抢不走。
   *
   * 顺序有意如此：先摘路由再删容器，否则容器删到一半时流量还会打进来。
   */
  async remove(id: string, opts: RemoveInput): Promise<void> {
    return lifecycleOperations.run(() => this.removeUnlocked(id, opts))
  }

  private async removeUnlocked(id: string, opts: RemoveInput): Promise<void> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)
    if (opts.confirmSlug !== row.slug) {
      throw new SlugConfirmMismatchError()
    }

    try {
      // ① 摘路由：置 removing 后投影一次，Traefik 立刻不再往里送流量
      await updateInstance(this.db, row.id, { status: 'removing' })
      await this.syncRoutes()

      // ② 先优雅停，再删机器。顺序不能反：
      //    优雅停机让 dsh 把未落盘的会话写完；容器一删，这些就没了。
      //    机器名用 slug 现算，不读 row.containerId（它可能已经是 null）。
      await this.orchestrator.stopInstance(machineName(row.slug))
      await this.orchestrator.removeInstance(machineName(row.slug))

      // ③ 数据真删：容器已经不在，数据目录 + 升级快照 + 它的配额账一起清掉
      await this.dataStore.destroy(row.storageKey)

      // ④ 记录留成"退役主机名"（见上），再投影一次让路由条目彻底消失
      await retainInstanceRecord(this.db, row.id)
      await this.syncRoutes()
    } catch (err) {
      // 删失败就把状态写回去，别让实例永远卡在 removing——行还在，可以重试
      await this.failWith(row.id, err)
    }
  }

  /**
   * 改资源配额（D17：创建后只有管理员能改）。
   *
   * **CPU / 内存 / pids** 只在建容器时生效 → 改了必须重建（中断几秒，数据不动）。
   * **磁盘不用重建**：池化之后它只是文件系统上的一个数字（XFS project quota），扩容和缩容
   * 都在线改；缩到比当前用量还小时表现为"拒绝再写"、数据不丢。
   *
   * 原本在跑的实例重建后照旧运行；原本停着的**保持停止** —— 只把旧容器删掉
   * （否则 `start` 会复用旧容器、带着旧配额起来），等用户自己 `start`。
   */
  async setQuota(id: string, quota: QuotaInput): Promise<InstanceRow> {
    return lifecycleOperations.run(() => this.setQuotaUnlocked(id, quota))
  }

  private async setQuotaUnlocked(id: string, quota: QuotaInput): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)

    // 盘**先改、再落库**。反过来的话，运行时改失败就把"新容量"写进库里了 ——
    // 管理台显示新配额、用户灌满才发现还是老尺寸，正是这条要防的。
    // 缩到比当前用量还小是允许的：那时表现为"拒绝再写"，数据不丢。
    if (quota.diskMb !== row.diskMb) {
      await this.orchestrator.resizeStorage(row.storageKey, quota.diskMb)
    }

    const computeChanged =
      row.cpus !== quota.cpus ||
      row.memoryMb !== quota.memoryMb ||
      row.pidsLimit !== quota.pidsLimit
    const rebuild = computeChanged
    const wasRunning = row.status === 'running'

    // 先落库：即使下面运行时操作失败，配额意图也已记下，重试走 restart 即可
    const updated = await updateInstance(this.db, row.id, {
      ...quota,
      ...(rebuild ? { containerId: null } : {}),
    })
    if (updated === undefined) throw new Error(`实例不存在：${id}`)

    if (rebuild) {
      if (row.containerId !== null) await this.orchestrator.removeInstance(machineName(row.slug))
      return wasRunning ? this.restartUnlocked(id) : updated
    }

    return updated
  }

  /**
   * 换镜像（升级 / 降级）。**升级前给 `/data` 打一份快照**，所以失败可回滚。
   *
   * 顺序：校验 → 停容器 → 快照 → 落库 → 重建。每一步都有明确退路：
   * - 校验不通过：什么都没碰。
   * - 快照失败（多半是宿主空间不够）：容器已停、数据卷没动，按原规格把实例恢复起来。
   * - 新镜像起不来：**自动回滚**——数据回快照、镜像回旧版，然后抛错说明原因。
   *
   * 停机时间 = 停容器 + 复制已用数据 + 启动。数据越多越久（100MB 秒级，
   * 10GB 一两分钟）——快照的价钱，UI 上要写清楚。
   *
   * `allowAny` 只给管理员用：用户只能在**已发布**的版本里选（D21）。
   */
  async setImage(
    id: string,
    image: string,
    opts: { allowAny?: boolean } = {},
  ): Promise<InstanceRow> {
    return lifecycleOperations.run(() => this.setImageUnlocked(id, image, opts))
  }

  private async setImageUnlocked(
    id: string,
    image: string,
    opts: { allowAny?: boolean },
  ): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)
    if (image === row.image) return row

    await this.assertImageAllowed(image, { allowAny: opts.allowAny === true })

    const wasRunning = row.status === 'running'

    // ① 优雅停机器：让 dsh 把会话写完落进卷。
    //    这里绝不能用删除/强杀代替——那会丢掉还没落盘的数据。
    //    停下之后卷才是最新的状态，才谈得上打快照。
    await this.orchestrator.stopInstance(machineName(row.slug))

    // The next snapshot replaces the old one. Invalidate its image binding first,
    // so a crash cannot pair the new data with an older rollback image.
    if (row.previousImage !== null) {
      const invalidated = await updateInstance(this.db, row.id, { previousImage: null })
      if (invalidated === undefined) throw new Error(`实例不存在：${id}`)
    }

    // ② 快照失败不修改当前数据，但旧回滚点可能已失效。
    try {
      await this.dataStore.snapshot(row.storageKey)
    } catch (err) {
      if (wasRunning) await this.restartUnlocked(id)
      throw new ImageRejectedError(`升级前打快照失败，当前数据未改动，原回滚点可能已失效：${messageOf(err)}`)
    }

    // ③ 落库：新镜像 + 记下旧镜像（非空 = 有一份快照可回滚）
    const updated = await updateInstance(this.db, row.id, {
      image,
      previousImage: row.image,
      containerId: null,
    })
    if (updated === undefined) throw new Error(`实例不存在：${id}`)

    // 停着的实例只落库——新镜像在用户下次 start 时生效
    if (!wasRunning) return updated

    try {
      return await this.restartUnlocked(id)
    } catch (err) {
      try {
        // 用**升级前**的 wasRunning 决定要不要拉起来：此刻 DB 里的状态已被
        // 失败的 restart 写成 error，照它判断就会把实例留在「没容器」的状态
        await this.rollbackTo(id, row.image, wasRunning)
      } catch (rollbackErr) {
        // 回滚也失败：容器没了、库里记着新镜像——必须响亮地标 error
        await this.failWith(
          row.id,
          new ImageUpgradeFailedError(
            `新镜像 ${image} 起不来，回滚也失败了（${messageOf(rollbackErr)}）：${messageOf(err)}`,
          ),
        )
      }
      throw new ImageUpgradeFailedError(
        `新镜像 ${image} 起不来，已回滚到 ${row.image}：${messageOf(err)}`,
      )
    }
  }

  /**
   * 回滚到上一版：用升级前的快照覆盖数据，再按 `previous_image` 重建。
   *
   * 快照被 `mv` 消费掉（回滚只有一步），`previous_image` 随之清空——想再升回去
   * 就走一次正常升级（会重新打快照）。
   */
  async rollbackImage(id: string): Promise<InstanceRow> {
    return lifecycleOperations.run(() => this.rollbackImageUnlocked(id))
  }

  private async rollbackImageUnlocked(id: string): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)
    if (row.previousImage === null) throw new NoRollbackError()

    try {
      return await this.rollbackTo(id, row.previousImage, row.status === 'running')
    } catch (error) {
      return this.failWith(id, error)
    }
  }

  /**
   * 回滚的落地动作：恢复快照 → 落库回旧镜像 → （原本在跑的）重建。
   *
   * `rebuild` 由调用方给：自动回滚那条路上，DB 里的状态已经是失败后的 `error`，
   * 只能拿升级前的意图来判断。
   */
  private async rollbackTo(
    id: string,
    previousImage: string,
    rebuild: boolean,
  ): Promise<InstanceRow> {
    const row = await findInstanceById(this.db, id)
    if (row === undefined) throw new Error(`实例不存在：${id}`)
    const pending = await updateInstance(this.db, row.id, { status: 'provisioning' })
    if (pending === undefined) throw new Error(`实例不存在：${id}`)
    await this.syncRoutes()
    // 先优雅停（把未落盘的写入写完），再用快照覆盖 —— 顺序反了就会拿旧数据
    // 盖掉刚写完的新数据。
    await this.orchestrator.stopInstance(machineName(row.slug))

    // A stopped container retains its old mounts. Never allow it to restart against
    // data being replaced, even if copying or committing the restored version fails.
    await this.orchestrator.removeInstance(machineName(row.slug))
    await this.dataStore.restoreSnapshot(row.storageKey)

    const updated = await updateInstance(this.db, row.id, {
      image: previousImage,
      previousImage: null,
      containerId: null,
      status: 'stopped',
    })
    if (updated === undefined) throw new Error(`实例不存在：${id}`)

    const result = rebuild ? await this.restartUnlocked(id) : updated
    await this.dataStore.finishRestore(row.storageKey)
    return result
  }

  /**
   * 目标镜像准入。四道：引用合法 → 是我们自己的仓库 → 用户可选范围 → 拿得到（catalog ∪ 宿主）。
   *
   * 「拿得到」不再要求**宿主上已有**（D23）：catalog 里有就放行，真正用到时 `ensureImage`
   * 会拉下来。放宽是为了 `setImage`——它先停容器、打快照才重建，若在重建那一步才发现
   * 镜像要现拉，窗口会拖到几分钟。校验阶段就让它失败，什么都没动。
   *
   * 用户面（`allowAny=false`）仍然只认「已发布 ∩ 宿主已有」：升级本来就要停容器打快照，
   * 再叠一次长 pull 会让停机窗口难以预期。**创建**是唯一例外（`requireLocal: false`）——
   * 它没有停机窗口，且本来就会自动拉。
   */
  private async assertImageAllowed(
    image: string,
    opts: { allowAny?: boolean; requireLocal?: boolean } = {},
  ): Promise<void> {
    const allowAny = opts.allowAny === true

    if (!ImageRefSchema.safeParse(image).success) {
      throw new ImageRejectedError(`镜像引用不合法：${image}`)
    }

    // 「哪个仓库是我们的」是配置，不再从默认版本推断（D22）——表空也判得出来。
    const platform = this.env.INSTANCE_IMAGE_REPO
    if (imageRepo(image) !== platform) {
      throw new ImageRejectedError(`只能换成平台的实例镜像（${platform}），收到 ${image}`)
    }

    // 仓库是公开的，任何 collaborator 都能推 `:latest` 之类的 tag——形状不对的直接挡在门外
    if (!isReleaseTag(image)) {
      throw new ImageRejectedError(`镜像 tag 不符合发布序列（<dsh版本>_<修订号>）：${image}`)
    }

    if (!allowAny && !(await isImageRelease(this.db, image))) {
      throw new ImageRejectedError(`${image} 不在平台提供的版本列表里`)
    }

    if (opts.requireLocal === false) return

    // 运行时若报不了本地镜像（`canReportLocalImages` 为 false），跳过这一关：
    // 把「不给信息」当成「本地没有」会让升级永远被拒。真正用到时创建那一步会自己拉。
    if (!this.orchestrator.canReportLocalImages) return

    const local = await this.orchestrator.listImageTags()
    if (local.includes(image)) return

    if (allowAny && (await isImageInCatalog(this.db, image))) return
    // 用户看得到这句：说"平台侧暂时不可用"就够，"宿主上没有"是我们的实现细节
    throw new ImageRejectedError(`这一版在平台侧暂时不可用：${image}`)
  }

  private specOf(row: InstanceRow): InstanceSpec {
    return InstanceSpecSchema.parse({
      slug: row.slug,
      image: row.image,
      quota: {
        cpus: row.cpus,
        memoryMb: row.memoryMb,
        pidsLimit: row.pidsLimit,
        diskMb: row.diskMb,
      },
      env: {},
    })
  }

  /**
   * 失败收尾：记下原因 → **重新投影一次路由** → 原样抛出。
   *
   * 重新投影是必须的：`remove` 的第一步就是「先摘路由再删容器」，失败发生在后面几步时
   * 路由已经被摘掉，而此刻容器可能还好好地跑着。投影的判据是**容器事实**
   * （见 `routableInstanceSlugs`），不补这一下就再也没有人来把它加回去——
   * 页面表现为「实例打不开了」，真实原因却是「上一次操作失败了」。
   */
  private async failWith(id: string, err: unknown): Promise<never> {
    await updateInstance(this.db, id, { status: 'error', lastError: messageOf(err) })
    // 投影本身失败不能盖掉原始错误
    await this.syncRoutes().catch(() => undefined)
    throw err
  }

  private async applyRuntime(
    row: InstanceRow,
    opts: { createData?: boolean } = {},
  ): Promise<InstanceRow> {
    const spec = this.specOf(row)

    // ★ 唯一的收口点：**先有数据，再有实例**。
    // 数据目录没就位就直接抛，实例标 error——绝不能建出一个指向空目录的实例：
    // 那样实例照常跑、UI 照常绿，用户看到的是「数据没了」（D18 的铁律）。
    // 只有建实例这条路允许「建」；其余一律只 ensure，缺了就报错。
    if (opts.createData === true) {
      await this.dataStore.create(row.storageKey, row.diskMb)
      // 用户默认只在卷第一次诞生时落下。restart / 换镜像 / 回滚走下面的 ensure，
      // 不读、不写 `.credentials.yaml`，所以工作区里改过的 Key 不会回写，也不会被盖掉。
      await this.seedOwnerModelCredentials(row)
    } else {
      await this.dataStore.ensure(row.storageKey)
    }

    // Download failures must not stop an otherwise usable workspace.
    await this.orchestrator.ensureImage(row.image)
    // Use the stable name even if an interrupted operation lost the recorded container ID.
    await this.orchestrator.stopInstance(machineName(row.slug))

    // 属主要跟数据一起就位：工作负载以固定非 root 跑（`INSTANCE_UID`），而数据目录是 root 建的
    // ——漏了这一步，实例照常起、入口照常响应，agent 跑到一半才写不了盘（**静默失败**）。
    // 幂等且判据是**目录的实际属主**，所以每次建容器都调；回滚把旧数据（root 属主）盖回来时，
    // 它自然会把那一份重新迁一遍。
    // chown 在凭据文件之后：脚本会扫到隐藏文件，把刚写入的 `.credentials.yaml` 改成 1000:1000。
    await this.dataStore.chown(row.storageKey)

    // 宿主端口：**已有就沿用**——重启不能换地址，否则 Traefik 的路由会指向别处。
    // 没有才分配，分配时会真探端口（不能只信 DB，见 port-allocator）。
    const hostPort = row.hostPort ?? (await this.allocateHostPort())

    const ctx: RenderContext = {
      // 用实例自己记录的 tag，不是平台的当前版本：升级是**按实例**的
      // （管理台显示的就是实际在跑的版本，可灰度、可回滚）。
      // 库里的默认版本只决定新建实例时记什么（D21）。
      baseImage: row.image,
      baseDomain: this.env.BASE_DOMAIN,
      gateToken: gateToken(row.slug, this.env.PLATFORM_SECRET),
      // 数据卷的名字。宿主路径、卷名、镜像落在哪都由运行时决定 —— 编排层只认这个 key。
      storageKey: row.storageKey,
      hostPort,
    }

    const runtime = await this.orchestrator.createInstance(spec, ctx)

    const updated = await updateInstance(this.db, row.id, {
      status: 'running',
      // 运行时侧标识。列名沿用它（DB 迁移另开一步），装的现在是机器名。
      containerId: runtime.machineName,
      hostPort,
      lastError: null,
    })
    await this.syncRoutes()
    return updated ?? row
  }

  /**
   * 有用户默认才渲染 YAML 并写入。没有默认就不创建文件，让用户稍后在工作区里自填。
   * 明文只活在这次调用的栈上，不进 lastError（渲染 / 解密失败的文案是固定的）。
   */
  private async seedOwnerModelCredentials(row: InstanceRow): Promise<void> {
    const refs = await readOwnerModelRefs(this.db, this.env.PLATFORM_SECRET, row.ownerId)
    if (Object.keys(refs).length === 0) return
    const yaml = renderCredentialsYaml(refs)
    await this.dataStore.seedCredentialsFileIfAbsent(row.storageKey, Buffer.from(yaml, 'utf8'))
  }

  /** 分配宿主回环端口。判据 = 「DB 里没占 且 宿主上真的空闲」。 */
  private allocateHostPort(): Promise<number> {
    return allocateHostPort({
      takenPorts: async () => {
        const rows = await listAllInstances(this.db)
        return new Set(
          rows.map((r) => r.hostPort).filter((p): p is number => p !== null && p !== undefined),
        )
      },
    })
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
