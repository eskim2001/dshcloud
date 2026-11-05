import type { Readable } from 'node:stream'
import type { InstanceSpec, RenderedInstance, RenderContext } from '@dsh-cloud/instance-spec'

/** 实例此刻的真实状态。`state` 是运行时归一化后的枚举，`statusText` 是它的原文。 */
export interface InstanceLiveState {
  /** running / stopped / created / restarting / dead / unknown */
  state: string
  /** 人类可读，例如 `running (pid 12345)`。 */
  statusText: string
}

/**
 * 一份用量采样。字段与 `instance/container-stats.ts` 的 `ContainerUsage` 对齐，
 * 这样 HTTP 层不用为两个运行时写两套。
 */
export interface InstanceUsage {
  /** 100 = 用满一个核；多核实例可以超过 100。 */
  cpuPercent: number
  memMb: number
}

/**
 * 建数据卷时同名卷已经存在。
 *
 * **必须当错误，不能静默复用** —— 复用会把「这块卷里已经有别人的数据」伪装成「新建成功」，
 * 正是 D18 要防的那种失败。D18 原本靠「宿主目录存在且非空就拒绝」实现，换成数据卷之后
 * 这条就是它的等价物。
 */
export class StorageExistsError extends Error {}

/** 数据卷不存在。`ensureStorage` **绝不静默新建**：那会把「数据丢了」伪装成「一切正常」。 */
export class StorageNotFoundError extends Error {}

export class StorageIncompleteError extends Error {}

/**
 * 运行时驱动：**唯一**接触具体运行时的接缝。
 *
 * 换运行时只换这一层的实现，`provisioner`/`boot`/`reconciler` 这些业务代码不动。
 * 之前 `ARCHITECTURE.md` 声称 renderer 就是那个接缝——不成立：容器专有的东西
 * （网络、挂载、日志多路复用、状态枚举）全都漏在编排层里，所以这里把它收干净。
 */
export interface RuntimeDriver {
  readonly runtime: string

  // ---- 镜像 ----
  /**
   * 这个运行时能不能报告「宿主上本地有哪些镜像」。
   *
   * 为 `false` 时，准入逻辑**必须跳过**「本地是否有」这一关——否则会把「运行时不给这个信息」
   * 误判成「本地没有」，导致升级永远被拒。Docker 报得出来（恒为 `true`），这个开关留给
   * 未来可能报不了的运行时实现。
   */
  readonly canReportLocalImages: boolean
  ensureImage(ref: string): Promise<void>
  imageExists(ref: string): Promise<boolean>
  listImageTags(): Promise<string[]>
  openImagePull(ref: string): Promise<Readable>

  // ---- 生命周期 ----
  /** 幂等：同名已存在时先清掉再建。 */
  create(spec: InstanceSpec, ctx: RenderContext): Promise<RenderedInstance>
  start(machineName: string): Promise<void>
  /** **必须优雅**（如 Docker 的 SIGTERM 宽限）：给工作负载时间把会话落盘。禁止用删除/强杀代替。 */
  stop(machineName: string): Promise<void>
  /** 幂等：不存在时不报错，并清理该机器残留（孤儿进程、端口）。 */
  remove(machineName: string): Promise<void>

  // ---- 观测 ----
  /** `undefined` = 不存在（历史残留行）。**注意：不能只信运行时的自报状态**，见 `probeHealthy`。 */
  status(machineName: string): Promise<InstanceLiveState | undefined>
  /** 现存的实例机器名（含 DB 里没有的孤儿）。对账器用来发现漂移，不做删除。 */
  listInstanceNames(): Promise<string[]>
  /**
   * 探**服务本身**，不是探运行时状态。
   *
   * 容器 running 不等于服务在听（启动窗口里容器 running 而端口还没人接），
   * 所以必须真的去连入口端口。`hostPort` 由平台分配并落库，调用方传进来。
   */
  probeHealthy(machineName: string, hostPort: number): Promise<boolean>
  logs(machineName: string, tail: number): Promise<string>
  exec(machineName: string, argv: string[]): Promise<{ code: number; stdout: string }>
  stats(machineName: string): Promise<InstanceUsage | undefined>

  // ---- 数据卷 ----
  //
  // 实例数据是一块**运行时管理的卷**，不是宿主目录。宿主路径、卷名、镜像落在哪，
  // 都由运行时决定；业务层只认那个不透明的 `storageKey`。
  /**
   * 建数据卷。**同名已存在就抛 `StorageExistsError`**，绝不静默复用（见该类注释）。
   *
   * `sizeMb` 是**契约上的硬容量**（卷灌满就是 ENOSPC，不是「预算」）。⚠️ 但**当前实现给不了**：
   * Docker 命名卷没有配额，`diskMb` 现在只是声明值 —— 见 `DockerDriver.createStorage` 那段说明，
   * 以及 docs/RUNTIME-CONTAINER-EVAL.md 的落地状态。
   */
  createStorage(key: string, sizeMb: number): Promise<void>
  /** 确认数据卷在。不在就抛 `StorageNotFoundError`，**绝不新建**。 */
  ensureStorage(key: string): Promise<void>
  /**
   * 把这一份数据的属主**递归**改成 `uid:gid`。
   *
   * 为什么要平台侧来改：工作负载以固定非 root 跑（`INSTANCE_UID`），而数据目录是 root 建的
   * —— 属主不对，实例照常起、入口照常响应，agent 跑到一半才写不了盘（**静默失败**）。
   * 容器内降权做不到：`CapDrop: ALL` 下 `setpriv` / `su` / `gosu` 全是 `EPERM`（见 D29），
   * 所以只有在建容器时由运行时施加这一条路。
   *
   * **幂等，而且必须可重入**：回滚会把升级前的旧数据（root 属主）盖回来，那时必须重新迁一遍
   * —— 判据是目录的**实际属主**，不是库里的某条状态（记状态的那种做法在这里会骗人）。
   */
  chownStorage(key: string, uid: number, gid: number): Promise<void>
  /**
   * 仅在数据卷刚创建之后调用：`$DSH_HOME/.credentials.yaml` 不存在才写入。
   *
   * 已存在（含符号链接）就跳过，并且**不读内容**。这里没有对应的读接口——
   * 控制面不回读工作区里的模型 Key。权限 0600；属主靠紧接着的 `chownStorage`
   * 覆盖到这个文件（脚本会扫隐藏文件）。返回值只表示这次有没有写入。
   */
  seedCredentialsFileIfAbsent(key: string, contents: Buffer): Promise<boolean>
  /**
   * 仅在数据卷刚创建之后调用：`$DSH_HOME/profiles/web/cordis.patch.yml` 不存在才写入。
   *
   * 父目录不存在则创建。已存在（含符号链接）就跳过，并且**不读内容**。
   * 路径写死在这条原语上，不接受调用方指定别的相对路径，也不提供读接口。
   * 权限 0640；属主靠紧接着的 `chownStorage` 覆盖（脚本会扫到 `profiles/`）。
   * 返回值只表示这次有没有写入。
   */
  seedCordisPatchIfAbsent(key: string, contents: Buffer): Promise<boolean>
  /** 删掉这一块卷。幂等。**只删这一个 key** —— 快照卷是上层的事（见 `DataStore`）。 */
  removeStorage(key: string): Promise<void>
  /**
   * 改一个数据卷的容量上限（**扩容 / 缩容都走这里**）。
   *
   * 缩容是真实需求（用户把 quota 调小）。已用超了新上限时表现为"拒绝再写"、数据不丢 ——
   * 所以实现要允许"当前用量 > 新上限"这个中间状态，**不能**因此拒绝设置。
   */
  resizeStorage(key: string, sizeMb: number): Promise<void>
  /**
   * 这个 key 的数据**实际**有没有硬配额。`false` = 只有声明值（开发机，或池化之前建的实例）。
   *
   * UI 必须**如实**呈现它 —— 显示一个其实没生效的上限，比不显示更糟。
   */
  storageEnforced(key: string): Promise<boolean>
  /**
   * 一次读所有数据的用量（key → MiB）。**拿不到就返回 `undefined`**（命名卷退路），
   * 调用方据此显示"暂无数据"，而不是编一个 0。
   */
  storageUsageAll(): Promise<Map<string, number> | undefined>
  /** 已用容量（MiB）。**停机时也必须可读** —— 用量面板在实例没跑的时候也要有数。 */
  storageUsageMb(key: string): Promise<number | undefined>
  /**
   * 把一块卷整体复制成新卷（升级/回退的唯一保险）。
   * 目标已存在 → `StorageExistsError`；源不存在 → `StorageNotFoundError`。
   */
  copyStorage(fromKey: string, toKey: string): Promise<void>

  /** 回收孤儿进程 / 端口漂移。启动与每次对账时调。 */
  heal(): Promise<void>
}
