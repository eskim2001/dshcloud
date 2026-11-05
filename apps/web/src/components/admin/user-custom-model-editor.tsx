import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { Label } from '@/components/ui/label.js'
import { clearUserCustomModel, putUserCustomModel, type AdminUser } from '@/lib/api.js'
import { errorTextOf } from '@/lib/error-text.js'
import { keys } from '@/lib/query-keys.js'

/**
 * 管理员给这个用户设默认自定义模型接口。
 *
 * Key 输入框始终从空开始：服务端不回明文。保存成功后清掉。
 * 非密字段从已保存的配置回显。这里改的是用户级默认，只会被之后新建的工作空间带上。
 */
export function UserCustomModelEditor({
  userId,
  configured,
  customModel,
}: {
  userId: string
  configured: boolean
  customModel: AdminUser['customModel']
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [baseUrl, setBaseUrl] = useState(customModel?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [providerId, setProviderId] = useState(customModel?.providerId ?? 'cliproxy')
  const [displayName, setDisplayName] = useState(customModel?.displayName ?? '')
  const [modelIds, setModelIds] = useState((customModel?.modelIds ?? []).join(', '))
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.adminUsers })
  }

  const save = useMutation({
    mutationFn: () => {
      const key = apiKey.trim()
      const ids = modelIds.split(/[\n,]/).map((item) => item.trim()).filter((item) => item !== '')
      return putUserCustomModel(userId, {
        baseUrl: baseUrl.trim(),
        providerId: providerId.trim() === '' ? 'cliproxy' : providerId.trim(),
        displayName: displayName.trim() === '' ? null : displayName.trim(),
        api: 'openai-completions',
        apiKeyEnv: customModel?.apiKeyEnv ?? 'CLIPROXY_API_KEY',
        modelIds: ids,
        ...(key === '' ? {} : { apiKey: key }),
      })
    },
    onSuccess: async () => {
      setApiKey('')
      setError(null)
      await refresh()
    },
    onError: (err) => setError(errorTextOf(err, t('admin.actionFailed'))),
  })
  const clear = useMutation({
    mutationFn: () => clearUserCustomModel(userId),
    onSuccess: async () => {
      setBaseUrl('')
      setApiKey('')
      setProviderId('cliproxy')
      setDisplayName('')
      setModelIds('')
      setError(null)
      await refresh()
    },
    onError: (err) => setError(errorTextOf(err, t('admin.actionFailed'))),
  })

  const pending = save.isPending || clear.isPending
  const url = baseUrl.trim()

  return (
    <div className="flex w-72 flex-col items-stretch gap-1.5 text-left">
      <Badge variant={configured ? 'secondary' : 'outline'} className="self-end">
        {configured ? t('admin.users.customModelConfigured') : t('admin.users.customModelMissing')}
      </Badge>
      <Label className="text-xs text-muted-foreground">{t('admin.users.customModelBaseUrl')}</Label>
      <Input
        autoComplete="off"
        spellCheck={false}
        value={baseUrl}
        placeholder={t('admin.users.customModelBaseUrlPlaceholder')}
        disabled={pending}
        onChange={(event) => setBaseUrl(event.target.value)}
      />
      <Label className="text-xs text-muted-foreground">{t('admin.users.customModelApiKey')}</Label>
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={apiKey}
        placeholder={t('admin.users.customModelApiKeyPlaceholder')}
        disabled={pending}
        onChange={(event) => setApiKey(event.target.value)}
      />
      <Label className="text-xs text-muted-foreground">{t('admin.users.customModelProviderId')}</Label>
      <Input
        autoComplete="off"
        spellCheck={false}
        value={providerId}
        disabled={pending}
        onChange={(event) => setProviderId(event.target.value)}
      />
      <Label className="text-xs text-muted-foreground">{t('admin.users.customModelDisplayName')}</Label>
      <Input
        autoComplete="off"
        spellCheck={false}
        value={displayName}
        placeholder={t('admin.users.customModelDisplayNamePlaceholder')}
        disabled={pending}
        onChange={(event) => setDisplayName(event.target.value)}
      />
      <Label className="text-xs text-muted-foreground">{t('admin.users.customModelApi')}</Label>
      <Input value="openai-completions" disabled readOnly />
      <Label className="text-xs text-muted-foreground">{t('admin.users.customModelIds')}</Label>
      <Input
        autoComplete="off"
        spellCheck={false}
        value={modelIds}
        placeholder={t('admin.users.customModelIdsPlaceholder')}
        disabled={pending}
        onChange={(event) => setModelIds(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">{t('admin.users.customModelHint')}</p>
      <div className="flex justify-end gap-1">
        <Button size="sm" disabled={pending || url === ''} onClick={() => save.mutate()}>
          {t('admin.users.customModelSave')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || customModel === null}
          onClick={() => clear.mutate()}
        >
          {t('admin.users.customModelClear')}
        </Button>
      </div>
      {error !== null && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
