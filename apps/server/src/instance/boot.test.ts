import { describe, expect, it, vi } from 'vitest'
import type { InstanceRow } from '../db/schema.js'
import { bootInstances } from './boot.js'

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

function build(rows: InstanceRow[], over: Partial<Parameters<typeof bootInstances>[0]> = {}) {
  const events: string[] = []
  const markError = vi.fn(async (id: string, _message: string) => {
    events.push(`error:${id}`)
  })
  const warn = vi.fn()
  const deps = {
    listInstances: async () => rows,
    ensure: async (slug: string) => {
      events.push(`ensure:${slug}`)
    },
    start: async (id: string) => {
      events.push(`start:${id}`)
    },
    markError,
    warn,
    ...over,
  }
  return { deps, events, markError, warn }
}

describe('启动恢复：先校验数据，再拉起实例', () => {
  it('mounts the stored data identity rather than the public slug', async () => {
    const { deps, events } = build([row({ slug: 'alice', storageKey: 'unique-data-key' })])
    await bootInstances(deps)
    expect(events).toEqual(['ensure:unique-data-key', 'start:i-alice'])
  })

  it('所有挂载都排在所有启动之前（容器不能先于挂载起来）', async () => {
    const { deps, events } = build([row({ slug: 'alice' }), row({ slug: 'bob' })])
    await bootInstances(deps)

    expect(events).toEqual([
      'ensure:alice',
      'ensure:bob',
      'start:i-alice',
      'start:i-bob',
    ])
  })

  it('挂载失败 → 标 error 并**跳过启动**（宁可显式坏掉，也不给空数据）', async () => {
    const { deps, events, markError, warn } = build([row({ slug: 'alice' })], {
      ensure: async () => {
        throw new Error('数据文件不存在')
      },
    })
    await bootInstances(deps)

    expect(events).toEqual(['error:i-alice'])
    expect(markError).toHaveBeenCalledWith(
      'i-alice',
      '数据目录不可用：数据文件不存在',
    )
    expect(warn).toHaveBeenCalled()
  })

  it('一个实例挂不上不影响其他实例', async () => {
    const { deps, events } = build([row({ slug: 'alice' }), row({ slug: 'bob' })], {
      ensure: async (slug) => {
        if (slug === 'alice') throw new Error('坏了')
        events.push(`ensure:${slug}`)
      },
    })
    await bootInstances(deps)

    expect(events).toEqual(['error:i-alice', 'ensure:bob', 'start:i-bob'])
  })

  it('非 running 的实例只挂载、不启动（恢复的是「用户想要的运行状态」）', async () => {
    const { deps, events } = build([
      row({ slug: 'alice' }),
      row({ slug: 'bob', status: 'stopped' }),
      row({ slug: 'carol', status: 'error' }),
    ])
    await bootInstances(deps)

    expect(events).toEqual(['ensure:alice', 'ensure:bob', 'ensure:carol', 'start:i-alice'])
  })

  it('启动失败 → 标 error 并告警，不往上抛（一个实例坏了不该拖垮启动流程）', async () => {
    const { deps, markError, warn } = build([row({ slug: 'alice' })], {
      start: async () => {
        throw new Error('镜像不见了')
      },
    })
    await expect(bootInstances(deps)).resolves.toBeUndefined()

    expect(markError).toHaveBeenCalledWith('i-alice', '镜像不见了')
    expect(warn).toHaveBeenCalled()
  })

  it('没有实例时什么都不做', async () => {
    const { deps, events } = build([])
    await bootInstances(deps)
    expect(events).toEqual([])
  })

  it('停在 provisioning 的行判死并跳过（进程在创建中途崩掉留下的僵尸行）', async () => {
    const { deps, events, markError, warn } = build([
      row({ slug: 'alice' }),
      row({ slug: 'zombie', status: 'provisioning', containerId: null }),
    ])
    await bootInstances(deps)

    // 判死排在挂载之前，且僵尸行不参与挂载/启动——没人管它才是问题
    expect(events).toEqual(['error:i-zombie', 'ensure:alice', 'start:i-alice'])
    expect(markError).toHaveBeenCalledWith('i-zombie', expect.stringContaining('请先检查数据、快照和恢复副本'))
    expect(warn).toHaveBeenCalled()
  })

  it('preserves interrupted removal without mounting or starting its remaining data', async () => {
    const { deps, events, markError } = build([
      row({ slug: 'removing', status: 'removing' }), row({ slug: 'healthy' }),
    ])
    await bootInstances(deps)
    expect(events).toEqual(['error:i-removing', 'ensure:healthy', 'start:i-healthy'])
    expect(markError).toHaveBeenCalledWith('i-removing', expect.stringContaining('removing'))
  })
})
