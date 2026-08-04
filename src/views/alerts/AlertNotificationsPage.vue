<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NDataTable, NDescriptions, NDescriptionsItem, NDrawer, NDrawerContent, NEmpty, NInput, NInputNumber, NSelect, NSpace, NTag, NText, useMessage, type DataTableColumns } from 'naive-ui'
import { CopyOutline, DownloadOutline, RefreshOutline } from '@vicons/ionicons5'
import TimeRangePicker from '@/components/common/TimeRangePicker.vue'
import { useAuthStore } from '@/stores/auth'
import { usePermissions } from '@/composables/usePermissions'
import { rangeForPreset, type TimeRange, type TimeRangePreset } from '@/utils/time-range'
import { useI18n } from 'vue-i18n'

type Metric = { name: string; value: string; unit: string }
type Alert = {
  id: string; occurredAt: string; sourceHost: string; category: string; categoryLabel: string; severity: string; name: string
  ruleId: number; metrics: Metric[]; description: string | null; triggerCondition: string | null; groupPath: string | null
  startTime: string | null; endTime: string | null; eventId: string | null; restored: boolean
}
type Pagination = { page: number; pageSize: number; maxResults: number; availableCount: number; hasMore: boolean; limitReached: boolean }
type AlertExportRow = { occurredAt: string; severity: string; name: string; category: string; sourceHost: string; status: string }
type AlertReturnState = {
  severity: string; category: string; keyword: string; range: TimeRange; timePreset: TimeRangePreset
  pageSize: number; resultLimitChoice: string; customResultLimit: number | null; page: number
}

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const { canUseFunctions, readOnlyHint } = usePermissions()
const message = useMessage()
const { t, locale } = useI18n()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const loading = ref(false)
const exportLoading = ref(false)
const error = ref('')
const alerts = ref<Alert[]>([])
const selectedAlert = ref<Alert | null>(null)
const ALL_FILTER_VALUE = '__all__'
const filters = ref({ severity: ALL_FILTER_VALUE, category: ALL_FILTER_VALUE, keyword: '' })
const serverNow = ref(Date.now())
const timePreset = ref<TimeRangePreset>('lastHour')
const appliedRange = ref<TimeRange>(rangeForPreset('lastHour', serverNow.value))
const pageSize = ref(10)
const resultLimitChoice = ref('200')
const customResultLimit = ref<number | null>(null)
const page = ref(1)
const ALERT_RETURN_STATE_KEY = 'gaiop.alert-notifications-return-state'
const pagination = ref<Pagination>({ page: 1, pageSize: 10, maxResults: 200, availableCount: 0, hasMore: false, limitReached: false })
const categoryOptions = ref<Array<{ label: string; value: string }>>([])
const detailVisible = computed({ get: () => !!selectedAlert.value, set: (visible: boolean) => { if (!visible) selectedAlert.value = null } })
const isCustomLimit = computed(() => resultLimitChoice.value === 'custom')
const activeResultLimit = computed(() => isCustomLimit.value ? Math.min(Math.max(Number(customResultLimit.value) || 200, pageSize.value), 3000) : Number(resultLimitChoice.value))

const pageSizeOptions = computed(() => [10, 20, 50, 100].map((value) => ({ label: locale.value === 'zh-CN' ? `${value} 条/页` : `${value} / page`, value })))
const resultLimitOptions = computed(() => [50, 100, 200, 500, 1000].map((value) => ({ label: `TOP ${value}`, value: String(value) })).concat([{ label: locale.value === 'zh-CN' ? '自定义 TOP' : 'Custom TOP', value: 'custom' }]))

function authHeaders() { return { Authorization: `Bearer ${authStore.getToken() || ''}` } }
function severityType(severity: string) { return ({ '紧急': 'error', '重大': 'warning', '一般': 'info', '轻微': 'default' } as Record<string, 'error' | 'warning' | 'info' | 'default'>)[severity] || 'default' }
function severityLabel(severity: string) { return ({ '紧急': text('紧急', 'Critical'), '重大': text('重大', 'Major'), '一般': text('一般', 'Warning'), '轻微': text('轻微', 'Minor') } as Record<string, string>)[severity] || severity }
function formatTime(value: string | null) { return value ? new Date(value).toLocaleString(locale.value) : t('pages.gaiop.alerts.notRecorded') }
function pad(value: number) { return String(value).padStart(2, '0') }
function formatRangeTime(value: number) { const date = new Date(value); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}` }

async function refreshServerTime() {
  try {
    const response = await fetch('/api/alerts/time', { headers: authHeaders() })
    const data = await response.json()
    if (response.ok && data.ok && Number.isFinite(data.now)) serverNow.value = data.now
  } catch {
    // BFF time is preferred; keeping the existing timestamp avoids blocking a read-only query on a transient time request failure.
  }
}

const severityOptions = computed(() => [
  { label: t('pages.gaiop.alerts.allSeverity'), value: ALL_FILTER_VALUE },
  { label: locale.value === 'zh-CN' ? '紧急' : 'Critical', value: '紧急' },
  { label: locale.value === 'zh-CN' ? '重大' : 'Major', value: '重大' },
  { label: locale.value === 'zh-CN' ? '一般' : 'Warning', value: '一般' },
  { label: locale.value === 'zh-CN' ? '轻微' : 'Minor', value: '轻微' },
])
const allCategoryOptions = computed(() => [{ label: t('pages.gaiop.alerts.allCategory'), value: ALL_FILTER_VALUE }, ...categoryOptions.value])
const metricColumns = computed<DataTableColumns<Metric>>(() => [{ title: locale.value === 'zh-CN' ? '指标' : 'Metric', key: 'name' }, { title: locale.value === 'zh-CN' ? '值' : 'Value', key: 'value' }, { title: locale.value === 'zh-CN' ? '单位' : 'Unit', key: 'unit' }])
const columns = computed<DataTableColumns<Alert>>(() => [
  { title: t('pages.gaiop.alerts.time'), key: 'occurredAt', width: 180, render: (row) => formatTime(row.occurredAt) },
  { title: t('pages.gaiop.alerts.severity'), key: 'severity', width: 100, render: (row) => h(NTag, { type: severityType(row.severity), bordered: false }, { default: () => severityLabel(row.severity) }) },
  { title: t('pages.gaiop.alerts.name'), key: 'name', minWidth: 190, ellipsis: { tooltip: true } },
  { title: t('pages.gaiop.alerts.category'), key: 'categoryLabel', width: 150, render: (row) => row.categoryLabel || row.category },
  { title: t('pages.gaiop.alerts.source'), key: 'sourceHost', width: 130 },
  { title: t('pages.gaiop.alerts.status'), key: 'restored', width: 90, render: (row) => h(NTag, { type: row.restored ? 'success' : 'warning', bordered: false }, { default: () => row.restored ? t('pages.gaiop.alerts.restored') : t('pages.gaiop.alerts.triggered') }) },
  { title: t('pages.gaiop.alerts.actions'), key: 'actions', width: 80, fixed: 'right', render: (row) => h(NButton, { size: 'small', onClick: () => { selectedAlert.value = row } }, { default: () => t('pages.gaiop.alerts.details') }) },
])
const exportHeaders = computed(() => [t('pages.gaiop.alerts.time'), t('pages.gaiop.alerts.severity'), t('pages.gaiop.alerts.name'), t('pages.gaiop.alerts.category'), locale.value === 'zh-CN' ? '来源 IP' : 'Source IP', t('pages.gaiop.alerts.status')])

function alertStatus(row: Alert) { return row.restored ? t('pages.gaiop.alerts.restored') : t('pages.gaiop.alerts.triggered') }
function alertAnalysisInstruction(alert: Alert): string | null {
  const eventId = String(alert.eventId || '').trim()
  const start = Number.parseInt(String(alert.startTime || ''), 10)
  const end = Number.parseInt(String(alert.endTime || ''), 10)
  if (!eventId || !Number.isFinite(start) || start <= 0) return null
  const hasEnd = Number.isFinite(end) && end > 0
  const queryStart = hasEnd ? Math.floor(start / 60) * 60 - 60 : Math.floor(start / 60) * 60 - 120
  const queryEnd = hasEnd ? Math.floor(end / 60) * 60 + 60 : Math.floor(start / 60) * 60 + 120
  const metricPart = alert.metrics.map((metric) => metric.name.trim()).filter(Boolean).join(' ')
  return text(`分析告警数据包 eventId=${eventId} start=${queryStart} end=${queryEnd}${metricPart ? ` ${metricPart}` : ''}`, `Analyze alert data package eventId=${eventId} start=${queryStart} end=${queryEnd}${metricPart ? ` ${metricPart}` : ''}`)
}
const selectedAnalysisInstruction = computed(() => selectedAlert.value ? alertAnalysisInstruction(selectedAlert.value) : null)
function openAlertAnalysis() {
  if (!canUseFunctions.value) {
    message.warning(readOnlyHint.value)
    return
  }
  const instruction = selectedAnalysisInstruction.value
  if (!instruction) { message.warning(text('该告警未记录 Event ID 或告警窗口，暂时无法生成分析指令', 'This alert has no Event ID or alert window, so an analysis instruction cannot be generated')); return }
  try {
    sessionStorage.setItem('gaiop.alert-analysis-draft', instruction)
    const state: AlertReturnState = {
      severity: filters.value.severity, category: filters.value.category, keyword: filters.value.keyword,
      range: [...appliedRange.value] as [number, number], timePreset: timePreset.value,
      pageSize: pageSize.value, resultLimitChoice: resultLimitChoice.value,
      customResultLimit: customResultLimit.value, page: page.value,
    }
    sessionStorage.setItem(ALERT_RETURN_STATE_KEY, JSON.stringify(state))
    void router.push({ name: 'ChatWorkspace', query: { alertAnalysis: instruction, alertReturn: '1' } })
  } catch {
    message.error(text('无法写入对话草稿，请检查浏览器存储权限', 'Could not save the chat draft. Check browser storage permissions.'))
  }
}

function restoreAlertListState(): boolean {
  if (route.query.restoreAlertState !== '1') return false
  try {
    const raw = sessionStorage.getItem(ALERT_RETURN_STATE_KEY)
    sessionStorage.removeItem(ALERT_RETURN_STATE_KEY)
    if (!raw) return false
    const state = JSON.parse(raw) as Partial<AlertReturnState>
    const range = Array.isArray(state.range) ? state.range.map(Number) : []
    const startAt = range[0]
    const endAt = range[1]
    if (range.length !== 2 || startAt === undefined || endAt === undefined || !Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt > endAt) return false
    const allowedPresets: TimeRangePreset[] = ['lastHour', 'today', 'yesterday', 'last7days', 'last30days', 'thisMonth', 'custom']
    filters.value = {
      severity: typeof state.severity === 'string' ? state.severity : ALL_FILTER_VALUE,
      category: typeof state.category === 'string' ? state.category : ALL_FILTER_VALUE,
      keyword: typeof state.keyword === 'string' ? state.keyword.slice(0, 120) : '',
    }
    appliedRange.value = [startAt, endAt]
    timePreset.value = allowedPresets.includes(state.timePreset as TimeRangePreset) ? state.timePreset as TimeRangePreset : 'custom'
    pageSize.value = [10, 20, 50, 100].includes(Number(state.pageSize)) ? Number(state.pageSize) : 10
    resultLimitChoice.value = ['50', '100', '200', '500', '1000', 'custom'].includes(String(state.resultLimitChoice)) ? String(state.resultLimitChoice) : '200'
    customResultLimit.value = Number.isFinite(Number(state.customResultLimit)) ? Math.min(Math.max(Number(state.customResultLimit), pageSize.value), 3000) : null
    page.value = Math.max(1, Math.min(Number(state.page) || 1, 10_000))
    return true
  } catch {
    return false
  }
}
function currentPageRows(): AlertExportRow[] {
  return alerts.value.map((row) => ({
    occurredAt: formatTime(row.occurredAt),
    severity: row.severity,
    name: row.name,
    category: row.categoryLabel || row.category,
    sourceHost: row.sourceHost,
    status: alertStatus(row),
  }))
}
function asTsvCell(value: string) { return String(value).replace(/[\t\r\n]+/g, ' ') }
function currentPageText() {
  return [exportHeaders.value.join('\t'), ...currentPageRows().map((row) => Object.values(row).map(asTsvCell).join('\t'))].join('\n')
}
async function copyCurrentPage() {
  if (!alerts.value.length) { message.warning(text('当前页没有可复制的告警记录', 'There are no alert records on the current page to copy')); return }
  const content = currentPageText()
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content)
    } else {
      const textArea = document.createElement('textarea')
      textArea.value = content
      textArea.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
      document.body.appendChild(textArea)
      textArea.select()
      const copied = document.execCommand('copy')
      textArea.remove()
      if (!copied) throw new Error('clipboard unavailable')
    }
    message.success(text(`已复制当前页 ${alerts.value.length} 条记录`, `Copied ${alerts.value.length} records from the current page`))
  } catch {
    message.error(text('复制失败，请检查浏览器剪贴板权限', 'Copy failed. Check browser clipboard permissions.'))
  }
}
async function exportCurrentPage() {
  if (!alerts.value.length) { message.warning(t('pages.gaiop.alerts.exportEmpty')); return }
  exportLoading.value = true
  try {
    const response = await fetch('/api/alerts/export', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: currentPageRows(), locale: locale.value }),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      throw new Error(data?.error || t('pages.gaiop.alerts.exportFailed'))
    }
    const downloadUrl = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = `${locale.value === 'zh-CN' ? 'GAIOP-告警通知-当前页' : 'GAIOP-alerts-current-page'}-${formatRangeTime(Date.now()).replace(/[ :]/g, '-')}.xlsx`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(downloadUrl)
    message.success(t('pages.gaiop.alerts.exportSuccess', { count: alerts.value.length }))
  } catch (reason) {
    message.error(reason instanceof Error ? reason.message : t('pages.gaiop.alerts.exportFailed'))
  } finally {
    exportLoading.value = false
  }
}

async function loadAlerts() {
  const range = appliedRange.value
  loading.value = true; error.value = ''
  try {
    const params = new URLSearchParams({ page: String(page.value), pageSize: String(pageSize.value), maxResults: String(activeResultLimit.value) })
    if (range) { params.set('startAt', String(range[0])); params.set('endAt', String(range[1])) }
    if (filters.value.severity !== ALL_FILTER_VALUE) params.set('severity', filters.value.severity)
    if (filters.value.category !== ALL_FILTER_VALUE) params.set('category', filters.value.category)
    if (filters.value.keyword.trim()) params.set('keyword', filters.value.keyword.trim())
    const response = await fetch(`/api/alerts?${params}`, { headers: authHeaders() })
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) throw new Error(text('Admin BFF 未返回告警接口数据', 'The Admin BFF did not return alert API data'))
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || text('读取告警失败', 'Failed to load alerts'))
    alerts.value = Array.isArray(data.alerts) ? data.alerts : []
    categoryOptions.value = Array.isArray(data.categoryOptions) ? data.categoryOptions : []
    pagination.value = data.pagination || pagination.value
    page.value = pagination.value.page
  } catch (reason) {
    alerts.value = []; error.value = reason instanceof Error ? reason.message : text('读取告警失败', 'Failed to load alerts'); message.error(error.value)
  } finally { loading.value = false }
}

function applyFilters() { page.value = 1; loadAlerts() }
function applyTimeRange(range: TimeRange, preset: TimeRangePreset) {
  timePreset.value = preset
  appliedRange.value = range
  page.value = 1
  loadAlerts()
}
async function resetFilters() {
  filters.value = { severity: ALL_FILTER_VALUE, category: ALL_FILTER_VALUE, keyword: '' }
  await refreshServerTime()
  applyTimeRange(rangeForPreset('lastHour', serverNow.value), 'lastHour')
}
function applyPageSize() { if (activeResultLimit.value < pageSize.value) resultLimitChoice.value = String(pageSize.value); page.value = 1; loadAlerts() }
function applyResultLimit() { page.value = 1; loadAlerts() }
function changePage(next: number) { if (next < 1 || (next > page.value && !pagination.value.hasMore)) return; page.value = next; loadAlerts() }
onMounted(async () => {
  await refreshServerTime()
  const restored = restoreAlertListState()
  if (!restored) appliedRange.value = rangeForPreset('lastHour', serverNow.value)
  if (route.query.restoreAlertState === '1') void router.replace({ name: 'AlertNotifications', query: {} })
  loadAlerts()
})
</script>

<template>
  <section class="alerts-page">
    <NCard :title="t('pages.gaiop.alerts.title')" class="app-card">
      <template #header-extra>
        <NSpace class="time-toolbar" align="center" wrap :size="8">
          <TimeRangePicker
            v-model="appliedRange"
            :preset="timePreset"
            :server-now="serverNow"
            compact
            placement="bottom-end"
            @apply="applyTimeRange"
          />
          <NButton size="small" :loading="loading" @click="loadAlerts"><template #icon><RefreshOutline /></template>{{ t('pages.gaiop.alerts.refresh') }}</NButton>
        </NSpace>
      </template>
      <NAlert v-if="pagination.limitReached" type="warning" :bordered="false" style="margin-top: 12px;">{{ text(`当前筛选结果超过 TOP ${pagination.maxResults}；可提高 TOP 值继续查看。`, `Current filters exceed TOP ${pagination.maxResults}; increase TOP to continue viewing.`) }}</NAlert>
      <NAlert v-if="error" type="error" :bordered="false" style="margin-top: 12px;">{{ error }}</NAlert>

      <div class="filters">
        <div class="filter-main">
          <NSpace wrap :size="10">
            <NSelect v-model:value="filters.severity" :options="severityOptions" style="width: 160px" @update:value="applyFilters" />
            <NSelect v-model:value="filters.category" :options="allCategoryOptions" style="width: 180px" @update:value="applyFilters" />
            <NInput v-model:value="filters.keyword" clearable :placeholder="text('搜索名称、来源 IP 或事件 ID', 'Search name, source IP, or event ID')" style="width: 260px" @keyup.enter="applyFilters" />
            <NButton type="primary" @click="applyFilters">{{ text('筛选', 'Filter') }}</NButton>
            <NButton @click="resetFilters">{{ text('重置', 'Reset') }}</NButton>
          </NSpace>
        </div>
        <NSpace class="display-controls" wrap :size="10">
          <NSelect v-model:value="pageSize" :options="pageSizeOptions" style="width: 120px" @update:value="applyPageSize" />
          <NSelect v-model:value="resultLimitChoice" :options="resultLimitOptions" style="width: 180px" @update:value="!isCustomLimit && applyResultLimit()" />
          <NInputNumber v-if="isCustomLimit" v-model:value="customResultLimit" :min="pageSize" :max="3000" :precision="0" :placeholder="text('最高 3000 条', 'Up to 3000')" style="width: 150px" />
          <NButton v-if="isCustomLimit" type="primary" @click="applyResultLimit">{{ text('应用条数', 'Apply limit') }}</NButton>
          <NButton :disabled="!alerts.length" @click="copyCurrentPage"><template #icon><CopyOutline /></template>{{ text('复制内容', 'Copy') }}</NButton>
          <NButton :loading="exportLoading" :disabled="!alerts.length" @click="exportCurrentPage"><template #icon><DownloadOutline /></template>{{ t('pages.gaiop.alerts.export') }}</NButton>
        </NSpace>
      </div>

      <NDataTable :columns="columns" :data="alerts" :loading="loading" :bordered="false" :single-line="false" :scroll-x="980" :pagination="false">
        <template #empty><NEmpty :description="text('当前时间范围内暂无可展示的 Syslog 告警', 'No Syslog alerts are available in the current time range')" /></template>
      </NDataTable>
      <NSpace justify="space-between" align="center" style="margin-top: 16px;">
        <NText depth="3">{{ text(`已在当前读取窗口中匹配 ${pagination.availableCount} 条，TOP ${pagination.maxResults}。`, `${pagination.availableCount} records match the current retrieval window, TOP ${pagination.maxResults}.`) }}</NText>
        <NSpace align="center">
          <NButton :disabled="page <= 1 || loading" @click="changePage(page - 1)">{{ text('上一页', 'Previous') }}</NButton>
          <NText>{{ text(`第 ${page} 页`, `Page ${page}`) }}</NText>
          <NButton :disabled="!pagination.hasMore || loading" @click="changePage(page + 1)">{{ text('下一页', 'Next') }}</NButton>
        </NSpace>
      </NSpace>
    </NCard>

    <NDrawer v-model:show="detailVisible" :width="560" placement="right">
      <NDrawerContent :title="text('告警详情', 'Alert details')" closable>
        <template v-if="selectedAlert">
          <NDescriptions label-placement="left" :column="1" bordered>
            <NDescriptionsItem :label="text('告警名称', 'Alert name')">{{ selectedAlert.name }}</NDescriptionsItem>
            <NDescriptionsItem :label="text('严重级别', 'Severity')"><NTag :type="severityType(selectedAlert.severity)" :bordered="false">{{ severityLabel(selectedAlert.severity) }}</NTag></NDescriptionsItem>
            <NDescriptionsItem :label="text('告警类型', 'Alert type')">{{ selectedAlert.categoryLabel || selectedAlert.category }}</NDescriptionsItem>
            <NDescriptionsItem :label="text('告警时间', 'Alert time')">{{ formatTime(selectedAlert.occurredAt) }}</NDescriptionsItem>
            <NDescriptionsItem :label="text('来源', 'Source')">{{ selectedAlert.sourceHost }}</NDescriptionsItem>
            <NDescriptionsItem :label="text('规则 ID', 'Rule ID')">{{ selectedAlert.ruleId }}</NDescriptionsItem>
            <NDescriptionsItem :label="text('事件 ID', 'Event ID')">{{ selectedAlert.eventId || t('pages.gaiop.alerts.notRecorded') }}</NDescriptionsItem>
            <NDescriptionsItem :label="text('告警描述', 'Alert description')">{{ selectedAlert.description || t('pages.gaiop.alerts.notRecorded') }}</NDescriptionsItem>
            <NDescriptionsItem :label="text('分组', 'Group')">{{ selectedAlert.groupPath || t('pages.gaiop.alerts.notRecorded') }}</NDescriptionsItem>
          </NDescriptions>
          <NText strong style="display: block; margin: 20px 0 10px;">{{ text('触发指标', 'Triggered metrics') }}</NText>
          <NDataTable :columns="metricColumns" :data="selectedAlert.metrics" :bordered="false"><template #empty><NEmpty :description="text('未记录指标', 'No metrics recorded')" /></template></NDataTable>
          <NText strong style="display: block; margin: 20px 0 8px;">{{ text('触发条件', 'Trigger condition') }}</NText>
          <NText depth="3" class="trigger-condition">{{ selectedAlert.triggerCondition || t('pages.gaiop.alerts.notRecorded') }}</NText>
          <div class="alert-analysis-card">
            <div>
              <NText strong>{{ text('分析告警', 'Analyze alert') }}</NText>
              <code class="alert-analysis-card__instruction">
                {{ canUseFunctions
                  ? (selectedAnalysisInstruction || text('未记录：该告警缺少 Event ID 或告警窗口。', 'Not recorded: this alert has no Event ID or alert window.'))
                  : readOnlyHint }}
              </code>
            </div>
            <NButton
              v-if="canUseFunctions"
              type="primary"
              size="small"
              :disabled="!selectedAnalysisInstruction"
              @click="openAlertAnalysis"
            >
              {{ text('告警数据包详细分析', 'Detailed alert-packet analysis') }}
            </NButton>
          </div>
        </template>
      </NDrawerContent>
    </NDrawer>
  </section>
</template>

<style scoped>
.alerts-page { display: grid; gap: 16px; }
.time-toolbar { justify-content: flex-end; }
.trigger-condition { display: block; line-height: 1.7; white-space: pre-wrap; }
.alert-analysis-card { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-top: 20px; padding: 14px; border: 1px solid var(--border-color, #e8edf0); border-radius: 8px; background: var(--hover-color, #f6f8f7); }
.alert-analysis-card__instruction { display: block; max-width: 390px; overflow-wrap: anywhere; color: var(--text-color-1, #1f2937); font-size: 12px; line-height: 1.65; white-space: pre-wrap; }
.filters { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 16px 0; padding: 14px; border: 1px solid var(--border-color, #e8edf0); border-radius: 10px; background: var(--bg-card, #fff); }
.filter-main { min-width: 0; }
.display-controls { justify-content: flex-end; }
@media (max-width: 1120px) {
  .filters { align-items: flex-start; flex-direction: column; }
  .display-controls { justify-content: flex-start; }
}
@media (max-width: 720px) {
  .time-toolbar { max-width: 100%; }
  .alert-analysis-card { align-items: stretch; flex-direction: column; }
}
</style>
