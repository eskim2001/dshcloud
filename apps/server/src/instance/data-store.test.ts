import { describe, expect, it, vi } from 'vitest'
import { DataStore } from './data-store.js'
import { StorageNotFoundError, type RuntimeDriver } from '../runtime/driver.js'

describe('凭据文件只在不存在时写', () => {
  it('第一次写入，已存在则不覆盖，且没有读接口', async () => {
    const files = new Map<string, Buffer>()
    const writes: string[] = []
    const store = new DataStore({ driver: {
      seedCredentialsFileIfAbsent: async (key: string, contents: Buffer) => {
        writes.push(key)
        const id = `${key}/.credentials.yaml`
        if (files.has(id)) return false
        files.set(id, Buffer.from(contents))
        return true
      },
    } as unknown as RuntimeDriver })
    const body = Buffer.from('version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-model-key-alpha-9f3c\nrecords: {}\n')
    expect(await store.seedCredentialsFileIfAbsent('vol', body)).toBe(true)
    files.set('vol/.credentials.yaml', Buffer.from('user-edited'))
    expect(await store.seedCredentialsFileIfAbsent('vol', Buffer.from('version: 1\nrefs:\n  DEEPSEEK_API_KEY: fixture-model-key-beta-9f3c\nrecords: {}\n'))).toBe(false)
    expect(files.get('vol/.credentials.yaml')?.toString('utf8')).toBe('user-edited')
    expect(writes).toEqual(['vol', 'vol'])
    const names = Object.getOwnPropertyNames(DataStore.prototype)
    expect(names.filter((name) => name.toLowerCase().includes('credential'))).toEqual([
      'seedCredentialsFileIfAbsent',
    ])
    expect(names.some((name) => /read/i.test(name) && /credential/i.test(name))).toBe(false)
  })
})

describe('snapshot restore prerequisites', () => {
  it.each([new StorageNotFoundError('missing snapshot'), new Error('invalid snapshot directory')])(
    'preserves live data when the snapshot cannot be validated: %s', async failure => {
      const ensureStorage = vi.fn().mockRejectedValue(failure)
      const removeStorage = vi.fn()
      const copyStorage = vi.fn()
      const store = new DataStore({ driver: { ensureStorage, removeStorage, copyStorage } as unknown as RuntimeDriver })
      await expect(store.restoreSnapshot('instance-data')).rejects.toBe(failure)
      expect(ensureStorage).toHaveBeenCalledWith('instance-data.prev')
      expect(removeStorage).not.toHaveBeenCalled()
      expect(copyStorage).not.toHaveBeenCalled()
    },
  )

  it('validates the exact instance snapshot before any destructive operation', async () => {
    const calls: string[] = []
    const store = new DataStore({ driver: {
      ensureStorage: async (key: string) => { calls.push(`ensure:${key}`) },
      removeStorage: async (key: string) => { calls.push(`remove:${key}`) },
      copyStorage: async (from: string, to: string) => { calls.push(`copy:${from}:${to}`) },
    } as unknown as RuntimeDriver })
    await store.restoreSnapshot('instance-data')
    expect(calls).toEqual(['ensure:instance-data.prev', 'copy:instance-data:instance-data.recovery',
      'remove:instance-data', 'copy:instance-data.prev:instance-data'])
  })

  it.each(['backup', 'restore'])('retains current contents when %s copying fails', async step => {
    const volumes = new Map([['data', 'current changes'], ['data.prev', 'old version']])
    const store = new DataStore({ driver: {
      ensureStorage: async (key: string) => { if (!volumes.has(key)) throw new Error('missing') },
      removeStorage: async (key: string) => { volumes.delete(key) },
      copyStorage: async (from: string, to: string) => {
        if (volumes.has(to)) throw new Error('exists')
        if ((step === 'backup' && to.endsWith('.recovery')) || (step === 'restore' && to === 'data')) {
          throw new Error('disk full')
        }
        volumes.set(to, volumes.get(from)!)
      },
    } as unknown as RuntimeDriver })
    await expect(store.restoreSnapshot('data')).rejects.toThrow('disk full')
    expect(volumes.get(step === 'backup' ? 'data' : 'data.recovery')).toBe('current changes')
    expect(volumes.get('data.prev')).toBe('old version')
    if (step === 'restore') {
      await expect(store.restoreSnapshot('data')).rejects.toThrow('exists')
      expect(volumes.get('data.recovery')).toBe('current changes')
    }
  })

  it('retains recovery data until explicitly finalized', async () => {
    const volumes = new Map([['data', 'current'], ['data.prev', 'previous']])
    const store = new DataStore({ driver: {
      ensureStorage: async () => {},
      removeStorage: async (key: string) => { volumes.delete(key) },
      copyStorage: async (from: string, to: string) => {
        if (volumes.has(to)) throw new Error('exists')
        volumes.set(to, volumes.get(from)!)
      },
    } as unknown as RuntimeDriver })
    await store.restoreSnapshot('data')
    expect(volumes.get('data')).toBe('previous')
    expect(volumes.get('data.recovery')).toBe('current')
    await store.finishRestore('data')
    expect(volumes.has('data.recovery')).toBe(false)
    expect(volumes.get('data')).toBe('previous')
  })
})
