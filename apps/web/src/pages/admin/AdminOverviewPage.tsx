import { useQuery } from '@tanstack/react-query'
import { ArrowRightIcon, HardDriveIcon, UsersIcon, WorkflowIcon, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { AdminMetricStrip, AdminPage } from '@/components/admin/admin-page.js'
import { Card } from '@/components/ui/card.js'
import { listAdminInstances, listAdminUsers } from '@/lib/api.js'
import { formatMb } from '@/lib/format.js'
import { needsAttention } from '@/lib/instance-status.js'
import { keys } from '@/lib/query-keys.js'

export default function AdminOverviewPage() {
  const { t } = useTranslation()
  const instances = useQuery({ queryKey: keys.adminInstances, queryFn: listAdminInstances })
  const users = useQuery({ queryKey: keys.adminUsers, queryFn: listAdminUsers })
  const workspaces = instances.data?.instances ?? []
  const usedStorage = workspaces.reduce((total, item) => total + (item.diskUsedMb ?? 0), 0)
  const attention = workspaces.filter(needsAttention).length
  const runningDetail =
    instances.data === undefined
      ? undefined
      : instances.data.maxRunning > 0
        ? `${instances.data.runningCount} / ${instances.data.maxRunning}`
        : String(instances.data.runningCount)

  return (
    <AdminPage title={t('admin.overview.title')} description={t('admin.overview.description')}>
      <AdminMetricStrip items={[
        {
          icon: WorkflowIcon,
          label: t('admin.overview.workspaces'),
          value: instances.isPending ? '—' : workspaces.length,
          detail: runningDetail !== undefined
            ? `${t('admin.overview.attention', { count: attention })} · ${t('status.running')} ${runningDetail}`
            : t('admin.overview.attention', { count: attention }),
        },
        { icon: UsersIcon, label: t('admin.overview.users'), value: users.isPending ? '—' : users.data?.users.length ?? 0, detail: t('admin.overview.activeUsers') },
        { icon: HardDriveIcon, label: t('admin.overview.storage'), value: instances.isPending ? '—' : formatMb(usedStorage), detail: t('admin.overview.measured') },
      ]} />
      
      <section className="mt-4">
        <h2 className="text-[13px] font-medium tracking-tight mb-4 text-foreground/80">{t('admin.overview.operations')}</h2>
        <Card className="flex flex-col p-0 gap-0 divide-y divide-border/60">
          <AdminLink to="/admin/instances" icon={WorkflowIcon} title={t('nav.adminInstances')} body={t('admin.overview.manageWorkspaces')} />
          <AdminLink to="/admin/users" icon={UsersIcon} title={t('nav.adminUsers')} body={t('admin.overview.manageUsers')} />
          <AdminLink to="/admin/versions" icon={HardDriveIcon} title={t('nav.adminVersions')} body={t('admin.overview.manageVersions')} />
        </Card>
      </section>
    </AdminPage>
  )
}

function AdminLink({ to, icon: Icon, title, body }: { to: string; icon: LucideIcon; title: string; body: string }) {
  return (
    <Link to={to} className="group flex items-center justify-between p-6 transition-colors hover:bg-muted/30 outline-none">
      <div className="flex items-center gap-4">
        <div className="size-10 rounded-full bg-muted/50 flex items-center justify-center shrink-0 text-muted-foreground group-hover:text-primary transition-colors">
          <Icon className="size-4.5" />
        </div>
        <div>
          <p className="text-[14px] font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{body}</p>
        </div>
      </div>
      <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
    </Link>
  )
}
