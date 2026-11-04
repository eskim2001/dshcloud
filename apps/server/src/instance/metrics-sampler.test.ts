import { describe, expect, it, vi } from 'vitest'
import type { NewMetric } from '../db/metric-repo.js'
import type { InstanceRow } from '../db/schema.js'
import { sampleOnce, type SamplerDeps } from './metrics-sampler.js'

function row(slug: string, over: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: `i-${slug}`,
    storageKey: slug,
    deletedAt: null,
    slug,
    ownerId: 'u1',
    status: 'running',
    image: 'dsh-instance:0.1.0',
    previousImage: null,
    containerId: `c-${slug}`,
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

function build(over: Partial<SamplerDeps> = {}) {
  const insert = vi.fn(async (_m: NewMetric) => undefined)
  const warn = vi.fn()
  const deps: SamplerDeps = {
    listRunning: async () => [row('alice')],
    stats: async () => ({ cpuPercent: 12.5, memMb: 200 }),
    disk: async () => ({ usedMb: 42 }),
    insert,
    deleteBefore: async () => 0,
    warn,
    ...over,
  }
  return { deps, insert, warn }
}

describe('sampleOnce', () => {
  it('给每个运行中的实例写一条采样', async () => {
    const { deps, insert } = build({
      listRunning: async () => [row('alice'), row('bob')],
    })
    await sampleOnce(deps)
    expect(insert).toHaveBeenCalledTimes(2)
    expect(insert).toHaveBeenCalledWith({
      instanceId: 'i-alice',
      cpuPercent: 12.5,
      memMb: 200,
      diskUsedMb: 42,
    })
  })

  it('磁盘读不到 → 写 0，但采样照记', async () => {
    const { deps, insert } = build({ disk: async () => undefined })
    await sampleOnce(deps)
    expect(insert).toHaveBeenCalledWith({
      instanceId: 'i-alice',
      cpuPercent: 12.5,
      memMb: 200,
      diskUsedMb: 0,
    })
  })

  it('没有 containerId 的实例跳过（历史残留行）', async () => {
    const { deps, insert } = build({
      listRunning: async () => [row('alice', { containerId: null })],
    })
    await sampleOnce(deps)
    expect(insert).not.toHaveBeenCalled()
  })

  it('首帧没有差值 → 跳过，不写假的 0', async () => {
    const { deps, insert } = build({ stats: async () => undefined })
    await sampleOnce(deps)
    expect(insert).not.toHaveBeenCalled()
  })

  it('一个实例失败只告警，不影响其他实例', async () => {
    const { deps, insert, warn } = build({
      listRunning: async () => [row('alice'), row('bob')],
      stats: async (id) => {
        if (id === 'c-alice') throw new Error('容器没了')
        return { cpuPercent: 1, memMb: 10 }
      },
    })
    await sampleOnce(deps)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledWith({
      instanceId: 'i-bob',
      cpuPercent: 1,
      memMb: 10,
      diskUsedMb: 42,
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('alice')
  })
})
