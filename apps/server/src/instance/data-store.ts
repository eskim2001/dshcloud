import { INSTANCE_GID, INSTANCE_UID } from '@dsh-cloud/instance-spec'
import type { RuntimeDriver } from '../runtime/driver.js'

export interface DataStoreOptions {
  /**
   * 数据卷的原语在运行时驱动上：**卷是运行时的概念** —— 宿主路径、卷名、镜像落在哪，
   * 全由它决定。这个类只留**策略**：绝不静默覆盖、快照只够用一次、快照怎么命名。
   */
  driver: RuntimeDriver
}

/** 磁盘用量。 */
export interface DataUsage {
  usedMb: number
}

/** 用量 + 容量 + **这个容量到底管不管用**，给管理台/详情页展示用。 */
export interface DiskUsage {
  usedMb: number
  quotaMb: number
  /**
   * 这份配额**真的在生效**吗。
   *
   * `false` = 只有声明值（开发机内核不支持，或是池化之前建的命名卷实例）。
   * **UI 必须如实呈现** —— 显示一个其实没生效的上限比不显示更糟。
   */
  enforced: boolean
}

/**
 * 实例数据的生命周期与策略。
 *
 * 这里只决定数据生命周期，不解释宿主路径。生产驱动使用带 XFS 配额的目录，
 * Docker Desktop 开发环境使用命名卷；两者都必须拒绝覆盖已有的复制目标。
 */
export class DataStore {
  private readonly driver: RuntimeDriver

  constructor(opts: DataStoreOptions) {
    this.driver = opts.driver
  }

  /** 快照卷的 key。回滚只够用一次，用过就删（与 D19 同语义）。 */
  snapshotKey(storageKey: string): string {
    return `${storageKey}.prev`
  }

  recoveryKey(storageKey: string): string {
    return `${storageKey}.recovery`
  }

  /**
   * 首次开通：建数据卷。
   *
   * **卷已存在就抛**（驱动抛 `StorageExistsError`）—— 这是本模块最重要的一条，继承自
   * D18：静默复用会把「这块卷里已经有别人的数据」伪装成「一切正常」，比报错糟得多。
   * 新建只走这里。
   */
  async create(storageKey: string, sizeMb: number): Promise<void> {
    await this.driver.createStorage(storageKey, sizeMb)
  }

  /** 幂等确保数据卷在。**绝不新建** —— 卷不见了就抛错，让上层看见。 */
  async ensure(storageKey: string): Promise<void> {
    await this.driver.ensureStorage(storageKey)
  }

  /**
   * 把这一份数据的属主递归改成平台固定的运行用户。
   *
   * **必须在起容器之前调**：工作负载以非 root 跑（`INSTANCE_UID`），而数据目录是 root 建的
   * —— 属主不对，实例照常起、入口照常响应，agent 跑到一半才写不了盘。容器内补不了这一步
   * （`CapDrop: ALL` 下 `su` / `setpriv` 全是 `EPERM`，见 D29）。
   *
   * 幂等，且判据是**目录的实际属主**而不是库里的状态：回滚会把升级前的旧数据（root 属主）
   * 盖回来，那时必须重新迁一遍。
   */
  async chown(storageKey: string): Promise<void> {
    await this.driver.chownStorage(storageKey, INSTANCE_UID, INSTANCE_GID)
  }

  /**
   * 新建卷之后、chown 之前：凭据文件不存在才写。
   * 不提供读 `.credentials.yaml` 的方法——工作区里改过的 Key 不能被控制面读回来。
   */
  async seedCredentialsFileIfAbsent(storageKey: string, contents: Buffer): Promise<boolean> {
    return this.driver.seedCredentialsFileIfAbsent(storageKey, contents)
  }

  /**
   * 用量。只用于**展示**。命名卷**没有硬配额**，真正的写上限要宿主侧文件系统配额
   * （XFS project quota，见 `DockerDriver.createStorage`）来兜。**停机时也读得到** ——
   * 卷不依赖容器在跑。
   */
  async usage(storageKey: string): Promise<DataUsage | undefined> {
    const usedMb = await this.driver.storageUsageMb(storageKey)
    return usedMb === undefined ? undefined : { usedMb }
  }

  /** 这个 key 的数据**实际**有没有硬配额（`false` = 命名卷：开发机，或池化之前建的实例）。 */
  async enforced(storageKey: string): Promise<boolean> {
    return await this.driver.storageEnforced(storageKey)
  }

  /**
   * 一次读所有实例的用量（key → MiB）。列表页每行都要显示磁盘，逐行读就是 N 次调用。
   * **拿不到返回 `undefined`**（命名卷退路）—— 调用方据此显示"暂无数据"，别编一个 0。
   */
  async usageAll(): Promise<Map<string, number> | undefined> {
    return await this.driver.storageUsageAll()
  }

  /**
   * 回滚快照（`.prev`）的占用。没有快照时返回 `undefined`。
   *
   * 管理台用它显示「有一份可回滚的数据，占多少」—— 回滚只有一次机会，
   * 用户要能看见这份保险还在不在、值不值得留。
   */
  async snapshotUsage(storageKey: string): Promise<DataUsage | undefined> {
    return this.usage(this.snapshotKey(storageKey))
  }

  /**
   * 把当前数据整卷复制一份到 `.prev`（升级/回退的唯一保险）。
   *
   * 先删掉可能存在的旧快照再复制：`copyStorage` 对已存在的目标是**拒绝**的，
   * 正好逼着我们把这个决定写出来，而不是让它悄悄覆盖。
   *
   * 代价注意：从前 `.prev` 与活数据同目录，改名/硬链接就能当快照；现在两卷之间是
   * 整卷 `cp -a`（辅助容器里做），复制的是全量数据。
   */
  async snapshot(storageKey: string): Promise<void> {
    await this.driver.removeStorage(this.snapshotKey(storageKey))
    await this.driver.copyStorage(storageKey, this.snapshotKey(storageKey))
  }

  /** 用 `.prev` 覆盖当前数据。回滚路径专用。 */
  async restoreSnapshot(storageKey: string): Promise<void> {
    // A missing or invalid backup must never cause deletion of the remaining live data.
    await this.driver.ensureStorage(this.snapshotKey(storageKey))
    // Preserve current data before any destructive step. An existing recovery copy blocks
    // retries rather than overwriting evidence from an interrupted operation.
    await this.driver.copyStorage(storageKey, this.recoveryKey(storageKey))
    await this.driver.removeStorage(storageKey)
    await this.driver.copyStorage(this.snapshotKey(storageKey), storageKey)
  }

  /** Only after the database and requested runtime state have both been restored. */
  async finishRestore(storageKey: string): Promise<void> {
    await this.driver.removeStorage(this.recoveryKey(storageKey))
  }

  /** 丢掉 `.prev`。回滚只够用一次，用过就清（与 D19 同语义）。 */
  async dropSnapshot(storageKey: string): Promise<void> {
    await this.driver.removeStorage(this.snapshotKey(storageKey))
  }

  /** 彻底删除数据（含升级快照）。**不可逆** —— 删实例时调，没有第二条路（D31）。 */
  async destroy(storageKey: string): Promise<void> {
    await this.driver.removeStorage(storageKey)
    await this.driver.removeStorage(this.snapshotKey(storageKey))
    await this.driver.removeStorage(this.recoveryKey(storageKey))
  }
}
