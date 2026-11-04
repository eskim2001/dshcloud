import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { PageHeader } from '@/components/page-header.js'
import { cn } from '@/lib/utils.js'

export function AdminPage({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 pt-6 md:pt-8 relative z-10">
      <PageHeader
        title={title}
        {...(description === undefined ? {} : { description })}
        {...(actions === undefined ? {} : { actions })}
      />
      {children}
    </div>
  )
}

export function AdminMetricStrip({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; icon: LucideIcon; detail?: string; alert?: boolean }>
}) {
  return (
    <div className="grid rounded-xl border border-border/80 bg-card shadow-sm sm:grid-cols-3 overflow-hidden">
      {items.map(({ label, value, icon: Icon, detail, alert }, idx) => (
        <div
          key={label}
          className={cn(
            "flex min-h-24 items-center gap-4 py-5 px-6",
            idx !== items.length - 1 && "border-b sm:border-b-0 sm:border-r border-border/60"
          )}
        >
          <Icon className={cn('size-5 text-muted-foreground', alert && 'text-destructive')} />
          <div>
            <p className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-medium tabular-nums tracking-tight text-foreground">{value}</p>
            {detail !== undefined && <p className="mt-1 text-xs text-muted-foreground">{detail}</p>}
          </div>
        </div>
      ))}
    </div>
  )
}

export function AdminTableSection({
  toolbar,
  children,
}: {
  toolbar?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col rounded-xl border border-border/80 bg-card shadow-sm overflow-hidden">
      {toolbar !== undefined && (
        <div className="flex flex-col justify-between gap-4 border-b border-border/60 bg-muted/30 px-6 py-5 lg:flex-row lg:items-center">
          {toolbar}
        </div>
      )}
      <div className="min-w-0 px-4 py-3 md:px-5 relative z-10">{children}</div>
    </section>
  )
}
