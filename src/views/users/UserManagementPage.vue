<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NDataTable, NEmpty, NIcon, NInput, NModal, NSelect, NSpace, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { AddOutline, CreateOutline, RefreshOutline, SearchOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'
import { isValidPassword, passwordPolicyMessage } from '@/utils/password-policy'
import { localizeApiError } from '@/utils/api-error'
import type { AppLocale } from '@/i18n/locale'
import { useI18n } from 'vue-i18n'

type UserRole = 'basic' | 'auditor' | 'standard' | 'admin'
type UserStatus = 'active' | 'inactive'
type ManagedUser = {
  id: string
  username: string
  role: UserRole
  description: string
  status: UserStatus
  isInitialAdmin: boolean
  mustChangePassword: boolean
  updatedAt: number
}

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const dialog = useDialog()
const message = useMessage()
const { t, locale } = useI18n()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const passwordHint = computed(() => passwordPolicyMessage(locale.value as AppLocale))
const loading = ref(false)
const users = ref<ManagedUser[]>([])
const keyword = ref('')
const roleFilter = ref<UserRole | null>(null)
const statusFilter = ref<UserStatus | null>(null)
const isAdmin = computed(() => authStore.isAdmin)
const isInitialAdmin = computed(() => Boolean(authStore.currentUser?.isInitialAdmin))
const resetTarget = ref<ManagedUser | null>(null)
const resetModalVisible = computed({
  get: () => Boolean(resetTarget.value),
  set: value => {
    if (!value && !resetting.value) resetTarget.value = null
  },
})
const temporaryPassword = ref('')
const confirmPassword = ref('')
const resetting = ref(false)

const roleText = computed<Record<UserRole, string>>(() => ({ basic: t('pages.gaiop.users.basic'), auditor: t('pages.gaiop.users.auditor'), standard: t('pages.gaiop.users.standard'), admin: t('pages.gaiop.users.admin') }))
const roleType: Record<UserRole, 'default' | 'info' | 'success' | 'warning'> = { basic: 'default', auditor: 'info', standard: 'success', admin: 'warning' }
const roleOptions = computed(() => Object.entries(roleText.value).map(([value, label]) => ({ value, label })))
const statusOptions = computed(() => [{ value: 'active', label: t('pages.gaiop.users.active') }, { value: 'inactive', label: t('pages.gaiop.users.inactive') }])
const filteredUsers = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  return users.value.filter(user => {
    if (roleFilter.value && user.role !== roleFilter.value) return false
    if (statusFilter.value && user.status !== statusFilter.value) return false
    if (!query) return true
    return user.username.toLowerCase().includes(query) || user.description.toLowerCase().includes(query)
  })
})

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

function headers() { return { Authorization: `Bearer ${authStore.getToken()}` } }

async function loadUsers() {
  loading.value = true
  try {
    const response = await fetch('/api/users', { headers: headers() })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, t('pages.gaiop.users.loadFailed')))
    users.value = data.users
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('pages.gaiop.users.loadFailed'))
  } finally {
    loading.value = false
  }
}

function canEditUser(user: ManagedUser) {
  if (!isAdmin.value) return false
  if (user.isInitialAdmin) return false
  return user.role !== 'admin' || isInitialAdmin.value
}

function canResetUser(user: ManagedUser) {
  return canEditUser(user) && !user.isInitialAdmin && user.id !== authStore.currentUser?.id
}

function canDeleteUser(user: ManagedUser) {
  return canEditUser(user) && !user.isInitialAdmin && user.id !== authStore.currentUser?.id
}

function managementReason(user: ManagedUser, action: 'edit' | 'reset' | 'delete') {
  if (!isAdmin.value) return t('pages.gaiop.users.adminOnly')
  if (user.isInitialAdmin) {
    return text('初始管理员账户受保护，只能由本人正常修改密码', 'The initial administrator account is protected and can change only its own password normally')
  }
  if (user.role === 'admin' && !isInitialAdmin.value) return text('只有初始管理员可以管理管理员账户', 'Only the initial administrator can manage administrator accounts')
  if (user.id === authStore.currentUser?.id && action !== 'edit') return text('请使用“修改密码”；当前账户不能删除', 'Use Change password; the current account cannot be deleted')
  return ''
}

function openResetPassword(user: ManagedUser) {
  resetTarget.value = user
  temporaryPassword.value = ''
  confirmPassword.value = ''
}

async function submitResetPassword() {
  if (!resetTarget.value) return
  if (!isValidPassword(temporaryPassword.value)) {
    message.error(passwordHint.value)
    return
  }
  if (temporaryPassword.value !== confirmPassword.value) {
    message.error(text('两次输入的密码不一致', 'Passwords do not match'))
    return
  }
  resetting.value = true
  try {
    const response = await fetch(`/api/users/${resetTarget.value.id}/reset-password`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        temporaryPassword: temporaryPassword.value,
        confirmPassword: confirmPassword.value,
      }),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('重置失败', 'Password reset failed')))
    message.success(text('临时密码已设置，该用户首次登录必须修改密码', 'Temporary password set. The user must change it on first sign-in.'))
    resetTarget.value = null
    temporaryPassword.value = ''
    confirmPassword.value = ''
    await loadUsers()
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('重置失败', 'Password reset failed'))
  } finally {
    resetting.value = false
  }
}

function removeUser(user: ManagedUser) {
  dialog.error({
    title: text('删除用户', 'Delete user'), content: text(`确定删除用户“${user.username}”吗？此操作不可恢复。`, `Delete user “${user.username}”? This cannot be undone.`),
    positiveText: text('确认删除', 'Delete'), negativeText: text('取消', 'Cancel'),
    onPositiveClick: async () => {
      const response = await fetch(`/api/users/${user.id}`, { method: 'DELETE', headers: headers() })
      const data = await response.json()
      if (!response.ok || !data.ok) { message.error(localizeApiError(data, text('删除失败', 'Delete failed'))); return }
      message.success(text('用户已删除', 'User deleted'))
      await loadUsers()
    },
  })
}

const columns = computed<DataTableColumns<ManagedUser>>(() => {
  const base: DataTableColumns<ManagedUser> = [
    { title: t('pages.gaiop.users.updatedAt'), key: 'updatedAt', width: 180, render: row => formatTime(row.updatedAt) },
    { title: t('pages.gaiop.users.username'), key: 'username', minWidth: 140 },
    { title: t('pages.gaiop.users.role'), key: 'role', width: 220, render: row => h(NSpace, { size: 'small' }, { default: () => [
      h(NTag, { type: roleType[row.role], bordered: false }, { default: () => roleText.value[row.role] }),
      ...(row.isInitialAdmin ? [h(NTag, { type: 'warning', bordered: false }, { default: () => t('pages.gaiop.users.initialAdmin') })] : []),
    ] }) },
    { title: t('pages.gaiop.users.description'), key: 'description', minWidth: 220, ellipsis: { tooltip: true }, render: row => row.description || '—' },
    { title: t('pages.gaiop.users.status'), key: 'status', width: 105, render: row => h(NTag, { type: row.status === 'active' ? 'success' : 'default', bordered: false }, { default: () => row.status === 'active' ? t('pages.gaiop.users.active') : t('pages.gaiop.users.inactive') }) },
  ]
  if (!isAdmin.value) return base
  return [...base, {
    title: t('pages.gaiop.users.actions'), key: 'actions', width: 250, render: row => h(NSpace, { size: 'small' }, { default: () => [
      h(NButton, { size: 'small', disabled: !canEditUser(row), title: managementReason(row, 'edit'), onClick: () => router.push({ name: 'UserEdit', params: { id: row.id } }) }, { icon: () => h(NIcon, null, { default: () => h(CreateOutline) }), default: () => t('pages.gaiop.users.editAction') }),
      h(NButton, { size: 'small', disabled: !canResetUser(row), title: managementReason(row, 'reset'), onClick: () => openResetPassword(row) }, { default: () => t('pages.gaiop.users.resetAction') }),
      h(NButton, { size: 'small', type: 'error', ghost: true, disabled: !canDeleteUser(row), title: managementReason(row, 'delete'), onClick: () => removeUser(row) }, { default: () => t('pages.gaiop.users.deleteAction') }),
    ] }),
  }]
})

onMounted(loadUsers)
</script>

<template>
  <div class="user-management-page">
    <NCard :title="t('pages.gaiop.users.list')" :bordered="false" class="user-card">
      <template #header-extra>
        <NSpace>
          <NButton @click="router.push({ name: 'PasswordChange', query: { returnTo: route.fullPath } })">{{ t('pages.gaiop.users.changePassword') }}</NButton>
          <NButton v-if="isAdmin" type="primary" @click="router.push({ name: 'UserCreate' })">
            <template #icon><NIcon><AddOutline /></NIcon></template>{{ t('pages.gaiop.users.create') }}
          </NButton>
          <NButton :loading="loading" @click="loadUsers">
            <template #icon><NIcon><RefreshOutline /></NIcon></template>{{ t('pages.gaiop.users.refresh') }}
          </NButton>
        </NSpace>
      </template>
      <NAlert v-if="!isAdmin" type="info" :bordered="false" class="user-read-only-alert">
        {{ t('pages.gaiop.users.readOnly') }}
      </NAlert>
      <div class="user-toolbar">
        <NInput v-model:value="keyword" clearable :placeholder="t('pages.gaiop.users.search')">
          <template #prefix><NIcon><SearchOutline /></NIcon></template>
        </NInput>
        <NSelect v-model:value="roleFilter" clearable :placeholder="t('pages.gaiop.users.allRoles')" :options="roleOptions" />
        <NSelect v-model:value="statusFilter" clearable :placeholder="t('pages.gaiop.users.allStatuses')" :options="statusOptions" />
        <span class="user-toolbar__count">{{ text(`共 ${filteredUsers.length} 个用户`, `${filteredUsers.length} users`) }}</span>
      </div>
      <NDataTable :columns="columns" :data="filteredUsers" :loading="loading" :bordered="false" :single-line="false" :pagination="{ pageSize: 10 }">
        <template #empty><NEmpty :description="t('pages.gaiop.users.empty')" /></template>
      </NDataTable>
    </NCard>
    <NModal v-model:show="resetModalVisible" :mask-closable="!resetting">
      <NCard :title="text(`重置“${resetTarget?.username || ''}”的密码`, `Reset password for “${resetTarget?.username || ''}”`)" :bordered="false" class="reset-card" role="dialog" aria-modal="true">
        <NAlert type="warning" :bordered="false">
          {{ text('重置会撤销该用户的所有登录Token。用户使用临时密码登录后，只能修改密码，并需使用新密码重新登录。', 'Resetting revokes all sign-in tokens for this user. After signing in with the temporary password, the user can only change the password and must sign in again with the new password.') }}
        </NAlert>
        <div class="reset-fields">
          <NInput v-model:value="temporaryPassword" type="password" show-password-on="click" :placeholder="text('输入临时密码', 'Enter temporary password')" />
          <NInput v-model:value="confirmPassword" type="password" show-password-on="click" :placeholder="text('再次输入临时密码', 'Re-enter temporary password')" />
          <span class="password-hint">{{ passwordHint }}</span>
        </div>
        <template #footer>
          <NSpace justify="end">
            <NButton :disabled="resetting" @click="resetTarget = null">{{ t('pages.gaiop.users.cancel') }}</NButton>
            <NButton type="primary" :loading="resetting" @click="submitResetPassword">{{ text('确认重置', 'Confirm reset') }}</NButton>
          </NSpace>
        </template>
      </NCard>
    </NModal>
  </div>
</template>

<style scoped>
.user-management-page { min-width: 0; }
.user-card { min-height: 420px; }
.user-read-only-alert { margin-bottom: 16px; }
.user-toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) 160px 150px auto; align-items: center; gap: 12px; margin-bottom: 16px; }
.user-toolbar__count { color: var(--text-secondary); font-size: 13px; white-space: nowrap; }
.reset-card { width: min(520px, calc(100vw - 32px)); }
.reset-fields { display: grid; gap: 12px; margin-top: 18px; }
.password-hint { color: var(--text-secondary); font-size: 13px; }
@media (max-width: 900px) { .user-toolbar { grid-template-columns: 1fr 1fr; } }
@media (max-width: 560px) { .user-toolbar { grid-template-columns: 1fr; } }
</style>
