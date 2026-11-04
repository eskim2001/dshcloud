import { dirname } from 'node:path'
import { assertProductionConfig } from './production-config.js'
import { exchangeWorkspaceGrant, resolveWorkspaceSession, deleteExpiredWorkspaceAccess } from './db/workspace-access-repo.js'
import { workspaceToken } from './http/workspace-login.js'
import { createWorkspaceGateway } from './http/workspace-gateway.js'
import { findInstanceBySlug } from './db/instance-repo.js'
import { createUserWithPassword } from './account.js'
import { buildApp } from './app.js'
import { createAuth } from './auth.js'
import { createDb } from './db/client.js'
import { listAllInstances, updateInstance } from './db/instance-repo.js'
import { deleteMetricsBefore, insertMetric } from './db/metric-repo.js'
import { getPlatformSetting, savePlatformDomains } from './db/platform-setting-repo.js'
import { loadEnv, withPlatformDomains } from './env.js'
import { createActivityToucher } from './instance/activity.js'
import { bootInstances } from './instance/boot.js'
import { DataStore } from './instance/data-store.js'
import { selectIdleRunningInstances } from './instance/idle-cull.js'
import { startMetricsSampler } from './instance/metrics-sampler.js'
import { InstanceOrchestrator } from './instance/orchestrator.js'
import { InstanceProvisioner } from './instance/provisioner.js'
import { platformRoutesHttpEntryPoint, projectPlatformRoutes } from './instance/platform-routes.js'
import { reconcileInstances } from './instance/reconciler.js'
import { syncRoutesFromInstances } from './instance/routes-sync.js'
import { createLocalRuntime } from './runtime/local.js'
import { NodeRuntimeDriver } from './runtime/node/client.js'

const parsed = loadEnv()
assertProductionConfig(parsed, process.env.DSH_CONTAINERIZED === '1' || process.env.NODE_ENV === 'production')
const production = process.env.DSH_CONTAINERIZED === '1' || process.env.NODE_ENV === 'production'
const nodeSocket = process.env.DSH_NODE_SOCKET
if (production && !nodeSocket) throw new Error('Production control plane requires DSH_NODE_SOCKET')
const { db } = createDb(parsed.DATABASE_URL)

// 域名有两个来源：装机时写在 env 里（**优先**），或引导态里操作者在面板填、落在 DB。
// **必须在这里合成一次**，之后 createAuth / buildApp / 路由投影一律用这份生效的 `env`
// —— 否则 `trustedOrigins` 之类会拿空域名算出废值（`https://`），装完了也写不进东西。
const stored = await getPlatformSetting(db)
const { env, bootstrap } = withPlatformDomains(parsed, stored)

const auth = createAuth(env, db, { bootstrap })

const driver = nodeSocket ? new NodeRuntimeDriver(nodeSocket) : await createLocalRuntime({
  root: env.HOST_STORAGE_ROOT, containerized: false, production: false, selfContainer: '',
  ...(env.HOST_POOL_SIZE_MB === undefined ? {} : { sizeMb: env.HOST_POOL_SIZE_MB }),
})
if (driver instanceof NodeRuntimeDriver) await driver.ready()
const orchestrator = new InstanceOrchestrator(driver, env.INSTANCE_IMAGE_REPO)
// 数据卷是运行时的概念，原语在驱动上；DataStore 只留策略（见 instance/data-store.ts）。
const dataStore = new DataStore({ driver })

// 工作空间访问成功 → 刷新 lastActiveAt（≥60s 节流），供空闲回收用。
const touchActivity = createActivityToucher(async (id, at) => {
  await updateInstance(db, id, { lastActiveAt: at })
})

const gateway = createWorkspaceGateway({
  baseDomain: env.BASE_DOMAIN, consoleDomain: env.CONSOLE_DOMAIN,
  publicScheme: env.PUBLIC_SCHEME, gateSecret: env.PLATFORM_SECRET,
  findInstanceBySlug: slug => findInstanceBySlug(db, slug),
  findTargetPort: async slug => {
    const row = await findInstanceBySlug(db, slug)
    return row && !['provisioning', 'removing', 'stopped'].includes(row.status)
      ? row.hostPort ?? undefined : undefined
  },
  resolveUserId: async (cookie, slug) => {
    const token = workspaceToken(cookie, env.PUBLIC_SCHEME === 'https')
    if (!slug || !token) return undefined
    const row = await findInstanceBySlug(db, slug)
    return row ? resolveWorkspaceSession(db, token, row.id) : undefined
  },
  onAuthorized: (instance) => touchActivity(instance.id),
  login: {
    secure: env.PUBLIC_SCHEME === 'https',
    consoleOrigin: `${env.PUBLIC_SCHEME}://${env.CONSOLE_DOMAIN}`,
    exchange: async input => {
      const row = await findInstanceBySlug(db, input.slug)
      return row ? exchangeWorkspaceGrant(db, { ...input, instanceId: row.id }) : undefined
    },
  },
})
const credentialCleanup = setInterval(() => {
  void deleteExpiredWorkspaceAccess(db).catch(() => console.error('Workspace credential cleanup failed'))
}, 60_000)
credentialCleanup.unref()
// workspace-gateway 与控制面共用 `CONTROL_PLANE_LISTEN_HOST`（默认 0.0.0.0）。
// Traefik 经 host.docker.internal:gatewayPort 反代到这里；Linux host-gateway 摸不到
// 宿主 loopback，硬绑 127.0.0.1 会让实例工作空间 502。Docker Desktop 可改回 127.0.0.1。
// 勿与实例内 dsh `web --host`（保持 127.0.0.1）混淆——那是容器内回环，不是这条宿主绑定。
await new Promise<void>((resolve, reject) => {
  gateway.once('error', reject)
  gateway.listen(0, env.CONTROL_PLANE_LISTEN_HOST, resolve)
})
const gatewayPort = (gateway.address() as import('node:net').AddressInfo).port

const routesConfigPath = process.env.TRAEFIK_ROUTES_PATH ?? '/etc/traefik/dynamic/routes.yml'
const forwardAuthAddress =
  process.env.FORWARD_AUTH_ADDRESS ?? `http://127.0.0.1:${env.PORT}/auth/verify`

// 明文档（本地 `web` entryPoint）不挂 tls；https 档必须挂，否则 Traefik 在 443 上
// 收不到这个 router（entryPoint 开了 TLS 不代表 router 自动有）。
const instanceTls: { certResolver?: string } | undefined =
  env.PUBLIC_SCHEME === 'https'
    ? env.TRAEFIK_CERT_RESOLVER === ''
      ? {}
      : { certResolver: env.TRAEFIK_CERT_RESOLVER }
    : undefined

const syncRoutes = async (): Promise<void> => {
  const instances = await listAllInstances(db)
  // 路由判据是**运行时事实**（见 routableInstances）：读不到就省略，函数会退回 DB 意图
  const containerStates = await orchestrator.listInstanceStates().catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`读实例实时状态失败，路由这次按 DB 意图投影：${detail}`)
    return undefined
  })
  await syncRoutesFromInstances(instances, {
    configPath: routesConfigPath,
    baseDomain: env.BASE_DOMAIN,
    forwardAuthAddress,
    gatewayAddress: `http://${env.INSTANCE_UPSTREAM_HOST}:${gatewayPort}`,
    upstreamHost: env.INSTANCE_UPSTREAM_HOST,
    entryPoint: env.TRAEFIK_ENTRYPOINT,
    ...(instanceTls === undefined ? {} : { tls: instanceTls }),
    ...(containerStates === undefined ? {} : { containerStates }),
  })
}

const provisioner = new InstanceProvisioner(db, orchestrator, dataStore, env, syncRoutes)

/**
 * 投影平台自己的三条路由（控制台 / `:80` 跳转 / 引导口）。
 *
 * **只有平台镜像会写**：本地开发的控制台由 Vite 提供、文件在仓库里（`dynamic-dev/platform.yml`），
 * 控制面插一脚只会打架。门槛就用 `WEB_DIST_DIR` —— 与 `app.ts` 注册控制台静态文件**同一个条件**
 * （"我自己 serve 控制台" 才意味着"路由也该我写"）。
 *
 * 引导态与已配置态都跑，靠状态对齐（幂等）：这样上一轮半途挂了也不会把明文 catch-all 留在 `:80` 上。
 */
const projectPlatform = async (consoleDomain: string | undefined): Promise<void> => {
  if (env.WEB_DIST_DIR === '') return
  const removed = await projectPlatformRoutes({
    dir: dirname(routesConfigPath),
    selfPort: env.PORT,
    ...(consoleDomain === undefined
      ? {}
      : { consoleDomain, ...(env.BASE_DOMAIN === '' ? {} : { baseDomain: env.BASE_DOMAIN }) }),
    entryPoint: env.TRAEFIK_ENTRYPOINT,
    httpEntryPoint: platformRoutesHttpEntryPoint,
    upstreamHost: env.INSTANCE_UPSTREAM_HOST,
    ...(instanceTls === undefined ? {} : { tls: instanceTls }),
  })
  if (removed.length > 0) console.log(`平台路由已按当前状态对齐，删掉：${removed.join('、')}`)
}

/**
 * 重启控制面**自己**。
 *
 * 配完域名要让新身份生效（cookie 域、better-auth 的 baseURL 都是**启动期**配置），而
 * `restart` 不会改环境变量 —— 所以流程是：先落库、先投影（暴露当场关闭），再重启读新值。
 *
 * 失败只告警：投影已经做完了，最坏情况是控制台要等下一次重启才认得新域名。
 */
const restartSelf = (): void => {
  const self = env.SELF_CONTAINER
  if (self === '') {
    console.warn('没配 SELF_CONTAINER，无法自动重启 —— 请手动重启控制面，新域名才会生效。')
    return
  }
  // The container supervisor restarts us; the public control plane must not own Docker credentials.
  process.kill(process.pid, 'SIGTERM')
}

/**
 * 把 DB 状态拉回和运行时一致，变了就重新投影一次路由。对账是**只读 + 状态修正**：
 * 不改机器，孤儿只告警。
 */
const reconcile = async (): Promise<void> => {
  const { changed } = await reconcileInstances({
    listInstances: () => listAllInstances(db),
    inspectStatus: (name) => orchestrator.inspectStatus(name),
    update: (id, patch) => updateInstance(db, id, patch),
    listInstanceNames: () => orchestrator.listInstanceNames(),
    warn: (msg) => console.warn(msg),
  })
  if (changed > 0) await syncRoutes()
}

/**
 * 周期性的孤儿清理。
 *
 * 以前这里还带一个 `sync` —— microVM 时代靠它把 guest 内的写入回传宿主，两次之间的
 * 写入在异常掉电时会丢。数据改成「运行时管理的卷」之后就没有「回传」这回事了：写入直接
 * 落在卷上，没有窗口可压缩。所以只剩 `heal`。
 *
 * **尽力而为**：失败只告警，不影响对账主流程。
 */
const healOrphans = async (): Promise<void> => {
  await orchestrator.heal().catch((err: unknown) => {
    console.warn(`清理孤儿失败：${messageOf(err)}`)
  })
}

const app = await buildApp({
  env,
  db,
  auth,
  provisioner,
  orchestrator,
  dataStore,
  logger: true,
  bootstrap,
  onWorkspaceAuthorized: touchActivity,
  // 只有引导态才把 setup 那条路接上；已配置时省掉它 ⇒ setup-routes 走「已配置」的默认行为
  ...(bootstrap
    ? {
        setup: {
          configured: false,
          token: env.SETUP_TOKEN,
          saveDomains: async (domains: { baseDomain: string; consoleDomain: string }) => {
            await savePlatformDomains(db, domains)
            // **先关暴露**：投影会把 `:80` 上的明文引导口摘掉。即使下面那次重启失败，
            // 暴露也已经关了 —— 顺序不能倒过来。
            await projectPlatform(domains.consoleDomain)
          },
          // 首个管理员由**向导**建（装机时不再问邮箱/密码）。走的是平台建号的唯一入口，
          // 与邀请兑换同一条路：绕过注册开关，也不需要已有会话。
          createAdmin: async ({ email, password }: { email: string; password: string }) => {
            await createUserWithPassword(auth, { email, password, role: 'admin' })
          },
          restart: restartSelf,
        },
      }
    : {}),
})

// 下面一整段只有**配好域名**才做。引导态连域名都没有：实例的位置要靠子域，谁也建不了实例
// （那时只有 token 门保护的 setup 页）。硬跑只会拿空域名拼出一堆没意义的路由。
let reconcileTimer: NodeJS.Timeout | undefined
let idleCullTimer: NodeJS.Timeout | undefined
let stopSampler: (() => void) | undefined

if (bootstrap) {
  console.warn('平台还没配置域名 —— 引导态：只暴露 token 门保护的 setup 页（地址见安装脚本的输出）。')
} else {
  // 启动顺序：① 校验数据目录 → ② 拉起 DB 里 running 的实例 → ③ 对账 → ④ 投影路由。
  // ② 必须在 ③ 之前：运行时不会在宿主重启后自动拉起实例，先对账会把「应该在跑」的全抹成 stopped。
  await bootInstances({
    listInstances: () => listAllInstances(db),
    ensure: (storageKey) => dataStore.ensure(storageKey),
    start: (id) => provisioner.start(id).then(() => undefined),
    markError: async (id, message) => {
      await updateInstance(db, id, { status: 'error', lastError: message })
    },
    warn: (msg) => console.warn(msg),
  })

  await reconcile()
  await syncRoutes()

  // 外部改动（宿主重启、手动删机器、被 prune）只能靠定时对账收敛
  let reconciliationPending = false
  reconcileTimer = setInterval(() => {
    // A long lifecycle operation can hold the queue across many timer ticks.
    if (reconciliationPending) return
    reconciliationPending = true
    void healOrphans()
      .then(() => reconcile())
      .catch((err: unknown) => {
        console.warn(`对账失败：${messageOf(err)}`)
      })
      .finally(() => { reconciliationPending = false })
  }, 45_000)
  // 不 unref 的话进程退不掉、测试也会挂住
  reconcileTimer.unref()

  // 空闲回收：停掉「running 且 lastActiveAt 过旧」的实例，给小机腾 running 名额。
  // `PLATFORM_IDLE_CULL_MINUTES=0` 关闭。失败只告警，不挡对账。
  if (env.PLATFORM_IDLE_CULL_MINUTES > 0) {
    let idleCullPending = false
    idleCullTimer = setInterval(() => {
      if (idleCullPending) return
      idleCullPending = true
      void (async () => {
        const idle = selectIdleRunningInstances(await listAllInstances(db), {
          idleMinutes: env.PLATFORM_IDLE_CULL_MINUTES,
        })
        for (const row of idle) {
          console.warn(
            `空闲回收：停止工作空间 ${row.slug}（超过 ${env.PLATFORM_IDLE_CULL_MINUTES} 分钟无访问）`,
          )
          await provisioner.stop(row.id).catch((err: unknown) => {
            console.warn(`空闲回收失败（${row.slug}）：${messageOf(err)}`)
          })
        }
      })()
        .catch((err: unknown) => {
          console.warn(`空闲回收轮询失败：${messageOf(err)}`)
        })
        .finally(() => {
          idleCullPending = false
        })
    }, 60_000)
    idleCullTimer.unref()
  }

  // 用量采样：一分钟一轮，顺带清理 30 天前的点。
  // Docker 原生给 stats，所以 CPU / 内存和磁盘用量都能采到。
  stopSampler = startMetricsSampler({
    listRunning: async () => (await listAllInstances(db)).filter((r) => r.status === 'running'),
    stats: (machineNameOrId) => orchestrator.stats(machineNameOrId),
    disk: (storageKey) => dataStore.usage(storageKey),
    insert: (metric) => insertMetric(db, metric),
    deleteBefore: (cutoff) => deleteMetricsBefore(db, cutoff),
    warn: (msg) => console.warn(msg),
  })
}

// 平台自己的三条路由要在**开始服务之前**就位：引导口的文件不先落地，操作者打开 :80 什么也看不到。
await projectPlatform(bootstrap ? undefined : env.CONSOLE_DOMAIN)

// 监听地址见 `CONTROL_PLANE_LISTEN_HOST`（默认 0.0.0.0）。
//
// Docker Desktop 上绑 127.0.0.1 时，容器经 host.docker.internal 仍能摸到宿主回环；
// Linux Docker 的 host-gateway（如 172.17.0.1）**到不了** loopback —— Traefik 在容器、
// 控制面在宿主时必须绑 0.0.0.0（或真实宿主 IP）。生产仍应由反向代理对外，
// 勿把控制面业务口直接暴露公网（见 docs/FORK.md）。
const listenHost = env.CONTROL_PLANE_LISTEN_HOST
await app.listen({ host: listenHost, port: env.PORT })

const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`收到 ${signal}，退出中`)
  // 引导态下这些定时器都没起（见上面那段），所以要判空
  if (reconcileTimer !== undefined) clearInterval(reconcileTimer)
  if (idleCullTimer !== undefined) clearInterval(idleCullTimer)
  stopSampler?.()
  await app.close()
  clearInterval(credentialCleanup)
  await gateway.shutdown()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
