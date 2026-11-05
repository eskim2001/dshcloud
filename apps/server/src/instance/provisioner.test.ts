import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceRow } from '../db/schema.js'
import type { Env } from '../env.js'
import type { DataStore } from './data-store.js'
import type { InstanceOrchestrator } from './orchestrator.js'
import { gateToken } from './gate-token.js'
import {
  ImageRejectedError,
  ImageUpgradeFailedError,
  InstanceProvisioner,
  MaxRunningExceededError,
  NoRollbackError,
  SlugConfirmMismatchError,
} from './provisioner.js'

vi.mock('../db/instance-repo.js', () => ({
  findInstanceById: vi.fn(),
  listAllInstances: vi.fn(async () => []),
  updateInstance: vi.fn(),
  countInstancesByOwner: vi.fn(),
  countRunningInstances: vi.fn(async () => 0),
  createInstanceRecord: vi.fn(),
  retainInstanceRecord: vi.fn(),
  QuotaExceededError: class QuotaExceededError extends Error {},
}))
vi.mock('../db/user-repo.js', () => ({ findUserQuota: vi.fn() }))
vi.mock('../db/image-release-repo.js', () => ({
  findDefaultImageRelease: vi.fn(),
  isImageRelease: vi.fn(),
}))
vi.mock('../db/image-catalog-repo.js', () => ({ isImageInCatalog: vi.fn() }))
vi.mock('../model-credentials/load.js', () => ({
  readOwnerModelRefs: vi.fn(async () => ({})),
  readOwnerCustomModel: vi.fn(async () => null),
}))

const {
  findInstanceById,
  updateInstance,
  createInstanceRecord,
  retainInstanceRecord,
  countRunningInstances,
} = await import('../db/instance-repo.js')
const { findDefaultImageRelease, isImageRelease } = await import('../db/image-release-repo.js')
const { isImageInCatalog } = await import('../db/image-catalog-repo.js')
const findById = vi.mocked(findInstanceById)
const update = vi.mocked(updateInstance)
const countRunning = vi.mocked(countRunningInstances)
const findDefaultRelease = vi.mocked(findDefaultImageRelease)
const isPublished = vi.mocked(isImageRelease)
const inCatalog = vi.mocked(isImageInCatalog)
const { readOwnerCustomModel, readOwnerModelRefs } = await import('../model-credentials/load.js')
const readRefs = vi.mocked(readOwnerModelRefs)
const readCustom = vi.mocked(readOwnerCustomModel)

const env = {
  BASE_DOMAIN: 'app.example.com',
  CONSOLE_DOMAIN: 'console.app.example.com',
  PLATFORM_SECRET: 'test-secret',
  MAX_INSTANCES_PER_USER: 3,
  INSTANCE_IMAGE_REPO: 'dsh-instance',
  PLATFORM_MAX_RUNNING: 3,
} as Env

/** 升级目标：已发布的那一版。 */
const NEW_IMAGE = 'dsh-instance:0.1.1_1'
const DEFAULT_REF = 'dsh-instance:0.1.0_1'

function row(over: Partial<InstanceRow> = {}): InstanceRow {
  return {
    id: 'i-1',
    slug: 'alice',
    storageKey: 'alice',
    deletedAt: null,
    ownerId: 'u1',
    status: 'running',
    image: 'dsh-instance:0.1.0_1',
    previousImage: null,
    containerId: 'c-1',
    hostPort: null,
    cpus: 1,
    memoryMb: 2048,
    pidsLimit: 512,
    diskMb: 10_240,
    lastError: null,
    stoppedAt: null,
    lastActiveAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }
}

interface Fakes {
  dataStore: DataStore
  orchestrator: InstanceOrchestrator
  syncRoutes: () => Promise<void>
  calls: {
    createData: ReturnType<typeof vi.fn>
    ensure: ReturnType<typeof vi.fn>
    chown: ReturnType<typeof vi.fn>
    usage: ReturnType<typeof vi.fn>
    snapshot: ReturnType<typeof vi.fn>
    restoreSnapshot: ReturnType<typeof vi.fn>
    finishRestore: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    stopInstance: ReturnType<typeof vi.fn>
    removeInstance: ReturnType<typeof vi.fn>
    startInstance: ReturnType<typeof vi.fn>
    resizeStorage: ReturnType<typeof vi.fn>
    createInstance: ReturnType<typeof vi.fn>
    inspectStatus: ReturnType<typeof vi.fn>
    listImageTags: ReturnType<typeof vi.fn>
    ensureImage: ReturnType<typeof vi.fn>
    syncRoutes: ReturnType<typeof vi.fn>
    seedCredentials: ReturnType<typeof vi.fn>
    seedPatch: ReturnType<typeof vi.fn>
  }
}

function build(): Fakes {
  const createData = vi.fn(async () => undefined)
  const ensure = vi.fn(async () => undefined)
  const chown = vi.fn(async () => undefined)
  const usage = vi.fn(async () => ({ usedMb: 100 }))
  const snapshot = vi.fn(async () => undefined)
  const restoreSnapshot = vi.fn(async () => undefined)
  const finishRestore = vi.fn(async () => undefined)
  const destroy = vi.fn(async () => undefined)
  const snapshotUsage = vi.fn(async () => undefined)
  const seedCredentials = vi.fn(async () => false)
  const seedPatch = vi.fn(async () => false)

  const stopInstance = vi.fn(async () => undefined)
  const removeInstance = vi.fn(async () => undefined)
  const startInstance = vi.fn(async () => undefined)
  const resizeStorage = vi.fn(async () => undefined)
  const inspectStatus = vi.fn(async () => 'running')
  const listImageTags = vi.fn(async () => ['dsh-instance:0.1.0_1', 'dsh-instance:0.1.1_1'])
  const ensureImage = vi.fn(async () => undefined)
  const syncRoutes = vi.fn(async () => undefined)

  // 返回的形状是**运行时中立**的 `RenderedInstance` + 状态：不再有 containerName /
  // networkName / containerPort 这些容器概念，身份是 machineName。
  const createInstance = vi.fn(async () => ({
    slug: 'alice',
    machineName: 'dsh-instance-alice',
    hostname: 'alice.app.example.com',
    image: 'dsh-instance:0.1.0_1',
    user: '502',
    workingDir: '/data/home/workspace',
    env: [],
    guestPort: 8080,
    hostPort: 20001,
    guestDataDir: '/data',
    cpus: 1,
    memoryMb: 2048,
    pidsLimit: 512,
    mounts: [],
    labels: {},
    status: 'running',
  }))

  const dataStore = {
    create: createData,
    ensure,
    chown,
    usage,
    dir: (key: string) => `/var/lib/dsh/${key}`,
    snapshot,
    restoreSnapshot,
    finishRestore,
    snapshotUsage,
    destroy,
    seedCredentialsFileIfAbsent: seedCredentials,
    seedCordisPatchIfAbsent: seedPatch,
    ownerId: '502',
  } as unknown as DataStore

  const orchestrator = {
    // 让准入逻辑照常跑「本地有没有」那一关（真运行时为 false 时才跳过）
    canReportLocalImages: true,
    createInstance,
    stopInstance,
    removeInstance,
    startInstance,
    resizeStorage,
    inspectStatus,
    listImageTags,
    ensureImage,
  } as unknown as InstanceOrchestrator

  return {
    dataStore,
    orchestrator,
    syncRoutes,
    calls: {
      createData,
      ensure,
      chown,
      usage,
      snapshot,
      restoreSnapshot,
      finishRestore,
      destroy,
      stopInstance,
      removeInstance,
      startInstance,
      resizeStorage,
      createInstance,
      inspectStatus,
      listImageTags,
      ensureImage,
      syncRoutes,
      seedCredentials,
      seedPatch,
    },
  }
}

function makeProvisioner(fakes: Fakes): InstanceProvisioner {
  return new InstanceProvisioner(
    {} as never,
    fakes.orchestrator,
    fakes.dataStore,
    env,
    fakes.syncRoutes,
  )
}

const quota = { cpus: 1, memoryMb: 2048, pidsLimit: 512, diskMb: 10_240 }

beforeEach(() => {
  vi.clearAllMocks()
  readRefs.mockResolvedValue({})
  readCustom.mockResolvedValue(null)
  update.mockImplementation(async (_db, _id, patch) => ({ ...row(), ...patch }) as InstanceRow)
  countRunning.mockResolvedValue(0)
  // 库里有一个默认版本，且任何目标都算「已发布」——要测拒绝的用例自己覆盖
  findDefaultRelease.mockResolvedValue({
    id: 'r-1',
    ref: DEFAULT_REF,
    isDefault: true,
    publishedAt: new Date(0),
  })
  isPublished.mockResolvedValue(true)
  // 默认 catalog 里没有目标版本——要测「catalog 里有」的用例自己覆盖
  inCatalog.mockResolvedValue(false)
})

describe('全局同时 running 上限', () => {
  it('create 时已满 → MaxRunningExceededError，不落库', async () => {
    countRunning.mockResolvedValue(3)
    const fakes = build()
    await expect(
      makeProvisioner(fakes).create({ slug: 'alice', ownerId: 'u1', ...quota }),
    ).rejects.toBeInstanceOf(MaxRunningExceededError)
    expect(createInstanceRecord).not.toHaveBeenCalled()
  })

  it('start 已 stopped、名额已满 → 拒绝；已 running 的 start 不占新名额', async () => {
    countRunning.mockResolvedValue(3)
    findById.mockResolvedValue(row({ status: 'stopped', containerId: 'c-1' }))
    const fakes = build()
    await expect(makeProvisioner(fakes).start('i-1')).rejects.toBeInstanceOf(MaxRunningExceededError)

    findById.mockResolvedValue(row({ status: 'running', containerId: 'c-1' }))
    await expect(makeProvisioner(fakes).start('i-1')).resolves.toBeTruthy()
  })

  it('PLATFORM_MAX_RUNNING=0 → 不限制', async () => {
    countRunning.mockResolvedValue(99)
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ storageKey: 'k' }))
    const fakes = build()
    const p = new InstanceProvisioner(
      {} as never,
      fakes.orchestrator,
      fakes.dataStore,
      { ...env, PLATFORM_MAX_RUNNING: 0 },
      fakes.syncRoutes,
    )
    await expect(p.create({ slug: 'alice', ownerId: 'u1', ...quota })).resolves.toBeTruthy()
  })
})

describe('storage ownership across lifecycle operations', () => {
  it('creates data at the reserved storage key, never the public slug', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ storageKey: 'unique-data-key' }))
    const fakes = build()
    await makeProvisioner(fakes).create({ slug: 'alice', ownerId: 'u1', ...quota })
    expect(createInstanceRecord).toHaveBeenCalledWith({}, expect.objectContaining({ ownerId: 'u1' }), 3)
    expect(fakes.dataStore.create).toHaveBeenCalledWith('unique-data-key', quota.diskMb)
    expect(fakes.calls.createInstance).toHaveBeenCalledWith(expect.objectContaining({ slug: 'alice' }), expect.objectContaining({ storageKey: 'unique-data-key' }))
  })

  it('重建都先迁属主，且**早于建容器**', async () => {
    // 属主不对不会当场报错：实例起得来、入口也应答，agent 跑到一半才写不了盘
    // —— 所以既盯"调没调"，也盯"在不在建容器之前"。
    findById.mockResolvedValue(
      row({ storageKey: 'unique-data-key', containerId: null, status: 'stopped' }),
    )
    const fakes = build()
    await makeProvisioner(fakes).start('i-1')

    expect(fakes.calls.chown).toHaveBeenCalledWith('unique-data-key')
    const chownAt = fakes.calls.chown.mock.invocationCallOrder[0] ?? -1
    const createAt = fakes.calls.createInstance.mock.invocationCallOrder[0] ?? -1
    expect(fakes.calls.stopInstance).toHaveBeenCalledWith('dsh-instance-alice')
    expect(fakes.calls.stopInstance.mock.invocationCallOrder[0]).toBeLessThan(chownAt)
    expect(chownAt).toBeLessThan(createAt)
  })

  it('停机失败则不迁属主，也不建立替代容器', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.stopInstance.mockRejectedValueOnce(new Error('stop failed'))
    await expect(makeProvisioner(fakes).restart('i-1')).rejects.toThrow('stop failed')
    expect(fakes.calls.chown).not.toHaveBeenCalled()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
  })

  it('删除 = 数据真删（含快照），只把行留成主机名占位', async () => {
    findById.mockResolvedValue(row({ storageKey: 'unique-data-key' }))
    const fakes = build()
    await makeProvisioner(fakes).remove('i-1', { confirmSlug: 'alice' })
    expect(fakes.dataStore.destroy).toHaveBeenCalledWith('unique-data-key')
    expect(retainInstanceRecord).toHaveBeenCalledWith({}, 'i-1')
  })

  it('子域名对不上 → 拒绝，且什么都不动（容器、数据、路由都在）', async () => {
    findById.mockResolvedValue(row({ storageKey: 'unique-data-key' }))
    const fakes = build()
    await expect(
      makeProvisioner(fakes).remove('i-1', { confirmSlug: '不是这个名字' }),
    ).rejects.toThrow(SlugConfirmMismatchError)
    expect(fakes.dataStore.destroy).not.toHaveBeenCalled()
    expect(fakes.calls.removeInstance).not.toHaveBeenCalled()
    expect(fakes.calls.syncRoutes).not.toHaveBeenCalled()
  })

  it('uses the same storage key for upgrade snapshots, rollback and rebuild', async () => {
    statefulDb(row({ storageKey: 'unique-data-key' }))
    const fakes = build()
    const provisioner = makeProvisioner(fakes)
    await provisioner.setImage('i-1', NEW_IMAGE)
    await provisioner.rollbackImage('i-1')
    expect(fakes.calls.snapshot).toHaveBeenCalledWith('unique-data-key')
    expect(fakes.calls.restoreSnapshot).toHaveBeenCalledWith('unique-data-key')
    expect(fakes.calls.ensure).toHaveBeenCalledWith('unique-data-key')
    expect(fakes.calls.createInstance).toHaveBeenLastCalledWith(expect.objectContaining({ slug: 'alice' }), expect.objectContaining({ storageKey: 'unique-data-key' }))
  })
})

describe('存量实例的 slug 落进保留字表之后', () => {
  // 保留字是**创建期命名政策**。对库里已有的行再判一次，会让扩表把存量实例变成
  // 「打不开也删不掉」——所以这里盯住：slug 是保留字，生命周期照样走完。
  it('删除照常走完，不因为 slug 是保留字而失败', async () => {
    findById.mockResolvedValue(row({ slug: 'test', storageKey: 'unique-data-key' }))
    const fakes = build()
    await makeProvisioner(fakes).remove('i-1', { confirmSlug: 'test' })
    expect(fakes.dataStore.destroy).toHaveBeenCalledWith('unique-data-key')
    expect(retainInstanceRecord).toHaveBeenCalledWith({}, 'i-1')
  })

  it('start 照常按规格重建容器', async () => {
    findById.mockResolvedValue(row({ slug: 'test', containerId: null, status: 'stopped' }))
    const fakes = build()
    await makeProvisioner(fakes).start('i-1')
    expect(fakes.calls.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'test' }),
      expect.anything(),
    )
  })
})

describe('新建：镜像取自库里的默认版本（D21）', () => {
  it('落库的是默认版本那一行', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ image: DEFAULT_REF }))
    const fakes = build()
    await makeProvisioner(fakes).create({ slug: 'alice', ownerId: 'u1', ...quota })
    expect(createInstanceRecord).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ image: DEFAULT_REF }),
      3,
    )
  })

  it('库里没有默认版本 → 响亮失败，不落库也不起容器', async () => {
    findDefaultRelease.mockResolvedValue(undefined)
    const fakes = build()
    await expect(
      makeProvisioner(fakes).create({ slug: 'alice', ownerId: 'u1', ...quota }),
    ).rejects.toThrow(ImageRejectedError)
    expect(createInstanceRecord).not.toHaveBeenCalled()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
  })

  it('自选版本 → 用自选的那一版，默认版本不参与', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ image: NEW_IMAGE }))
    const fakes = build()
    await makeProvisioner(fakes).create({
      slug: 'alice',
      ownerId: 'u1',
      ...quota,
      image: NEW_IMAGE,
    })
    expect(createInstanceRecord).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ image: NEW_IMAGE }),
      3,
    )
  })

  it('自选版本不要求宿主已有（D23：创建本来就会自动拉）', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ image: NEW_IMAGE }))
    const fakes = build()
    fakes.calls.listImageTags.mockResolvedValue([])
    await makeProvisioner(fakes).create({
      slug: 'alice',
      ownerId: 'u1',
      ...quota,
      image: NEW_IMAGE,
    })
    expect(fakes.calls.createInstance).toHaveBeenCalled()
  })

  it('自选未发布的版本 → 拒绝，不落库', async () => {
    isPublished.mockResolvedValue(false)
    const fakes = build()
    await expect(
      makeProvisioner(fakes).create({
        slug: 'alice',
        ownerId: 'u1',
        ...quota,
        image: 'dsh-instance:9.9.9_1',
      }),
    ).rejects.toThrow(ImageRejectedError)
    expect(createInstanceRecord).not.toHaveBeenCalled()
  })

  it('自选别的仓库 → 拒绝', async () => {
    const fakes = build()
    await expect(
      makeProvisioner(fakes).create({
        slug: 'alice',
        ownerId: 'u1',
        ...quota,
        image: 'docker.io/evil/dsh-instance:0.1.1_1',
      }),
    ).rejects.toThrow(ImageRejectedError)
    expect(createInstanceRecord).not.toHaveBeenCalled()
  })
})

describe('改配额：磁盘（池化之后扩和缩都在线改，不用重建容器）', () => {
  it('扩容 → 只改限额，不重建容器', async () => {
    findById.mockResolvedValue(row({ storageKey: 'unique-data-key' }))
    const fakes = build()

    await makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 20_480 })

    // 配额是文件系统上的一个数字（XFS project quota），改它不需要碰容器/数据
    expect(fakes.calls.resizeStorage).toHaveBeenCalledWith('unique-data-key', 20_480)
    expect(fakes.calls.removeInstance).not.toHaveBeenCalled()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalled()
  })

  it('缩容也允许 —— 已用超了新上限时表现为「拒绝再写」，数据不丢', async () => {
    findById.mockResolvedValue(row({ storageKey: 'unique-data-key' }))
    const fakes = build()

    await makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 1_024 })

    expect(fakes.calls.resizeStorage).toHaveBeenCalledWith('unique-data-key', 1_024)
    expect(update).toHaveBeenCalled()
  })

  it('改盘失败 → **不落库**（别把新容量写进库里、而盘上还是老的）', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.resizeStorage.mockRejectedValueOnce(new Error('xfs_quota: not permitted'))

    await expect(
      makeProvisioner(fakes).setQuota('i-1', { ...quota, diskMb: 20_480 }),
    ).rejects.toThrow('not permitted')
    expect(update).not.toHaveBeenCalled()
  })
})

describe('改配额：计算资源变化', () => {
  it('CPU 变了 → 删旧机器并按新规格重建', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    await makeProvisioner(fakes).setQuota('i-1', { ...quota, cpus: 2 })

    // 机器名由 slug 现算，不再拿容器 id
    expect(fakes.calls.removeInstance).toHaveBeenCalledWith('dsh-instance-alice')
    expect(fakes.calls.createInstance).toHaveBeenCalled()
    expect(fakes.calls.resizeStorage).not.toHaveBeenCalled()
  })

  it('什么都没变 → 只落库，不碰运行时', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    await makeProvisioner(fakes).setQuota('i-1', quota)

    expect(fakes.calls.stopInstance).not.toHaveBeenCalled()
    expect(fakes.calls.removeInstance).not.toHaveBeenCalled()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
    expect(fakes.calls.resizeStorage).not.toHaveBeenCalled()
  })
})

/**
 * 让假 DB 记住写入——升级→失败→自动回滚这条链要读好几次行，
 * 常量 mock 会让回滚读到「还没有 previous_image」的旧行。
 */
function statefulDb(initial: InstanceRow): { current: () => InstanceRow } {
  let state = initial
  findById.mockImplementation(async () => state)
  update.mockImplementation(async (_db, _id, patch) => {
    state = { ...state, ...patch } as InstanceRow
    return state
  })
  return { current: () => state }
}

describe('换镜像：准入', () => {
  it('没发布过 → 拒绝，什么都没动', async () => {
    findById.mockResolvedValue(row())
    isPublished.mockResolvedValue(false)
    const fakes = build()

    await expect(makeProvisioner(fakes).setImage('i-1', 'dsh-instance:0.9.9')).rejects.toThrow(
      ImageRejectedError,
    )
    expect(fakes.calls.removeInstance).not.toHaveBeenCalled()
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('不是平台自己的镜像仓库 → 拒绝（挡住「换成别人的镜像」）', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()

    await expect(
      makeProvisioner(fakes).setImage('i-1', 'evil/backdoor:latest'),
    ).rejects.toThrow(/只能换成平台的实例镜像/)
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
  })

  it('tag 不是发布序列的形状 → 拒绝（公开仓库里谁都能推 :latest）', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.listImageTags.mockResolvedValue(['dsh-instance:latest'])

    await expect(
      makeProvisioner(fakes).setImage('i-1', 'dsh-instance:latest'),
    ).rejects.toThrow(/不符合发布序列/)
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
  })

  it('宿主上没有、catalog 里也没有 → 拒绝', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.listImageTags.mockResolvedValue(['dsh-instance:0.1.0_1'])

    await expect(
      makeProvisioner(fakes).setImage('i-1', NEW_IMAGE, { allowAny: true }),
    ).rejects.toThrow(/这一版在平台侧暂时不可用/)
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
  })

  it('管理员 allowAny：catalog 里有但宿主上没有 → 放行（真正用到时自动拉）', async () => {
    const db = statefulDb(row())
    const fakes = build()
    fakes.calls.listImageTags.mockResolvedValue(['dsh-instance:0.1.0_1'])
    inCatalog.mockResolvedValue(true)

    const updated = await makeProvisioner(fakes).setImage('i-1', 'dsh-instance:0.1.2_1', {
      allowAny: true,
    })
    expect(updated.image).toBe('dsh-instance:0.1.2_1')
    expect(db.current().image).toBe('dsh-instance:0.1.2_1')
    expect(fakes.calls.snapshot).toHaveBeenCalledWith('alice')
  })

  it('用户面不吃 catalog 兜底：宿主上没有就拒（升级不该变成一次长 pull）', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.listImageTags.mockResolvedValue(['dsh-instance:0.1.0_1'])
    inCatalog.mockResolvedValue(true)

    await expect(makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)).rejects.toThrow(
      /这一版在平台侧暂时不可用/,
    )
  })

  it('目标就是当前版本 → 幂等，不碰任何东西', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()

    const updated = await makeProvisioner(fakes).setImage('i-1', 'dsh-instance:0.1.0_1')
    expect(updated.image).toBe('dsh-instance:0.1.0_1')
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('换镜像：升级', () => {
  it('invalidates the old rollback image before replacing a stopped instance snapshot', async () => {
    const db = statefulDb(row({ status: 'stopped', previousImage: 'dsh-instance:0.0.9_1' }))
    const fakes = build()
    fakes.calls.snapshot.mockImplementationOnce(async () => {
      expect(db.current().previousImage).toBeNull()
      throw new Error('snapshot failed')
    })
    await expect(makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)).rejects.toThrow('snapshot failed')
    expect(db.current().image).toBe(DEFAULT_REF)
    expect(db.current().previousImage).toBeNull()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
  })

  it('does not replace a snapshot if invalidating its old image binding fails', async () => {
    statefulDb(row({ status: 'stopped', previousImage: 'dsh-instance:0.0.9_1' }))
    const fakes = build()
    update.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)).rejects.toThrow('database unavailable')
    expect(fakes.calls.snapshot).not.toHaveBeenCalled()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
  })
  it('快照未完成时，另一个编排对象的停机请求等待整个升级结束', async () => {
    statefulDb(row())
    const fakes = build()
    let release!: () => void
    let entered!: () => void
    const snapshotEntered = new Promise<void>(resolve => { entered = resolve })
    fakes.calls.snapshot.mockImplementationOnce(async () => {
      entered()
      await new Promise<void>(resolve => { release = resolve })
    })
    const upgrading = makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)
    await snapshotEntered
    const stopping = makeProvisioner(fakes).stop('i-1')
    await Promise.resolve()
    expect(fakes.calls.stopInstance).toHaveBeenCalledTimes(1)
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
    release()
    await upgrading
    const stopped = await stopping
    expect(stopped.status).toBe('stopped')
    const stops = fakes.calls.stopInstance.mock.invocationCallOrder
    expect(stops.at(-1)).toBeGreaterThan(fakes.calls.createInstance.mock.invocationCallOrder[0]!)
  })
  it('停容器 → 打快照 → 落库（新镜像 + previous_image）→ 重建', async () => {
    const db = statefulDb(row())
    const fakes = build()

    const updated = await makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)

    // 先**优雅停机**（让 dsh 把会话写完落进卷），再打快照。
    // 这里不是「删容器」——直接删会丢掉还没落盘的写入。
    expect(fakes.calls.stopInstance).toHaveBeenCalledWith('dsh-instance-alice')
    expect(fakes.calls.snapshot).toHaveBeenCalledWith('alice')
    expect(update).toHaveBeenCalledWith({}, 'i-1', {
      image: NEW_IMAGE,
      previousImage: 'dsh-instance:0.1.0_1',
      containerId: null,
    })
    expect(fakes.calls.createInstance).toHaveBeenCalled()
    expect(updated.image).toBe(NEW_IMAGE)
    expect(db.current().image).toBe(NEW_IMAGE)
  })

  it('快照失败 → **不落库**，按原规格把实例恢复起来', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()
    fakes.calls.snapshot.mockRejectedValue(new Error('宿主空间不足'))

    await expect(makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)).rejects.toThrow(
      /打快照失败，当前数据未改动/,
    )
    // 落库这条**只认 image 那次写**——失败路径上的 restart 仍会写 status/containerId
    expect(update).not.toHaveBeenCalledWith({}, 'i-1', expect.objectContaining({ image: NEW_IMAGE }))
    // 容器已删、文件系统已卸载——但数据没动，重建就回到原样
    expect(fakes.calls.createInstance).toHaveBeenCalled()
  })

  it('新镜像起不来 → 自动回滚：数据回快照、镜像回旧版', async () => {
    const db = statefulDb(row())
    const fakes = build()
    fakes.calls.createInstance
      .mockRejectedValueOnce(new Error('crash-loop'))
      .mockResolvedValueOnce({ containerId: 'c-2', status: 'running' })

    await expect(makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)).rejects.toThrow(
      ImageUpgradeFailedError,
    )

    expect(fakes.calls.restoreSnapshot).toHaveBeenCalledWith('alice')
    expect(db.current().image).toBe('dsh-instance:0.1.0_1')
    expect(db.current().previousImage).toBeNull()
    // 两次 createInstance：新镜像失败一次，回滚后旧镜像成功一次
    expect(fakes.calls.createInstance).toHaveBeenCalledTimes(2)
    expect(db.current().status).toBe('running')
  })

  it('原本停着的实例只落库，新镜像等用户自己 start', async () => {
    findById.mockResolvedValue(row({ status: 'stopped', containerId: null }))
    const fakes = build()

    const updated = await makeProvisioner(fakes).setImage('i-1', NEW_IMAGE)

    expect(updated.image).toBe(NEW_IMAGE)
    expect(fakes.calls.snapshot).toHaveBeenCalledWith('alice')
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
  })
})

describe('换镜像：回滚', () => {
  it('没有可回滚的版本 → NoRollbackError，什么都不动', async () => {
    findById.mockResolvedValue(row())
    const fakes = build()

    await expect(makeProvisioner(fakes).rollbackImage('i-1')).rejects.toThrow(NoRollbackError)
    expect(fakes.calls.restoreSnapshot).not.toHaveBeenCalled()
  })

  it('恢复快照 → 落库回旧镜像（清空 previous_image）→ 重建', async () => {
    const db = statefulDb(
      row({ image: NEW_IMAGE, previousImage: 'dsh-instance:0.1.0_1' }),
    )
    const fakes = build()

    const updated = await makeProvisioner(fakes).rollbackImage('i-1')

    expect(fakes.calls.restoreSnapshot).toHaveBeenCalledWith('alice')
    expect(update).toHaveBeenCalledWith({}, 'i-1', {
      image: 'dsh-instance:0.1.0_1',
      previousImage: null,
      containerId: null,
      status: 'stopped',
    })
    expect(fakes.calls.createInstance).toHaveBeenCalled()
    expect(updated.image).toBe('dsh-instance:0.1.0_1')
    expect(db.current().previousImage).toBeNull()
    expect(fakes.calls.finishRestore).toHaveBeenCalledWith('alice')
    expect(fakes.calls.finishRestore.mock.invocationCallOrder[0]).toBeGreaterThan(
      fakes.calls.createInstance.mock.invocationCallOrder[0]!,
    )
  })

  it('retains recovery data when the restored runtime fails to start', async () => {
    statefulDb(row({ image: NEW_IMAGE, previousImage: 'dsh-instance:0.1.0_1' }))
    const fakes = build()
    fakes.calls.createInstance.mockRejectedValueOnce(new Error('restored runtime failed'))
    await expect(makeProvisioner(fakes).rollbackImage('i-1')).rejects.toThrow('restored runtime failed')
    expect(fakes.calls.restoreSnapshot).toHaveBeenCalled()
    expect(fakes.calls.finishRestore).not.toHaveBeenCalled()
  })

  it('removes old mounts before restore and records a failed copy without restarting', async () => {
    const db = statefulDb(row({ image: NEW_IMAGE, previousImage: 'dsh-instance:0.1.0_1' }))
    const fakes = build()
    fakes.calls.restoreSnapshot.mockRejectedValueOnce(new Error('copy failed'))
    await expect(makeProvisioner(fakes).rollbackImage('i-1')).rejects.toThrow('copy failed')
    expect(fakes.calls.removeInstance).toHaveBeenCalledWith('dsh-instance-alice')
    expect(fakes.calls.removeInstance.mock.invocationCallOrder[0]).toBeGreaterThan(
      fakes.calls.stopInstance.mock.invocationCallOrder[0]!,
    )
    expect(fakes.calls.restoreSnapshot.mock.invocationCallOrder[0]).toBeGreaterThan(
      fakes.calls.removeInstance.mock.invocationCallOrder[0]!,
    )
    expect(db.current().status).toBe('error')
    expect(db.current().image).toBe(NEW_IMAGE)
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
    expect(fakes.calls.finishRestore).not.toHaveBeenCalled()
  })

  it('does not touch data when the old container cannot be removed', async () => {
    const db = statefulDb(row({ image: NEW_IMAGE, previousImage: 'dsh-instance:0.1.0_1' }))
    const fakes = build()
    fakes.calls.removeInstance.mockRejectedValueOnce(new Error('remove failed'))
    await expect(makeProvisioner(fakes).rollbackImage('i-1')).rejects.toThrow('remove failed')
    expect(fakes.calls.restoreSnapshot).not.toHaveBeenCalled()
    expect(db.current().status).toBe('error')
  })

  it('retains recovery data if committing the restored image fails', async () => {
    statefulDb(row({ image: NEW_IMAGE, previousImage: 'dsh-instance:0.1.0_1' }))
    const fakes = build()
    fakes.calls.restoreSnapshot.mockImplementationOnce(async () => {
      update.mockRejectedValueOnce(new Error('database unavailable'))
    })
    await expect(makeProvisioner(fakes).rollbackImage('i-1')).rejects.toThrow('database unavailable')
    expect(fakes.calls.restoreSnapshot).toHaveBeenCalled()
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
    expect(fakes.calls.finishRestore).not.toHaveBeenCalled()
  })

  it('withdraws access before touching rollback data and leaves a stopped instance stopped', async () => {
    const db = statefulDb(row({ status: 'stopped', image: NEW_IMAGE, previousImage: DEFAULT_REF }))
    const fakes = build()
    fakes.calls.stopInstance.mockImplementationOnce(async () => {
      expect(db.current().status).toBe('provisioning')
      expect(fakes.calls.syncRoutes).toHaveBeenCalled()
    })
    const result = await makeProvisioner(fakes).rollbackImage('i-1')
    expect(result.status).toBe('stopped')
    expect(result.image).toBe(DEFAULT_REF)
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
    expect(fakes.calls.finishRestore).toHaveBeenCalledWith('alice')
  })

  it('does not stop or restore when withdrawing rollback routes fails', async () => {
    const db = statefulDb(row({ status: 'stopped', image: NEW_IMAGE, previousImage: DEFAULT_REF }))
    const fakes = build()
    fakes.calls.syncRoutes.mockRejectedValueOnce(new Error('route update failed'))
    await expect(makeProvisioner(fakes).rollbackImage('i-1')).rejects.toThrow('route update failed')
    expect(fakes.calls.stopInstance).not.toHaveBeenCalled()
    expect(fakes.calls.restoreSnapshot).not.toHaveBeenCalled()
    expect(db.current().status).toBe('error')
  })
})

describe('重建前的镜像兜底（D23）', () => {
  it('restart / create 都先确保镜像在宿主上（被 prune 掉也能自愈）', async () => {
    statefulDb(row())
    const fakes = build()

    await makeProvisioner(fakes).restart('i-1')
    expect(fakes.calls.ensureImage).toHaveBeenCalledWith('dsh-instance:0.1.0_1')

    fakes.calls.ensureImage.mockClear()
    vi.mocked(createInstanceRecord).mockResolvedValue(row())
    await makeProvisioner(fakes).create({ slug: 'alice', ownerId: 'u1', ...quota })
    expect(fakes.calls.ensureImage).toHaveBeenCalledWith(DEFAULT_REF)
  })

  it('拉不到镜像 → 标 error，不建容器（别把「镜像没了」报成「规格错了」）', async () => {
    const db = statefulDb(row())
    const fakes = build()
    fakes.calls.ensureImage.mockRejectedValue(
      new Error('拉取镜像 dsh-instance:0.1.0_1 失败：manifest unknown'),
    )

    await expect(makeProvisioner(fakes).restart('i-1')).rejects.toThrow(/拉取镜像/)
    expect(db.current().status).toBe('error')
    expect(db.current().lastError).toContain('manifest unknown')
    expect(fakes.calls.createInstance).not.toHaveBeenCalled()
  })
})

describe('失败收尾：标 error 之后必须重新投影一次路由', () => {
  // 投影判据是**容器事实**（routableInstanceSlugs）。但投影这件事只在成功路径和
  // remove 的第一步里发生——失败路径不补这一下，路由就停在「上一次投影」的样子。
  // remove 尤其致命：它第一步就把路由摘了，后面任何一步失败都会留下
  // 「容器还好好地跑着、路由却没了」——页面表现为实例打不开，没人会修。
  it('remove 中途失败 → 标 error，并把已经摘掉的路由重新投影一次', async () => {
    const db = statefulDb(row())
    const fakes = build()
    vi.mocked(fakes.orchestrator.removeInstance).mockRejectedValue(new Error('daemon 超时'))

    await expect(makeProvisioner(fakes).remove('i-1', { confirmSlug: 'alice' })).rejects.toThrow(
      'daemon 超时',
    )

    expect(db.current().status).toBe('error')
    expect(db.current().lastError).toBe('daemon 超时')
    // ① 置 removing 后摘一次，② failWith 里补一次
    expect(fakes.calls.syncRoutes).toHaveBeenCalledTimes(2)
  })

  it('其他动作失败也补投影（create / restart 的重建路径同理）', async () => {
    const db = statefulDb(row())
    const fakes = build()
    fakes.calls.ensureImage.mockRejectedValue(new Error('拉取镜像失败'))

    await expect(makeProvisioner(fakes).restart('i-1')).rejects.toThrow('拉取镜像失败')

    expect(db.current().status).toBe('error')
    expect(fakes.calls.syncRoutes).toHaveBeenCalledTimes(1)
  })

  it('投影本身失败不能盖掉原始错误（标 error 已经落库了）', async () => {
    const db = statefulDb(row())
    const fakes = build()
    fakes.calls.ensureImage.mockRejectedValue(new Error('拉取镜像失败'))
    fakes.calls.syncRoutes.mockRejectedValue(new Error('Traefik 目录只读'))

    await expect(makeProvisioner(fakes).restart('i-1')).rejects.toThrow('拉取镜像失败')
    expect(db.current().status).toBe('error')
  })
})

const ALPHA = 'fixture-model-key-alpha-9f3c'
const BETA = 'fixture-model-key-beta-9f3c'
const EDITED = 'fixture-model-key-edited-9f3c'
const KEY1 = 'a'.repeat(32)
const KEY2 = 'b'.repeat(32)
const KEY3 = 'c'.repeat(32)

describe('用户默认模型 Key 只注入新建工作区', () => {
  it('没有默认就不写文件', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ storageKey: KEY1 }))
    const fakes = build()
    await makeProvisioner(fakes).create({ slug: 'alice', ownerId: 'u1', ...quota })
    expect(fakes.calls.seedCredentials).not.toHaveBeenCalled()
    expect(fakes.calls.seedPatch).not.toHaveBeenCalled()
    expect(fakes.calls.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ env: {} }),
      expect.objectContaining({ gateToken: gateToken('alice', env.PLATFORM_SECRET) }),
    )
  })

  it('三钉：新工作区带上当时的默认；工作区里改过的不回写；改默认不覆盖旧卷', async () => {
    const files = new Map<string, Buffer>()
    const defaults: { current: Record<string, string> } = { current: { DEEPSEEK_API_KEY: ALPHA } }
    readRefs.mockImplementation(async () => ({ ...defaults.current }))
    let n = 0
    const keys = [KEY1, KEY2, KEY3]
    vi.mocked(createInstanceRecord).mockImplementation(async (_db, input) => {
      const storageKey = keys[n] ?? KEY1
      n += 1
      return row({
        id: `i-${input.slug}`,
        slug: input.slug,
        ownerId: input.ownerId,
        storageKey,
      })
    })
    const fakes = build()
    fakes.calls.seedCredentials.mockImplementation(async (key: string, contents: Buffer) => {
      const id = `${key}/.credentials.yaml`
      if (files.has(id)) return false
      files.set(id, Buffer.from(contents))
      return true
    })
    const provisioner = makeProvisioner(fakes)

    await provisioner.create({ slug: 'ws1', ownerId: 'u1', ...quota })
    const first = files.get(`${KEY1}/.credentials.yaml`)?.toString('utf8') ?? ''
    expect(first).toContain('version: 1')
    expect(first).toContain(`DEEPSEEK_API_KEY: ${ALPHA}`)
    expect(first).toContain('records: {}')
    expect(first).not.toContain(BETA)
    const createAt = fakes.calls.createData.mock.invocationCallOrder[0] ?? -1
    const seedAt = fakes.calls.seedCredentials.mock.invocationCallOrder[0] ?? -1
    const chownAt = fakes.calls.chown.mock.invocationCallOrder[0] ?? -1
    const instanceAt = fakes.calls.createInstance.mock.invocationCallOrder[0] ?? -1
    expect(createAt).toBeLessThan(seedAt)
    expect(seedAt).toBeLessThan(chownAt)
    expect(chownAt).toBeLessThan(instanceAt)
    expect(fakes.calls.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ env: {} }),
      expect.objectContaining({ gateToken: gateToken('ws1', env.PLATFORM_SECRET) }),
    )
    expect(gateToken('ws1', env.PLATFORM_SECRET)).not.toContain(ALPHA)

    // 用户在 W1 里改了 Key。控制面的默认还是 ALPHA，文件不再被写。
    files.set(`${KEY1}/.credentials.yaml`, Buffer.from(`version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${EDITED}\nrecords: {}\n`))
    const readsAfterCreate = readRefs.mock.calls.length
    const seedsAfterCreate = fakes.calls.seedCredentials.mock.calls.length
    findById.mockImplementation(async (_db, id) => {
      if (id === 'i-ws1') {
        return row({ id, slug: 'ws1', ownerId: 'u1', storageKey: KEY1, status: 'stopped', containerId: null })
      }
      return undefined
    })
    await provisioner.restart('i-ws1')
    await provisioner.start('i-ws1')
    expect(readRefs.mock.calls.length).toBe(readsAfterCreate)
    expect(fakes.calls.seedCredentials.mock.calls.length).toBe(seedsAfterCreate)
    expect(files.get(`${KEY1}/.credentials.yaml`)?.toString('utf8')).toContain(EDITED)
    expect(defaults.current).toEqual({ DEEPSEEK_API_KEY: ALPHA })

    await provisioner.create({ slug: 'ws2', ownerId: 'u1', ...quota })
    expect(files.get(`${KEY2}/.credentials.yaml`)?.toString('utf8')).toContain(ALPHA)
    expect(files.get(`${KEY2}/.credentials.yaml`)?.toString('utf8')).not.toContain(EDITED)
    expect(files.get(`${KEY1}/.credentials.yaml`)?.toString('utf8')).toContain(EDITED)

    defaults.current = { DEEPSEEK_API_KEY: BETA }
    await provisioner.restart('i-ws1')
    expect(files.get(`${KEY1}/.credentials.yaml`)?.toString('utf8')).toContain(EDITED)
    expect(files.get(`${KEY1}/.credentials.yaml`)?.toString('utf8')).not.toContain(BETA)
    await provisioner.create({ slug: 'ws3', ownerId: 'u1', ...quota })
    expect(files.get(`${KEY3}/.credentials.yaml`)?.toString('utf8')).toContain(BETA)
    expect(files.get(`${KEY1}/.credentials.yaml`)?.toString('utf8')).toContain(EDITED)
    expect(files.get(`${KEY2}/.credentials.yaml`)?.toString('utf8')).toContain(ALPHA)
    expect(fakes.calls.seedPatch).not.toHaveBeenCalled()
  })
})

const CUSTOM_URL = 'https://example.test/v1'
const PLACEHOLDER = '__dshcloud_fetch_models__'

describe('用户默认 Custom 模型只注入新建工作区', () => {
  const customOf = (modelIds: string[] = []) => ({
    providerId: 'cliproxy',
    displayName: 'CLIProxyAPI',
    baseUrl: CUSTOM_URL,
    api: 'openai-completions',
    apiKeyEnv: 'CLIPROXY_API_KEY',
    modelIds,
  })

  function filesOf(fakes: Fakes) {
    const files = new Map<string, Buffer>()
    fakes.calls.seedCredentials.mockImplementation(async (key: string, contents: Buffer) => {
      const id = `${key}/.credentials.yaml`
      if (files.has(id)) return false
      files.set(id, Buffer.from(contents))
      return true
    })
    fakes.calls.seedPatch.mockImplementation(async (key: string, contents: Buffer) => {
      const id = `${key}/profiles/web/cordis.patch.yml`
      if (files.has(id)) return false
      files.set(id, Buffer.from(contents))
      return true
    })
    return files
  }

  it('配置完整时两个文件各写一次，且不把 Key 放进容器 env', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ storageKey: KEY1, slug: 'ws1' }))
    readRefs.mockResolvedValue({ CLIPROXY_API_KEY: ALPHA, DEEPSEEK_API_KEY: BETA })
    readCustom.mockResolvedValue(customOf(['model-a', 'model-b']))
    const fakes = build()
    const files = filesOf(fakes)
    await makeProvisioner(fakes).create({ slug: 'ws1', ownerId: 'u1', ...quota })

    const cred = files.get(`${KEY1}/.credentials.yaml`)?.toString('utf8') ?? ''
    const patch = files.get(`${KEY1}/profiles/web/cordis.patch.yml`)?.toString('utf8') ?? ''
    expect(cred).toContain(`CLIPROXY_API_KEY: ${ALPHA}`)
    expect(cred).toContain(`DEEPSEEK_API_KEY: ${BETA}`)
    expect(cred).not.toContain(CUSTOM_URL)
    expect(patch).toContain('id: llm-pi-ai')
    expect(patch).toContain('baseURL: https://example.test/v1')
    expect(patch).toContain('id: model-a')
    expect(patch).toContain('id: model-b')
    expect(patch).not.toContain('DEEPSEEK_BASE_URL')
    expect(patch).not.toContain(ALPHA)
    expect(fakes.calls.seedCredentials).toHaveBeenCalledTimes(1)
    expect(fakes.calls.seedPatch).toHaveBeenCalledTimes(1)
    const createAt = fakes.calls.createData.mock.invocationCallOrder[0] ?? -1
    const credAt = fakes.calls.seedCredentials.mock.invocationCallOrder[0] ?? -1
    const patchAt = fakes.calls.seedPatch.mock.invocationCallOrder[0] ?? -1
    const chownAt = fakes.calls.chown.mock.invocationCallOrder[0] ?? -1
    const instanceAt = fakes.calls.createInstance.mock.invocationCallOrder[0] ?? -1
    expect(createAt).toBeLessThan(credAt)
    expect(credAt).toBeLessThan(patchAt)
    expect(patchAt).toBeLessThan(chownAt)
    expect(chownAt).toBeLessThan(instanceAt)
    expect(fakes.calls.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ env: {} }),
      expect.anything(),
    )
  })

  it('只有 DeepSeek Key、没有 Custom base URL 时只写凭据', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ storageKey: KEY1 }))
    readRefs.mockResolvedValue({ DEEPSEEK_API_KEY: ALPHA })
    readCustom.mockResolvedValue(null)
    const fakes = build()
    const files = filesOf(fakes)
    await makeProvisioner(fakes).create({ slug: 'ws1', ownerId: 'u1', ...quota })
    expect(files.get(`${KEY1}/.credentials.yaml`)?.toString('utf8')).toContain(ALPHA)
    expect(files.has(`${KEY1}/profiles/web/cordis.patch.yml`)).toBe(false)
    expect(fakes.calls.seedPatch).not.toHaveBeenCalled()
  })

  it('有 base URL 但没有对应 Key 时两个文件都不写', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ storageKey: KEY1 }))
    readRefs.mockResolvedValue({})
    readCustom.mockResolvedValue(customOf())
    const fakes = build()
    const files = filesOf(fakes)
    await makeProvisioner(fakes).create({ slug: 'ws1', ownerId: 'u1', ...quota })
    expect(files.size).toBe(0)
    expect(fakes.calls.seedCredentials).not.toHaveBeenCalled()
    expect(fakes.calls.seedPatch).not.toHaveBeenCalled()
  })

  it('有 base URL 和无关的 DeepSeek Key、但没有 CLIPROXY Key 时只写凭据', async () => {
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ storageKey: KEY1 }))
    readRefs.mockResolvedValue({ DEEPSEEK_API_KEY: ALPHA })
    readCustom.mockResolvedValue(customOf())
    const fakes = build()
    const files = filesOf(fakes)
    await makeProvisioner(fakes).create({ slug: 'ws1', ownerId: 'u1', ...quota })
    expect(files.get(`${KEY1}/.credentials.yaml`)?.toString('utf8')).toContain(ALPHA)
    expect(fakes.calls.seedPatch).not.toHaveBeenCalled()
  })

  it('文件已在则不覆盖；restart / start / 换镜像 / 回滚不再写', async () => {
    const files = new Map<string, Buffer>([
      [`${KEY1}/.credentials.yaml`, Buffer.from('user-credentials')],
      [`${KEY1}/profiles/web/cordis.patch.yml`, Buffer.from('user-patch')],
    ])
    vi.mocked(createInstanceRecord).mockResolvedValue(row({ id: 'i-ws1', slug: 'ws1', storageKey: KEY1 }))
    readRefs.mockResolvedValue({ CLIPROXY_API_KEY: ALPHA })
    readCustom.mockResolvedValue(customOf())
    const fakes = build()
    fakes.calls.seedCredentials.mockImplementation(async (key: string, contents: Buffer) => {
      const id = `${key}/.credentials.yaml`
      if (files.has(id)) return false
      files.set(id, Buffer.from(contents))
      return true
    })
    fakes.calls.seedPatch.mockImplementation(async (key: string, contents: Buffer) => {
      const id = `${key}/profiles/web/cordis.patch.yml`
      if (files.has(id)) return false
      files.set(id, Buffer.from(contents))
      return true
    })
    const provisioner = makeProvisioner(fakes)
    await provisioner.create({ slug: 'ws1', ownerId: 'u1', ...quota })
    expect(files.get(`${KEY1}/.credentials.yaml`)?.toString('utf8')).toBe('user-credentials')
    expect(files.get(`${KEY1}/profiles/web/cordis.patch.yml`)?.toString('utf8')).toBe('user-patch')

    const seeds = fakes.calls.seedCredentials.mock.calls.length
    const patches = fakes.calls.seedPatch.mock.calls.length
    findById.mockImplementation(async (_db, id) => {
      if (id === 'i-ws1') {
        return row({
          id,
          slug: 'ws1',
          ownerId: 'u1',
          storageKey: KEY1,
          status: 'running',
          image: 'dsh-instance:0.1.0_1',
          previousImage: 'dsh-instance:0.1.0_1',
        })
      }
      return undefined
    })
    await provisioner.restart('i-ws1')
    await provisioner.start('i-ws1')
    await provisioner.setImage('i-ws1', NEW_IMAGE)
    await provisioner.rollbackImage('i-ws1')
    expect(fakes.calls.seedCredentials.mock.calls.length).toBe(seeds)
    expect(fakes.calls.seedPatch.mock.calls.length).toBe(patches)
    expect(files.get(`${KEY1}/.credentials.yaml`)?.toString('utf8')).toBe('user-credentials')
    expect(files.get(`${KEY1}/profiles/web/cordis.patch.yml`)?.toString('utf8')).toBe('user-patch')
  })

  it('三钉：新工作区用当时的默认；工作区自改不回写；改默认不覆盖旧卷', async () => {
    const defaults = {
      refs: { CLIPROXY_API_KEY: ALPHA } as Record<string, string>,
      modelIds: [] as string[],
      baseUrl: CUSTOM_URL,
    }
    readRefs.mockImplementation(async () => ({ ...defaults.refs }))
    readCustom.mockImplementation(async () => customOf(defaults.modelIds))
    let n = 0
    const keys = [KEY1, KEY2, KEY3]
    vi.mocked(createInstanceRecord).mockImplementation(async (_db, input) => {
      const storageKey = keys[n] ?? KEY1
      n += 1
      return row({ id: `i-${input.slug}`, slug: input.slug, ownerId: input.ownerId, storageKey })
    })
    const fakes = build()
    const files = filesOf(fakes)
    const provisioner = makeProvisioner(fakes)

    await provisioner.create({ slug: 'ws1', ownerId: 'u1', ...quota })
    expect(files.get(`${KEY1}/profiles/web/cordis.patch.yml`)?.toString('utf8')).toContain(PLACEHOLDER)
    files.set(`${KEY1}/profiles/web/cordis.patch.yml`, Buffer.from('local-url'))
    files.set(`${KEY1}/.credentials.yaml`, Buffer.from('local-key'))
    const reads = readRefs.mock.calls.length
    findById.mockResolvedValue(row({
      id: 'i-ws1', slug: 'ws1', ownerId: 'u1', storageKey: KEY1, status: 'stopped', containerId: null,
    }))
    await provisioner.restart('i-ws1')
    expect(readRefs.mock.calls.length).toBe(reads)
    expect(readCustom.mock.calls.length).toBe(reads)
    expect(files.get(`${KEY1}/profiles/web/cordis.patch.yml`)?.toString('utf8')).toBe('local-url')
    expect(defaults.refs).toEqual({ CLIPROXY_API_KEY: ALPHA })

    await provisioner.create({ slug: 'ws2', ownerId: 'u1', ...quota })
    expect(files.get(`${KEY2}/.credentials.yaml`)?.toString('utf8')).toContain(ALPHA)
    expect(files.get(`${KEY2}/profiles/web/cordis.patch.yml`)?.toString('utf8')).toContain(CUSTOM_URL)
    expect(files.get(`${KEY1}/profiles/web/cordis.patch.yml`)?.toString('utf8')).toBe('local-url')

    defaults.refs = { CLIPROXY_API_KEY: BETA }
    defaults.baseUrl = 'https://example.test/v2'
    readCustom.mockImplementation(async () => ({ ...customOf(), baseUrl: defaults.baseUrl }))
    await provisioner.restart('i-ws1')
    expect(files.get(`${KEY1}/profiles/web/cordis.patch.yml`)?.toString('utf8')).toBe('local-url')
    expect(files.get(`${KEY2}/profiles/web/cordis.patch.yml`)?.toString('utf8')).toContain(CUSTOM_URL)
    await provisioner.create({ slug: 'ws3', ownerId: 'u1', ...quota })
    expect(files.get(`${KEY3}/.credentials.yaml`)?.toString('utf8')).toContain(BETA)
    expect(files.get(`${KEY3}/profiles/web/cordis.patch.yml`)?.toString('utf8')).toContain('https://example.test/v2')
    expect(files.get(`${KEY1}/profiles/web/cordis.patch.yml`)?.toString('utf8')).toBe('local-url')
    expect(files.get(`${KEY2}/profiles/web/cordis.patch.yml`)?.toString('utf8')).not.toContain('/v2')
  })
})
