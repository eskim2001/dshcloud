import { describe, expect, it } from 'vitest'
import { selectIdleRunningInstances } from './idle-cull.js'

const now = new Date('2026-01-01T12:00:00.000Z')

function row(
  over: Partial<{ id: string; slug: string; status: string; lastActiveAt: Date | null }> = {},
) {
  return {
    id: 'i-1',
    slug: 'alice',
    status: 'running',
    lastActiveAt: new Date('2026-01-01T10:00:00.000Z'),
    ...over,
  }
}

describe('selectIdleRunningInstances', () => {
  it('idleMinutes=0 → 关闭，不选中任何人', () => {
    expect(selectIdleRunningInstances([row()], { idleMinutes: 0, now })).toEqual([])
  })

  it('只选 running 且 lastActiveAt 早于 cutoff 的', () => {
    const idle = row({ id: 'old', slug: 'old', lastActiveAt: new Date('2026-01-01T10:00:00.000Z') })
    const fresh = row({
      id: 'fresh',
      slug: 'fresh',
      lastActiveAt: new Date('2026-01-01T11:30:00.000Z'),
    })
    const stopped = row({
      id: 'stopped',
      slug: 'stopped',
      status: 'stopped',
      lastActiveAt: new Date('2026-01-01T09:00:00.000Z'),
    })
    const missing = row({ id: 'null', slug: 'null', lastActiveAt: null })

    // 45 分钟：cutoff = 11:15；old(10:00) 中，fresh(11:30) 不中
    expect(selectIdleRunningInstances([idle, fresh, stopped, missing], { idleMinutes: 45, now })).toEqual([
      { id: 'old', slug: 'old' },
    ])
  })
})
