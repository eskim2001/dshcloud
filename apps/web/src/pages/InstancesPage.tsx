import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, TerminalSquareIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { BrandMark } from '@/components/brand-mark.js'
import { InstanceCard } from '@/components/instances/instance-card.js'
import { Card } from '@/components/ui/card.js'
import { PageHeader } from '@/components/page-header.js'
import { Button, buttonVariants } from '@/components/ui/button.js'
import {
  ApiError,
  listInstances,
  removeInstance,
  restartInstance,
  startInstance,
  stopInstance,
} from '@/lib/api.js'
import { listRefetchInterval } from '@/lib/instance-status.js'
import { invalidateInstances, keys } from '@/lib/query-keys.js'
import { cn } from '@/lib/utils.js'

export default function InstancesPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const instances = useQuery({
    queryKey: keys.instances,
    queryFn: listInstances,
    refetchInterval: (query) => listRefetchInterval(query.state.data?.instances),
  })

  const list = instances.data?.instances ?? []
  const maxInstances = instances.data?.maxInstances
  const atLimit = maxInstances !== undefined && list.length >= maxInstances

  const invalidate = () => invalidateInstances(queryClient)

  const restart = useMutation({ mutationFn: restartInstance, onSuccess: invalidate })
  const stop = useMutation({ mutationFn: stopInstance, onSuccess: invalidate })
  const start = useMutation({ mutationFn: startInstance, onSuccess: invalidate })

  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null)

  const remove = useMutation({
    mutationFn: ({ id, confirmSlug }: { id: string; confirmSlug: string }) =>
      removeInstance(id, confirmSlug),
    onSuccess: async (_data, { id }) => {
      setDeleteError((prev) => (prev?.id === id ? null : prev))
      await invalidate()
    },
    onError: (err, { id }) => {
      setDeleteError({
        id,
        message: err instanceof ApiError ? err.message : t('instances.deleteFailed'),
      })
    },
  })

  const busyFor = (id: string) =>
    (restart.isPending && restart.variables === id) ||
    (stop.isPending && stop.variables === id) ||
    (start.isPending && start.variables === id) ||
    (remove.isPending && remove.variables?.id === id)

  return (
    <div className="relative min-h-[calc(100vh-4rem)] w-full pb-12">

      <div className="relative mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-6 md:pt-8 z-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <h1 className="font-heading text-[1.65rem] font-medium tracking-[-0.03em] text-foreground">
                {t('instances.title')}
              </h1>
              {maxInstances !== undefined && (
                <div 
                  className="flex items-center rounded-md border border-border/80 bg-muted/30 px-2.5 py-1 text-[11px] font-medium uppercase tracking-widest text-muted-foreground"
                  title={atLimit ? t('instances.quotaFull') : undefined}
                >
                  {t('instances.quotaUsed', { used: list.length, limit: maxInstances })}
                </div>
              )}
            </div>
            <p className="text-[14px] leading-6 text-muted-foreground max-w-[600px]">
              {t('instances.subtitle')}
            </p>
          </div>
          
          <div className="shrink-0 relative z-10">
            {atLimit ? (
              <Button disabled className="h-10 px-6 text-[14px] shadow-sm">
                <PlusIcon className="mr-1.5 size-4" />
                {t('instances.create')}
              </Button>
            ) : (
              <Button className="h-10 px-6 text-[14px] shadow-sm transition-transform active:translate-y-[1px]" render={<Link to="/workspaces/new" />} nativeButton={false}>
                <PlusIcon className="mr-1.5 size-4" />
                {t('instances.create')}
              </Button>
            )}
          </div>
        </div>

        {instances.isPending && (
          <div className="flex items-center justify-center py-20">
            <p className="font-mono text-xs text-muted-foreground animate-pulse uppercase">{t('common.loading')}</p>
          </div>
        )}
        
        {instances.isError && (
          <div className="border border-destructive/20 bg-destructive/5 p-4 rounded-md">
            <p className="text-sm text-destructive">{t('instances.loadFailed')}</p>
          </div>
        )}

        {instances.data !== undefined && list.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/20 py-24 text-center">
            <div className="flex size-12 items-center justify-center rounded-lg bg-background border shadow-xs mb-4">
              <BrandMark className="size-6 text-foreground" />
            </div>
            <h2 className="text-lg font-medium text-foreground tracking-tight">{t('instances.emptyTitle')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('instances.emptyHint')}</p>
            <Button variant="outline" className="mt-6 h-10 px-6 text-[14px] shadow-sm" render={<Link to="/workspaces/new" />} nativeButton={false}>
              {t('instances.emptyAction')}
            </Button>
          </div>
        )}

        {list.length > 0 && (
          <Card className="flex flex-col p-0 gap-0">
            {list.map((instance, i) => (
              <InstanceCard
                key={instance.id}
                instance={instance}
                busy={busyFor(instance.id)}
                deleteError={deleteError?.id === instance.id ? deleteError.message : null}
                onRestart={() => restart.mutate(instance.id)}
                onStop={() => stop.mutate(instance.id)}
                onStart={() => start.mutate(instance.id)}
                onDelete={(confirmSlug) => remove.mutate({ id: instance.id, confirmSlug })}
                className={i !== list.length - 1 ? "border-b border-border/60" : ""}
              />
            ))}
          </Card>
        )}
      </div>
    </div>
  )
}
