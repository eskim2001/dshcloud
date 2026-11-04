import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as retryDelay } from 'node:timers/promises'
import type Docker from 'dockerode'
import Fastify from 'fastify'
import { stringify } from 'yaml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDocker } from '../docker/client.js'
import { registerForwardAuth } from '../http/forward-auth-route.js'
import { buildTraefikConfig } from './traefik.js'

describe.runIf(process.env.DSH_SECURITY_INTEGRATION === '1')('real Traefik session boundary', () => {
  const backend = Fastify()
  let directory: string | undefined
  let container: Docker.Container | undefined
  let port: number
  let receivedCookie: string | undefined

  function getEcho(cookie = '', method = 'GET', origin?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const connection = request({
        hostname: '127.0.0.1', port, path: '/echo', method,
        headers: { Host: 'alice.app.example.com', Cookie: cookie,
          ...(origin === undefined ? {} : { Origin: origin }) },
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.on('error', reject)
        response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }))
      })
      connection.setTimeout(5_000, () => connection.destroy(new Error('Ingress request timed out')))
      connection.on('error', reject)
      connection.end()
    })
  }

  beforeAll(async () => {
    registerForwardAuth(backend, {
      baseDomain: 'app.example.com', consoleDomain: 'console.app.example.com',
      publicScheme: 'https', gateSecret: 'integration-gate',
      findInstanceBySlug: async (slug) => ({ id: `i-${slug}`, slug, ownerId: 'alice' }),
      resolveUserId: async (cookie) => cookie?.includes('dsh_cloud.session_token=alice')
        ? 'alice' : cookie?.includes('dsh_cloud.session_token=bob') ? 'bob' : undefined,
    })
    backend.get('/echo', async (req) => ({ cookie: req.headers.cookie ?? '', gate: req.headers['x-platform-token'] }))
    backend.post('/echo', async () => ({ accepted: true }))
    backend.get('/socket', async (req, reply) => {
      receivedCookie = req.headers.cookie
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
      reply.hijack()
      req.raw.socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    })
    await backend.listen({ host: '0.0.0.0', port: 0 })
    const address = backend.server.address()
    if (address === null || typeof address === 'string') throw new Error('No backend port')
    const origin = `http://host.docker.internal:${address.port}`
    const config = buildTraefikConfig([{ instance: 'alice', hostname: 'alice.app.example.com', hostPort: 20001 }], {
      forwardAuthAddress: `${origin}/auth/verify`, entryPoint: 'web',
    })
    config.http.services!['instance-alice']!.loadBalancer.servers = [{ url: origin }]
    directory = await mkdtemp(join(tmpdir(), 'dsh-security-ingress-'))
    await writeFile(join(directory, 'routes.yml'), stringify(config))
    container = await createDocker().createContainer({
      Image: 'traefik:v3.5',
      Cmd: ['--entrypoints.web.address=:8080', '--providers.file.filename=/test/routes.yml'],
      ExposedPorts: { '8080/tcp': {} },
      HostConfig: {
        Binds: [`${directory}:/test:ro`],
        ExtraHosts: ['host.docker.internal:host-gateway'],
        PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '0' }] },
      },
    })
    await container.start()
    const info = await container.inspect()
    port = Number(info.NetworkSettings.Ports['8080/tcp']?.[0]?.HostPort)
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await getEcho()
        if (result.status !== 302) throw new Error(`Ingress not ready: ${result.status}`)
        break
      } catch (error) {
        if (attempt >= 60) throw error
        await retryDelay(100)
      }
    }
  }, 30_000)

  afterAll(async () => {
    await container?.remove({ force: true, v: true })
    await backend.close()
    if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  })

  it.each([
    ['dsh_cloud.session_token=alice', ''],
    ['__Secure-dsh_cloud.session_token=alice; dsh_session=instance', 'dsh_session=instance'],
    ['dsh_cloud.session_token=alice; dsh_cloud.session_data.0=private; dsh_session=instance', 'dsh_session=instance'],
  ])('never forwards platform cookies to the backend: %s', async (cookie, expected) => {
    const response = await getEcho(cookie)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ cookie: expected, gate: expect.any(String) })
  })

  it.each([
    ['', 302, 'https://alice.app.example.com'],
    ['dsh_cloud.session_token=bob', 403, 'https://alice.app.example.com'],
    ['dsh_cloud.session_token=alice; dsh_session=instance', 101, 'https://alice.app.example.com'],
    ['dsh_cloud.session_token=alice', 403, 'https://bob.app.example.com'],
    ['dsh_cloud.session_token=alice', 403, 'https://evil.example'],
    ['dsh_cloud.session_token=alice', 403, 'null'],
  ] as const)('authorizes WebSocket upgrades and filters their cookies: %s', async (cookie, expected, origin) => {
    receivedCookie = undefined
    const code = await new Promise<number>((resolve, reject) => {
      const connection = request({
        hostname: '127.0.0.1', port, path: '/socket',
        headers: {
          Host: 'alice.app.example.com', Cookie: cookie,
          Origin: origin,
          Connection: 'Upgrade', Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      })
      connection.setTimeout(5_000, () => connection.destroy(new Error('Upgrade timed out')))
      connection.on('error', reject)
      connection.on('response', response => {
        response.resume()
        resolve(response.statusCode!)
      })
      connection.on('upgrade', (response, socket) => {
        socket.destroy()
        resolve(response.statusCode!)
      })
      connection.end()
    })
    expect(code).toBe(expected)
    expect(receivedCookie).toBe(expected === 101 ? 'dsh_session=instance' : undefined)
  })

  it.each([undefined, 'null', 'https://bob.app.example.com', 'https://console.app.example.com'])(
    'rejects cross-origin writes before reaching an unguarded backend: %s', async (origin) => {
      expect((await getEcho('dsh_cloud.session_token=alice', 'POST', origin)).status).toBe(403)
    },
  )
  it('allows owner writes from the exact workspace origin', async () => {
    const response = await getEcho('dsh_cloud.session_token=alice', 'POST', 'https://alice.app.example.com')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ accepted: true })
  })
})
