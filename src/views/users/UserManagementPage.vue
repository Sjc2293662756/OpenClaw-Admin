<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NCard, NDataTable, NEmpty, NIcon, NInput, NSelect, NSpace, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { AddOutline, CreateOutline, RefreshOutline, SearchOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'

type UserRole = 'basic' | 'auditor' | 'standard' | 'admin'
type UserStatus = 'active' | 'inactive'
type ManagedUser = { id: string; username: string; role: UserRole; description: string; status: UserStatus; updatedAt: number }

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

function resetPassword(user: ManagedUser) {
  dialog.warning({
    title: '重置用户密码',
    content: `确定将“${user.username}”的密码重置为默认密码 admin123 吗？该用户当前登录会话将失效。`,
    positiveText: '确认重置', negativeText: '取消',
    onPositiveClick: async () => {
      const response = await fetch(`/api/users/${user.id}/reset-password`, { method: 'POST', headers: headers() })
      const data = await response.json()
      if (!response.ok || !data.ok) { message.error(data.error || '重置失败'); return }
      message.success('密码已重置为 admin123')
      await loadUsers()
    },
  })
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
  { title: '用户权限', key: 'role', width: 130, render: row => h(NTag, { type: roleType[row.role], bordered: false }, { default: () => roleText[row.role] }) },
  { title: '描述', key: 'description', minWidth: 220, ellipsis: { tooltip: true }, render: row => row.description || '—' },
  { title: '状态', key: 'status', width: 105, render: row => h(NTag, { type: row.status === 'active' ? 'success' : 'default', bordered: false }, { default: () => row.status === 'active' ? '已激活' : '未激活' }) },
  { title: '操作', key: 'actions', width: 250, render: row => h(NSpace, { size: 'small' }, { default: () => [
    h(NButton, { size: 'small', disabled: !isAdmin.value, onClick: () => router.push({ name: 'UserEdit', params: { id: row.id } }) }, { icon: () => h(NIcon, null, { default: () => h(CreateOutline) }), default: () => '编辑' }),
    h(NButton, { size: 'small', disabled: !isAdmin.value, onClick: () => resetPassword(row) }, { default: () => '重置' }),
    h(NButton, { size: 'small', type: 'error', ghost: true, disabled: !isAdmin.value, onClick: () => removeUser(row) }, { default: () => '删除' }),
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
</template>

<style scoped>
.user-card { min-height: 420px; }
.user-toolbar { display: grid; grid-template-columns: minmax(220px, 1fr) 160px 150px auto; align-items: center; gap: 12px; margin-bottom: 16px; }
.user-toolbar__count { color: var(--text-secondary); font-size: 13px; white-space: nowrap; }
@media (max-width: 900px) { .user-toolbar { grid-template-columns: 1fr 1fr; } }
@media (max-width: 560px) { .user-toolbar { grid-template-columns: 1fr; } }
</style>
