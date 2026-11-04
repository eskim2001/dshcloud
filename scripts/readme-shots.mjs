#!/usr/bin/env node
/**
 * 重新生成 README 里的控制台截图：`node scripts/readme-shots.mjs`。
 *
 * 为什么要有这个脚本：README 的截图是**手抓的**，而 UI 一改它们就过期 —— 过期到一定程度就没人
 * 敢再动 README。把视口尺寸、主题、语言写死在代码里，重拍就是跑一条命令。
 *
 * 产出：`docs/screenshots/<locale>/<theme>/<page>.png`，10 页 × 2 主题 × 2 语言 = 40 张。
 * 两个 README 把明暗两套塞进 `<picture>` + `prefers-color-scheme`，读者只看到符合自己系统的那套。
 *
 * 前置：
 *   1. 本地栈起着（`pnpm dev`）；
 *   2. 同目录的 Chrome 带 `--remote-debugging-port=9222`（脚本会在连不上时把命令打出来）。
 *
 * 只用 Node 内置能力（node 22 起自带 WebSocket / fetch），不引依赖 —— 和 `scripts/dev.mjs` 一致。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = process.env.SHOTS_DIR
  ? path.resolve(process.env.SHOTS_DIR)
  : path.join(ROOT, 'docs/screenshots')

const CDP = 'http://127.0.0.1:9222'
const ORIGIN = 'https://lvh.me'
const EMAIL = 'admin@lvh.me'
const PASSWORD = 'dsh-cloud-dev'

/**
 * 视口 = **iPad mini 横屏**（iPad mini 6/7 的 CSS 逻辑分辨率 1133×744）。桌面控制台在这个
 * 宽度下侧栏和内容区都摆得下，比更宽的视口更适合缩进 README 的两列表格。
 *
 * **固定帧，不按内容裁高度**：表格画廊里等高才整齐。代价是比视口高的页面底部会被切掉，
 * 所以每个页面都把关键信息放在首屏 —— 重拍后要抽查一眼有没有切掉要紧的东西。
 *
 * `DPR = 2` ⇒ 实际输出 2266×1488。缩略图在 GitHub 上被缩到 ~400px，2x 源仍有余量，点开看原图
 * 在视网膜屏上也不糊。**改成 1 能把这一堆图从 ~10MB 压到 ~2.5MB**，是个一行常量的事。
 */
const WIDTH = 1133
const HEIGHT = 744
const DPR = 2

/**
 * 出哪几套主题。默认**两套都出**（README 靠 `<picture>` 按读者的系统偏好挑一套）。
 * 只跑一套时用 `SHOTS_THEME=dark` / `SHOTS_THEME=light` —— 调版面时省一半时间。
 */
const THEMES =
  process.env.SHOTS_THEME === 'dark' || process.env.SHOTS_THEME === 'light'
    ? [process.env.SHOTS_THEME]
    : ['light', 'dark']

/**
 * 拍哪些页。按**用户旅程**排：进门（登录）→ 日常（主页 / 工作空间 / 创建 / 详情 / 设置）
 * → 平台管理（概览 / 全部工作空间 / 版本 / 用户）。README 的表格按同样的顺序铺。
 *
 * `route` 以 `:workspace` 开头表示「带一个工作空间 id」，取列表里的第一个（见下面 workspaces）。
 *
 * 没进来的四个，都是有理由的：账号设置（个人设置，不是卖点）、打开工作空间（过渡页，700ms
 * 后自动跳走，截不稳）、接受邀请（要现造 token，且还是旧视觉）、setup 引导页（本地栈进不去
 * 引导态 —— `dev.mjs` 一上来就把 BASE_DOMAIN 写死，见 apps/server/src/env.ts 的 withPlatformDomains）。
 */
const PAGES = [
  { file: 'login', route: '/login' },
  { file: 'home', route: '/home' },
  { file: 'workspaces', route: '/workspaces' },
  // 资源规格（CPU / 内存 / 磁盘 / 进程数）收在「使用高级设置」这个 <details> 里，
  // 不展开就只有一个名字输入框 —— 那正是这一页最值得展示的东西。
  { file: 'workspace-new', route: '/workspaces/new', expand: true },
  { file: 'workspace', route: ':workspace' },
  { file: 'workspace-settings', route: ':workspace/settings' },
  { file: 'admin', route: '/admin' },
  { file: 'admin-instances', route: '/admin/instances' },
  { file: 'admin-versions', route: '/admin/versions' },
  { file: 'admin-users', route: '/admin/users' },
]

const LOCALES = ['zh-CN', 'en']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageTarget() {
  const res = await fetch(`${CDP}/json`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page')
  if (page === undefined) throw new Error('CDP 里没有可用的 page target')
  return page
}

/** 极简 CDP 客户端：够用就好（顺序发命令 + 按 id 收结果）。 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 0

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    const entry = pending.get(msg.id)
    if (entry === undefined) return
    pending.delete(msg.id)
    entry(msg.result)
  })

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('连不上 CDP WebSocket')))
  })

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async (expression) => {
    await ready
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r?.result?.value
  }

  return { ws, ready, send, evaluate }
}

const fail = (msg) => {
  console.error(`\n✖ ${msg}`)
  console.error(
    '  先起本地栈（pnpm dev），再起一个带调试端口的 Chrome：\n' +
      `  nohup '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --remote-debugging-port=9222 \\\n` +
      `    --ignore-certificate-errors --user-data-dir=/tmp/chrome-dsh-cloud --no-first-run \\\n` +
      `    --no-default-browser-check about:blank >/tmp/chrome-dsh.log 2>&1 &`,
  )
  process.exit(1)
}

const target = await pageTarget().catch(() => fail(`连不上 ${CDP}（Chrome 没起？）`))
const cdp = connect(target.webSocketDebuggerUrl)
await cdp.ready
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
// 本地入口用的是 Traefik **自签**证书，而且每次重建入口栈证书都会换（卷一删就重新生成）。
// 靠 Chrome 里手动点过「继续访问」撑不住 —— 换个证书页面就变成 chrome-error，脚本会卡在登录那步。
// 所以让 CDP 这一侧直接忽略证书错误。
await cdp.send('Security.enable')
await cdp.send('Security.setIgnoreCertificateErrors', { ignore: true })

// 站在目标源上写偏好（主题 / 语言），再登录 —— 否则 localStorage 写不进去
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: DPR,
  mobile: false,
})
await cdp.send('Page.navigate', { url: `${ORIGIN}/login` })
await sleep(2500)

const signedIn = await cdp.evaluate(
  `fetch('/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:${JSON.stringify(EMAIL)},password:${JSON.stringify(PASSWORD)}})}).then(r=>r.status)`,
)
if (signedIn !== 200) fail(`登录失败（${signedIn}）—— 本地栈起了吗？密码还是 ${PASSWORD} 吗？`)

const workspaces = await cdp.evaluate(
  `fetch('/api/instances').then(r=>r.json()).then(d=>d.instances.map(i=>i.id))`,
)
if (!Array.isArray(workspaces) || workspaces.length === 0) {
  fail('一个工作空间都没有：详情页 / 设置页的截图需要至少一个，先建一个再跑')
}

let count = 0
for (const locale of LOCALES) {
  for (const theme of THEMES) {
    for (const page of PAGES) {
      // 主题 / 语言都从 localStorage 读；每轮都重设，别把上一轮的偏好带过来
      await cdp.evaluate(
        `localStorage.setItem('dsh-cloud.theme',${JSON.stringify(theme)});localStorage.setItem('dsh-cloud.locale',${JSON.stringify(locale)});'ok'`,
      )
      const route = page.route.startsWith(':workspace')
        ? `/workspaces/${workspaces[0]}${page.route.slice(':workspace'.length)}`
        : page.route
      await cdp.send('Page.navigate', { url: `${ORIGIN}${route}` })
      await sleep(2500)
      // 藏掉滚动条。两件事：
      //   1. 内容高过取景框的页面会画出滚动条，深色主题下是一条很显眼的灰条；
      //   2. 它还会占掉 ~15px，让「有滚条的页」正文比「没滚条的页」窄一截 —— 十张并排看得出来。
      // 用 CSS 而不是 CDP 的 Emulation.setScrollbarsHidden：后者只藏不还，实测 clientWidth 仍是 1118；
      // `::-webkit-scrollbar{display:none}` 两者都办到（1118 → 1133）。每次导航后都要重注入。
      await cdp.evaluate(
        `(() => { const s = document.createElement('style'); s.textContent = '::-webkit-scrollbar{display:none !important} html{scrollbar-width:none !important}'; document.head.appendChild(s); return 'ok' })()`,
      )
      // `expand: true` 的页面先把折叠块打开再拍（见 PAGES 里 workspace-new 的说明）
      if (page.expand === true) {
        await cdp.evaluate('document.querySelectorAll("details").forEach((d) => { d.open = true });"expanded"')
        await sleep(500)
      }
      // 视口就是取景框，固定不动；只把滚动位置拉回顶部，否则拍到的是上一页留下的滚动位置
      await cdp.evaluate('scrollTo(0,0);"top"')
      await sleep(500)

      // 不传 clip：按 deviceScaleFactor 出图（DPR 2 ⇒ 2266×1488）
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const out = path.join(OUT_DIR, locale, theme, `${page.file}.png`)
      mkdirSync(path.dirname(out), { recursive: true })
      writeFileSync(out, Buffer.from(shot.data, 'base64'))
      count += 1
      console.log(`✓ ${path.relative(ROOT, out)}`)
    }
  }
}

cdp.ws.close()
console.log(`\n完成，共 ${count} 张（${WIDTH * DPR}×${HEIGHT * DPR}）。改过 UI 就重跑一遍，别让 README 里的截图比代码老。`)
