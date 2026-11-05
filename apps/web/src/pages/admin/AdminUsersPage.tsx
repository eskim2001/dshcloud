import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { CircleCheckIcon, ShieldCheckIcon, UsersIcon } from 'lucide-react'
import { AdminMetricStrip, AdminPage, AdminTableSection } from '@/components/admin/admin-page.js'
import { BanButton } from '@/components/admin/ban-button.js'
import { CreateUserPanel } from '@/components/admin/create-user-panel.js'
import { InvitePanel } from '@/components/admin/invite-panel.js'
import { RoleButton } from '@/components/admin/role-button.js'
import { UserModelKeyEditor } from '@/components/admin/user-model-key-editor.js'
import { UserQuotaEditor } from '@/components/admin/user-quota-editor.js'
import { UserResourceCapsEditor } from '@/components/admin/user-resource-caps-editor.js'
import { Badge } from '@/components/ui/badge.js'
import { Button } from '@/components/ui/button.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.js'
import { banUser, listAdminUsers, setUserQuota, setUserRole, unbanUser, type UserQuotaPatch } from '@/lib/api.js'
import { errorTextOf } from '@/lib/error-text.js'
import { keys } from '@/lib/query-keys.js'
import { sessionKey, useSession } from '@/lib/use-session.js'

/**
 * 账号管理：封禁 / 解封、改实例数上限、授予或撤销管理员。
 *
 * 这里**没有搜索和分页**——用户量是"一个团队/一个小集群"的量级，一屏能看完；
 * 真到需要搜索的量级，该加的是服务端筛选而不是前端过滤。
 */
export default function AdminUsersPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const session = useSession()

  const users = useQuery({ queryKey: keys.adminUsers, queryFn: listAdminUsers })

  const invalidateUsers = () => queryClient.invalidateQueries({ queryKey: keys.adminUsers })

  const ban = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => banUser(id, reason),
    onSuccess: invalidateUsers,
  })
  const unban = useMutation({ mutationFn: unbanUser, onSuccess: invalidateUsers })
  const quota = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UserQuotaPatch }) => setUserQuota(id, patch),
    onSuccess: invalidateUsers,
  })
  const role = useMutation({
    mutationFn: ({ id, next }: { id: string; next: 'user' | 'admin' }) => setUserRole(id, next),
    onSuccess: (_result, variables) => {
      // 降的是自己：下一个 /api/admin/* 请求就 403，别去刷列表，直接回首页
      if (variables.id === session.data?.id) {
        void queryClient.invalidateQueries({ queryKey: sessionKey })
        navigate('/')
        return
      }
      void invalidateUsers()
    },
  })

  // 服务端文案（如「不能降级最后一名管理员」）比笼统的「操作失败」有用
  const failed = ban.isError || unban.isError || quota.isError || role.isError
  const allUsers = users.data?.users ?? []
  const activeUsers = allUsers.filter((user) => !user.banned).length
  const adminUsers = allUsers.filter((user) => user.role === 'admin').length

  return (
    <AdminPage title={t('admin.users.title')} description={t('admin.users.description')}>
      <CreateUserPanel />

      <AdminMetricStrip items={[
        { icon: UsersIcon, label: t('admin.users.total'), value: allUsers.length },
        { icon: CircleCheckIcon, label: t('admin.users.active'), value: activeUsers },
        { icon: ShieldCheckIcon, label: t('admin.users.admin'), value: adminUsers },
      ]} />

      {failed && (
        <p className="mb-4 text-sm text-destructive">
          {errorTextOf(
            role.error ?? ban.error ?? unban.error ?? quota.error,
            t('admin.actionFailed'),
          )}
        </p>
      )}

      <AdminTableSection>
          {users.isPending && (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          )}
          {users.isError && <p className="text-sm text-destructive">{t('admin.users.loadFailed')}</p>}

          {users.data !== undefined && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.users.user')}</TableHead>
                  <TableHead>{t('admin.users.instances')}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t('admin.users.quota')}</TableHead>
                  <TableHead>{t('admin.users.status')}</TableHead>
                  <TableHead className="text-right">{t('admin.users.modelKey')}</TableHead>
                  <TableHead className="text-right">{t('admin.users.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data.users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{user.email}</span>
                        {user.role === 'admin' && (
                          <Badge variant="secondary">{t('admin.users.admin')}</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{user.name}</div>
                    </TableCell>
                    <TableCell>{user.instanceCount}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <UserQuotaEditor
                        user={user}
                        fallback={users.data.maxInstancesPerUser}
                        pending={quota.isPending && quota.variables?.id === user.id}
                        onSave={(value) => quota.mutate({ id: user.id, patch: { quota: value } })}
                      />
                      <UserResourceCapsEditor
                        user={user}
                        caps={users.data.platformCaps}
                        pending={quota.isPending && quota.variables?.id === user.id}
                        onSave={(value) => quota.mutate({ id: user.id, patch: value })}
                      />
                    </TableCell>
                    <TableCell>
                      {user.banned ? (
                        <div className="flex flex-col gap-1">
                          <Badge variant="destructive">{t('admin.users.banned')}</Badge>
                          {user.banReason !== null && (
                            <span className="text-xs text-muted-foreground">{user.banReason}</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {t('admin.users.active')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <UserModelKeyEditor
                        userId={user.id}
                        configured={user.modelCredentials.configured}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <RoleButton
                          isAdmin={user.role === 'admin'}
                          self={user.id === session.data?.id}
                          email={user.email}
                          pending={role.isPending && role.variables?.id === user.id}
                          onConfirm={() =>
                            role.mutate({
                              id: user.id,
                              next: user.role === 'admin' ? 'user' : 'admin',
                            })
                          }
                        />
                        {user.banned ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={unban.isPending && unban.variables === user.id}
                            onClick={() => unban.mutate(user.id)}
                          >
                            {t('admin.users.unban')}
                          </Button>
                        ) : (
                          <BanButton
                            email={user.email}
                            pending={ban.isPending && ban.variables?.id === user.id}
                            onConfirm={(reason) => ban.mutate({ id: user.id, reason })}
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
      </AdminTableSection>

      {/* 邀请：公开注册关掉之后，熟人**只能**从这里进来（兑换页见 AcceptInvitePage） */}
      <InvitePanel />
    </AdminPage>
  )
}
