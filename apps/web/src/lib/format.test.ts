import { describe, expect, it } from 'vitest'
import { dshTagLabel, dshVersionLabel, formatMb, hostOf, imageTagOf } from './format.js'

describe('formatMb', () => {
  it('不到 1 GB 用 MB（四舍五入）', () => {
    expect(formatMb(512)).toBe('512 MB')
    expect(formatMb(268.6)).toBe('269 MB')
  })

  it('整 GB 不带小数，非整 GB 保留一位', () => {
    expect(formatMb(1024)).toBe('1 GB')
    expect(formatMb(10_240)).toBe('10 GB')
    expect(formatMb(1536)).toBe('1.5 GB')
  })
})

describe('hostOf', () => {
  it('从入口 URL 里只取主机名 —— 那条 URL 带的是一次性 token，贴出去没用还碍眼', () => {
    expect(hostOf('https://telegram.lvh.me/?token=abc123')).toBe('telegram.lvh.me')
    expect(hostOf('https://alice.app.dsh.test/')).toBe('alice.app.dsh.test')
  })

  it('不是 URL 就原样返回（宁可显示原值，也不抛）', () => {
    expect(hostOf('telegram.lvh.me')).toBe('telegram.lvh.me')
    expect(hostOf('')).toBe('')
  })
})

describe('imageTagOf', () => {
  it('只取 tag —— 升级候选的仓库前缀全都一样，显示整串会把差异挤没', () => {
    expect(imageTagOf('ghcr.io/eskim2001/dsh-instance:0.1.6-alpha.1_1')).toBe('0.1.6-alpha.1_1')
    expect(imageTagOf('ghcr.io/eskim2001/dsh-instance:0.1.5-rc.2_4')).toBe('0.1.5-rc.2_4')
  })

  it('没有 tag 就原样返回', () => {
    expect(imageTagOf('ghcr.io/eskim2001/dsh-instance')).toBe('ghcr.io/eskim2001/dsh-instance')
  })

  it('带端口的 registry 不算 tag（ImageRefSchema 允许这种写法）', () => {
    expect(imageTagOf('reg.example.com:5000/dsh-instance')).toBe('reg.example.com:5000/dsh-instance')
    expect(imageTagOf('reg.example.com:5000/dsh-instance:1.0')).toBe('1.0')
  })
})

describe('dshVersionLabel', () => {
  it('用户面短标：dsh 前缀 + 去掉 _修订号', () => {
    expect(dshVersionLabel('ghcr.io/eskim2001/dsh-instance:0.1.6-alpha.1_5')).toBe('dsh 0.1.6-alpha.1')
    expect(dshVersionLabel('dsh-instance:0.1.5-rc.2_4')).toBe('dsh 0.1.5-rc.2')
    expect(dshVersionLabel('dsh-instance:0.1.9_10')).toBe('dsh 0.1.9')
  })

  it('非发布形状的 tag 只加前缀（没有 _N 可去）', () => {
    expect(dshVersionLabel('dsh-instance:latest')).toBe('dsh latest')
  })

  it('取不到 tag 时原样返回', () => {
    expect(dshVersionLabel('ghcr.io/eskim2001/dsh-instance')).toBe('ghcr.io/eskim2001/dsh-instance')
  })
})

describe('dshTagLabel', () => {
  it('保留修订号 —— 选项里两条修订要能区分', () => {
    expect(dshTagLabel('ghcr.io/eskim2001/dsh-instance:0.1.6-alpha.1_5')).toBe('dsh 0.1.6-alpha.1_5')
  })
})
