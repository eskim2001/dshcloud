#!/usr/bin/env node
/**
 * 一条命令起本地开发栈：`pnpm dev`。
 *
 * 干的事：预检 → 生成/校验 apps/server/.env.local → 起 compose（Postgres + Traefik）
 * → 等 Postgres → 迁移 → seed → 起控制面和管理台 → 等控制台起来才打印地址和凭据。
 *
 * 退出（Ctrl-C）只停两个应用进程，**不拆 compose 栈**——下次 `pnpm dev` 秒起。
 * 要停入口和 Postgres：`pnpm dev:down`。
 *
 * 不引依赖：只用 node 内置模块 + 全局 fetch。
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPOSE_FILE = 'docker/compose/local.yml'
const ENV_PATH = path.join(ROOT, 'apps/server/.env.local')

const SERVER_PORT = 3000
const WEB_PORT = 5173

const PG_SERVICE = 'postgres'
const PG_USER = 'dshcloud'
const PG_DB = 'dsh_cloud'

const DEV_ADMIN_EMAIL = 'admin@lvh.me'
const DEV_ADMIN_PASSWORD = 'dsh-cloud-dev'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (msg) => console.log(msg)
const step = (msg) => console.log(`\n▸ ${msg}`)

function fail(msg, hint) {
  console.error(`\n✖ ${msg}`)
  if (hint) {
    for (const line of hint.split('\n')) console.error(`  ${line}`)
  }
  process.exit(1)
}

// ── 预检：所有检查跑完才动 Docker，否则失败会留下半起状态 ────────────────

function checkPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err) => resolve(err.code !== 'EADDRINUSE'))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen({ host: '127.0.0.1', port, exclusive: true })
  })
}

async function preflight() {
  step('预检')

  if (!existsSync(path.join(ROOT, 'node_modules'))) {
    fail('没装依赖。', '先跑：pnpm install')
  }

  for (const [port, what] of [
    [SERVER_PORT, '控制面'],
    [WEB_PORT, '管理台（Vite）'],
  ]) {
    if (!(await checkPort(port))) {
      fail(
        `端口 ${port} 被占用（${what}）。`,
        `端口是写死的，换个端口前端入口就断了。找占用者：lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      )
    }
  }

  const docker = spawnSync('docker', ['info'], { stdio: 'ignore' })
  if (docker.error?.code === 'ENOENT') {
    fail('没找到 docker 命令。', '装 Docker Desktop：https://www.docker.com/products/docker-desktop/')
  }
  if (docker.status !== 0) {
    fail('Docker daemon 没在跑。', '启动 Docker Desktop 再试（控制面启动时也要连它，不能只在建实例时用）。')
  }

  const compose = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' })
  if (compose.status !== 0) {
    fail('docker compose 不可用。', '需要 Compose v2（Docker Desktop 自带）。')
  }

  log('  依赖 / 端口 / Docker 都就绪')
}

// ── apps/server/.env.local ────────────────────────────────────────────

function generateEnvFile() {
  const lines = [
    '# 由 `pnpm dev` 生成（scripts/dev.mjs），本地开发专用。已在 .gitignore 里。',
    '# 想重新生成（比如 secret 想换一把）：删掉本文件再跑 `pnpm dev`。',
    '',
    '# ── 本地入口栈（docker/compose/local.yml）对应的形态 ──',
    '# 域名走 *.lvh.me：公共通配 DNS 解析到 127.0.0.1，不需要本地 DNS。',
    'DATABASE_URL=postgres://dshcloud:dshcloud@127.0.0.1:55432/dsh_cloud',
    'BASE_DOMAIN=lvh.me',
    '# 控制台就是父域顶点。管理入口 https://lvh.me/admin ；console.lvh.me 只跳转过来。',
    'CONSOLE_DOMAIN=lvh.me',
    'PUBLIC_SCHEME=https',
    'TRAEFIK_ENTRYPOINT=websecure',
    '# 留空 = 不挂 ACME resolver，落到 Traefik 内置的默认自签证书（浏览器红锁，点继续）',
    'TRAEFIK_CERT_RESOLVER=',
    'FORWARD_AUTH_ADDRESS=http://host.docker.internal:3000/auth/verify',
    'TRAEFIK_ROUTES_PATH=./traefik-dynamic/routes.yml',
    'INSTANCE_IMAGE_REPO=ghcr.io/eskim2001/dsh-instance',
    '',
    '# ── 实例数据与入口 ──',
    '# 实例数据落在家目录：默认值是 /var/lib/dsh，给 Linux 生产用，macOS 上建不了。',
    `HOST_STORAGE_ROOT=${path.join(os.homedir(), 'dsh-data')}`,
    '# Traefik 跑在容器里，它自己的 127.0.0.1 不是宿主 —— 实例后端必须经 host.docker.internal，',
    '# 否则实例一律 502。',
    'INSTANCE_UPSTREAM_HOST=host.docker.internal',
    '',
    '# ── 随机生成，不打印 ──',
    `PLATFORM_SECRET=${randomBytes(32).toString('hex')}`,
    `BETTER_AUTH_SECRET=${randomBytes(32).toString('hex')}`,
    '',
    '# ── 首次 seed 的管理员；只在库里还没有管理员时创建 ──',
    `SEED_ADMIN_EMAIL=${DEV_ADMIN_EMAIL}`,
    `SEED_ADMIN_PASSWORD=${DEV_ADMIN_PASSWORD}`,
    'SEED_ADMIN_NAME=Admin',
    '',
  ]
  writeFileSync(ENV_PATH, lines.join('\n'))
}

function parseEnvFile(text) {
  const map = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return map
}

/** 已有文件一个字都不改——本地可能填了真东西（仓库、真实域名）。 */
function validateEnvFile(map) {
  const problems = []
  for (const key of ['DATABASE_URL', 'BASE_DOMAIN', 'CONSOLE_DOMAIN', 'PLATFORM_SECRET', 'BETTER_AUTH_SECRET']) {
    if (!map.get(key)) problems.push(`缺 ${key}`)
  }
  for (const key of ['PLATFORM_SECRET', 'BETTER_AUTH_SECRET']) {
    const value = map.get(key)
    if (value && value.length < 32) problems.push(`${key} 不足 32 字符（现在 ${value.length}）`)
  }
  const base = map.get('BASE_DOMAIN')
  const console_ = map.get('CONSOLE_DOMAIN')
  if (base && console_ && console_ !== base && !console_.endsWith(`.${base}`)) {
    problems.push(`CONSOLE_DOMAIN（${console_}）必须等于 BASE_DOMAIN（${base}），或是它的子域`)
  }
  return problems
}

function ensureEnvLocal() {
  step('环境变量 apps/server/.env.local')

  if (!existsSync(ENV_PATH)) {
    generateEnvFile()
    log('  已生成（含两个随机 secret）')
    return
  }

  const problems = validateEnvFile(parseEnvFile(readFileSync(ENV_PATH, 'utf8')))
  if (problems.length > 0) {
    fail(
      'apps/server/.env.local 已存在但不合格：',
      problems.map((p) => `- ${p}`).join('\n'),
    )
  }
  log('  已存在，校验通过（不改动）')
}

function readDevCredentials() {
  try {
    const map = parseEnvFile(readFileSync(ENV_PATH, 'utf8'))
    return {
      email: map.get('SEED_ADMIN_EMAIL') || DEV_ADMIN_EMAIL,
      password: map.get('SEED_ADMIN_PASSWORD') || DEV_ADMIN_PASSWORD,
      consoleDomain: map.get('CONSOLE_DOMAIN') || 'lvh.me',
    }
  } catch {
    return { email: DEV_ADMIN_EMAIL, password: DEV_ADMIN_PASSWORD, consoleDomain: 'lvh.me' }
  }
}

// ── compose ──────────────────────────────────────────────────────────

function compose(args, options = {}) {
  return spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], { cwd: ROOT, ...options })
}

function up() {
  step('启动 Postgres + 入口（Traefik）')

  const result = compose(['up', '-d'], { encoding: 'utf8' })
  if (result.stdout) process.stdout.write(result.stdout)

  if (result.status !== 0) {
    const err = result.stderr ?? ''
    if (/address already in use/i.test(err)) {
      fail(
        '宿主端口被占用（80 或 443）。',
        '找占用者：lsof -nP -iTCP:443 -sTCP:LISTEN（换 80 同理）',
      )
    }
    if (/already in use by container|Conflict/i.test(err)) {
      fail(
        '容器名冲突：已经有一个同名容器（可能是以前 `docker run` 留下的）。',
        '确认里面没有要留的数据后删掉：docker rm -f dsh-postgres dsh-ingress',
      )
    }
    process.stderr.write(err)
    fail('docker compose up 失败。')
  }
  log('  容器已就绪')
}

async function waitForPostgres() {
  step('等 Postgres 接受连接')

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    // 容器还没起来时 exec 会直接失败——那是「再等等」，不是致命错
    const probe = compose(['exec', '-T', PG_SERVICE, 'pg_isready', '-U', PG_USER, '-d', PG_DB], { stdio: 'ignore' })
    if (probe.status === 0) {
      log('  已就绪')
      return
    }
    await sleep(1000)
  }

  console.error(compose(['logs', '--tail=50', PG_SERVICE], { encoding: 'utf8' }).stdout ?? '')
  fail('Postgres 60 秒内没起来。', '数据卷还在，可以去看看上面日志里它为什么起不来。')
}

// ── 迁移 + seed ───────────────────────────────────────────────────────

function runPnpmScript(script, options = {}) {
  return spawnSync('pnpm', ['--filter', '@dsh-cloud/server', script], { cwd: ROOT, ...options })
}

function migrate() {
  step('跑数据库迁移')
  const result = runPnpmScript('db:migrate', { stdio: 'inherit', timeout: 120_000 })
  if (result.status !== 0) {
    fail('迁移失败。', '确认 DATABASE_URL 指向的是容器里的库（127.0.0.1:55432）。')
  }
}

/** 返回 'created' | 'skipped' | 'promoted' | 'unknown'。 */
function seed() {
  step('初始化管理员')

  const result = runPnpmScript('db:seed', { encoding: 'utf8', timeout: 120_000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  process.stdout.write(output)
  if (result.status !== 0) fail('seed 失败。')

  if (output.includes('已创建管理员')) return 'created'
  if (output.includes('提权为管理员')) return 'promoted'
  if (/\d+ 个管理员/.test(output)) return 'skipped'
  return 'unknown'
}

// ── 应用进程 ─────────────────────────────────────────────────────────

const children = []
let shuttingDown = false

function spawnChild(label, args) {
  const child = spawn('pnpm', args, {
    cwd: ROOT,
    // detached 是必须的：pnpm → tsx/node → vite 是一棵进程树，
    // 只有自己成了进程组组长，才杀得干净（只杀 pnpm 会留下孤儿）。
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const prefix = (stream, out) => {
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) out.write(`[${label}] ${line}\n`)
    })
  }
  prefix(child.stdout, process.stdout)
  prefix(child.stderr, process.stderr)

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`\n✖ [${label}] 退出了（code=${code} signal=${signal}），停掉其余进程。`)
    // 半死状态（一个在跑一个没了）比干净停止更难查，所以一起停
    shutdown(1)
  })

  children.push(child)
  return child
}

async function waitForConsole() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (shuttingDown) return false
    try {
      const res = await fetch(`http://127.0.0.1:${WEB_PORT}/`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return true
    } catch {
      // 还没起来
    }
    await sleep(500)
  }
  return false
}

async function shutdown(exitCode) {
  if (shuttingDown) return
  shuttingDown = true

  const stillRunning = () => children.some((c) => c.exitCode === null && c.signalCode === null)
  const signal = (sig) => {
    for (const child of children) {
      try {
        process.kill(-child.pid, sig)
      } catch {
        // 已经没了
      }
    }
  }

  signal('SIGTERM')
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && stillRunning()) await sleep(100)
  signal('SIGKILL')

  console.log('\n已停控制面和管理台。入口和 Postgres 还留着，下次 `pnpm dev` 秒起。')
  console.log('要停它们：pnpm dev:down')
  process.exit(exitCode)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// ── 主流程 ───────────────────────────────────────────────────────────

await preflight()
ensureEnvLocal()
up()
await waitForPostgres()
migrate()
const seedResult = seed()

step('起控制面和管理台')
log('  （改代码自动重启；Ctrl-C 停）\n')
spawnChild('server', ['--filter', '@dsh-cloud/server', 'dev:local'])
spawnChild('web', ['--filter', '@dsh-cloud/web', 'dev'])

if (!(await waitForConsole())) {
  // 等待期间按了 Ctrl-C：shutdown 已经在收尾，别再报一次错
  if (!shuttingDown) fail('管理台 30 秒内没起来。', '看看上面 [web] 的输出。')
} else {
  const { email, password, consoleDomain } = readDevCredentials()
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`  管理台：https://${consoleDomain}/admin`)
  console.log('  证书是 Traefik 的默认自签证书 → 浏览器会红锁，点「继续访问」。')
  if (seedResult === 'created') {
    console.log(`  登录：${email} / ${password}`)
  } else {
    console.log(`  登录：${email}（密码是库里已有的那个，seed 不改已存在用户的密码）`)
    console.log('        忘了密码就重置：docker compose -f docker/compose/local.yml down -v && rm apps/server/.env.local')
  }
  console.log(`${'─'.repeat(60)}\n`)
}
