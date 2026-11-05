import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { LockKeyholeIcon, MonitorSmartphoneIcon, UserRoundIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/page-header.js'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.js'
import { Switch } from '@/components/ui/switch.js'
import {
  ApiError,
  changePassword,
  listSessions,
  revokeSession,
  updateUserName,
  type SessionSummary,
} from '@/lib/api.js'
import { keys } from '@/lib/query-keys.js'
import { describeUserAgent } from '@/lib/user-agent.js'
import { sessionKey, useSession } from '@/lib/use-session.js'

/**
 * 账号设置：资料、密码、登录设备。
 *
 * 这三件事原先散在「个人资料」和「会话」两个页面里，而「密码」根本没有入口——
 * 运维上这意味着"想改密码只能找管理员"。现在合成一页，顺序就是最常改的排最前。
 *
 * **邮箱是只读的**：换邮箱要先给新地址发验证信，平台没有邮件通道（见 auth.ts），
 * 所以这里写清楚原因，而不是给一个点了会失败的输入框。
 */
export default function AccountPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedView = searchParams.get('view')
  const activeView: AccountView = isAccountView(requestedView) ? requestedView : 'profile'
  const tabs = [
    { value: 'profile' as const, label: t('settings.account.tabs.profile'), icon: UserRoundIcon },
    { value: 'security' as const, label: t('settings.account.tabs.security'), icon: LockKeyholeIcon },
    { value: 'sessions' as const, label: t('settings.account.tabs.sessions'), icon: MonitorSmartphoneIcon },
  ]

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 pt-6 md:pt-8 relative z-10">
      <PageHeader
        title={t('settings.account.title')}
        description={t('settings.account.description')}
      />
      <div className="flex gap-8 border-b border-border/80" role="tablist" aria-label={t('settings.account.tabs.label')}>
        {tabs.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            id={`account-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={activeView === value}
            aria-controls={`account-panel-${value}`}
            className={`relative -mb-px inline-flex h-12 shrink-0 items-center gap-2 border-b-2 px-1 text-sm font-medium transition-colors ${activeView === value ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'}`}
            onClick={() => setSearchParams(value === 'profile' ? {} : { view: value }, { replace: true })}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </div>
      <div
        id={`account-panel-${activeView}`}
        role="tabpanel"
        aria-labelledby={`account-tab-${activeView}`}
      >
        {activeView === 'profile' && <ProfileCard />}
        {activeView === 'security' && <PasswordCard />}
        {activeView === 'sessions' && <SessionsCard />}
      </div>
    </div>
  )
}

type AccountView = 'profile' | 'security' | 'sessions'

function isAccountView(value: string | null): value is AccountView {
  return value === 'profile' || value === 'security' || value === 'sessions'
}

/**
 * 改昵称。邮箱只读——改邮箱要邮件验证通道（平台没配），所以摆的是**说明**不是输入框。
 */
function ProfileCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: user } = useSession()
  const stored = user?.name ?? ''
  const [name, setName] = useState(stored)
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    mutationFn: () => updateUserName(name.trim()),
    onSuccess: async () => {
      // 侧栏底部的名字读的是同一份会话缓存，不刷它就会留在旧值上
      await queryClient.invalidateQueries({ queryKey: sessionKey })
      setSaved(true)
    },
  })

  const dirty = name.trim() !== stored

  return (
    <AccountSection
      title={t('settings.profile.title')}
      description={t('settings.profile.description')}
    >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (dirty) save.mutate()
          }}
        >
          <FieldGroup className="grid max-w-2xl gap-5 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="account-name">{t('settings.profile.name')}</FieldLabel>
              <Input
                id="account-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setSaved(false)
                }}
                placeholder={t('settings.profile.namePlaceholder')}
                maxLength={64}
              />
            </Field>
            <Field>
              <FieldLabel>{t('login.email')}</FieldLabel>
              <span className="text-sm">{user?.email ?? ''}</span>
              <p className="text-xs text-muted-foreground">{t('settings.account.emailHint')}</p>
            </Field>
          </FieldGroup>

          {save.isError && (
            <p className="mt-4 text-sm text-destructive">
              {save.error instanceof ApiError
                ? save.error.message
                : t('settings.account.saveFailed')}
            </p>
          )}

          <div className="mt-5 flex items-center gap-3">
            <Button type="submit" className="h-10 px-6 text-[14px] shadow-sm" disabled={!dirty || save.isPending}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
            {saved && !dirty && (
              <span className="text-sm text-muted-foreground">{t('settings.account.saved')}</span>
            )}
          </div>
        </form>
    </AccountSection>
  )
}

/** 服务端配的最小长度（better-auth 默认 8，见 auth.ts 没覆盖过它）。 */
const MIN_PASSWORD_LENGTH = 8

/**
 * 改密码。**必须带当前密码**——否则会话被人拿到就等于账号被夺走。
 *
 * 错误优先按 better-auth 的 `code` 翻成本地文案（它的 message 是英文的）；
 * 认不出来的码就把服务端原文摆出来，总比吞掉强。
 */
function PasswordCard() {
  const { t } = useTranslation()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [revokeOthers, setRevokeOthers] = useState(true)

  const change = useMutation({
    mutationFn: () =>
      changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: revokeOthers,
      }),
    onSuccess: () => {
      setCurrent('')
      setNext('')
      setConfirm('')
    },
  })

  const tooShort = next !== '' && next.length < MIN_PASSWORD_LENGTH
  const mismatch = confirm !== '' && confirm !== next
  const valid = current !== '' && next.length >= MIN_PASSWORD_LENGTH && next === confirm

  const localError = tooShort
    ? t('settings.account.passwordTooShort', { min: MIN_PASSWORD_LENGTH })
    : mismatch
      ? t('settings.account.passwordMismatch')
      : null

  return (
    <AccountSection
      title={t('login.password')}
      description={t('settings.account.passwordDescription')}
    >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (valid) change.mutate()
          }}
        >
          <FieldGroup className="grid gap-5 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="password-current">{t('settings.account.currentPassword')}</FieldLabel>
              <Input
                id="password-current"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => {
                  setCurrent(e.target.value)
                  if (change.isError) change.reset()
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="password-new">{t('settings.account.newPassword')}</FieldLabel>
              <Input
                id="password-new"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => {
                  setNext(e.target.value)
                  if (change.isError) change.reset()
                }}
              />
              {/* 规则就贴在新密码下面——先前只在提交失败时才看到「至少 8 位」 */}
              <p className="text-xs text-muted-foreground">
                {t('settings.account.passwordRule', { min: MIN_PASSWORD_LENGTH })}
              </p>
            </Field>
            <Field>
              <FieldLabel htmlFor="password-confirm">
                {t('settings.account.confirmPassword')}
              </FieldLabel>
              <Input
                id="password-confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
          </FieldGroup>

          {/* 「踢掉其他设备」是有副作用的开关：独立成块、写明后果，
              不和「保存」挤在一行（先前那个已按下的 toggle 看不出是开关）。 */}
          <div className="mt-6 flex items-center justify-between gap-4 rounded-md border border-border/80 p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {t('settings.account.revokeOthers')}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t('settings.account.revokeOthersHint')}
              </p>
            </div>
            <Switch
              checked={revokeOthers}
              onCheckedChange={(checked) => setRevokeOthers(checked)}
              aria-label={t('settings.account.revokeOthers')}
            />
          </div>

          <div className="mt-5">
            <Button type="submit" className="h-10 px-6 text-[14px] shadow-sm" disabled={!valid || change.isPending}>
              {change.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>

          {localError !== null && <p className="mt-4 text-sm text-destructive">{localError}</p>}
          {change.isError && (
            <p className="mt-4 text-sm text-destructive">
              {passwordErrorText(
                change.error,
                t('settings.account.passwordFailed'),
                t,
              )}
            </p>
          )}
          {change.isSuccess && (
            <p className="mt-4 text-sm text-muted-foreground">{t('settings.account.passwordChanged')}</p>
          )}

        </form>
    </AccountSection>
  )
}

function passwordErrorText(error: unknown, fallback: string, t: TFunction): string {
  if (!(error instanceof ApiError)) return fallback
  switch (error.code) {
    case 'INVALID_PASSWORD':
      return t('settings.account.wrongPassword')
    case 'PASSWORD_TOO_SHORT':
      return t('settings.account.passwordTooShort', { min: MIN_PASSWORD_LENGTH })
    case 'CREDENTIAL_ACCOUNT_NOT_FOUND':
      return t('settings.account.noPassword')
    default:
      // 认不出来的码：把服务端原文摆出来（英文），总比吞掉强
      return error.message
  }
}

/** 已登录的设备。当前这台不能撤销自己——那样会立刻把自己踢下线。 */
function SessionsCard() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const sessions = useQuery({ queryKey: keys.sessions, queryFn: listSessions })

  const revoke = useMutation({
    mutationFn: revokeSession,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.sessions }),
  })

  // 当前设备置顶，其余按最近登录排——用户最想先看到「最近是谁登的」
  const rows = useMemo(() => {
    const data = sessions.data ?? []
    return [...data].sort((a, b) =>
      a.current !== b.current ? (a.current ? -1 : 1) : b.createdAt.localeCompare(a.createdAt),
    )
  }, [sessions.data])

  return (
    <AccountSection
      title={t('settings.sessions.title')}
      description={t('settings.sessions.description')}
    >
        {revoke.isError && (
          <p className="mb-4 text-sm text-destructive">{t('settings.sessions.revokeFailed')}</p>
        )}
        {sessions.isPending && (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        )}
        {sessions.isError && (
          <p className="text-sm text-destructive">{t('settings.sessions.loadFailed')}</p>
        )}

        {sessions.data !== undefined && (
          <div className="overflow-x-auto">
            <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('settings.sessions.device')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('settings.sessions.ip')}</TableHead>
                <TableHead className="hidden md:table-cell">
                  {t('settings.sessions.signedInAt')}
                </TableHead>
                <TableHead className="text-right">{t('settings.sessions.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((session) => (
                <TableRow key={session.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-wrap items-center gap-2">
                      <span>
                        {describeUserAgent(session.userAgent) ||
                          t('settings.sessions.unknownDevice')}
                      </span>
                      {session.current && (
                        <Badge variant="secondary">{t('settings.sessions.current')}</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {session.ipAddress ?? '—'}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {new Date(session.createdAt).toLocaleString(i18n.language)}
                  </TableCell>
                  <TableCell className="text-right">
                    {!session.current && (
                      <RevokeSessionButton
                        session={session}
                        pending={revoke.isPending && revoke.variables === session.id}
                        onConfirm={() => revoke.mutate(session.id)}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            </Table>
          </div>
        )}
    </AccountSection>
  )
}

function AccountSection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col rounded-xl border border-border/80 bg-card shadow-sm overflow-hidden">
      <div className="border-b border-border/60 bg-muted/30 px-6 py-5">
        <h2 className="text-sm font-medium tracking-tight text-foreground">{title}</h2>
        <p className="mt-1 text-[13px] leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="p-6 relative z-10">{children}</div>
    </section>
  )
}

function RevokeSessionButton({
  session,
  pending,
  onConfirm,
}: {
  session: SessionSummary
  pending: boolean
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  const device = describeUserAgent(session.userAgent) || t('settings.sessions.unknownDevice')

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" size="sm" disabled={pending} />}>
        {t('settings.sessions.revoke')}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('settings.sessions.revokeTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('settings.sessions.revokeDescription', { device })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t('settings.sessions.revoke')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
