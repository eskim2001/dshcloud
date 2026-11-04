import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangleIcon, CircleCheckIcon, Layers3Icon, MoreHorizontalIcon, SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { InstanceImageForm } from '@/components/admin/instance-image-form.js'
import { InstanceQuotaForm } from '@/components/admin/instance-quota-form.js'
import { AdminMetricStrip, AdminPage, AdminTableSection } from '@/components/admin/admin-page.js'
import { LogsSheet, type LogsTarget } from '@/components/logs-sheet.js'
import { QuotaMeter } from '@/components/quota-meter.js'
import { StatusBadge } from '@/components/status-badge.js'
import { Button } from '@/components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js'
import { Input } from '@/components/ui/input.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.js'
import {
  listAdminInstances,
  rollbackAdminInstanceImage,
  setAdminInstanceImage,
  setInstanceQuota,
  type AdminInstance,
} from '@/lib/api.js'
import { errorTextOf } from '@/lib/error-text.js'
import { listRefetchInterval, needsAttention } from '@/lib/instance-status.js'
import { invalidateInstances, keys } from '@/lib/query-keys.js'

/**
 * 舰队视图：全站实例的状态、磁盘与日志。
 *
 * 这个页面存在的理由只有一条：**一屏里看全"谁不对、谁快满"**。所以没有面板、没有图表、
 * 没有分页控件——顶上一条筛选，下面一张表，动作全收进行尾的 `⋯`。
 *
 * 不能浏览用户实例里的 `/data`：那是隔离边界，不是权限问题（能看日志是排障需要）。
 */
export default function AdminInstancesPage() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()

  // 实例状态由服务端从 Docker 现算，会漂（crash-loop / 外部停掉 / 宿主重启）→ 低频兜底
  const instances = useQuery({
    queryKey: keys.adminInstances,
    queryFn: listAdminInstances,
    // 见 lib/instance-status.ts：在途按 3 秒跟，其余 10 秒兜底
    refetchInterval: (query) => listRefetchInterval(query.state.data?.instances),
  })

  /** 正在看日志的实例（null = 抽屉关着）。 */
  const [logTarget, setLogTarget] = useState<LogsTarget | null>(null)
  /** 正在改配额的实例（null = 对话框关着）。 */
  const [quotaTarget, setQuotaTarget] = useState<AdminInstance | null>(null)
  /** 正在改镜像的实例（null = 对话框关着）。 */
  const [imageTarget, setImageTarget] = useState<AdminInstance | null>(null)

  /** 状态筛选（`all` = 不筛）。 */
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [search, setSearch] = useState('')

  /** 筛选按钮上固定这几个状态；状态是服务端现算的，做成"出现过的状态"会一直在抖。 */
  const statusFilters = ['all', 'running', 'stopped', 'error'] as const
  const list = instances.data?.instances ?? []
  const attentionCount = list.filter(needsAttention).length
  const runningCount = instances.data?.runningCount ?? list.filter((item) => item.status === 'running').length
  const maxRunning = instances.data?.maxRunning
  const platformCaps = instances.data?.platformCaps
  const visible = list.filter((i) => {
    if (statusFilter !== 'all' && i.status !== statusFilter) return false
    const needle = search.trim().toLowerCase()
    return needle === '' || i.slug.toLowerCase().includes(needle) || i.ownerEmail.toLowerCase().includes(needle)
  })

  /** 实例相关的改动**两个列表一起刷**（用户面 + 舰队面），并把该实例的详情带上。 */
  const refreshInstances = (id?: string) => invalidateInstances(queryClient, id)

  const instanceQuota = useMutation({
    mutationFn: ({ id, value }: { id: string; value: Parameters<typeof setInstanceQuota>[1] }) =>
      setInstanceQuota(id, value),
    onSuccess: () => refreshInstances(),
  })
  const instanceImage = useMutation({
    mutationFn: ({ id, image }: { id: string; image: string }) => setAdminInstanceImage(id, image),
    onSuccess: () => refreshInstances(),
  })
  const instanceRollback = useMutation({
    mutationFn: rollbackAdminInstanceImage,
    onSuccess: () => refreshInstances(),
  })

  const renderActions = (item: AdminInstance) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('admin.instances.actions')}
          />
        }
      >
        <MoreHorizontalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setQuotaTarget(item)}>
          {t('admin.instances.editQuota')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setImageTarget(item)}>
          {t('admin.instances.editImage')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setLogTarget({ id: item.id, slug: item.slug, scope: 'admin' })}
        >
          {t('admin.instances.logs')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <>
      <AdminPage title={t('admin.instances.title')} description={t('admin.instances.description')}>
        <AdminMetricStrip
          items={[
            { label: t('admin.instances.total'), value: list.length, icon: Layers3Icon },
            {
              label: t('status.running'),
              value:
                maxRunning !== undefined && maxRunning > 0
                  ? `${runningCount} / ${maxRunning}`
                  : runningCount,
              icon: CircleCheckIcon,
            },
            { label: t('admin.instances.needsAttention'), value: attentionCount, icon: AlertTriangleIcon, alert: attentionCount > 0 },
          ]}
        />

        <AdminTableSection
          toolbar={
            <>
              <div className="relative w-full lg:max-w-xs">
                <SearchIcon className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('admin.instances.search')} className="pl-9" />
              </div>
              <div className="flex flex-wrap items-center gap-1">
            {statusFilters.map((s) => (
              <Button
                key={s}
                variant={s === statusFilter ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setStatusFilter(s === statusFilter ? 'all' : s)}
              >
                {s === 'all' ? t('admin.instances.filterAll') : t(`status.${s}`, { defaultValue: s })}
              </Button>
            ))}
              </div>
            </>
          }
        >
          {instances.isPending && (
            <p className="py-10 text-sm text-muted-foreground">{t('common.loading')}</p>
          )}
          {instances.isError && (
            <p className="text-sm text-destructive">{t('admin.instances.loadFailed')}</p>
          )}

          {instances.data !== undefined && (
            <div className="divide-y md:hidden">
              {visible.map((item) => (
                <div key={item.id} className="py-4">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <p className="min-w-0 break-all font-medium">{item.slug}</p>
                    <div className="shrink-0">{renderActions(item)}</div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-5">
                    <div className="min-w-0">
                      <p className="mb-1.5 text-xs text-muted-foreground">
                        {t('admin.instances.status')}
                      </p>
                      <StatusBadge status={item.status} statusText={item.statusText} />
                    </div>
                    <div className="min-w-0">
                      <p className="mb-1.5 text-xs text-muted-foreground">
                        {t('admin.instances.disk')}
                      </p>
                      <QuotaMeter
                        usedMb={item.diskUsedMb}
                        quotaMb={item.diskMb}
                        enforced={item.diskEnforced}
                        className="w-full min-w-0"
                      />
                    </div>
                  </div>
                  {(item.lastError !== null || (item.status === 'restarting' && item.statusText !== null)) && (
                    <p className="mt-3 text-xs text-destructive">
                      {item.lastError ?? item.statusText}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          {instances.data !== undefined && (
            <Table className="hidden min-w-[760px] md:table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.instances.slug')}</TableHead>
                  <TableHead className="hidden md:table-cell">
                    {t('admin.instances.owner')}
                  </TableHead>
                  <TableHead>{t('admin.instances.status')}</TableHead>
                  <TableHead>{t('admin.instances.disk')}</TableHead>
                  <TableHead className="hidden lg:table-cell">
                    {t('admin.instances.createdAt')}
                  </TableHead>
                  <TableHead className="sticky right-0 z-10 w-12 bg-background" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((item) => (
                  <TableRow key={item.id} className="group h-20">
                    <TableCell>
                      <p className="font-medium">{item.slug}</p>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {item.ownerEmail}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={item.status} statusText={item.statusText} />
                      {item.status === 'restarting' && item.statusText !== null && (
                        <div className="mt-1 font-mono text-xs text-destructive">
                          {item.statusText}
                        </div>
                      )}
                      {item.lastError !== null && (
                        <div className="mt-1 text-xs text-destructive">{item.lastError}</div>
                      )}
                    </TableCell>
                    {/* 「快满了」在这里就能看见，不用点进去 —— 这是舰队页存在的理由 */}
                    <TableCell>
                      <QuotaMeter
                        usedMb={item.diskUsedMb}
                        quotaMb={item.diskMb}
                        enforced={item.diskEnforced}
                      />
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground lg:table-cell">
                      {new Date(item.createdAt).toLocaleString(i18n.language)}
                    </TableCell>
                    <TableCell className="sticky right-0 z-10 w-12 bg-background transition-colors group-hover:bg-muted">
                      {/* 动作收进 `⋯`：默认一行只看状态与磁盘，不堆按钮 */}
                      {renderActions(item)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {instances.data !== undefined && visible.length === 0 && (
            <p className="border-b py-12 text-center text-sm text-muted-foreground">{t('admin.instances.noneMatch')}</p>
          )}
        </AdminTableSection>
      </AdminPage>

      {/* 日志抽屉：与用户列表**共用同一个组件**；关掉即卸载 → EventSource 跟着断 */}
      <LogsSheet target={logTarget} onClose={() => setLogTarget(null)} />

      <Dialog
        open={quotaTarget !== null}
        onOpenChange={(open) => {
          if (!open) setQuotaTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('admin.instances.quotaTitle')} · {quotaTarget?.slug}
            </DialogTitle>
            <DialogDescription>{t('admin.instances.quotaHint')}</DialogDescription>
          </DialogHeader>
          {quotaTarget !== null && platformCaps !== undefined && (
            <InstanceQuotaForm
              key={quotaTarget.id}
              item={quotaTarget}
              platformCaps={platformCaps}
              pending={instanceQuota.isPending}
              error={errorTextOf(instanceQuota.error, t('admin.actionFailed'))}
              onSubmit={(value) =>
                instanceQuota.mutate(
                  { id: quotaTarget.id, value },
                  { onSuccess: () => setQuotaTarget(null) },
                )
              }
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={imageTarget !== null}
        onOpenChange={(open) => {
          if (!open) setImageTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('admin.instances.imageTitle')} · {imageTarget?.slug}
            </DialogTitle>
            <DialogDescription>{t('admin.instances.imageHint')}</DialogDescription>
          </DialogHeader>
          {imageTarget !== null && (
            <InstanceImageForm
              key={imageTarget.id}
              item={imageTarget}
              pending={instanceImage.isPending}
              error={errorTextOf(instanceImage.error, t('admin.actionFailed'))}
              rollbackPending={instanceRollback.isPending}
              rollbackError={errorTextOf(instanceRollback.error, t('admin.actionFailed'))}
              onApply={(image) =>
                instanceImage.mutate(
                  { id: imageTarget.id, image },
                  { onSuccess: () => setImageTarget(null) },
                )
              }
              onRollback={() =>
                instanceRollback.mutate(imageTarget.id, {
                  onSuccess: () => setImageTarget(null),
                })
              }
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
