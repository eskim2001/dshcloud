import Fastify from 'fastify'
import type { RuntimeDriver } from '../driver.js'
import { StorageExistsError, StorageNotFoundError, StorageIncompleteError } from '../driver.js'
import { imageRepo } from '../../instance/image-catalog.js'
import { NODE_PROTOCOL_VERSION, parseNodeRequest, type NodeRequest } from './protocol.js'

export function createNodeService(driver: RuntimeDriver, allowedImageRepo: string) {
  const app = Fastify({ logger: false, bodyLimit: 65_536, requestTimeout: 30_000 })
  let active = 0
  let mutating = false
  const readOnly = new Set(['imageExists', 'listImageTags', 'status', 'stats', 'logs',
    'probeHealthy', 'listInstanceNames', 'ensureStorage', 'storageEnforced', 'storageUsageMb', 'storageUsageAll'])

  app.get('/health', async () => ({ protocol: NODE_PROTOCOL_VERSION, runtime: driver.runtime }))
  app.post('/v1/runtime', async (request, reply) => {
    let operation: NodeRequest
    try { operation = parseNodeRequest(request.body, allowedImageRepo) } catch {
      return reply.code(400).send({ error: 'invalid-operation' })
    }
    const mutation = !readOnly.has(operation.method)
    if (active >= 32 || (mutation && mutating)) {
      return reply.code(503).header('Retry-After', '1').send({ error: 'node-busy' })
    }
    active++
    if (mutation) mutating = true
    let streamOwnsSlot = false
    let released = false
    const release = () => {
      if (released) return
      released = true
      active--
      if (mutation) mutating = false
    }
    try {
      if (operation.method === 'openImagePull') {
        const stream = await driver.openImagePull(operation.args[0])
        streamOwnsSlot = true
        stream.once('close', release)
        stream.once('end', release)
        stream.once('error', release)
        reply.raw.once('close', () => { stream.destroy(); release() })
        return reply.type('text/plain').send(stream)
      }
      const value = await dispatch(driver, operation)
      if (operation.method === 'listImageTags') {
        return { value: (value as string[]).filter(ref => imageRepo(ref) === allowedImageRepo) }
      }
      return { value: value instanceof Map ? [...value] : value ?? null }
    } catch (error) {
      if (error instanceof StorageExistsError) return reply.code(409).send({ error: 'storage-exists' })
      if (error instanceof StorageNotFoundError) return reply.code(404).send({ error: 'storage-not-found' })
      if (error instanceof StorageIncompleteError) return reply.code(409).send({ error: 'storage-incomplete' })
      // Docker errors can include credentials and host paths. They are not part of the RPC contract.
      return reply.code(500).send({ error: 'node-operation-failed' })
    } finally {
      if (!streamOwnsSlot) release()
    }
  })
  return app
}

async function dispatch(driver: RuntimeDriver, request: NodeRequest): Promise<unknown> {
  switch (request.method) {
    case 'ensureImage': return driver.ensureImage(...request.args)
    case 'imageExists': return driver.imageExists(...request.args)
    case 'listImageTags': return driver.listImageTags()
    case 'create': return driver.create(...request.args)
    case 'start': return driver.start(...request.args)
    case 'stop': return driver.stop(...request.args)
    case 'remove': return driver.remove(...request.args)
    case 'status': return driver.status(...request.args)
    case 'stats': return driver.stats(...request.args)
    case 'logs': return driver.logs(...request.args)
    case 'probeHealthy': return driver.probeHealthy(...request.args)
    case 'listInstanceNames': return driver.listInstanceNames()
    case 'createStorage': return driver.createStorage(...request.args)
    case 'ensureStorage': return driver.ensureStorage(...request.args)
    case 'removeStorage': return driver.removeStorage(...request.args)
    case 'resizeStorage': return driver.resizeStorage(...request.args)
    case 'chownStorage': return driver.chownStorage(...request.args)
    case 'storageEnforced': return driver.storageEnforced(...request.args)
    case 'storageUsageMb': return driver.storageUsageMb(...request.args)
    case 'storageUsageAll': return driver.storageUsageAll()
    case 'copyStorage': return driver.copyStorage(...request.args)
    case 'seedCredentialsFileIfAbsent':
      return driver.seedCredentialsFileIfAbsent(request.args[0], Buffer.from(request.args[1], 'utf8'))
    case 'seedCordisPatchIfAbsent':
      return driver.seedCordisPatchIfAbsent(request.args[0], Buffer.from(request.args[1], 'utf8'))
    case 'heal': return driver.heal()
    case 'openImagePull': throw new Error('Streaming operation requires stream transport')
  }
}
