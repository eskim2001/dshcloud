import { BRIDGE_PORT, DATA_ROOT, GATE_TOKEN_HEADER } from '../constants.js'
import type { InstanceSpec } from '../schema.js'
import type {
  InstanceRenderer,
  RenderedInstance,
  RenderedMount,
  RenderContext,
} from './types.js'

/**
 * 实例机器名的前缀。
 *
 * 运行时那边列的是**宿主上所有**实例，有前缀才能一眼认出哪些是本平台的，
 * 也给清理/对账一个判据。
 */
export const MACHINE_PREFIX = 'dsh-instance-'
export const machineName = (slug: string): string => `${MACHINE_PREFIX}${slug}`
export const instanceHostname = (slug: string, baseDomain: string): string => `${slug}.${baseDomain}`

/**
 * 每实例一个网络的名字（**由 slug 派生，一个 slug 恰好一个网络**）。
 *
 * 共享一个广播域就等于没隔离：同网段容器能直连邻居的端口、能扫、也能 ARP 欺骗，
 * 而桥上转发的是明文（TLS 在入口就终结了）。所以实例各占一个网络，见 D37。
 *
 * 前缀与 `MACHINE_PREFIX` 同理：宿主上还有别的容器，得能一眼认出哪些是本平台的。
 */
export const NETWORK_PREFIX = 'dsh-net-'
export const networkName = (slug: string): string => `${NETWORK_PREFIX}${slug}`

/** 容器内环境：所有可写路径都指向 `/data`。 */
function renderEnv(spec: InstanceSpec, ctx: RenderContext): string[] {
  return [
    `DSH_HOME=${DATA_ROOT}`,
    `HOME=${DATA_ROOT}/home`,
    // agent 装的全局包也要落进卷，否则升级/重建就丢
    `NPM_CONFIG_PREFIX=${DATA_ROOT}/.npm-global`,
    `NPM_CONFIG_CACHE=${DATA_ROOT}/.npm`,
    `PNPM_HOME=${DATA_ROOT}/.pnpm`,
    `PNPM_STORE_DIR=${DATA_ROOT}/.pnpm-store`,
    `COREPACK_HOME=${DATA_ROOT}/.corepack`,
    `PATH=${DATA_ROOT}/.npm-global/bin:${DATA_ROOT}/.pnpm:/usr/local/bin:/usr/bin:/bin`,
    // Caddy 需要可写目录；**必须显式传** —— Caddyfile 里
    // `@no_gate not header {$DSH_GATE_HEADER} {$DSH_GATE_TOKEN}` 在变量为空时会
    // 展开成 `not header`（参数缺失）→ 配置加载失败 → caddy 直接退出；
    // entrypoint 两个进程都盯着（任一退出就停容器），所以症状是容器起不来，不是静默坏。
    `XDG_DATA_HOME=${DATA_ROOT}/.caddy/data`,
    `XDG_CONFIG_HOME=${DATA_ROOT}/.caddy/config`,
    `DSH_TRUSTED_HOSTS=${instanceHostname(spec.slug, ctx.baseDomain)}`,
    `DSH_GATE_HEADER=${GATE_TOKEN_HEADER}`,
    `DSH_GATE_TOKEN=${ctx.gateToken}`,
    `DSH_GATE_INSTANCE=${spec.slug}`,
    ...Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
  ]
}

/**
 * 把实例规格渲染成一份**运行时中立**的机器定义。
 *
 * 中立到什么程度：这里不认识具体运行时 —— 挂载、端口、用户、容量都是通用概念，
 * 由 driver 翻成自己的参数。数据卷在驱动那边是 Docker 命名卷，在这里只是一个不透明的 key。
 *
 * 关键设计（见 docs/ARCHITECTURE.md §四）：
 * - **`/data` 必须活得过升级**：升级走「删掉重建」，容器一定重造，只有平台侧的数据卷
 *   才活得过去。这份约束换运行时也不变。
 * - **不能用宿主目录直挂**：直挂走 Docker Desktop 的 VM 共享文件系统，那个后端有硬链接
 *   语义问题（上游 #1559）——unlink 掉两个名字中的一个，剩下的那个会永久只读，而 dsh 的
 *   会话日志每次落盘都会踩到。命名卷是 VM 里的真文件系统，没有这个问题。
 * - **容量 = `quota.diskMb`**，只是**声明值**（记进卷的 label）；Docker 命名卷没有硬配额，
 *   真正的上限要宿主侧文件系统配额，而且都**不能原地扩容**。
 * - **运行用户 = root**（`'0'`）：卷的根目录归 root，声明式属主映射对命名卷无效。
 * - **WORKDIR = 挂载点本身**（`/data`）：空卷里还没有 `/data/home/workspace` 那层骨架，
 *   而 `/data` 作为挂载点在容器起来时一定存在 —— 那层骨架归镜像的 entrypoint 建，建完再 cd 进去。
 */
export function renderInstance(spec: InstanceSpec, ctx: RenderContext): RenderedInstance {
  const { slug, quota } = spec

  const mounts: RenderedMount[] = [
    {
      storageKey: ctx.storageKey,
      guest: DATA_ROOT,
      mode: 'rw',
      sizeMb: quota.diskMb,
    },
  ]

  return {
    slug,
    machineName: machineName(slug),
    hostname: instanceHostname(slug, ctx.baseDomain),
    image: ctx.baseImage,
    user: '0',
    workingDir: DATA_ROOT,
    env: renderEnv(spec, ctx),
    guestPort: BRIDGE_PORT,
    hostPort: ctx.hostPort,
    guestDataDir: DATA_ROOT,
    // 资源上限属于"机器定义"：驱动照着建就行，别让它再回去翻 spec（那样漏一个字段就是静默失效）
    cpus: quota.cpus,
    memoryMb: quota.memoryMb,
    pidsLimit: quota.pidsLimit,
    mounts,
    labels: {
      'dsh.cloud/instance': slug,
      'dsh.cloud/managed': 'true',
    },
  }
}

export const instanceRenderer: InstanceRenderer = {
  runtime: 'instance',
  render: renderInstance,
}
