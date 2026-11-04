import { describe, expect, it, vi } from 'vitest'
import { createActivityToucher } from './activity.js'

describe('createActivityToucher', () => {
  it('节流窗口内只写一次', async () => {
    const write = vi.fn(async () => undefined)
    const touch = createActivityToucher(write, { throttleMs: 60_000 })
    touch('i-1')
    touch('i-1')
    touch('i-1')
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('i-1', expect.any(Date))
  })

  it('不同实例互不节流', async () => {
    const write = vi.fn(async () => undefined)
    const touch = createActivityToucher(write, { throttleMs: 60_000 })
    touch('a')
    touch('b')
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(2)
  })
})
