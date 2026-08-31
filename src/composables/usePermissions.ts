import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { canUseConversation } from '@/permissions/access-control'

export function usePermissions() {
  const authStore = useAuthStore()
  const { locale } = useI18n()
  const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
  const role = computed(() => authStore.currentUser?.role)
  const canUseFunctions = computed(() => canUseConversation(role.value))
  const canDeleteSessions = computed(() => ['basic', 'standard', 'admin'].includes(role.value || ''))
  const canContinueSessions = computed(() => canUseConversation(role.value))
  const canReadAllSessions = computed(() => (
    authStore.currentUser?.effectiveModules?.sessions === true
    && authStore.currentUser?.effectiveModules?.['data.allUsers'] === true
  ))
  const canEditConfiguration = computed(() => role.value === 'admin')
  const canManageTasks = computed(() => role.value === 'admin')
  const canManageSkills = computed(() => role.value === 'admin')
  const canManageSecurity = computed(() => authStore.currentUser?.role === 'admin')
  const readOnlyHint = computed(() => text('当前账户仅可查看，不能执行操作', 'This account is read-only and cannot perform actions'))
  const chatReadOnlyTitle = computed(() =>
    role.value === 'auditor' ? text('审计只读模式', 'Audit read-only mode') : text('历史会话只读模式', 'History read-only mode')
  )
  const chatReadOnlyHint = computed(() =>
    role.value === 'auditor'
      ? (canReadAllSessions.value
          ? text('当前为审计用户，暂无权限进行会话，可查看全部渠道和用户的会话历史。', 'You are using an audit account and cannot start or continue sessions. You can view history for all channels and users.')
          : text('当前为审计用户，暂无权限进行会话，可查看授权范围内的会话历史。', 'You are using an audit account and cannot start or continue sessions. You can view history within the authorized data scope.'))
      : text('当前账户无权进行会话。', 'This account cannot start or continue sessions.')
  )
  return {
    role,
    canUseFunctions,
    canDeleteSessions,
    canContinueSessions,
    canReadAllSessions,
    canEditConfiguration,
    canManageTasks,
    canManageSkills,
    canManageSecurity,
    readOnlyHint,
    chatReadOnlyTitle,
    chatReadOnlyHint,
  }
}
