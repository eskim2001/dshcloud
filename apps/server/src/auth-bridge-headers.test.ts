import { describe, expect, it } from 'vitest'
import {
  CONSERVATIVE_CLIENT_IP,
  authBridgeHeaders,
  canonicalAuthUrl,
  clientIpForAuth,
} from './auth-bridge-headers.js'

const base = 'https://console.app.example.com'

describe('auth 桥接头', () => {
  it('剥掉伪造的地址头，只留一个由可信 IP 决定的 x-forwarded-for', () => {
    const headers = authBridgeHeaders(
      {
        cookie: 'sid=keep',
        origin: base,
        'content-type': 'application/json',
        'x-forwarded-for': ['9.9.9.9', '8.8.8.8'],
        'cf-connecting-ip': '198.51.100.99',
        'true-client-ip': '192.0.2.50',
        'x-real-ip': '192.0.2.51',
        'X-Forwarded-For': '203.0.113.99',
      },
      '203.0.113.10',
    )
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.10')
    expect(headers.get('x-forwarded-for')).not.toContain(',')
    expect(headers.get('cf-connecting-ip')).toBeNull()
    expect(headers.get('true-client-ip')).toBeNull()
    expect(headers.get('x-real-ip')).toBeNull()
    expect(headers.get('cookie')).toBe('sid=keep')
    expect(headers.get('origin')).toBe(base)
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('空的或非法的地址写成同一只保守桶', () => {
    expect(CONSERVATIVE_CLIENT_IP).toBe('0.0.0.0')
    for (const ip of [undefined, null, '', 'not-an-ip', '203.0.113.10, 198.51.100.8', ' 203.0.113.10']) {
      expect(clientIpForAuth(ip)).toBe('0.0.0.0')
      expect(authBridgeHeaders({}, ip).get('x-forwarded-for')).toBe('0.0.0.0')
    }
  })

  it('单个合法地址原样写入', () => {
    expect(clientIpForAuth('203.0.113.10')).toBe('203.0.113.10')
    expect(clientIpForAuth('::1')).toBe('::1')
  })
})

describe('auth 路径规范化', () => {
  it('把 %2F 解成真正的路径分隔，查询串保留', () => {
    const url = canonicalAuthUrl('/api/auth/sign-in%2femail?x=1', base)
    expect(url?.pathname).toBe('/api/auth/sign-in/email')
    expect(url?.search).toBe('?x=1')
  })

  it('百分号编码的 .. 折进管理路径，和限速看到的是同一条', () => {
    expect(canonicalAuthUrl('/api/auth/sign-in/%2e%2e/admin/set-role', base)?.pathname).toBe(
      '/api/auth/admin/set-role',
    )
  })

  it('双重编码和解不开的百分号拒绝', () => {
    expect(canonicalAuthUrl('/api/auth/sign-in%252femail', base)).toBeUndefined()
    expect(canonicalAuthUrl('/api/auth/%', base)).toBeUndefined()
    expect(canonicalAuthUrl('/api/auth/sign-in%5cemail', base)).toBeUndefined()
  })
})
