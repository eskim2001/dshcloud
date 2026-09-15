import { dirname } from 'node:path'
import { createUserWithPassword } from './account.js'
import { buildApp } from './app.js'
import { createAuth } from './auth.js'
import { createDb } from './db/client.js'
import { listAllInstances, updateInstance } from './db/instance-repo.js'
import { deleteMetricsBefore, insertMetric } from './db/metric-repo.js'
import { getPlatformSetting, savePlatformDomains } from './db/platform-setting-repo.js'
import { createDocker } from './docker/client.js'
import { loadEnv, withPlatformDomains } from './env.js'
import { bootInstances } from './instance/boot.js'
import { DataStore } from './instance/data-store.js'
import { machineName } from '@dsh-cloud/instance-spec'
import { startMetricsSampler } from './instance/metrics-sampler.js'
import { InstanceOrchestrator } from './instance/orchestrator.js'
import { InstanceProvisioner } from './instance/provisioner.js'
import { platformRoutesHttpEntryPoint, projectPlatformRoutes } from './instance/platform-routes.js'
import { reconcileInstances } from './instance/reconciler.js'
import { syncRoutesFromInstances } from './instance/routes-sync.js'
import { ensureStoragePool } from './instance/pool.js'
import { DockerDriver } from './runtime/docker/driver.js'
import { LXCFS_FILES, detectLxcfsProc } from './runtime/docker/lxcfs.js'

const parsed = loadEnv()
const { db } = createDb(parsed.DATABASE_URL)

// 域名有两个来源：装机时写在 env 里（**优先**），或引导态里操作者在面板填、落在 DB。
// **必须在这里合成一次**，之后 createAuth / buildApp / 路由投影一律用这份生效的 `env`
// —— 否则 `trustedOrigins` 之类会拿空域名算出废值（`https://`），装完了也写不进东西。
const stored = await getPlatformSetting(db)
const { env, bootstrap } = withPlatformDomains(parsed, stored)

const auth = createAuth(env, db, { bootstrap })

// 数据池：实例数据是池子里的目录 + XFS project quota（硬限）。
//
// **起不来就别起** —— 池化的隔离是**逻辑隔离**（全靠配额真设上了），而 `xfs_quota limit`
// 在缺 CAP_SYS_ADMIN 时是**静默失败**。带着"看起来有配额"跑着，比直接报错糟得多。
const pool = await ensureStoragePool({
  root: env.HOST_STORAGE_ROOT,
  ...(env.HOST_POOL_SIZE_MB === undefined ? {} : { sizeMb: env.HOST_POOL_SIZE_MB }),
  // 平台镜像里 compose 会设它。容器内**只探针和设配额**，不建池 —— 建出来的宿主看不见（D35）。
  containerized: process.env.DSH_CONTAINERIZED === '1',
})
if (!pool.enforced) {
  console.warn(
    `⚠️ ${pool.detail}\n` +
      `   实例数据退回 Docker 命名卷：diskMb 只是**声明值**，不会被强制 —— 界面上的"配额"要标成"无上限"。`,
  )
}

// 宿主指纹：宿主装了 lxcfs 时，把它的假文件挂进实例容器，盖掉 `/proc` 里那几个**宿主全局**的数字
// （内存大小、启动时长、swap 设备）。**探测只在启动时做一次**；缺席是常态，没装的宿主上什么都不做。
const lxcfsProcDir = await detectLxcfsProc()
if (lxcfsProcDir !== null) {
  console.log(`proc 加固：宿主有 lxcfs，实例容器会盖住 ${LXCFS_FILES.join(' / ')}`)
}

// 运行时驱动是**唯一**接触具体运行时的接口（见 runtime/driver.ts）。
const driver = new DockerDriver({ pool, ...(lxcfsProcDir === null ? {} : { lxcfsProcDir }) })
const orchestrator = new InstanceOrchestrator(driver, env.INSTANCE_IMAGE_REPO)
// 数据卷是运行时的概念，原语在驱动上；DataStore 只留策略（见 instance/data-store.ts）。
const dataStore = new DataStore({ driver })

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
    ...(consoleDomain === undefined ? {} : { consoleDomain }),
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
  createDocker()
    .getContainer(self)
    .restart()
    .catch((err: unknown) => {
      console.warn(`自动重启失败（${messageOf(err)}）—— 请手动重启控制面，新域名才会生效。`)
    })
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
  reconcileTimer = setInterval(() => {
    void healOrphans()
      .then(() => reconcile())
      .catch((err: unknown) => {
        console.warn(`对账失败：${messageOf(err)}`)
      })
  }, 45_000)
  // 不 unref 的话进程退不掉、测试也会挂住
  reconcileTimer.unref()

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

// 引导态把控制面**直接开到对外**：此刻域名还不知道、证书更没影，操作者需要一个「打开就能用」
// 的地址（安装脚本会把它打印出来）。口子上只挂 setup 页、健康检查和控制台静态文件 —— 见 `app.ts`
// 里那段早返回，业务路由一条都不属于引导态。
//
// 配好域名后就回到 `127.0.0.1`。那是**默认**（控制面在宿主网络上，Traefik 走回环进来），
// 不是新增的限制 —— 引导态的开放在这条路径上是唯一的例外，也是它必须尽快收回的原因。
const listenHost = bootstrap ? '0.0.0.0' : '127.0.0.1'
await app.listen({ host: listenHost, port: env.PORT })

const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`收到 ${signal}，退出中`)
  // 引导态下这两个都没起（见上面那段），所以要判空
  if (reconcileTimer !== undefined) clearInterval(reconcileTimer)
  stopSampler?.()
  await app.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
