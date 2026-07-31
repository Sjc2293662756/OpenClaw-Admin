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
      ? '可以查看全部渠道和用户的会话历史，不能新建、发送、继续、重置、删除或导出会话。'
      : '可以查看和删除本人的历史会话，不能新建会话、发送消息、上传附件、停止生成、重新生成或重置会话。'
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
