import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import type { AdminUser, PlatformCaps } from '@/lib/api.js'

/**
 * 改这个用户**单个**工作空间的资源上限。
 *
 * 留空 = 清掉个人覆盖、回落平台封顶（placeholder 就是那个平台数）。
 * 空值必须能提交，不能当成非法输入。写得比平台高则按钮不可用——服务端也会 400。
 */
export function UserResourceCapsEditor({
  user,
  caps,
  pending,
  onSave,
}: {
  user: AdminUser
  caps: PlatformCaps
  pending: boolean
  onSave: (value: {
    cpuQuota: number | null
    memoryMbQuota: number | null
    pidsQuota: number | null
    diskMbQuota: number | null
  }) => void
}) {
  const { t } = useTranslation()
  const stored = {
    cpu: user.cpuQuota === null ? '' : String(user.cpuQuota),
    memory: user.memoryMbQuota === null ? '' : String(user.memoryMbQuota),
    pids: user.pidsQuota === null ? '' : String(user.pidsQuota),
    disk: user.diskMbQuota === null ? '' : String(user.diskMbQuota),
  }
  const [cpu, setCpu] = useState(stored.cpu)
  const [memory, setMemory] = useState(stored.memory)
  const [pids, setPids] = useState(stored.pids)
  const [disk, setDisk] = useState(stored.disk)

  const cpuValue = parsePositive(cpu, caps.maxCpus)
  const memoryValue = parseIntInRange(memory, 1, caps.maxMemoryMb)
  const pidsValue = parseIntInRange(pids, 1, caps.maxPids)
  // 磁盘档位本身有 128MB 下限，封顶写得更低会让创建无解。
  const diskValue = parseIntInRange(disk, 128, caps.maxDiskMb)
  const valid =
    cpuValue !== undefined &&
    memoryValue !== undefined &&
    pidsValue !== undefined &&
    diskValue !== undefined
  const dirty = cpu !== stored.cpu || memory !== stored.memory || pids !== stored.pids || disk !== stored.disk

  const fields = [
    { id: 'cpu', label: t('admin.users.cpuQuota'), value: cpu, set: setCpu, placeholder: String(caps.maxCpus), step: '0.1' },
    { id: 'memory', label: t('admin.users.memoryQuota'), value: memory, set: setMemory, placeholder: String(caps.maxMemoryMb), step: '1' },
    { id: 'pids', label: t('admin.users.pidsQuota'), value: pids, set: setPids, placeholder: String(caps.maxPids), step: '1' },
    { id: 'disk', label: t('admin.users.diskQuota'), value: disk, set: setDisk, placeholder: String(caps.maxDiskMb), step: '1' },
  ] as const

  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs text-muted-foreground">{t('admin.users.resourceCaps')}</p>
      <div className="grid grid-cols-2 gap-2">
        {fields.map((field) => (
          <label key={field.id} className="flex flex-col gap-1 text-xs text-muted-foreground">
            {field.label}
            <Input
              className="h-8 w-24"
              inputMode="decimal"
              value={field.value}
              placeholder={field.placeholder}
              step={field.step}
              onChange={(e) => field.set(e.target.value)}
            />
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t('admin.users.resourceCapsHint')}</p>
      <Button
        variant="outline"
        size="sm"
        disabled={!dirty || !valid || pending}
        onClick={() => {
          if (cpuValue === undefined || memoryValue === undefined || pidsValue === undefined || diskValue === undefined) {
            return
          }
          onSave({
            cpuQuota: cpuValue,
            memoryMbQuota: memoryValue,
            pidsQuota: pidsValue,
            diskMbQuota: diskValue,
          })
        }}
      >
        {t('admin.users.saveResourceCaps')}
      </Button>
    </div>
  )
}

/** 空串 = 恢复平台默认；非法（含高于平台）= undefined。 */
function parsePositive(raw: string, max: number): number | null | undefined {
  if (raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || n > max) return undefined
  return n
}

function parseIntInRange(raw: string, min: number, max: number): number | null | undefined {
  if (raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) return undefined
  return n
}
