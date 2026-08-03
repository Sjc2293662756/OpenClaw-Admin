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
  NPagination,
  NSelect,
  NSpace,
  NStatistic,
  NTag,
  NText,
  type DataTableColumns,
  useMessage,
} from 'naive-ui'
import { CopyOutline, RefreshOutline, SearchOutline } from '@vicons/ionicons5'
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

type AuditSummary = { total: number; success: number; failed: number; denied: number; unclassified: number }
type AuditPagination = { page: number; pageSize: number; total: number; totalPages: number }
type AuditFilters = {
  keyword: string
  username: string
  role: string | null
  category: string | null
  result: string | null
  source: string | null
  errorCode: string
}
type AuditResponse = { ok: boolean; logs: AuditLog[]; pagination: AuditPagination; summary: AuditSummary; error?: string }

const authStore = useAuthStore()
const message = useMessage()
const loading = ref(false)
const forbidden = ref(false)
const loadError = ref('')
const logs = ref<AuditLog[]>([])
const selectedLog = ref<AuditLog | null>(null)
const detailVisible = ref(false)
const timePreset = ref<TimeRangePreset>('today')
const timeRange = ref<TimeRange>(rangeForPreset('today', Date.now()))
const page = ref(1)
const pageSize = ref(20)
const pagination = ref<AuditPagination>({ page: 1, pageSize: 20, total: 0, totalPages: 0 })
const summary = ref<AuditSummary>({ total: 0, success: 0, failed: 0, denied: 0, unclassified: 0 })
const filters = ref<AuditFilters>({ keyword: '', username: '', role: null, category: null, result: null, source: null, errorCode: '' })
const auditTimeRangePresets: readonly TimeRangePreset[] = ['today', 'yesterday', 'last7days', 'last30days', 'custom']
const pageSizeOptions = [20, 50, 100].map((value) => ({ label: `${value} 条/页`, value }))
const roleLabels: Record<string, string> = { basic: '基础用户', auditor: '审计用户', standard: '标准用户', admin: '管理员', system: '系统' }
const roleTypes: Record<string, 'default' | 'info' | 'success' | 'warning'> = { basic: 'default', auditor: 'info', standard: 'success', admin: 'warning', system: 'default' }
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

const summaryItems = computed(() => [
  { label: '总记录', value: summary.value.total, className: 'summary-total' },
  { label: '成功', value: summary.value.success, className: 'summary-success' },
  { label: '失败', value: summary.value.failed, className: 'summary-failed' },
  { label: '已记录拒绝', value: summary.value.denied, className: 'summary-denied' },
  { label: '历史未分类', value: summary.value.unclassified, className: 'summary-unclassified' },
])

function displayValue(value: unknown) {
  return value === null || value === undefined || String(value).trim() === '' ? '历史未记录' : String(value)
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

function buildRequestUrl() {
  const params = new URLSearchParams({
    from: String(timeRange.value[0]),
    to: String(timeRange.value[1]),
    page: String(page.value),
    pageSize: String(pageSize.value),
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
  filters.value = { keyword: '', username: '', role: null, category: null, result: null, source: null, errorCode: '' }
  queryFromFirstPage()
}

function applyPageSize(value: number) {
  pageSize.value = value
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

const columns: DataTableColumns<AuditLog> = [
  { title: '时间', key: 'createdAt', width: 174, render: (row) => formatTime(row.createdAt) },
  { title: '结果', key: 'result', width: 96, render: (row) => h(NTag, { type: row.result ? resultTypes[row.result] : 'default', bordered: false }, { default: () => displayResult(row.result) }) },
  { title: '操作用户', key: 'username', width: 118, ellipsis: { tooltip: true }, render: (row) => displayValue(row.username) },
  { title: '用户角色', key: 'role', width: 112, render: (row) => h(NTag, { type: roleTypes[row.role] || 'default', bordered: false }, { default: () => displayRole(row.role) }) },
  { title: '分类', key: 'category', width: 112, ellipsis: { tooltip: true }, render: (row) => displayCategory(row.category) },
  { title: '操作 / 说明', key: 'action', minWidth: 210, render: (row) => h('div', { class: 'audit-operation', title: `${displayValue(row.action)}\n${displayValue(row.detail)}` }, [h('div', { class: 'audit-operation__action' }, displayValue(row.action)), h('div', { class: 'audit-operation__detail' }, displayValue(row.detail))]) },
  { title: '对象', key: 'target', minWidth: 150, ellipsis: { tooltip: true }, render: (row) => displayValue(row.target) },
  { title: '来源', key: 'source', width: 104, ellipsis: { tooltip: true }, render: (row) => displaySource(row.source) },
  { title: '错误码', key: 'errorCode', width: 138, ellipsis: { tooltip: true }, render: (row) => displayValue(row.errorCode) },
  { title: '详情', key: 'detailEntry', width: 76, fixed: 'right', render: (row) => h(NButton, { size: 'small', tertiary: true, onClick: () => openDetail(row) }, { default: () => '查看' }) },
]

onMounted(() => { void loadLogs() })
onBeforeUnmount(() => activeController?.abort())
</script>

<template>
  <section class="audit-page">
    <NCard title="审计信息" :bordered="false" class="audit-card">
      <template #header-extra>
        <NSpace align="center" wrap>
          <TimeRangePicker v-model="timeRange" :preset="timePreset" :presets="auditTimeRangePresets" @apply="applyTimeRange" />
          <NButton :loading="loading" @click="loadLogs"><template #icon><NIcon><RefreshOutline /></NIcon></template>刷新</NButton>
        </NSpace>
      </template>

      <NAlert v-if="forbidden" type="warning" :bordered="false">审计信息仅审计用户和管理员可查看。</NAlert>
      <template v-else>
        <NAlert v-if="loadError" type="error" :bordered="false" class="audit-alert">{{ loadError }}；已保留上次查询结果。</NAlert>

        <div class="audit-summary" aria-label="当前筛选范围汇总">
          <NCard v-for="item in summaryItems" :key="item.label" :bordered="true" size="small" :class="['audit-summary__item', item.className]">
            <NStatistic :label="item.label" :value="item.value" />
          </NCard>
        </div>

        <div class="audit-filters">
          <NInput v-model:value="filters.keyword" clearable placeholder="关键词：用户、操作、对象或说明" style="width: 250px" @keyup.enter="queryFromFirstPage">
            <template #prefix><NIcon><SearchOutline /></NIcon></template>
          </NInput>
          <NInput v-model:value="filters.username" clearable placeholder="用户名" style="width: 150px" />
          <NSelect v-model:value="filters.role" clearable placeholder="全部角色" :options="roleOptions" style="width: 140px" />
          <NSelect v-model:value="filters.category" clearable placeholder="全部分类" :options="categoryOptions" style="width: 150px" />
          <NSelect v-model:value="filters.result" clearable placeholder="全部结果" :options="resultOptions" style="width: 128px" />
          <NSelect v-model:value="filters.source" clearable placeholder="全部来源" :options="sourceOptions" style="width: 140px" />
          <NInput v-model:value="filters.errorCode" clearable placeholder="错误码" style="width: 150px" />
          <NButton type="primary" @click="queryFromFirstPage">查询</NButton>
          <NButton @click="resetFilters">重置</NButton>
        </div>

        <NDataTable :columns="columns" :data="logs" :loading="loading" :bordered="false" :single-line="false" :scroll-x="1400" :pagination="false">
          <template #empty><NEmpty description="当前条件暂无审计记录" /></template>
        </NDataTable>

        <div class="audit-pagination">
          <NText depth="3">共 {{ pagination.total }} 条记录</NText>
          <NSpace align="center" wrap>
            <NSelect :value="pageSize" :options="pageSizeOptions" style="width: 112px" @update:value="applyPageSize" />
            <NPagination :page="page" :page-count="pagination.totalPages" :disabled="loading || pagination.totalPages <= 1" @update:page="changePage" />
          </NSpace>
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
.audit-summary { display: grid; grid-template-columns: repeat(5, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px; }
.audit-summary__item { border-top-width: 3px; }
.summary-total { border-top-color: var(--primary-color, #2080f0); }
.summary-success { border-top-color: var(--success-color, #18a058); }
.summary-failed { border-top-color: var(--error-color, #d03050); }
.summary-denied { border-top-color: var(--warning-color, #f0a020); }
.summary-unclassified { border-top-color: #8b8b8b; }
.audit-filters { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; padding: 14px; border: 1px solid var(--border-color, #e8edf0); border-radius: 10px; background: var(--bg-card, #fff); }
.audit-pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; }
.audit-operation { min-width: 0; cursor: help; }
.audit-operation__action, .audit-operation__detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.audit-operation__detail { margin-top: 2px; color: var(--text-color-3, #909399); font-size: 12px; }
.audit-detail-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.audit-request-id { overflow-wrap: anywhere; }
@media (max-width: 1120px) { .audit-summary { grid-template-columns: repeat(3, minmax(140px, 1fr)); } }
@media (max-width: 720px) { .audit-summary { grid-template-columns: repeat(2, minmax(140px, 1fr)); } .audit-pagination { align-items: flex-start; flex-direction: column; } }
</style>
