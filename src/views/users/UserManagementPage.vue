<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NDataTable, NEmpty, NIcon, NInput, NModal, NSelect, NSpace, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { AddOutline, CreateOutline, RefreshOutline, SearchOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'
import { isValidPassword, PASSWORD_POLICY_MESSAGE } from '@/utils/password-policy'

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
const authStore = useAuthStore()
const dialog = useDialog()
const message = useMessage()
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

const roleText: Record<UserRole, string> = { basic: '基础用户', auditor: '审计用户', standard: '标准用户', admin: '管理员' }
const roleType: Record<UserRole, 'default' | 'info' | 'success' | 'warning'> = { basic: 'default', auditor: 'info', standard: 'success', admin: 'warning' }
const roleOptions = Object.entries(roleText).map(([value, label]) => ({ value, label }))
const statusOptions = [{ value: 'active', label: '已激活' }, { value: 'inactive', label: '未激活' }]
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
    if (!response.ok || !data.ok) throw new Error(data.error || '获取用户列表失败')
    users.value = data.users
  } catch (error) {
    message.error(error instanceof Error ? error.message : '获取用户列表失败')
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
  if (!isAdmin.value) return '仅管理员可以执行此操作'
  if (user.isInitialAdmin) {
    return '初始管理员账户受保护，只能由本人正常修改密码'
  }
  if (user.role === 'admin' && !isInitialAdmin.value) return '只有初始管理员可以管理管理员账户'
  if (user.id === authStore.currentUser?.id && action !== 'edit') return '请使用“修改密码”；当前账户不能删除'
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
    message.error(PASSWORD_POLICY_MESSAGE)
    return
  }
  if (temporaryPassword.value !== confirmPassword.value) {
    message.error('两次输入的密码不一致')
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
    if (!response.ok || !data.ok) throw new Error(data.error || '重置失败')
    message.success('临时密码已设置，该用户首次登录必须修改密码')
    resetTarget.value = null
    temporaryPassword.value = ''
    confirmPassword.value = ''
    await loadUsers()
  } catch (error) {
    message.error(error instanceof Error ? error.message : '重置失败')
  } finally {
    resetting.value = false
  }
}

function removeUser(user: ManagedUser) {
  dialog.error({
    title: '删除用户', content: `确定删除用户“${user.username}”吗？此操作不可恢复。`,
    positiveText: '确认删除', negativeText: '取消',
    onPositiveClick: async () => {
      const response = await fetch(`/api/users/${user.id}`, { method: 'DELETE', headers: headers() })
      const data = await response.json()
      if (!response.ok || !data.ok) { message.error(data.error || '删除失败'); return }
      message.success('用户已删除')
      await loadUsers()
    },
  })
}

const columns: DataTableColumns<ManagedUser> = [
  { title: '更新时间', key: 'updatedAt', width: 180, render: row => formatTime(row.updatedAt) },
  { title: '用户名', key: 'username', minWidth: 140 },
  { title: '用户权限', key: 'role', width: 220, render: row => h(NSpace, { size: 'small' }, { default: () => [
    h(NTag, { type: roleType[row.role], bordered: false }, { default: () => roleText[row.role] }),
    ...(row.isInitialAdmin ? [h(NTag, { type: 'warning', bordered: false }, { default: () => '初始管理员' })] : []),
  ] }) },
  { title: '描述', key: 'description', minWidth: 220, ellipsis: { tooltip: true }, render: row => row.description || '—' },
  { title: '状态', key: 'status', width: 105, render: row => h(NTag, { type: row.status === 'active' ? 'success' : 'default', bordered: false }, { default: () => row.status === 'active' ? '已激活' : '未激活' }) },
  { title: '操作', key: 'actions', width: 250, render: row => h(NSpace, { size: 'small' }, { default: () => [
    h(NButton, { size: 'small', disabled: !canEditUser(row), title: managementReason(row, 'edit'), onClick: () => router.push({ name: 'UserEdit', params: { id: row.id } }) }, { icon: () => h(NIcon, null, { default: () => h(CreateOutline) }), default: () => '编辑' }),
    h(NButton, { size: 'small', disabled: !canResetUser(row), title: managementReason(row, 'reset'), onClick: () => openResetPassword(row) }, { default: () => '重置' }),
    h(NButton, { size: 'small', type: 'error', ghost: true, disabled: !canDeleteUser(row), title: managementReason(row, 'delete'), onClick: () => removeUser(row) }, { default: () => '删除' }),
  ] }) },
]

onMounted(loadUsers)
</script>

<template>
  <NCard title="用户列表" :bordered="false" class="user-card">
    <template #header-extra>
      <NSpace>
        <NButton @click="router.push({ name: 'PasswordChange' })">修改密码</NButton>
        <NButton :disabled="!isAdmin" type="primary" @click="router.push({ name: 'UserCreate' })">
          <template #icon><NIcon><AddOutline /></NIcon></template>添加用户
        </NButton>
        <NButton :loading="loading" @click="loadUsers">
          <template #icon><NIcon><RefreshOutline /></NIcon></template>刷新
        </NButton>
      </NSpace>
    </template>
    <div class="user-toolbar">
      <NInput v-model:value="keyword" clearable placeholder="搜索用户名或描述">
        <template #prefix><NIcon><SearchOutline /></NIcon></template>
      </NInput>
      <NSelect v-model:value="roleFilter" clearable placeholder="全部角色" :options="roleOptions" />
      <NSelect v-model:value="statusFilter" clearable placeholder="全部状态" :options="statusOptions" />
      <span class="user-toolbar__count">共 {{ filteredUsers.length }} 个用户</span>
    </div>
    <NDataTable :columns="columns" :data="filteredUsers" :loading="loading" :bordered="false" :single-line="false" :pagination="{ pageSize: 10 }">
      <template #empty><NEmpty description="暂无用户" /></template>
    </NDataTable>
  </NCard>
  <NModal v-model:show="resetModalVisible" :mask-closable="!resetting">
    <NCard :title="`重置“${resetTarget?.username || ''}”的密码`" :bordered="false" class="reset-card" role="dialog" aria-modal="true">
      <NAlert type="warning" :bordered="false">
        重置会撤销该用户的所有登录Token。用户使用临时密码登录后，只能修改密码，并需使用新密码重新登录。
      </NAlert>
      <div class="reset-fields">
        <NInput v-model:value="temporaryPassword" type="password" show-password-on="click" placeholder="输入临时密码" />
        <NInput v-model:value="confirmPassword" type="password" show-password-on="click" placeholder="再次输入临时密码" />
        <span class="password-hint">{{ PASSWORD_POLICY_MESSAGE }}</span>
      </div>
      <template #footer>
        <NSpace justify="end">
          <NButton :disabled="resetting" @click="resetTarget = null">取消</NButton>
          <NButton type="primary" :loading="resetting" @click="submitResetPassword">确认重置</NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>

<style scoped>
.user-card { min-height: 420px; }
.user-toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) 160px 150px auto; align-items: center; gap: 12px; margin-bottom: 16px; }
.user-toolbar__count { color: var(--text-secondary); font-size: 13px; white-space: nowrap; }
.reset-card { width: min(520px, calc(100vw - 32px)); }
.reset-fields { display: grid; gap: 12px; margin-top: 18px; }
.password-hint { color: var(--text-secondary); font-size: 13px; }
@media (max-width: 900px) { .user-toolbar { grid-template-columns: 1fr 1fr; } }
@media (max-width: 560px) { .user-toolbar { grid-template-columns: 1fr; } }
</style>
