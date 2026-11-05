import { request } from 'node:http'
import type { Readable } from 'node:stream'
import type { InstanceSpec, RenderContext, RenderedInstance } from '@dsh-cloud/instance-spec'
import { StorageExistsError, StorageNotFoundError, StorageIncompleteError, type RuntimeDriver, type InstanceLiveState, type InstanceUsage } from '../driver.js'
import { NODE_PROTOCOL_VERSION, type NodeRequest } from './protocol.js'

export class NodeRuntimeDriver implements RuntimeDriver {
  readonly runtime = 'docker'
  readonly canReportLocalImages = true
  constructor(private readonly socketPath: string, private readonly timeouts = {
    health: 5000, read: 15_000, mutation: 15 * 60_000,
  }) {}

  async ready(): Promise<void> {
    const response = await this.send('/health')
    const result = JSON.parse(await this.read(response)) as { protocol?: number }
    if (response.statusCode !== 200 || result.protocol !== NODE_PROTOCOL_VERSION) throw new Error('Unsupported node protocol')
  }

  private send(path: string, body?: NodeRequest): Promise<import('node:http').IncomingMessage> {
    const reads = new Set(['imageExists', 'listImageTags', 'status', 'stats', 'logs', 'probeHealthy',
      'listInstanceNames', 'ensureStorage', 'storageEnforced', 'storageUsageMb', 'storageUsageAll'])
    const timeout = body === undefined ? this.timeouts.health
      : reads.has(body.method) ? this.timeouts.read : this.timeouts.mutation
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.socketPath, path, method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeout) }, resolve)
      req.once('error', reject)
      req.end(body ? JSON.stringify(body) : undefined)
    })
  }

  private async read(stream: Readable): Promise<string> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const raw of stream) {
      const chunk = Buffer.from(raw)
      size += chunk.length
      if (size > 8 * 1024 * 1024) { stream.destroy(); throw new Error('Node response exceeds limit') }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private async call<T>(body: NodeRequest): Promise<T> {
    const response = await this.send('/v1/runtime', body)
    const result = JSON.parse(await this.read(response)) as { value?: T; error?: string }
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid node response')
    if (response.statusCode !== 200) {
      if (result.error === 'storage-exists') throw new StorageExistsError('Instance storage already exists')
      if (result.error === 'storage-not-found') throw new StorageNotFoundError('Instance storage is missing')
      if (result.error === 'storage-incomplete') throw new StorageIncompleteError('工作空间数据操作未完成，需要先检查并恢复数据，不能直接启动')
      throw new Error(`Node operation ${body.method} failed (${response.statusCode})`)
    }
    if (!Object.hasOwn(result, 'value') || Object.hasOwn(result, 'error')) throw new Error('Invalid node success response')
    return (result.value === null ? undefined : result.value) as T
  }

  ensureImage(ref: string): Promise<void> { return this.call({ method: 'ensureImage', args: [ref] }) }
  imageExists(ref: string): Promise<boolean> { return this.call({ method: 'imageExists', args: [ref] }) }
  listImageTags(): Promise<string[]> { return this.call({ method: 'listImageTags', args: [] }) }
  async openImagePull(ref: string): Promise<Readable> {
    const response = await this.send('/v1/runtime', { method: 'openImagePull', args: [ref] })
    if (response.statusCode !== 200) { response.destroy(); throw new Error('Node image pull failed') }
    return response
  }
  create(spec: InstanceSpec, ctx: RenderContext): Promise<RenderedInstance> { return this.call({ method: 'create', args: [spec, ctx] }) }
  start(name: string): Promise<void> { return this.call({ method: 'start', args: [name] }) }
  stop(name: string): Promise<void> { return this.call({ method: 'stop', args: [name] }) }
  remove(name: string): Promise<void> { return this.call({ method: 'remove', args: [name] }) }
  status(name: string): Promise<InstanceLiveState | undefined> { return this.call({ method: 'status', args: [name] }) }
  stats(name: string): Promise<InstanceUsage | undefined> { return this.call({ method: 'stats', args: [name] }) }
  logs(name: string, tail: number): Promise<string> { return this.call({ method: 'logs', args: [name, tail] }) }
  probeHealthy(name: string, port: number): Promise<boolean> { return this.call({ method: 'probeHealthy', args: [name, port] }) }
  listInstanceNames(): Promise<string[]> { return this.call({ method: 'listInstanceNames', args: [] }) }
  async exec(_name: string, _argv: string[]): Promise<{ code: number; stdout: string }> {
    throw new Error('Generic command execution is not exposed by the node service')
  }
  createStorage(key: string, size: number): Promise<void> { return this.call({ method: 'createStorage', args: [key, size] }) }
  ensureStorage(key: string): Promise<void> { return this.call({ method: 'ensureStorage', args: [key] }) }
  chownStorage(key: string, uid: number, gid: number): Promise<void> {
    if (uid !== 1000 || gid !== 1000) return Promise.reject(new Error('Invalid instance identity'))
    return this.call({ method: 'chownStorage', args: [key, uid, gid] })
  }
  removeStorage(key: string): Promise<void> { return this.call({ method: 'removeStorage', args: [key] }) }
  resizeStorage(key: string, size: number): Promise<void> { return this.call({ method: 'resizeStorage', args: [key, size] }) }
  storageEnforced(key: string): Promise<boolean> { return this.call({ method: 'storageEnforced', args: [key] }) }
  storageUsageMb(key: string): Promise<number | undefined> { return this.call({ method: 'storageUsageMb', args: [key] }) }
  async storageUsageAll(): Promise<Map<string, number> | undefined> {
    const entries = await this.call<Array<[string, number]> | undefined>({ method: 'storageUsageAll', args: [] })
    return entries === undefined ? undefined : new Map(entries)
  }
  copyStorage(from: string, to: string): Promise<void> { return this.call({ method: 'copyStorage', args: [from, to] }) }
  seedCredentialsFileIfAbsent(key: string, contents: Buffer): Promise<boolean> {
    const yaml = contents.toString('utf8')
    if (yaml.length === 0 || yaml.length > 8192 || contents.length !== Buffer.byteLength(yaml)) {
      return Promise.reject(new Error('Invalid credentials payload'))
    }
    return this.call({ method: 'seedCredentialsFileIfAbsent', args: [key, yaml] })
  }
  seedCordisPatchIfAbsent(key: string, contents: Buffer): Promise<boolean> {
    const yaml = contents.toString('utf8')
    if (yaml.length === 0 || yaml.length > 8192 || contents.length !== Buffer.byteLength(yaml)) {
      return Promise.reject(new Error('Invalid cordis patch payload'))
    }
    return this.call({ method: 'seedCordisPatchIfAbsent', args: [key, yaml] })
  }
  heal(): Promise<void> { return this.call({ method: 'heal', args: [] }) }
}
