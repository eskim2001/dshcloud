/**
 * 工作空间「最近活跃」触摸。
 *
 * forward-auth / gateway 每个请求都会成功放行一次——若每次写库，磁盘与 DB
 * 会被打爆。内存节流：同一实例 ≥ `throttleMs` 才真正落库；失败则忘掉节流，
 * 好让下一次请求重试。
 */
export function createActivityToucher(
  write: (instanceId: string, at: Date) => Promise<void>,
  opts: { throttleMs?: number } = {},
): (instanceId: string) => void {
  const throttleMs = opts.throttleMs ?? 60_000
  const lastWrite = new Map<string, number>()

  return (instanceId: string): void => {
    const now = Date.now()
    const prev = lastWrite.get(instanceId) ?? 0
    if (now - prev < throttleMs) return
    lastWrite.set(instanceId, now)
    void write(instanceId, new Date(now)).catch(() => {
      lastWrite.delete(instanceId)
    })
  }
}
