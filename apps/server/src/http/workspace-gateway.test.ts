import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceGateway, filterWorkspaceCookies } from './workspace-gateway.js'
import { workspaceToken } from './workspace-login.js'

const servers: Server[] = []
async function listen(server: Server) {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

describe('workspace response boundary', () => {
  it('exchanges a browser-bound grant and sends no platform credentials to the backend', async () => {
    let backendRequests = 0
    const backendPort = await listen(createServer((req, res) => {
      backendRequests++
      res.end(req.headers.cookie ?? '')
    }))
    let expectedState = ''
    let exchanges = 0
    const token = 't'.repeat(43)
    const gateway = createWorkspaceGateway({
      baseDomain: 'example.com', consoleDomain: 'console.example.com', publicScheme: 'https', gateSecret: 'test',
      findInstanceBySlug: async slug => slug === 'alice' ? { id: `i-${slug}`, slug, ownerId: 'alice' } : undefined,
      findTargetPort: async () => backendPort,
      resolveUserId: async cookie => workspaceToken(cookie, true) === token ? 'alice' : undefined,
      login: {
        secure: true, consoleOrigin: 'https://console.example.com',
        exchange: async input => {
          exchanges++
          expect(input).toEqual({ slug: 'alice', code: 'grant', state: expectedState, callbackUrl: 'https://alice.example.com/_dsh_cloud/callback' })
          return token
        },
      },
    })
    const port = await listen(gateway)
    async function call(path: string, cookie = '', method = 'GET') {
      return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'alice.example.com', cookie } }, res => {
          let body = ''
          res.setEncoding('utf8'); res.on('data', chunk => { body += chunk })
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
        })
        req.on('error', reject); req.end()
      })
    }
    const start = await call('/chat?id=one', '__Host-dsh_cloud.session_token=console-secret')
    expect(start.status).toBe(302)
    const authorize = new URL(start.headers.location!)
    expect(authorize.origin + authorize.pathname).toBe('https://console.example.com/api/workspace/authorize')
    expectedState = authorize.searchParams.get('state')!
    const transaction = start.headers['set-cookie']![0]!
    expect(transaction).toContain('HttpOnly')
    expect(transaction).toContain('Secure')
    expect(transaction).not.toContain('Domain=')
    const callback = `/_dsh_cloud/callback?code=grant&state=${expectedState}`
    expect((await call(callback)).status).toBe(403)
    expect((await call(callback.replace(expectedState, 'x'.repeat(43)), transaction.split(';')[0]!)).status).toBe(403)
    expect(exchanges).toBe(0)
    const completed = await call(callback, transaction.split(';')[0]!)
    expect(completed.status).toBe(303)
    expect(completed.headers.location).toBe('/chat?id=one')
    expect(completed.headers['cache-control']).toBe('no-store')
    expect(backendRequests).toBe(0)
    const sessionCookie = completed.headers['set-cookie']![0]!.split(';')[0]!
    const workspace = await call('/chat', `${sessionCookie}; ${transaction.split(';')[0]}; __Host-dsh_cloud.session_token=console-secret; dsh=ok`)
    expect(workspace.status).toBe(200)
    expect(workspace.body).toBe('dsh=ok')
    expect(backendRequests).toBe(1)
  })
  it('disconnects a live SSE response after its owner loses access', async () => {
    let owner = 'alice'
    const backendPort = await listen(createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: connected\n\n')
    }))
    const gateway = createWorkspaceGateway({
      baseDomain: 'example.com', consoleDomain: 'console.example.com',
      publicScheme: 'https', gateSecret: 'test',
      findInstanceBySlug: async slug => ({ id: `i-${slug}`, slug, ownerId: owner }),
      findTargetPort: async () => backendPort,
      resolveUserId: async () => 'alice',
    })
    const port = await listen(gateway)
    const req = request({ hostname: '127.0.0.1', port, headers: { host: 'alice.example.com' } })
    const responseReady = once(req, 'response')
    req.end()
    try {
      const [response] = await responseReady as [import('node:http').IncomingMessage]
      expect(response.statusCode).toBe(200)
      response.on('error', () => {})
      const closed = new Promise<void>(resolve => response.once('close', resolve))
      response.resume()
      owner = 'bob'
      await closed
      expect(response.complete).toBe(false)
    } finally {
      req.destroy()
      await gateway.shutdown()
    }
  }, 35_000)
  it('closes upgraded connections during shutdown and filters handshake cookies', async () => {
    const backend = createServer()
    const backendSockets = new Set<import('node:stream').Duplex>()
    backend.on('upgrade', (_req, socket) => {
      backendSockets.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => backendSockets.delete(socket))
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSet-Cookie: evil=1; Domain=example.com\r\nSet-Cookie: dsh=ok; HttpOnly\r\nClear-Site-Data: "cookies"\r\n\r\n')
    })
    const backendPort = await listen(backend)
    const gateway = createWorkspaceGateway({
      baseDomain: 'example.com', consoleDomain: 'console.example.com',
      publicScheme: 'https', gateSecret: 'test',
      findInstanceBySlug: async slug => ({ id: `i-${slug}`, slug, ownerId: 'alice' }),
      findTargetPort: async () => backendPort,
      resolveUserId: async () => 'alice',
    })
    const port = await listen(gateway)
    const req = request({ hostname: '127.0.0.1', port, headers: {
      host: 'alice.example.com', origin: 'https://alice.example.com',
      connection: 'Upgrade', upgrade: 'websocket',
    } })
    const upgraded = once(req, 'upgrade')
    req.end()
    try {
      const [response, socket] = await upgraded as [import('node:http').IncomingMessage, import('node:net').Socket, Buffer]
      expect(response.headers['set-cookie']).toEqual(['dsh=ok; HttpOnly'])
      expect(response.headers['clear-site-data']).toBeUndefined()
      socket.resume()
      const disconnected = once(socket, 'close')
      await gateway.shutdown()
      await disconnected
      expect(gateway.listening).toBe(false)
    } finally {
      req.destroy()
      for (const socket of backendSockets) socket.destroy()
    }
  })
  it('preserves host cookies and rejects domain and platform credentials', () => {
    expect(filterWorkspaceCookies([
      'dsh=ok; Path=/; HttpOnly',
      'attack=x; Domain=example.com',
      'attack=x; dOmAiN=.example.com',
      'attack=x; Domain=',
      '__Host-dsh_cloud.session_token=evil; Path=/; Secure',
      '__Secure-dsh_cloud.session_token=evil',
      'dsh_cloud.session_data.0=evil',
    ])).toEqual(['dsh=ok; Path=/; HttpOnly'])
  })
  it('authenticates before proxying and filters an untrusted backend response', async () => {
    let requests = 0
    let backendCookie = ''
    const backendPort = await listen(createServer((req, res) => {
      requests++
      backendCookie = req.headers.cookie ?? ''
      res.setHeader('set-cookie', ['dsh=ok; HttpOnly', 'evil=1; Domain=example.com', 'dsh_cloud.session_token=evil'])
      res.setHeader('clear-site-data', '"cookies"')
      res.setHeader('cache-control', 'public, max-age=31536000')
      res.setHeader('cdn-cache-control', 'public, max-age=31536000')
      res.setHeader('surrogate-control', 'max-age=31536000')
      res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors *")
      res.end('workspace')
    }))
    const port = await listen(createWorkspaceGateway({
      baseDomain: 'example.com', consoleDomain: 'console.example.com',
      publicScheme: 'https', gateSecret: 'test',
      findInstanceBySlug: async slug => slug === 'alice' ? { id: `i-${slug}`, slug, ownerId: 'alice' } : undefined,
      findTargetPort: async () => backendPort,
      resolveUserId: async cookie => cookie?.includes('dsh_cloud.session_token=alice') ? 'alice' : 'bob',
    }))
    async function call(cookie: string) {
      return new Promise<{ status: number; cookies?: string[]; clear?: string | string[] }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, headers: { host: 'alice.example.com', cookie } }, res => {
          expect(res.headers['cache-control']).toBe('private, no-store')
          expect(res.headers['cdn-cache-control']).toBeUndefined()
          expect(res.headers['surrogate-control']).toBeUndefined()
          if (res.statusCode === 200) {
            expect(res.headers['content-security-policy']).toContain("default-src 'self'; frame-ancestors *")
            expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
            expect(res.headers['x-frame-options']).toBe('DENY')
          }
          res.resume()
          res.on('end', () => resolve({ status: res.statusCode!,
            ...(res.headers['set-cookie'] ? { cookies: res.headers['set-cookie'] } : {}),
            ...(res.headers['clear-site-data'] ? { clear: res.headers['clear-site-data'] } : {}),
          }))
        })
        req.on('error', reject)
        req.end()
      })
    }
    expect((await call('dsh_cloud.session_token=bob')).status).toBe(403)
    expect(requests).toBe(0)
    expect(await call('dsh_cloud.session_token=alice; dsh=old')).toEqual({ status: 200, cookies: ['dsh=ok; HttpOnly'] })
    expect(backendCookie).toBe('dsh=old')
    expect(requests).toBe(1)
  })
})
