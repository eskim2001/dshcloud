/**
 * 空闲回收：选中「该停」的 running 实例。
 *
 * 抽纯函数是为了单测能钉死阈值，不绑定时器 / provisioner。
 * `idleMinutes <= 0` 表示功能关闭（与 env `PLATFORM_IDLE_CULL_MINUTES=0` 对齐）。
 */
export interface IdleCullCandidate {
  id: string
  slug: string
  status: string
  lastActiveAt: Date | null
}

export function selectIdleRunningInstances(
  instances: readonly IdleCullCandidate[],
  opts: { idleMinutes: number; now?: Date },
): { id: string; slug: string }[] {
  if (opts.idleMinutes <= 0) return []
  const cutoff = (opts.now ?? new Date()).getTime() - opts.idleMinutes * 60_000
  return instances
    .filter(
      (row) =>
        row.status === 'running' &&
        row.lastActiveAt !== null &&
        row.lastActiveAt.getTime() < cutoff,
    )
    .map((row) => ({ id: row.id, slug: row.slug }))
}
