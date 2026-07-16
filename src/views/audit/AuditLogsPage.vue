<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NDataTable, NEmpty, NIcon, NInput, NSelect, NSpace, NTag, useMessage, type DataTableColumns } from 'naive-ui'
import { RefreshOutline, SearchOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'

type AuditLog = { id: string; username: string; role: string; action: string; target: string; detail: string; createdAt: number }
const authStore = useAuthStore()
const message = useMessage()
const loading = ref(false)
const forbidden = ref(false)
const loadError = ref('')
const logs = ref<AuditLog[]>([])
const keyword = ref('')
const roleFilter = ref<string | null>(null)
const roleText: Record<string, string> = { basic: '基础用户', auditor: '审计用户', standard: '标准用户', admin: '管理员', system: '系统' }
const roleType: Record<string, 'default' | 'info' | 'success' | 'warning'> = { basic: 'default', auditor: 'info', standard: 'success', admin: 'warning', system: 'default' }
const roleOptions = Object.entries(roleText).map(([value, label]) => ({ value, label }))
const filteredLogs = computed(() => {
  const query = keyword.value.trim().toLowerCase()
  return logs.value.filter(log => {
    if (roleFilter.value && log.role !== roleFilter.value) return false
    if (!query) return true
    return [log.username, log.action, log.target, log.detail].some(value => String(value || '').toLowerCase().includes(query))
  })
})
function formatTime(timestamp: number) { const d = new Date(timestamp); const two = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` }
async function loadLogs() {
  loading.value = true; forbidden.value = false; loadError.value = ''
  try {
    const response = await fetch('/api/audit-logs?limit=200', { headers: { Authorization: `Bearer ${authStore.getToken()}` } })
    const data = await response.json()
    if (response.status === 403) { forbidden.value = true; return }
    if (!response.ok || !data.ok) throw new Error(data.error || '获取审计信息失败')
    logs.value = data.logs
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '获取审计信息失败'
    message.error(loadError.value)
  } finally { loading.value = false }
}
const columns: DataTableColumns<AuditLog> = [
  { title: '时间', key: 'createdAt', width: 180, render: row => formatTime(row.createdAt) },
  { title: '操作用户', key: 'username', width: 140 },
  { title: '用户类型', key: 'role', width: 120, render: row => h(NTag, { type: roleType[row.role] || 'default', bordered: false }, { default: () => roleText[row.role] || row.role }) },
  { title: '操作', key: 'action', width: 150 },
  { title: '对象', key: 'target', minWidth: 170, ellipsis: { tooltip: true }, render: row => row.target || '—' },
  { title: '说明', key: 'detail', minWidth: 220, ellipsis: { tooltip: true }, render: row => row.detail || '—' },
]
onMounted(loadLogs)
</script>

<template>
  <NCard title="审计信息" :bordered="false" class="audit-card">
    <template #header-extra><NSpace><NButton :loading="loading" @click="loadLogs"><template #icon><NIcon><RefreshOutline /></NIcon></template>刷新</NButton></NSpace></template>
    <NAlert v-if="forbidden" type="warning" :bordered="false">审计信息仅审计用户和管理员可查看。</NAlert>
    <template v-else>
      <NAlert v-if="loadError" type="error" :bordered="false" class="audit-alert">{{ loadError }}</NAlert>
      <div class="audit-toolbar">
        <NInput v-model:value="keyword" clearable placeholder="搜索用户、操作、对象或说明">
          <template #prefix><NIcon><SearchOutline /></NIcon></template>
        </NInput>
        <NSelect v-model:value="roleFilter" clearable placeholder="全部角色" :options="roleOptions" />
        <span class="audit-toolbar__count">显示 {{ filteredLogs.length }} / {{ logs.length }} 条</span>
      </div>
      <NDataTable :columns="columns" :data="filteredLogs" :loading="loading" :bordered="false" :single-line="false" :pagination="{ pageSize: 15 }"><template #empty><NEmpty description="暂无符合条件的审计记录" /></template></NDataTable>
    </template>
  </NCard>
</template>

<style scoped>
.audit-card { min-height: 420px; }
.audit-alert { margin-bottom: 14px; }
.audit-toolbar { display: grid; grid-template-columns: minmax(260px, 1fr) 170px auto; align-items: center; gap: 12px; margin-bottom: 16px; }
.audit-toolbar__count { color: var(--text-secondary); font-size: 13px; white-space: nowrap; }
@media (max-width: 760px) { .audit-toolbar { grid-template-columns: 1fr; } }
</style>
