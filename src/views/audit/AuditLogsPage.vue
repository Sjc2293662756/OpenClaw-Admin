<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NDataTable,
  NDescriptions,
  NDescriptionsItem,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NIcon,
  NInput,
  NInputNumber,
  NPagination,
  NSelect,
  NSpace,
  NStatistic,
  NTag,
  NText,
  NTooltip,
  type DataTableColumns,
  useMessage,
} from 'naive-ui'
import { CopyOutline, InformationCircleOutline, RefreshOutline, SearchOutline } from '@vicons/ionicons5'
import TimeRangePicker from '@/components/common/TimeRangePicker.vue'
import { useAuthStore } from '@/stores/auth'
import { rangeForPreset, type TimeRange, type TimeRangePreset } from '@/utils/time-range'

type AuditValue = 'success' | 'failed' | 'denied' | null
type AuditLog = {
  id: string
  actorUserId: string | null
  username: string
  role: string
  action: string
  target: string
  detail: string
  createdAt: number
  category: string | null
  result: AuditValue
  source: string | null
  restMethod: string | null
  restPath: string | null
  rpcMethod: string | null
  errorCode: string | null
  requestId: string | null
  sourceAddress: string | null
}
type ManagedUser = { id: string; username: string; role: string; status: string }
type AuditSummary = { total: number; success: number; failed: number; denied: number; unclassified: number }
type AuditPagination = { page: number; pageSize: number; total: number; browseTotal: number; maxResults: number; totalPages: number }
type AuditFilters = {
  keyword: string
  username: string | null
  role: string | null
  category: string | null
  result: string | null
  source: string | null
  errorCode: string
}
type AuditResponse = { ok: boolean; logs: AuditLog[]; pagination: AuditPagination; summary: AuditSummary; error?: string }

const DEFAULT_MAX_RESULTS = 200
const MAX_RESULTS = 3000
const authStore = useAuthStore()
const message = useMessage()
const loading = ref(false)
const forbidden = ref(false)
const loadError = ref('')
const logs = ref<AuditLog[]>([])
const users = ref<ManagedUser[]>([])
const selectedLog = ref<AuditLog | null>(null)
const detailVisible = ref(false)
const timePreset = ref<TimeRangePreset>('today')
const timeRange = ref<TimeRange>(rangeForPreset('today', Date.now()))
const page = ref(1)
const pageSize = ref(20)
const maxResults = ref(DEFAULT_MAX_RESULTS)
const resultLimitChoice = ref(String(DEFAULT_MAX_RESULTS))
const customResultLimit = ref<number | null>(DEFAULT_MAX_RESULTS)
const pagination = ref<AuditPagination>({ page: 1, pageSize: 20, total: 0, browseTotal: 0, maxResults: DEFAULT_MAX_RESULTS, totalPages: 0 })
const summary = ref<AuditSummary>({ total: 0, success: 0, failed: 0, denied: 0, unclassified: 0 })
const filters = ref<AuditFilters>({ keyword: '', username: null, role: null, category: null, result: null, source: null, errorCode: '' })
const auditTimeRangePresets: readonly TimeRangePreset[] = ['today', 'yesterday', 'last7days', 'last30days', 'custom']
const pageSizeOptions = [10, 20, 50, 100].map((value) => ({ label: `${value} 条/页`, value }))
const resultLimitOptions = [50, 100, 200, 500, 1000].map((value) => ({ label: `TOP ${value}`, value: String(value) })).concat([{ label: '自定义 TOP', value: 'custom' }])
const roleLabels: Record<string, string> = { basic: '基础用户', auditor: '审计用户', standard: '标准用户', admin: '管理员', system: '系统' }
const roleTypes: Record<string, 'default' | 'info' | 'success' | 'warning'> = { basic: 'default', auditor: 'info', standard: 'success', admin: 'warning', system: 'default' }
const statusLabels: Record<string, string> = { active: '已激活', inactive: '未激活' }
const categoryLabels: Record<string, string> = { authentication: '身份认证', authorization: '权限校验', resource_access: '资源访问', operation: '业务操作', system: '系统事件' }
const sourceLabels: Record<string, string> = { auth: '登录认证', rest: 'REST接口', rpc: 'Gateway RPC', system: '系统' }
const resultLabels: Record<Exclude<AuditValue, null>, string> = { success: '成功', failed: '失败', denied: '拒绝' }
const resultTypes: Record<Exclude<AuditValue, null>, 'success' | 'error' | 'warning'> = { success: 'success', failed: 'error', denied: 'warning' }
const roleOptions = Object.entries(roleLabels).map(([value, label]) => ({ value, label }))
const categoryOptions = Object.entries(categoryLabels).map(([value, label]) => ({ value, label }))
const resultOptions = Object.entries(resultLabels).map(([value, label]) => ({ value, label }))
const sourceOptions = Object.entries(sourceLabels).map(([value, label]) => ({ value, label }))

let requestSequence = 0
let activeController: AbortController | null = null

const isCustomLimit = computed(() => resultLimitChoice.value === 'custom')
const effectiveMaxResults = computed(() => pagination.value.maxResults || maxResults.value)
const topLimited = computed(() => pagination.value.total > effectiveMaxResults.value)
const userOptions = computed(() => [
  { label: 'system（系统事件）', value: 'system' },
  ...users.value
    .filter((user) => user.username !== 'system')
    .map((user) => ({ label: `${user.username}（${displayRole(user.role)}，${statusLabels[user.status] || user.status}）`, value: user.username })),
])
const summaryItems = computed(() => [
  { label: '总记录', value: summary.value.total, className: 'summary-total' },
  { label: '成功', value: summary.value.success, className: 'summary-success' },
  { label: '失败', value: summary.value.failed, className: 'summary-failed' },
  { label: '已记录拒绝', value: summary.value.denied, className: 'summary-denied' },
  { label: '历史未结构化', value: summary.value.unclassified, className: 'summary-unclassified', hint: '早期审计记录没有结果分类字段，不代表操作失败。' },
])

function displayValue(value: unknown) {
  return value === null || value === undefined || String(value).trim() === '' ? '历史未记录' : String(value)
}

function displayTableValue(value: unknown) {
  return value === null || value === undefined || String(value).trim() === '' ? '—' : String(value)
}

function displayRole(role: string | null | undefined) {
  return roleLabels[String(role || '')] || displayValue(role)
}

function displayCategory(category: string | null | undefined) {
  return categoryLabels[String(category || '')] || displayValue(category)
}

function displaySource(source: string | null | undefined) {
  return sourceLabels[String(source || '')] || displayValue(source)
}

function displayResult(result: AuditValue) {
  return result ? resultLabels[result] : '历史未记录'
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

function addTextParameter(params: URLSearchParams, name: string, value: string | null) {
  const text = String(value || '').trim()
  if (text) params.set(name, text)
}

function boundedMaxResults(value: unknown) {
  const numeric = Math.trunc(Number(value))
  const fallback = Math.max(DEFAULT_MAX_RESULTS, pageSize.value)
  return Math.min(Math.max(Number.isFinite(numeric) ? numeric : fallback, pageSize.value), MAX_RESULTS)
}

function synchronizeResultLimitChoice(value: number) {
  resultLimitChoice.value = [50, 100, 200, 500, 1000].includes(value) ? String(value) : 'custom'
  if (resultLimitChoice.value === 'custom') customResultLimit.value = value
}

function buildRequestUrl() {
  const params = new URLSearchParams({
    from: String(timeRange.value[0]),
    to: String(timeRange.value[1]),
    page: String(page.value),
    pageSize: String(pageSize.value),
    maxResults: String(maxResults.value),
  })
  addTextParameter(params, 'keyword', filters.value.keyword)
  addTextParameter(params, 'username', filters.value.username)
  addTextParameter(params, 'role', filters.value.role)
  addTextParameter(params, 'category', filters.value.category)
  addTextParameter(params, 'result', filters.value.result)
  addTextParameter(params, 'source', filters.value.source)
  addTextParameter(params, 'errorCode', filters.value.errorCode)
  return `/api/audit-logs?${params.toString()}`
}

async function loadUsers() {
  try {
    const response = await fetch('/api/users', { headers: { Authorization: `Bearer ${authStore.getToken()}` } })
    const data = await response.json()
    if (response.ok && data.ok && Array.isArray(data.users)) users.value = data.users
  } catch {
    // 审计查询仍可用；历史用户名继续可由关键词检索。
  }
}

async function loadLogs() {
  const currentRequest = ++requestSequence
  activeController?.abort()
  const controller = new AbortController()
  activeController = controller
  loading.value = true
  forbidden.value = false
  loadError.value = ''
  try {
    const response = await fetch(buildRequestUrl(), {
      headers: { Authorization: `Bearer ${authStore.getToken()}` },
      signal: controller.signal,
    })
    const data = await response.json() as AuditResponse
    if (currentRequest !== requestSequence) return
    if (response.status === 403) {
      forbidden.value = true
      return
    }
    if (!response.ok || !data.ok) throw new Error(data.error || '获取审计信息失败')
    logs.value = data.logs
    pagination.value = data.pagination
    summary.value = data.summary
    page.value = data.pagination.page
    maxResults.value = data.pagination.maxResults
    synchronizeResultLimitChoice(data.pagination.maxResults)
    selectedLog.value = null
    detailVisible.value = false
  } catch (error) {
    if (controller.signal.aborted || currentRequest !== requestSequence) return
    loadError.value = error instanceof Error ? error.message : '获取审计信息失败'
    message.error(loadError.value)
  } finally {
    if (currentRequest === requestSequence) loading.value = false
  }
}

function queryFromFirstPage() {
  page.value = 1
  void loadLogs()
}

function applyTimeRange(range: TimeRange, preset: TimeRangePreset) {
  timeRange.value = range
  timePreset.value = preset
  queryFromFirstPage()
}

function resetFilters() {
  filters.value = { keyword: '', username: null, role: null, category: null, result: null, source: null, errorCode: '' }
  timePreset.value = 'today'
  timeRange.value = rangeForPreset('today', Date.now())
  queryFromFirstPage()
}

function applyPageSize(value: number) {
  pageSize.value = Number(value)
  if (maxResults.value < pageSize.value) {
    maxResults.value = pageSize.value
    synchronizeResultLimitChoice(maxResults.value)
  }
  queryFromFirstPage()
}

function handleResultLimitChoice(value: string) {
  resultLimitChoice.value = value
  if (value === 'custom') {
    customResultLimit.value = maxResults.value
    return
  }
  maxResults.value = boundedMaxResults(value)
  synchronizeResultLimitChoice(maxResults.value)
  queryFromFirstPage()
}

function applyCustomResultLimit() {
  maxResults.value = boundedMaxResults(customResultLimit.value)
  customResultLimit.value = maxResults.value
  synchronizeResultLimitChoice(maxResults.value)
  queryFromFirstPage()
}

function changePage(value: number) {
  if (value === page.value || value < 1 || value > pagination.value.totalPages) return
  page.value = value
  void loadLogs()
}

function openDetail(log: AuditLog) {
  selectedLog.value = log
  detailVisible.value = true
}

async function copyRequestId(requestId: string | null) {
  if (!requestId) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(requestId)
    } else {
      const element = document.createElement('textarea')
      element.value = requestId
      element.style.position = 'fixed'
      element.style.opacity = '0'
      document.body.appendChild(element)
      element.select()
      document.execCommand('copy')
      element.remove()
    }
    message.success('请求编号已复制')
  } catch {
    message.error('复制请求编号失败')
  }
}

function renderOperation(row: AuditLog) {
  const detail = String(row.detail || '').trim()
  return h('div', { class: 'audit-operation', title: detail ? `${displayTableValue(row.action)}\n${detail}` : displayTableValue(row.action) }, [
    h('div', { class: 'audit-operation__action' }, displayTableValue(row.action)),
    detail ? h('div', { class: 'audit-operation__detail' }, detail) : null,
  ])
}

const columns: DataTableColumns<AuditLog> = [
  { title: '时间', key: 'createdAt', width: 174, render: (row) => formatTime(row.createdAt) },
  { title: '结果', key: 'result', width: 96, render: (row) => h(NTag, { type: row.result ? resultTypes[row.result] : 'default', bordered: false }, { default: () => displayResult(row.result) }) },
  { title: '操作用户', key: 'username', width: 118, ellipsis: { tooltip: true }, render: (row) => displayTableValue(row.username) },
  { title: '用户角色', key: 'role', width: 112, render: (row) => h(NTag, { type: roleTypes[row.role] || 'default', bordered: false }, { default: () => displayRole(row.role) }) },
  { title: '分类', key: 'category', width: 112, ellipsis: { tooltip: true }, render: (row) => displayCategory(row.category) },
  { title: '操作 / 说明', key: 'action', minWidth: 210, render: renderOperation },
  { title: '对象', key: 'target', minWidth: 150, ellipsis: { tooltip: true }, render: (row) => displayTableValue(row.target) },
  { title: '来源', key: 'source', width: 104, ellipsis: { tooltip: true }, render: (row) => row.source ? displaySource(row.source) : '—' },
  { title: '错误码', key: 'errorCode', width: 138, ellipsis: { tooltip: true }, render: (row) => displayTableValue(row.errorCode) },
  { title: '详情', key: 'detailEntry', width: 76, fixed: 'right', render: (row) => h(NButton, { size: 'small', tertiary: true, onClick: () => openDetail(row) }, { default: () => '查看' }) },
]

onMounted(() => {
  void loadLogs()
  void loadUsers()
})
onBeforeUnmount(() => activeController?.abort())
</script>

<template>
  <section class="audit-page">
    <NCard title="审计信息" :bordered="false" class="audit-card">
      <template #header-extra>
        <NSpace class="time-toolbar" align="center" wrap :size="8">
          <TimeRangePicker v-model="timeRange" :preset="timePreset" :presets="auditTimeRangePresets" compact placement="bottom-end" @apply="applyTimeRange" />
          <NButton size="small" :loading="loading" @click="loadLogs"><template #icon><NIcon><RefreshOutline /></NIcon></template>刷新</NButton>
        </NSpace>
      </template>

      <NAlert v-if="forbidden" type="warning" :bordered="false">审计信息仅审计用户和管理员可查看。</NAlert>
      <template v-else>
        <NAlert v-if="topLimited" type="warning" :bordered="false" class="audit-alert">当前筛选结果超过 TOP {{ effectiveMaxResults }}，可提高 TOP 值继续查看。</NAlert>
        <NAlert v-if="loadError" type="error" :bordered="false" class="audit-alert">{{ loadError }}；已保留上次查询结果。</NAlert>

        <div class="audit-summary" aria-label="当前筛选范围汇总">
          <NCard v-for="item in summaryItems" :key="item.label" :bordered="true" size="small" :class="['audit-summary__item', item.className]">
            <NStatistic :value="item.value">
              <template #label>
                <span>{{ item.label }}</span>
                <NTooltip v-if="item.hint"><template #trigger><NIcon class="summary-hint-icon" :component="InformationCircleOutline" /></template>{{ item.hint }}</NTooltip>
              </template>
            </NStatistic>
          </NCard>
        </div>

        <div class="filters">
          <div class="filter-keyword">
            <NInput v-model:value="filters.keyword" clearable class="audit-keyword" placeholder="关键词：操作、对象、说明或历史用户" @keyup.enter="queryFromFirstPage">
              <template #prefix><NIcon><SearchOutline /></NIcon></template>
            </NInput>
          </div>

          <div class="filter-conditions">
            <NSelect v-model:value="filters.username" clearable filterable placeholder="全部用户" :options="userOptions" style="width: 220px" />
            <NSelect v-model:value="filters.role" clearable placeholder="全部角色" :options="roleOptions" style="width: 140px" />
            <NSelect v-model:value="filters.category" clearable placeholder="全部分类" :options="categoryOptions" style="width: 150px" />
            <NSelect v-model:value="filters.result" clearable placeholder="全部结果" :options="resultOptions" style="width: 128px" />
            <NSelect v-model:value="filters.source" clearable placeholder="全部来源" :options="sourceOptions" style="width: 140px" />
            <NInput v-model:value="filters.errorCode" clearable placeholder="错误码" style="width: 150px" @keyup.enter="queryFromFirstPage" />
            <NButton type="primary" :disabled="loading" @click="queryFromFirstPage">查询</NButton>
            <NButton secondary :disabled="loading" @click="resetFilters">重置</NButton>
          </div>

          <div class="display-controls">
            <NSelect :value="pageSize" :options="pageSizeOptions" style="width: 112px" @update:value="applyPageSize" />
            <NSelect :value="resultLimitChoice" :options="resultLimitOptions" style="width: 148px" @update:value="handleResultLimitChoice" />
            <NInputNumber v-if="isCustomLimit" v-model:value="customResultLimit" :min="pageSize" :max="MAX_RESULTS" :precision="0" placeholder="最高 3000 条" style="width: 150px" />
            <NButton v-if="isCustomLimit" type="primary" :disabled="loading" @click="applyCustomResultLimit">应用 TOP</NButton>
          </div>
        </div>

        <NDataTable :columns="columns" :data="logs" :loading="loading" :bordered="false" :single-line="false" :scroll-x="1400" :pagination="false">
          <template #empty><NEmpty description="当前条件暂无审计记录" /></template>
        </NDataTable>

        <div class="audit-pagination">
          <NText depth="3">匹配 {{ pagination.total }} 条，当前最多查看 TOP {{ effectiveMaxResults }}。</NText>
          <NPagination :page="page" :page-count="pagination.totalPages" :disabled="loading || pagination.totalPages <= 1" @update:page="changePage" />
        </div>
      </template>
    </NCard>

    <NDrawer v-model:show="detailVisible" :width="560" placement="right">
      <NDrawerContent title="审计详情" closable>
        <NDescriptions v-if="selectedLog" label-placement="left" :column="1" bordered>
          <NDescriptionsItem label="完整时间">{{ formatTime(selectedLog.createdAt) }}</NDescriptionsItem>
          <NDescriptionsItem label="操作用户">{{ displayValue(selectedLog.username) }}</NDescriptionsItem>
          <NDescriptionsItem label="用户 ID">{{ displayValue(selectedLog.actorUserId) }}</NDescriptionsItem>
          <NDescriptionsItem label="当时角色">{{ displayRole(selectedLog.role) }}</NDescriptionsItem>
          <NDescriptionsItem label="结果">{{ displayResult(selectedLog.result) }}</NDescriptionsItem>
          <NDescriptionsItem label="分类">{{ displayCategory(selectedLog.category) }}</NDescriptionsItem>
          <NDescriptionsItem label="来源">{{ displaySource(selectedLog.source) }}</NDescriptionsItem>
          <NDescriptionsItem label="操作">{{ displayValue(selectedLog.action) }}</NDescriptionsItem>
          <NDescriptionsItem label="对象">{{ displayValue(selectedLog.target) }}</NDescriptionsItem>
          <NDescriptionsItem label="完整说明"><span class="audit-detail-text">{{ displayValue(selectedLog.detail) }}</span></NDescriptionsItem>
          <NDescriptionsItem label="REST 方法">{{ displayValue(selectedLog.restMethod) }}</NDescriptionsItem>
          <NDescriptionsItem label="规范化 REST 路径">{{ displayValue(selectedLog.restPath) }}</NDescriptionsItem>
          <NDescriptionsItem label="RPC 方法">{{ displayValue(selectedLog.rpcMethod) }}</NDescriptionsItem>
          <NDescriptionsItem label="错误码">{{ displayValue(selectedLog.errorCode) }}</NDescriptionsItem>
          <NDescriptionsItem label="请求编号">
            <NSpace align="center" :wrap="false"><span class="audit-request-id">{{ displayValue(selectedLog.requestId) }}</span><NButton v-if="selectedLog.requestId" size="small" @click="copyRequestId(selectedLog.requestId)"><template #icon><NIcon><CopyOutline /></NIcon></template>复制</NButton></NSpace>
          </NDescriptionsItem>
          <NDescriptionsItem label="来源地址">{{ displayValue(selectedLog.sourceAddress) }}</NDescriptionsItem>
        </NDescriptions>
      </NDrawerContent>
    </NDrawer>
  </section>
</template>

<style scoped>
.audit-page { display: grid; gap: 16px; }
.audit-card { min-height: 420px; }
.audit-alert { margin-bottom: 14px; }
.time-toolbar { justify-content: flex-end; }
.audit-summary { display: grid; grid-template-columns: repeat(5, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px; }
.audit-summary__item { border-top-width: 3px; }
.summary-total { border-top-color: var(--primary-color, #2080f0); }
.summary-success { border-top-color: var(--success-color, #18a058); }
.summary-failed { border-top-color: var(--error-color, #d03050); }
.summary-denied { border-top-color: var(--warning-color, #f0a020); }
.summary-unclassified { border-top-color: #8b8b8b; }
.summary-hint-icon { margin-left: 4px; color: var(--text-color-3, #909399); cursor: help; vertical-align: -2px; }
.filters { display: grid; grid-template-areas: "keyword display" "conditions conditions"; grid-template-columns: minmax(420px, 1fr) auto; gap: 12px 20px; margin: 16px 0; padding: 16px; border: 1px solid var(--border-color, #e8edf0); border-radius: 10px; background: var(--bg-card, #fff); }
.filter-keyword { grid-area: keyword; min-width: 0; }
.audit-keyword { width: min(100%, 520px); min-width: 360px; }
.filter-conditions { grid-area: conditions; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.display-controls { grid-area: display; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px; }
.audit-pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; }
.audit-operation { min-width: 0; cursor: help; }
.audit-operation__action, .audit-operation__detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.audit-operation__detail { margin-top: 2px; color: var(--text-color-3, #909399); font-size: 12px; }
.audit-detail-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.audit-request-id { overflow-wrap: anywhere; }
@media (max-width: 1120px) { .audit-summary { grid-template-columns: repeat(3, minmax(140px, 1fr)); } .filters { grid-template-areas: "keyword" "conditions" "display"; grid-template-columns: minmax(0, 1fr); } .display-controls { justify-content: flex-start; } }
@media (max-width: 720px) { .audit-summary { grid-template-columns: repeat(2, minmax(140px, 1fr)); } .time-toolbar { max-width: 100%; } .audit-keyword { width: 100%; min-width: 0; } .audit-pagination { align-items: flex-start; flex-direction: column; } }
</style>
