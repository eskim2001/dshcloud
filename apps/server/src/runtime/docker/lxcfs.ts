import { stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 宿主上 lxcfs 的挂载点（FUSE）。控制面要**看见**它才探得到 —— 见 `docker/compose/prod.yml`
 * 里那条同路径只读挂载。宿主没装 lxcfs 时那个位置是 Docker 建出来的空目录，探测因此缺席。
 */
export const LXCFS_ROOT = '/var/lib/lxcfs'

/**
 * 逐个文件量过、**真的**盖住了宿主值的三个（2026-09-15 真机，2026-09-16 复量，挂/不挂各读一次对比）：
 *
 * | 文件 | 挂上之后 |
 * |---|---|
 * | `meminfo` | `MemTotal` = 容器的 cgroup `memory.max`（宿主 8G → 容器 2G） |
 * | `uptime` | 容器自己的运行时长（宿主 53 万秒 → 容器 0.1 秒） |
 * | `swaps` | 藏掉宿主的交换设备名与已用量（`/dev/vda2 … 780` → `none virtual … 0`） |
 *
 * **没列进来的都是量过"透传宿主值"的**，挂了等于没挂，别因为"lxcfs 提供了"就挂上：
 * `stat`（连 `btime` 一起透传 —— 宿主开机时刻因此**仍然可读**）、`diskstats`、`slabinfo`
 * （实测宿主 213 行 slab 原样透出）、`loadavg`（负载没有命名空间）、`cpuinfo`
 * （按 **cpuset** 假，而我们的配额走 `NanoCpus`、没设 cpuset，所以照旧报宿主核数和 CPU 型号）。
 * 实测表在 [SECURITY-HARDENING](../../../../docs/SECURITY-HARDENING.md)。
 *
 * 另外**挂了也绕得开**：直接调 `sysinfo(2)` 的程序（busybox 的 `free` 之类）不读这些文件，
 * 实测返回宿主的物理内存与运行时。这套是"降低可读性"，不是边界。
 */
export const LXCFS_FILES = ['meminfo', 'uptime', 'swaps'] as const

/**
 * 宿主装没装 lxcfs：探一次 `proc/meminfo` 在不在。
 *
 * **任何错误都当没有**（缺目录、权限、FUSE 没起来都算）—— 缺席是**常态**，没装的宿主上
 * 这里必须静默返回 `null`，实例容器照常起来，只是不挂这几个文件。
 * 探测只在**控制面启动时做一次**：装完 lxcfs 要重启控制面才生效。
 */
export async function detectLxcfsProc(root: string = LXCFS_ROOT): Promise<string | null> {
  const dir = join(root, 'proc')
  try {
    await stat(join(dir, 'meminfo'))
    return dir
  } catch {
    return null
  }
}
