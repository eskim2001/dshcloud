import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeDriver } from '../driver.js'
import { StorageExistsError, StorageNotFoundError, StorageIncompleteError } from '../driver.js'
import { parseNodeRequest } from './protocol.js'
import { createNodeService } from './server.js'
import { NodeRuntimeDriver } from './client.js'

const repo = 'ghcr.io/eskim2001/dsh-instance'
const key = 'a'.repeat(32)
const createRequest = () => ({ method: 'create', args: [
  { slug: 'alice', image: `${repo}:1_1`, quota: { cpus: 1, memoryMb: 1024, diskMb: 1024, pidsLimit: 128 }, env: {} },
  { baseImage: `${repo}:1_1`, baseDomain: 'example.com', gateToken: 'x'.repeat(43), storageKey: key, hostPort: 20001 },
] })

describe('node service policy', () => {
  it('reports incomplete storage without disclosing the host error details', async () => {
    const app = createNodeService({ ensureStorage: async () => {
      throw new StorageIncompleteError('private host path and credentials')
    } } as unknown as RuntimeDriver, repo)
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/runtime',
        payload: { method: 'ensureStorage', args: [key] } })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toEqual({ error: 'storage-incomplete' })
      expect(response.body).not.toContain('private')
    } finally { await app.close() }
  })
  it.each([
    { method: 'exec', args: ['dsh-instance-alice', ['sh']] },
    { method: 'stop', args: ['dsh-control-plane'] },
    { method: 'remove', args: ['../../etc'] },
    { method: 'createStorage', args: ['/etc', 100] },
    { method: 'chownStorage', args: [key, 0, 0] },
    { method: 'copyStorage', args: [key, 'b'.repeat(32)] },
    { method: 'copyStorage', args: [key, key] },
    { method: 'copyStorage', args: [key, `${'b'.repeat(32)}.recovery`] },
    { method: 'copyStorage', args: [`${key}.recovery`, key] },
    { method: 'ensureImage', args: ['evil.example/image:latest'] },
    { method: 'probeHealthy', args: ['dsh-instance-alice', 22] },
    { method: 'logs', args: ['dsh-instance-alice', -1] },
    { method: 'start', args: ['dsh-instance-alice'], privileged: true },
  ])('rejects forbidden operation %# before dispatch', async payload => {
    const calls = vi.fn()
    const driver = new Proxy({}, { get: () => calls }) as RuntimeDriver
    const app = createNodeService(driver, repo)
    try {
      expect((await app.inject({ method: 'POST', url: '/v1/runtime', payload })).statusCode).toBe(400)
      expect(calls).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('allows same-instance snapshot and fixed runtime shape', () => {
    expect(parseNodeRequest(createRequest(), repo).method).toBe('create')
    expect(parseNodeRequest({ method: 'copyStorage', args: [key, `${key}.prev`] }, repo).method).toBe('copyStorage')
    expect(parseNodeRequest({ method: 'copyStorage', args: [key, `${key}.recovery`] }, repo).method).toBe('copyStorage')
    const raw = createRequest()
    Object.assign(raw.args[1]!, { Binds: ['/:/host'], privileged: true })
    expect(() => parseNodeRequest(raw, repo)).toThrow()
  })

  it('拒绝把模型凭据写进快照卷，失败响应也不回显正文', async () => {
    const fixture = 'fixture-model-key-alpha-9f3c'
    expect(() => parseNodeRequest({
      method: 'seedCredentialsFileIfAbsent',
      args: [`${key}.prev`, 'version: 1\n'],
    }, repo)).toThrow()
    expect(() => parseNodeRequest({
      method: 'seedCredentialsFileIfAbsent',
      args: [key, 'x'.repeat(8193)],
    }, repo)).toThrow()
    const app = createNodeService({
      seedCredentialsFileIfAbsent: async () => {
        throw new Error(`leaked ${fixture}`)
      },
    } as unknown as RuntimeDriver, repo)
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/runtime',
        payload: { method: 'seedCredentialsFileIfAbsent', args: [key, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${fixture}\n`] },
      })
      expect(response.statusCode).toBe(500)
      expect(response.body).not.toContain(fixture)
      expect(response.json()).toEqual({ error: 'node-operation-failed' })
    } finally { await app.close() }
  })

  it('rejects a context image substitution', () => {
    const raw = createRequest()
    Object.assign(raw.args[1]!, { baseImage: 'evil.example/image:latest' })
    expect(() => parseNodeRequest(raw, repo)).toThrow()
  })

  it('holds mutation capacity until actual completion, without queueing a second mutation', async () => {
    let finish!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const stop = vi.fn(() => new Promise<void>(resolve => { finish = resolve; started() }))
    const app = createNodeService({ stop } as unknown as RuntimeDriver, repo)
    const payload = { method: 'stop', args: ['dsh-instance-alice'] }
    const first = app.inject({ method: 'POST', url: '/v1/runtime', payload }).then(response => response)
    await entered
    expect((await app.inject({ method: 'POST', url: '/v1/runtime', payload })).statusCode).toBe(503)
    expect(stop).toHaveBeenCalledTimes(1)
    finish()
    expect((await first).statusCode).toBe(200)
    await app.close()
  })

  it('redacts backend failures and excludes unrelated host image tags', async () => {
    const app = createNodeService({
      stop: async () => { throw new Error('secret=/host/password') },
      listImageTags: async () => [`${repo}:1_1`, 'private/database:latest'],
    } as unknown as RuntimeDriver, repo)
    try {
      const failure = await app.inject({ method: 'POST', url: '/v1/runtime', payload: { method: 'stop', args: ['dsh-instance-alice'] } })
      expect(failure.statusCode).toBe(500)
      expect(failure.body).not.toContain('password')
      const tags = await app.inject({ method: 'POST', url: '/v1/runtime', payload: { method: 'listImageTags', args: [] } })
      expect(tags.json()).toEqual({ value: [`${repo}:1_1`] })
    } finally { await app.close() }
  })

  it('round-trips over a real Unix socket, including map, stream, missing state and storage errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-node-'))
    const socket = join(directory, 'n.sock')
    const app = createNodeService({ runtime: 'docker',
      storageUsageAll: async () => new Map([[key, 12]]), status: async () => undefined,
      createStorage: async () => { throw new StorageExistsError() },
      ensureStorage: async () => { throw new StorageNotFoundError() },
      openImagePull: async () => Readable.from(['pulling\n', 'done\n']),
    } as unknown as RuntimeDriver, repo)
    try {
      await app.listen({ path: socket })
      const client = new NodeRuntimeDriver(socket)
      await client.ready()
      expect(await client.status('dsh-instance-alice')).toBeUndefined()
      expect(await client.storageUsageAll()).toEqual(new Map([[key, 12]]))
      await expect(client.createStorage(key, 100)).rejects.toBeInstanceOf(StorageExistsError)
      await expect(client.ensureStorage(key)).rejects.toBeInstanceOf(StorageNotFoundError)
      let progress = ''
      for await (const chunk of await client.openImagePull(`${repo}:1_1`)) progress += chunk.toString()
      expect(progress).toBe('pulling\ndone\n')
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
  })
})
