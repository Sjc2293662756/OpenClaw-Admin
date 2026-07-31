import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

export function usePermissions() {
  const authStore = useAuthStore()
  const role = computed(() => authStore.currentUser?.role)
  const canUseFunctions = computed(() => ['standard', 'admin'].includes(role.value || ''))
  const canDeleteSessions = computed(() => ['basic', 'standard', 'admin'].includes(role.value || ''))
  const canContinueSessions = computed(() => ['standard', 'admin'].includes(role.value || ''))
  const canReadAllSessions = computed(() => ['auditor', 'admin'].includes(role.value || ''))
  const canEditConfiguration = computed(() => role.value === 'admin')
  const canManageTasks = computed(() => role.value === 'admin')
  const canManageSkills = computed(() => role.value === 'admin')
  const canManageSecurity = computed(() => authStore.currentUser?.role === 'admin')
  const readOnlyHint = '当前账户仅可查看，不能执行操作'
  const chatReadOnlyTitle = computed(() =>
    role.value === 'auditor' ? '审计只读模式' : '历史会话只读模式'
  )
  const chatReadOnlyHint = computed(() =>
    role.value === 'auditor'
      ? '当前为审计用户，暂无权限进行会话，可查看全部渠道和用户的会话历史。'
      : '当前为基础用户，暂无权限进行会话，可查看和删除本人的历史会话。'
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
