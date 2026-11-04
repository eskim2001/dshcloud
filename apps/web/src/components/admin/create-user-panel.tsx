import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { createAdminUser } from '@/lib/api.js'
import { errorTextOf } from '@/lib/error-text.js'
import { keys } from '@/lib/query-keys.js'

/**
 * 管理员设账密建号。邀请链接是次要入口，这个表单才是主路径。
 * 密码确认只在浏览器里对一下，服务端仍按「至少 8 位」收。
 */
export function CreateUserPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [account, setAccount] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<'user' | 'admin'>('user')
  const [mismatch, setMismatch] = useState(false)
  const [createdEmail, setCreatedEmail] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () =>
      createAdminUser({
        account: account.trim(),
        password,
        ...(name.trim() === '' ? {} : { name: name.trim() }),
        role,
      }),
    onSuccess: (result) => {
      setCreatedEmail(result.user.email)
      setAccount('')
      setPassword('')
      setConfirm('')
      setName('')
      setRole('user')
      void queryClient.invalidateQueries({ queryKey: keys.adminUsers })
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setCreatedEmail(null)
    if (password !== confirm) {
      setMismatch(true)
      return
    }
    setMismatch(false)
    create.mutate()
  }

  return (
    <section className="rounded-xl border border-border/80 bg-card shadow-sm">
      <div className="border-b border-border/60 px-5 py-4">
        <h2 className="text-sm font-medium tracking-tight text-foreground">{t('admin.users.createTitle')}</h2>
        <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">
          {t('admin.users.createDescription')}
        </p>
      </div>
      <form onSubmit={submit} className="grid gap-4 px-5 py-5 md:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-[13px] md:col-span-2">
          <span className="font-medium text-foreground">{t('admin.users.account')}</span>
          <Input
            required
            value={account}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={t('admin.users.accountPlaceholder')}
            className="h-10"
            onChange={(e) => setAccount(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium text-foreground">{t('admin.users.password')}</span>
          <Input
            required
            type="password"
            minLength={8}
            autoComplete="new-password"
            value={password}
            className="h-10"
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium text-foreground">{t('admin.users.passwordConfirm')}</span>
          <Input
            required
            type="password"
            minLength={8}
            autoComplete="new-password"
            value={confirm}
            className="h-10"
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium text-foreground">{t('admin.users.name')}</span>
          <Input
            value={name}
            autoComplete="off"
            placeholder={t('admin.users.namePlaceholder')}
            className="h-10"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium text-foreground">{t('admin.users.role')}</span>
          <select
            value={role}
            className="h-10 rounded-md border border-input bg-transparent px-3 text-sm text-foreground"
            onChange={(e) => setRole(e.target.value === 'admin' ? 'admin' : 'user')}
          >
            <option value="user">{t('admin.users.roleUser')}</option>
            <option value="admin">{t('admin.users.roleAdmin')}</option>
          </select>
        </label>
        <div className="flex flex-col items-start gap-2 md:col-span-2">
          <Button type="submit" className="h-10 px-6" disabled={create.isPending}>
            {create.isPending ? t('admin.users.createPending') : t('admin.users.createSubmit')}
          </Button>
          {mismatch && <p className="text-sm text-destructive">{t('admin.users.passwordMismatch')}</p>}
          {create.isError && (
            <p className="text-sm text-destructive">{errorTextOf(create.error, t('admin.actionFailed'))}</p>
          )}
          {createdEmail !== null && (
            <p className="text-sm text-foreground">{t('admin.users.createDone', { email: createdEmail })}</p>
          )}
        </div>
      </form>
    </section>
  )
}
