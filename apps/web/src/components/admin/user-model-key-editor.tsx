import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { putUserModelCredentials } from '@/lib/api.js'
import { errorTextOf } from '@/lib/error-text.js'
import { keys } from '@/lib/query-keys.js'

/**
 * 管理员给这个用户设默认模型 Key。
 *
 * 输入框始终从空开始：服务端不回明文。保存成功后清掉，避免明文留在表单里。
 * 这里改的是用户级默认里的官方 DeepSeek Key，只会被之后新建的工作空间带上。
 * 清除只拿掉这一把 ref，不动自定义通道的 Key。
 */
export function UserModelKeyEditor({
  userId,
  configured,
}: {
  userId: string
  configured: boolean
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.adminUsers })
  }

  const save = useMutation({
    mutationFn: (value: string) => putUserModelCredentials(userId, { refs: { DEEPSEEK_API_KEY: value } }),
    onSuccess: async () => {
      setDraft('')
      setError(null)
      await refresh()
    },
    onError: (err) => setError(errorTextOf(err, t('admin.actionFailed'))),
  })
  const clear = useMutation({
    mutationFn: () => putUserModelCredentials(userId, { refs: { DEEPSEEK_API_KEY: null } }),
    onSuccess: async () => {
      setDraft('')
      setError(null)
      await refresh()
    },
    onError: (err) => setError(errorTextOf(err, t('admin.actionFailed'))),
  })

  const pending = save.isPending || clear.isPending
  const value = draft.trim()

  return (
    <div className="flex min-w-44 flex-col items-end gap-1.5">
      <Badge variant={configured ? 'secondary' : 'outline'}>
        {configured ? t('admin.users.modelKeyConfigured') : t('admin.users.modelKeyMissing')}
      </Badge>
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="w-44"
        value={draft}
        placeholder={t('admin.users.modelKeyPlaceholder')}
        disabled={pending}
        onChange={(event) => setDraft(event.target.value)}
      />
      <p className="max-w-44 text-right text-xs text-muted-foreground">{t('admin.users.modelKeyHint')}</p>
      <div className="flex gap-1">
        <Button
          size="sm"
          disabled={pending || value === ''}
          onClick={() => save.mutate(value)}
        >
          {t('admin.users.modelKeySave')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !configured}
          onClick={() => clear.mutate()}
        >
          {t('admin.users.modelKeyClear')}
        </Button>
      </div>
      {error !== null && <p className="max-w-44 text-right text-xs text-destructive">{error}</p>}
    </div>
  )
}
