import { computed } from 'vue'
import { useAuthStore } from '@/stores/auth'

export function usePermissions() {
  const authStore = useAuthStore()
  const canUseFunctions = computed(() => ['standard', 'admin'].includes(authStore.currentUser?.role || ''))
  const canEditConfiguration = computed(() => ['standard', 'admin'].includes(authStore.currentUser?.role || ''))
  const canManageSecurity = computed(() => authStore.currentUser?.role === 'admin')
  const readOnlyHint = '当前账户仅可查看，不能执行操作'
  return { canUseFunctions, canEditConfiguration, canManageSecurity, readOnlyHint }
}
