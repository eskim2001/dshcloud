import { describe, expect, it, vi } from 'vitest'
import type { InstancePatch } from '../db/instance-repo.js'
import type { InstanceRow } from '../db/schema.js'
import { reconcileInstances } from './reconciler.js'
import { lifecycleOperations } from './operation-queue.js'

function row(over: Partial<InstanceRow> & { slug: string }): InstanceRow {
  return {
    id: `i-${over.slug}`,
    storageKey: over.slug,
    deletedAt: null,
    ownerId: 'u1',
    status: 'running',
    image: 'dsh-instance:0.1.0',
    previousImage: null,
    containerId: `c-${over.slug}`,
    hostPort: null,
    cpus: 1,
    memoryMb: 2048,
    pidsLimit: 512,
    diskMb: 10_240,
    lastError: null,
    stoppedAt: null,
    lastActiveAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }
}

/** `containerStatus: null` = 容器已经不在（`undefined` 会被默认参数吃掉，所以用 null）。 */
function build(rows: InstanceRow[], containerStatus: string | null = 'running') {
  const update = vi.fn(async (_id: string, _patch: InstancePatch) => undefined)
  const warn = vi.fn()
  const inspectStatus = vi.fn(async () => containerStatus ?? undefined)
  return {
    update,
    warn,
    inspectStatus,
    run: () =>
      reconcileInstances({
        listInstances: async () => rows,
        inspectStatus,
        update,
        listInstanceNames: async () => [],
        warn,
      }),
  }
}

describe('对账：DB 状态 ↔ Docker 事实', () => {
  it('reads state only after an in-flight lifecycle operation has finished', async () => {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    let current = row({ slug: 'alice', status: 'stopped' })
    const operation = lifecycleOperations.run(async () => {
      entered()
      await barrier
      current = { ...current, status: 'error' }
    })
    await started
    const listInstances = vi.fn(async () => [current])
    const inspectStatus = vi.fn(async () => 'running')
    const update = vi.fn(async () => undefined)
    const reconciliation = reconcileInstances({
      listInstances, inspectStatus, update,
      listInstanceNames: async () => [], warn: vi.fn(),
    })
    try {
      await Promise.resolve()
      expect(listInstances).not.toHaveBeenCalled()
    } finally { release(); await operation }
    expect(await reconciliation).toEqual({ changed: 0 })
    expect(inspectStatus).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
  it('容器已退出但 DB 还写 running → 改成 stopped', async () => {
    const { run, update } = build([row({ slug: 'alice' })], 'exited')
    const { changed } = await run()
    expect(changed).toBe(1)
    expect(update).toHaveBeenCalledWith('i-alice', { status: 'stopped' })
  })

  it('容器在跑但 DB 写 stopped（宿主重启后 unless-stopped 拉起）→ 改成 running', async () => {
    const { run, update } = build([row({ slug: 'alice', status: 'stopped' })], 'running')
    await run()
    expect(update).toHaveBeenCalledWith('i-alice', { status: 'running', lastError: null })
  })

  it('两边一致时一个写都不发', async () => {
    const { run, update } = build([row({ slug: 'alice' })], 'running')
    const { changed } = await run()
    expect(changed).toBe(0)
    expect(update).not.toHaveBeenCalled()
  })

  it('容器不见了 → stopped 并清掉 containerId（下次 start 直接重建）', async () => {
    const { run, update } = build([row({ slug: 'alice' })], null)
    await run()
    expect(update).toHaveBeenCalledWith('i-alice', { status: 'stopped', containerId: null })
  })

  it('restarting 算活着，不误判成停止', async () => {
    // crash-loop 的容器会停在 restarting，这一档要算活着。
    const { run, update } = build([row({ slug: 'alice' })], 'restarting')
    await run()
    expect(update).not.toHaveBeenCalled()
  })

  it('编排进行中的实例不插手', async () => {
    const rows = [
      row({ slug: 'alice', status: 'provisioning' }),
      row({ slug: 'bob', status: 'removing' }),
    ]
    const { run, update, inspectStatus } = build(rows, 'exited')
    await run()
    expect(inspectStatus).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('error 状态不动——用户要靠它看到失败原因', async () => {
    const { run, update } = build([row({ slug: 'alice', status: 'error' })], 'exited')
    await run()
    expect(update).not.toHaveBeenCalled()
  })

  it('查不动只告警，不瞎写状态', async () => {
    const update = vi.fn(async () => undefined)
    const warn = vi.fn()
    const { changed } = await reconcileInstances({
      listInstances: async () => [row({ slug: 'alice' })],
      inspectStatus: async () => {
        throw new Error('docker 挂了')
      },
      update,
      listInstanceNames: async () => [],
      warn,
    })
    expect(changed).toBe(0)
    expect(update).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('孤儿容器只告警不删', async () => {
    const warn = vi.fn()
    await reconcileInstances({
      listInstances: async () => [row({ slug: 'alice' })],
      inspectStatus: async () => 'running',
      update: async () => undefined,
      listInstanceNames: async () => ['dsh-instance-alice', 'dsh-instance-ghost'],
      warn,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('dsh-instance-ghost')
  })
})
