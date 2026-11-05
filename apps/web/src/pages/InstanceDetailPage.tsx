import { useQuery } from '@tanstack/react-query'
import { ArrowLeftIcon, ArrowRightIcon, DatabaseIcon, SettingsIcon, TerminalSquareIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { StatusBadge } from '@/components/status-badge.js'
import { Card } from '@/components/ui/card.js'
import { Button } from '@/components/ui/button.js'
import { getInstance } from '@/lib/api.js'
import { dshVersionLabel, formatMb } from '@/lib/format.js'
import { instanceRefetchInterval } from '@/lib/instance-status.js'
import { keys } from '@/lib/query-keys.js'

export default function InstanceDetailPage() {
  const { id = '' } = useParams()
  const { t, i18n } = useTranslation()

  const instance = useQuery({
    queryKey: keys.instance(id),
    queryFn: () => getInstance(id),
    enabled: id !== '',
    refetchInterval: (query) => instanceRefetchInterval(query.state.data),
  })

  if (instance.isError) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 pt-10">
        <BackLink />
        <p className="text-sm text-destructive">{t('workspaceDetail.notFound')}</p>
      </div>
    )
  }

  if (instance.data === undefined) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 pt-10">
        <BackLink />
        <p className="text-sm text-muted-foreground animate-pulse">{t('common.loading')}</p>
      </div>
    )
  }

  const item = instance.data

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col px-6 pt-8 md:pt-10 relative z-10 pb-16">
      <div className="mb-6">
        <BackLink />
      </div>
      
      <header className="flex flex-col sm:flex-row sm:items-center justify-between pb-8 border-b border-border/40">
        <div className="flex items-center gap-4">
          <div className="size-12 rounded-xl bg-card border border-border/80 shadow-sm flex items-center justify-center shrink-0 text-muted-foreground">
            <TerminalSquareIcon className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground truncate max-w-[200px] sm:max-w-none">{item.slug}</h1>
              <StatusBadge status={item.status} statusText={item.statusText} className="shrink-0" />
            </div>
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
              {t('workspaceDetail.created', { time: new Date(item.createdAt).toLocaleDateString(i18n.language) })}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-3 w-full sm:w-auto mt-6 sm:mt-0 relative z-10">
          <Button variant="outline" size="icon" className="h-10 w-10 shrink-0 shadow-sm" title={t('workspaceDetail.settings')} render={<Link to={`/workspaces/${id}/settings`} />} nativeButton={false}>
            <SettingsIcon className="size-4.5 text-muted-foreground" />
            <span className="sr-only">{t('workspaceDetail.settings')}</span>
          </Button>
          <Button className="h-10 flex-1 sm:flex-none shadow-sm whitespace-nowrap px-6 text-[14px]" render={<Link to={`/workspaces/${id}/open`} />} nativeButton={false}>
            {t('workspaceDetail.open')}
            <ArrowRightIcon className="ml-1.5 size-4" />
          </Button>
        </div>
      </header>

      {item.lastError !== null && (
        <div className="mt-8 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-[13px] font-medium text-destructive">{t('workspaceDetail.attention')}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-destructive/80">{item.lastError}</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mt-8">
         <Card className="flex flex-col p-6 justify-center relative overflow-hidden group">
            <DatabaseIcon className="absolute -right-4 -bottom-4 size-24 text-muted/20 transition-transform group-hover:scale-110 group-hover:-rotate-12 duration-500" />
            <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground mb-4 relative z-10">{t('workspaceDetail.storage')}</span>
            <div className="flex items-baseline gap-2 relative z-10">
               <span className="text-3xl font-light tabular-nums tracking-tight text-foreground">
                 {item.diskUsedMb === undefined ? t('instanceDetail.noData') : formatMb(item.diskUsedMb)}
               </span>
            </div>
         </Card>
         
         <Card className="flex flex-col p-6 justify-center">
            <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground mb-4">{t('workspaceDetail.version')}</span>
            <span className="text-sm font-mono text-foreground truncate" title={item.image}>{dshVersionLabel(item.image)}</span>
         </Card>

         <Card className="flex flex-col p-6 justify-center sm:col-span-2 lg:col-span-1">
            <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground mb-4">{t('workspaceDetail.recent')}</span>
            <p className="text-[13px] font-medium text-foreground">
              {item.stoppedAt === null ? t('workspaceDetail.available') : t('activity.stopped')}
            </p>
            <time className="mt-1.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground tabular-nums">
              {new Date(item.stoppedAt ?? item.createdAt).toLocaleString(i18n.language)}
            </time>
         </Card>
      </div>
    </div>
  )
}

function BackLink() {
  const { t } = useTranslation()
  return (
    <Link
      to="/workspaces"
      className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-primary"
    >
      <ArrowLeftIcon className="size-3.5" />
      {t('workspaceDetail.back')}
    </Link>
  )
}
