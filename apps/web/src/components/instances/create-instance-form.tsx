import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button.js'
import {
  DialogFooter,
} from '@/components/ui/dialog.js'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.js'
import { ApiError, createInstance, listImages, listInstances, type PlatformCaps } from '@/lib/api.js'
import { dshTagLabel, formatMb, imageTagOf } from '@/lib/format.js'
import { invalidateInstances, keys } from '@/lib/query-keys.js'

const MEMORY_MB_OPTIONS = [2048, 4096, 8192]
const CPU_OPTIONS = [1, 2, 4]
const DISK_MB_OPTIONS = [5120, 10_240, 20_480]

/** 服务端 create 的默认值（见 instance-routes 的 schema），在表单里摆出来当默认。 */
const DEFAULT_MEMORY_MB = 2048
const DEFAULT_CPUS = 1
const DEFAULT_DISK_MB = 10_240
const DEFAULT_PIDS_LIMIT = 512

/**
 * 自助路径的进程数下限。
 *
 * 服务端允许到 1，但**自助的护栏要比管理员紧**（同 D17 的取向：用户磁盘上限 100 GB、管理员 1 TB）——
 * 而且这个值创建后用户自己改不回来（只有管理员能改配额），填 1 等于把实例废掉。
 * 128 够跑 dsh 本身，留着"调大"这个真实需求（重型构建）。
 */
const MIN_PIDS_LIMIT = 128
/** 历史自助上限；真正生效的是 min(这个值, platformCaps.maxPids)。 */
const SELF_SERVE_MAX_PIDS = 4_096

/**
 * 预设档位里不超过 cap 的那些。全都高于 cap 时，退回 cap 本身——
 * 否则个人封顶比最小预设还低时，下拉是空的，提交却还握着一个超限默认值。
 */
function choicesAtMost(presets: number[], cap: number, floor = 0): number[] {
  const fitted = presets.filter((n) => n >= floor && n <= cap)
  if (fitted.length > 0) return fitted
  if (cap >= floor && cap > 0) return [cap]
  return []
}

const FALLBACK_CAPS: PlatformCaps = {
  maxCpus: 2,
  maxMemoryMb: 2048,
  maxPids: 512,
  maxDiskMb: 10_240,
  maxRunning: 3,
  idleCullMinutes: 45,
}

/** 版本下拉里「不指定」的哨兵值——Select 不接受空字符串。 */
const DEFAULT_IMAGE = '__default__'

/**
 * 新建工作空间的**推荐版** tag —— 与 `docker/instance-image/VERSION` 保持同一份
 * （那是发布到注册表、预热到宿主的版本）。钉在代码里是因为库里的「平台默认」
 * 可能停在一版旧修订上；只有当推荐版真的**已上架**时才顶替默认项，否则照旧回落。
 */
const RECOMMENDED_IMAGE_TAG = '0.1.6-alpha.1_5'

/**
 * 新建实例的表单。**弹窗一关就卸载**，所以状态活在这里而不是列表页。
 *
 * 「不选版本」是一个真实选项（优先用代码钉住的推荐版，没上架回落平台默认版本），
 * 不是空值——所以有个 `__default__` 哨兵。
 */
export function CreateInstanceForm({ onCreated }: { onCreated: (id: string) => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const capsQuery = useQuery({
    queryKey: keys.instances,
    queryFn: listInstances,
    staleTime: 60_000,
    // 服务端已经收成这个用户的有效封顶（平台 ∩ 个人）。这里继续按它裁档。
    select: (data) => data.platformCaps,
  })
  const caps = capsQuery.data ?? FALLBACK_CAPS
  const maxPidsLimit = Math.min(SELF_SERVE_MAX_PIDS, caps.maxPids)
  // 个人 pids 封顶若低于自助下限，下限跟着降，否则输入框永远非法、建不出来。
  const pidsFloor = Math.min(MIN_PIDS_LIMIT, maxPidsLimit)

  const memoryChoices = choicesAtMost(MEMORY_MB_OPTIONS, caps.maxMemoryMb, 1)
  const cpuChoices = choicesAtMost(CPU_OPTIONS, caps.maxCpus)
  const diskChoices = choicesAtMost(DISK_MB_OPTIONS, caps.maxDiskMb, 128)

  const [slug, setSlug] = useState('')
  const [memoryMb, setMemoryMb] = useState(() =>
    Math.min(DEFAULT_MEMORY_MB, FALLBACK_CAPS.maxMemoryMb),
  )
  const [cpus, setCpus] = useState(() => Math.min(DEFAULT_CPUS, FALLBACK_CAPS.maxCpus))
  const [diskMb, setDiskMb] = useState(() => Math.min(DEFAULT_DISK_MB, FALLBACK_CAPS.maxDiskMb))
  const [pids, setPids] = useState(String(Math.min(DEFAULT_PIDS_LIMIT, FALLBACK_CAPS.maxPids)))
  const [image, setImage] = useState(DEFAULT_IMAGE)

  // 只在弹窗打开时拉：版本列表平时用不上
  const images = useQuery({
    queryKey: keys.createImages,
    queryFn: listImages,
    staleTime: 60_000,
  })

  const pidsLimit = Number(pids)
  const pidsValid =
    Number.isInteger(pidsLimit) && pidsLimit >= pidsFloor && pidsLimit <= maxPidsLimit

  useEffect(() => {
    setPids((current) => {
      const n = Number(current)
      if (!Number.isFinite(n) || n > maxPidsLimit) return String(Math.min(DEFAULT_PIDS_LIMIT, maxPidsLimit))
      return current
    })
  }, [maxPidsLimit])

  const memoryValue = memoryChoices.includes(memoryMb) ? memoryMb : memoryChoices.at(-1)
  const cpuValue = cpuChoices.includes(cpus) ? cpus : cpuChoices.at(-1)
  const diskValue = diskChoices.includes(diskMb) ? diskMb : diskChoices.at(-1)
  const tiersReady = memoryValue !== undefined && cpuValue !== undefined && diskValue !== undefined

  const defaultRef = images.data?.default ?? null
  const recommendedRef =
    images.data?.published.find((ref) => imageTagOf(ref) === RECOMMENDED_IMAGE_TAG) ?? null
  // 「不选」实际指向的那一版：推荐版优先，其次库里的平台默认
  const autoRef = recommendedRef ?? defaultRef

  const create = useMutation({
    mutationFn: () =>
      createInstance({
        slug: slug.trim(),
        cpus: cpuValue ?? cpus,
        memoryMb: memoryValue ?? memoryMb,
        diskMb: diskValue ?? diskMb,
        pidsLimit,
        // 「不选」优先显式带上推荐版；它没上架才不带键，让服务端用平台默认版本（D21）
        ...(image === DEFAULT_IMAGE
          ? recommendedRef === null
            ? {}
            : { image: recommendedRef }
          : { image }),
      }),
    onSuccess: (instance) => {
      setSlug('')
      setImage(DEFAULT_IMAGE)
      // 新实例在两个列表里都该出现（用户面 + 舰队面）
      invalidateInstances(queryClient)
      onCreated(instance.id)
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (pidsValid && tiersReady) create.mutate()
  }

  const memoryOptions = memoryChoices.map((mb) => ({
    label: t('instances.gigabytes', { count: mb / 1024 }),
    value: mb,
  }))
  const cpuOptions = cpuChoices.map((n) => ({
    label: t('instances.cores', { count: n }),
    value: n,
  }))
  const diskOptions = diskChoices.map((mb) => ({ label: formatMb(mb), value: mb }))

  const autoLabel =
    recommendedRef !== null
      ? t('instances.versionRecommended', { version: dshTagLabel(recommendedRef) })
      : defaultRef === null
        ? t('instances.versionDefaultPlain')
        : t('instances.versionDefault', { version: dshTagLabel(defaultRef) })
  const versionOptions = [
    { label: autoLabel, value: DEFAULT_IMAGE },
    // 「不选」那项就是 autoRef，下面不再重复列它
    ...(images.data?.published ?? [])
      .filter((ref) => ref !== autoRef)
      .map((ref) => ({ label: dshTagLabel(ref), value: ref })),
  ]

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="slug">{t('workspaceCreate.name')}</FieldLabel>
          <Input
            id="slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value)
              // 输入变了，上一次的失败原因就不作数了
              if (create.isError) create.reset()
            }}
            placeholder={t('workspaceCreate.namePlaceholder')}
            pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
            minLength={3}
            maxLength={32}
            aria-invalid={create.isError}
            required
          />
          {create.isError ? (
            <p className="text-xs text-destructive">
              {create.error instanceof ApiError
                ? create.error.message
                : t('instances.createFailed')}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{t('workspaceCreate.nameHint')}</p>
          )}
        </Field>

        <details className="group rounded-md border px-4 py-3">
          <summary className="cursor-pointer list-none text-sm text-muted-foreground marker:hidden">
            {t('workspaceCreate.advanced')}
          </summary>
          <div className="mt-5 flex flex-col gap-5 border-t pt-5">
        <Field>
          <FieldLabel htmlFor="version">{t('instances.version')}</FieldLabel>
          <Select
            items={versionOptions}
            value={image}
            onValueChange={(value) => {
              if (typeof value === 'string') setImage(value)
            }}
          >
            <SelectTrigger id="version" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {versionOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {images.data !== undefined && images.data.published.length === 0
              ? t('instances.versionEmpty')
              : t('instances.versionHint')}
          </p>
        </Field>

        <div className="flex gap-3">
          <Field className="flex-1">
            <FieldLabel htmlFor="memory">{t('instances.memory')}</FieldLabel>
            <Select
              items={memoryOptions}
              value={memoryValue ?? memoryMb}
              onValueChange={(value) => {
                if (typeof value === 'number') setMemoryMb(value)
              }}
            >
              <SelectTrigger id="memory" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {memoryOptions.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field className="flex-1">
            <FieldLabel htmlFor="cpu">{t('instances.cpu')}</FieldLabel>
            <Select
              items={cpuOptions}
              value={cpuValue ?? cpus}
              onValueChange={(value) => {
                if (typeof value === 'number') setCpus(value)
              }}
            >
              <SelectTrigger id="cpu" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {cpuOptions.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="disk">{t('instances.disk')}</FieldLabel>
            <Select
              items={diskOptions}
              value={diskValue ?? diskMb}
            onValueChange={(value) => {
              if (typeof value === 'number') setDiskMb(value)
            }}
          >
            <SelectTrigger id="disk" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {diskOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('instances.diskHint')}</p>
        </Field>

        <Field>
          <FieldLabel htmlFor="pids">{t('instances.pidsLimit')}</FieldLabel>
          <Input
            id="pids"
            inputMode="numeric"
            value={pids}
            onChange={(e) => setPids(e.target.value)}
            aria-invalid={!pidsValid}
          />
          <p className="text-xs text-muted-foreground">
            {pidsValid
              ? t('instances.pidsHint', { min: pidsFloor, max: maxPidsLimit })
              : t('instances.pidsInvalid', { min: pidsFloor, max: maxPidsLimit })}
          </p>
        </Field>
          </div>
        </details>
      </FieldGroup>

      <DialogFooter className="mt-10 gap-3 sm:space-x-0">
        <Button variant="outline" className="h-10 px-6 text-[14px]" render={<Link to="/workspaces" />} nativeButton={false}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="h-10 px-6 text-[14px] shadow-sm" disabled={create.isPending || !pidsValid || !tiersReady}>
          {create.isPending ? t('instances.creating') : t('instances.create')}
        </Button>
      </DialogFooter>
    </form>
  )
}
