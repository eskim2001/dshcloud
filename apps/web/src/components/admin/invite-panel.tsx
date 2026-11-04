import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { CopyableText } from '@/components/copyable-text.js'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { createInvitation, listInvitations, revokeInvitation } from '@/lib/api.js'
import { errorTextOf } from '@/lib/error-text.js'
import { keys } from '@/lib/query-keys.js'

/**
 * 发邀请链接。**平台不发邮件**——owner 生成之后自己复制、自己发给熟人
 * （微信、Slack、当面，随他）。所以这里没有「已发送」状态，只有「发出去了几条」。
 *
 * ⚠️ 明文链接**只在生成那一刻存在**：服务端只存 token 的哈希。所以刚生成的那条
 * 要当场显示 + 可复制，关掉就再也拿不回来了——`freshUrl` 只活在内存里。
 */
export function InvitePanel() {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [freshUrl, setFreshUrl] = useState<string | null>(null)

  const invites = useQuery({ queryKey: keys.adminInvitations, queryFn: listInvitations })
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.adminInvitations })

  const create = useMutation({
    mutationFn: () => createInvitation(email.trim()),
    onSuccess: (result) => {
      setFreshUrl(result.url)
      setEmail('')
      void refresh()
    },
  })
  const revoke = useMutation({ mutationFn: revokeInvitation, onSuccess: () => void refresh() })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    // 上一轮的链接已经不可能再看到，生成新的就把它从屏幕上抹掉
    setFreshUrl(null)
    create.mutate()
  }

  const rows = invites.data?.invitations ?? []
  const failed = create.isError || revoke.isError

  return (
    <Collapsible className="mt-2 rounded-xl border border-border/70 bg-card">
      <CollapsibleTrigger className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left">
        <span>
          <span className="block text-sm font-medium tracking-tight text-foreground">
            {t('admin.users.inviteFold')}
          </span>
          <span className="mt-1 block text-[13px] leading-5 text-muted-foreground">
            {t('admin.users.inviteFoldHint')}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border/60 px-5 py-5">
      <p className="mb-4 text-[13px] leading-5 text-muted-foreground">
        {t('admin.users.inviteDescription', { hours: invites.data?.ttlHours ?? 0 })}
      </p>
      <div className="relative z-10 flex flex-col gap-6">
        <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('admin.users.inviteEmailPlaceholder')}
            className="sm:max-w-xs h-10"
          />
          <Button type="submit" className="h-10 px-6 text-[14px] shadow-sm" disabled={create.isPending}>
            {create.isPending ? t('admin.users.inviteCreating') : t('admin.users.inviteCreate')}
          </Button>
        </form>

      {freshUrl !== null && (
        <div className="flex flex-col gap-1 border border-dashed p-3">
          <CopyableText value={freshUrl} className="max-w-full" />
          <p className="text-xs text-muted-foreground">{t('admin.users.inviteCopyHint')}</p>
        </div>
      )}

      {failed && (
        <p className="text-sm text-destructive">
          {errorTextOf(
            create.error ?? revoke.error,
            t('admin.users.inviteFailed'),
          )}
        </p>
      )}

      {invites.isPending && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {invites.isError && (
        <p className="text-sm text-destructive">{t('admin.users.inviteLoadFailed')}</p>
      )}
      {invites.data !== undefined && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('admin.users.inviteEmpty')}</p>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col">
          {rows.map((invite) => {
            const accepted = invite.acceptedAt !== null
            const expired = !accepted && new Date(invite.expiresAt) <= new Date()
            return (
              <li
                key={invite.id}
                className="flex items-center justify-between gap-4 border-b py-3 last:border-b-0"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{invite.email}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('admin.users.inviteExpiresAt', {
                      time: new Date(invite.expiresAt).toLocaleDateString(i18n.language),
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {accepted ? (
                    <Badge variant="secondary">{t('admin.users.inviteAccepted')}</Badge>
                  ) : expired ? (
                    <Badge variant="outline">{t('admin.users.inviteExpired')}</Badge>
                  ) : (
                    <>
                      <Badge variant="outline">{t('admin.users.invitePending')}</Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revoke.isPending && revoke.variables === invite.id}
                        onClick={() => revoke.mutate(invite.id)}
                      >
                        {t('admin.users.inviteRevoke')}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
