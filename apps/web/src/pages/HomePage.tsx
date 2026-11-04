import { useQuery } from '@tanstack/react-query'
import { AlertTriangleIcon, ArrowRightIcon, DatabaseIcon, PlusIcon, TerminalSquareIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { StatusBadge } from '@/components/status-badge.js'
import { Button } from '@/components/ui/button.js'
import { Card } from '@/components/ui/card.js'
import { Skeleton } from '@/components/ui/skeleton.js'
import { listInstances } from '@/lib/api.js'
import { listRefetchInterval } from '@/lib/instance-status.js'
import { keys } from '@/lib/query-keys.js'
import { useSession } from '@/lib/use-session.js'

export default function HomePage() {
  const { t, i18n } = useTranslation()
  const { data: user } = useSession()
  const instances = useQuery({
    queryKey: keys.instances,
    queryFn: listInstances,
    refetchInterval: (query) => listRefetchInterval(query.state.data?.instances),
  })
  
  const recent = instances.data?.instances ?? []
  const current = recent[0]
  const others = recent.filter((item) => item.id !== current?.id).slice(0, 3)
  const name = user?.name?.split(/\s+/)[0] || user?.email.split('@')[0] || ''
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col px-6 pt-8 md:pt-10 relative z-10 pb-16">
      <header className="mb-10">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          {t(`home.${greeting}`, { name })}
        </h1>
        <p className="mt-2 text-[14px] text-muted-foreground">{t('home.subtitle')}</p>
      </header>

      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[13px] font-medium tracking-tight text-foreground/80">{t('home.continue')}</h2>
        </div>

        {instances.isPending && (
           <Card className="h-32 flex items-center p-6">
              <Skeleton className="h-8 w-1/3 rounded-md" />
           </Card>
        )}

        {instances.isError && (
          <Card className="p-6">
            <p className="text-sm text-destructive">{t('instances.loadFailed')}</p>
          </Card>
        )}

        {instances.data !== undefined && current === undefined && (
          <Card className="flex flex-col items-center justify-center border-dashed p-12 text-center">
            <div className="mb-4 flex size-11 items-center justify-center border border-border/80 text-muted-foreground">
              <PlusIcon className="size-4" />
            </div>
            <p className="text-[14px] font-medium text-foreground">{t('home.emptyTitle')}</p>
            <p className="mt-1 text-[13px] text-muted-foreground mb-6 max-w-md">{t('home.emptyBody')}</p>
            <Button className="h-10 px-6 text-[14px] shadow-sm" render={<Link to="/workspaces/new" />} nativeButton={false}>
              <PlusIcon className="mr-1.5 size-4" />
              {t('home.create')}
            </Button>
          </Card>
        )}

        {current !== undefined && (
          <div className="space-y-4">
            {current.lastError !== null && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 flex items-start gap-3">
                <AlertTriangleIcon className="size-4 shrink-0 text-destructive mt-0.5" aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-destructive">{t('workspaceDetail.attention')}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-destructive/80">{current.lastError}</p>
                </div>
                <Button variant="outline" className="h-8 px-4 text-xs shadow-none shrink-0" render={<Link to={`/workspaces/${current.id}`} />} nativeButton={false}>
                  {t('workspaceDetail.settings')}
                </Button>
              </div>
            )}

            <Card className="group relative flex flex-col gap-6 overflow-hidden border-l-2 border-l-primary p-6 sm:flex-row sm:items-center sm:justify-between">
              <Link to={`/workspaces/${current.id}/open`} className="absolute inset-0 z-0 outline-none">
                <span className="sr-only">{t('instances.open')}</span>
              </Link>
              
              <div className="flex items-center gap-4 relative z-10 pointer-events-none">
                <div className="size-12 rounded-xl bg-card border border-border/80 shadow-sm flex items-center justify-center shrink-0 text-muted-foreground">
                  <TerminalSquareIcon className="size-5" />
                </div>
                <div>
                  <div className="flex items-center gap-3">
                    <h3 className="font-heading text-xl font-semibold tracking-tight text-foreground truncate max-w-[200px] sm:max-w-md">{current.slug}</h3>
                    <StatusBadge status={current.status} statusText={current.statusText} />
                  </div>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    {t('instances.lastUsed', {
                      time: relativeDate(current.stoppedAt ?? current.createdAt, i18n.language),
                    })}
                  </p>
                </div>
              </div>
              
              <div className="relative z-10 w-full sm:w-auto mt-2 sm:mt-0">
                <Button className="h-10 w-full sm:w-auto px-6 text-[14px] shadow-sm pointer-events-auto" render={<Link to={`/workspaces/${current.id}/open`} />} nativeButton={false}>
                  {t('instances.open')}
                  <ArrowRightIcon className="ml-1.5 size-4" />
                </Button>
              </div>
            </Card>
          </div>
        )}
      </section>

      {current !== undefined && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8 mt-8 lg:mt-10">
          <section className="lg:col-span-2">
            <h2 className="text-[13px] font-medium tracking-tight mb-4 text-foreground/80">{t('home.activity')}</h2>
            <Card className="flex flex-col p-0 gap-0 divide-y divide-border/60">
              {others.length === 0 ? (
                <div className="p-6 text-[13px] text-muted-foreground text-center">
                  {t('activity.empty')}
                </div>
              ) : (
                others.map((item) => (
                  <Link key={item.id} to={`/workspaces/${item.id}`} className="group flex flex-col sm:flex-row sm:items-center justify-between p-5 transition-colors hover:bg-muted/30 outline-none gap-2 sm:gap-0">
                    <div className="flex items-center gap-3">
                      <span className="text-[14px] font-medium text-foreground truncate max-w-[200px]">{item.slug}</span>
                      <StatusBadge status={item.status} statusText={item.statusText} className="shrink-0" />
                    </div>
                    <div className="flex items-center justify-between sm:justify-end sm:gap-4 text-[13px] text-muted-foreground">
                      <time className="tabular-nums">
                        {relativeDate(item.stoppedAt ?? item.createdAt, i18n.language)}
                      </time>
                      <ArrowRightIcon className="size-4 opacity-0 -translate-x-2 transition-all group-hover:opacity-100 group-hover:translate-x-0 group-hover:text-primary hidden sm:block" />
                    </div>
                  </Link>
                ))
              )}
            </Card>
          </section>
          
          <section>
            <h2 className="text-[13px] font-medium tracking-tight mb-4 text-foreground/80">{t('home.quickActions')}</h2>
            <Card className="flex flex-col p-0 gap-0 divide-y divide-border/60">
              <Link to="/workspaces/new" className="group flex items-center justify-between p-5 transition-colors hover:bg-muted/30 outline-none">
                <div className="flex items-center gap-3 text-[14px] font-medium text-foreground">
                  <PlusIcon className="size-4 text-muted-foreground group-hover:text-primary transition-colors" />
                  {t('home.create')}
                </div>
                <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
              </Link>
              <Link to="/workspaces" className="group flex items-center justify-between p-5 transition-colors hover:bg-muted/30 outline-none">
                <div className="flex items-center gap-3 text-[14px] font-medium text-foreground">
                  <DatabaseIcon className="size-4 text-muted-foreground group-hover:text-primary transition-colors" />
                  {t('nav.workspaces')}
                </div>
                <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
              </Link>
            </Card>
          </section>
        </div>
      )}
    </div>
  )
}

function relativeDate(value: string, locale: string): string {
  const days = -Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 86_400_000))
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day')
}
