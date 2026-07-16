<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NDataTable, NDatePicker, NDescriptions, NDescriptionsItem, NDrawer, NDrawerContent, NEmpty, NInput, NInputNumber, NPopover, NSelect, NSpace, NTag, NText, useMessage, type DataTableColumns } from 'naive-ui'
import { CalendarOutline, ChevronDownOutline, CopyOutline, DownloadOutline, RefreshOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'

type Metric = { name: string; value: string; unit: string }
type Alert = {
  id: string; occurredAt: string; sourceHost: string; category: string; categoryLabel: string; severity: string; name: string
  ruleId: number; metrics: Metric[]; description: string | null; triggerCondition: string | null; groupPath: string | null
  startTime: string | null; endTime: string | null; eventId: string | null; restored: boolean
}
type Pagination = { page: number; pageSize: number; maxResults: number; availableCount: number; hasMore: boolean; limitReached: boolean }
type TimePreset = 'lastHour' | 'today' | 'yesterday' | 'last7days' | 'last30days' | 'thisMonth' | 'custom'
type AlertExportRow = { occurredAt: string; severity: string; name: string; category: string; sourceHost: string; status: string }
type AlertReturnState = {
  severity: string; category: string; keyword: string; range: [number, number]; timePreset: TimePreset
  pageSize: number; resultLimitChoice: string; customResultLimit: number | null; page: number
}

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const message = useMessage()
const loading = ref(false)
const exportLoading = ref(false)
const error = ref('')
const alerts = ref<Alert[]>([])
const selectedAlert = ref<Alert | null>(null)
const ALL_FILTER_VALUE = '__all__'
const filters = ref({ severity: ALL_FILTER_VALUE, category: ALL_FILTER_VALUE, keyword: '' })
const serverNow = ref(Date.now())
const timePreset = ref<TimePreset>('lastHour')
const appliedRange = ref<[number, number]>([serverNow.value - 60 * 60 * 1000, serverNow.value])
const customRange = ref<[number, number] | null>(null)
const timePopoverVisible = ref(false)
const customRangeVisible = ref(false)
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

const timeOptions: Array<{ label: string; value: TimePreset }> = [
  { label: '最近 1 小时', value: 'lastHour' }, { label: '今日', value: 'today' }, { label: '昨日', value: 'yesterday' },
  { label: '最近 7 日', value: 'last7days' }, { label: '最近 30 日', value: 'last30days' }, { label: '本月', value: 'thisMonth' }, { label: '自定义', value: 'custom' },
]
const pageSizeOptions = [10, 20, 50, 100].map((value) => ({ label: `${value} 条/页`, value }))
const resultLimitOptions = [50, 100, 200, 500, 1000].map((value) => ({ label: `TOP ${value}`, value: String(value) })).concat([{ label: '自定义 TOP', value: 'custom' }])
const dateShortcuts = computed(() => ({
  '最近 1 小时': rangeForPreset('lastHour'),
  '最近 24 小时': [serverNow.value - 24 * 60 * 60 * 1000, serverNow.value] as [number, number],
  '最近 7 日': rangeForPreset('last7days'),
}))

function authHeaders() { return { Authorization: `Bearer ${authStore.getToken() || ''}` } }
function severityType(severity: string) { return ({ '紧急': 'error', '重大': 'warning', '一般': 'info', '轻微': 'default' } as Record<string, 'error' | 'warning' | 'info' | 'default'>)[severity] || 'default' }
function formatTime(value: string | null) { return value ? new Date(value).toLocaleString() : '未记录' }
function pad(value: number) { return String(value).padStart(2, '0') }
function formatRangeTime(value: number) { const date = new Date(value); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}` }
const timeRangeLabel = computed(() => `${formatRangeTime(appliedRange.value[0])} - ${formatRangeTime(appliedRange.value[1])}`)
function rangeForPreset(preset: Exclude<TimePreset, 'custom'>, now = serverNow.value): [number, number] {
  const date = new Date(now)
  const today = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  if (preset === 'lastHour') return [now - 60 * 60 * 1000, now]
  if (preset === 'today') return [today, now]
  if (preset === 'yesterday') return [today - 24 * 60 * 60 * 1000, today - 1]
  if (preset === 'last7days') return [now - 7 * 24 * 60 * 60 * 1000, now]
  if (preset === 'last30days') return [now - 30 * 24 * 60 * 60 * 1000, now]
  return [new Date(date.getFullYear(), date.getMonth(), 1).getTime(), now]
}

async function refreshServerTime() {
  try {
    const response = await fetch('/api/alerts/time', { headers: authHeaders() })
    const data = await response.json()
    if (response.ok && data.ok && Number.isFinite(data.now)) serverNow.value = data.now
  } catch {
    // BFF time is preferred; keeping the existing timestamp avoids blocking a read-only query on a transient time request failure.
  }
}

const severityOptions = [
  { label: '告警级别：全部', value: ALL_FILTER_VALUE },
  { label: '紧急', value: '紧急' },
  { label: '重大', value: '重大' },
  { label: '一般', value: '一般' },
  { label: '轻微', value: '轻微' },
]
const allCategoryOptions = computed(() => [{ label: '全部告警类型', value: ALL_FILTER_VALUE }, ...categoryOptions.value])
const metricColumns: DataTableColumns<Metric> = [{ title: '指标', key: 'name' }, { title: '值', key: 'value' }, { title: '单位', key: 'unit' }]
const columns: DataTableColumns<Alert> = [
  { title: '告警时间', key: 'occurredAt', width: 180, render: (row) => formatTime(row.occurredAt) },
  { title: '严重级别', key: 'severity', width: 100, render: (row) => h(NTag, { type: severityType(row.severity), bordered: false }, { default: () => row.severity }) },
  { title: '告警名称', key: 'name', minWidth: 190, ellipsis: { tooltip: true } },
  { title: '告警类型', key: 'categoryLabel', width: 150, render: (row) => row.categoryLabel || row.category },
  { title: '来源', key: 'sourceHost', width: 130 },
  { title: '状态', key: 'restored', width: 90, render: (row) => h(NTag, { type: row.restored ? 'success' : 'warning', bordered: false }, { default: () => row.restored ? '已恢复' : '触发中' }) },
  { title: '操作', key: 'actions', width: 80, fixed: 'right', render: (row) => h(NButton, { size: 'small', onClick: () => { selectedAlert.value = row } }, { default: () => '详情' }) },
]
const exportHeaders = ['告警时间', '严重级别', '告警名称', '告警类型', '来源 IP', '状态']

function alertStatus(row: Alert) { return row.restored ? '已恢复' : '触发中' }
function alertAnalysisInstruction(alert: Alert): string | null {
  const eventId = String(alert.eventId || '').trim()
  const start = Number.parseInt(String(alert.startTime || ''), 10)
  const end = Number.parseInt(String(alert.endTime || ''), 10)
  if (!eventId || !Number.isFinite(start) || start <= 0) return null
  const hasEnd = Number.isFinite(end) && end > 0
  const queryStart = hasEnd ? Math.floor(start / 60) * 60 - 60 : Math.floor(start / 60) * 60 - 120
  const queryEnd = hasEnd ? Math.floor(end / 60) * 60 + 60 : Math.floor(start / 60) * 60 + 120
  const metricPart = alert.metrics.map((metric) => metric.name.trim()).filter(Boolean).join(' ')
  return `分析告警数据包 eventId=${eventId} start=${queryStart} end=${queryEnd}${metricPart ? ` ${metricPart}` : ''}`
}
const selectedAnalysisInstruction = computed(() => selectedAlert.value ? alertAnalysisInstruction(selectedAlert.value) : null)
function openAlertAnalysis() {
  const instruction = selectedAnalysisInstruction.value
  if (!instruction) { message.warning('该告警未记录 Event ID 或告警窗口，暂时无法生成分析指令'); return }
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
    message.error('无法写入对话草稿，请检查浏览器存储权限')
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
    const allowedPresets: TimePreset[] = ['lastHour', 'today', 'yesterday', 'last7days', 'last30days', 'thisMonth', 'custom']
    filters.value = {
      severity: typeof state.severity === 'string' ? state.severity : ALL_FILTER_VALUE,
      category: typeof state.category === 'string' ? state.category : ALL_FILTER_VALUE,
      keyword: typeof state.keyword === 'string' ? state.keyword.slice(0, 120) : '',
    }
    appliedRange.value = [startAt, endAt]
    timePreset.value = allowedPresets.includes(state.timePreset as TimePreset) ? state.timePreset as TimePreset : 'custom'
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
  return [exportHeaders.join('\t'), ...currentPageRows().map((row) => Object.values(row).map(asTsvCell).join('\t'))].join('\n')
}
async function copyCurrentPage() {
  if (!alerts.value.length) { message.warning('当前页没有可复制的告警记录'); return }
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
    message.success(`已复制当前页 ${alerts.value.length} 条记录`)
  } catch {
    message.error('复制失败，请检查浏览器剪贴板权限')
  }
}
async function exportCurrentPage() {
  if (!alerts.value.length) { message.warning('当前页没有可导出的告警记录'); return }
  exportLoading.value = true
  try {
    const response = await fetch('/api/alerts/export', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: currentPageRows() }),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      throw new Error(data?.error || '导出 Excel 失败')
    }
    const downloadUrl = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = `告警通知-当前页-${formatRangeTime(Date.now()).replace(/[ :]/g, '-')}.xlsx`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(downloadUrl)
    message.success(`已导出当前页 ${alerts.value.length} 条记录`)
  } catch (reason) {
    message.error(reason instanceof Error ? reason.message : '导出 Excel 失败')
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
    if (!contentType.includes('application/json')) throw new Error('Admin BFF 未返回告警接口数据')
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || '读取告警失败')
    alerts.value = Array.isArray(data.alerts) ? data.alerts : []
    categoryOptions.value = Array.isArray(data.categoryOptions) ? data.categoryOptions : []
    pagination.value = data.pagination || pagination.value
    page.value = pagination.value.page
  } catch (reason) {
    alerts.value = []; error.value = reason instanceof Error ? reason.message : '读取告警失败'; message.error(error.value)
  } finally { loading.value = false }
}

function applyFilters() { page.value = 1; loadAlerts() }
async function selectTimePreset(preset: TimePreset) {
  if (preset === 'custom') {
    customRange.value = [...appliedRange.value] as [number, number]
    customRangeVisible.value = true
    return
  }
  await refreshServerTime()
  timePreset.value = preset
  appliedRange.value = rangeForPreset(preset)
  customRangeVisible.value = false
  timePopoverVisible.value = false
  page.value = 1
  loadAlerts()
}
function confirmCustomRange() {
  if (!customRange.value) { message.warning('请选择自定义的开始和结束时间'); return }
  timePreset.value = 'custom'
  appliedRange.value = [...customRange.value] as [number, number]
  customRangeVisible.value = false
  timePopoverVisible.value = false
  page.value = 1
  loadAlerts()
}
function cancelTimeSelection() {
  customRange.value = null
  customRangeVisible.value = false
  timePopoverVisible.value = false
}
async function resetFilters() {
  filters.value = { severity: ALL_FILTER_VALUE, category: ALL_FILTER_VALUE, keyword: '' }
  await selectTimePreset('lastHour')
}
function applyPageSize() { if (activeResultLimit.value < pageSize.value) resultLimitChoice.value = String(pageSize.value); page.value = 1; loadAlerts() }
function applyResultLimit() { page.value = 1; loadAlerts() }
function changePage(next: number) { if (next < 1 || (next > page.value && !pagination.value.hasMore)) return; page.value = next; loadAlerts() }
onMounted(async () => {
  await refreshServerTime()
  const restored = restoreAlertListState()
  if (!restored) appliedRange.value = rangeForPreset('lastHour')
  if (route.query.restoreAlertState === '1') void router.replace({ name: 'AlertNotifications', query: {} })
  loadAlerts()
})
</script>

<template>
  <section class="alerts-page">
    <NCard title="告警通知" class="app-card">
      <template #header-extra>
        <NSpace class="time-toolbar" align="center" wrap :size="8">
          <NPopover v-model:show="timePopoverVisible" trigger="click" placement="bottom-end" :show-arrow="false" :style="{ padding: '0', borderRadius: customRangeVisible ? '0' : '8px', overflow: 'visible', '--n-border-radius': customRangeVisible ? '0px' : '8px' }">
            <template #trigger>
              <NButton class="time-trigger" size="small">
                <template #icon><CalendarOutline /></template>
                <span class="time-trigger-label">{{ timeRangeLabel }}</span>
                <ChevronDownOutline class="time-trigger-chevron" />
              </NButton>
            </template>
            <div class="time-picker-popover" :class="{ 'time-picker-popover--custom': customRangeVisible }">
              <NDatePicker v-if="customRangeVisible" v-model:value="customRange" type="datetimerange" panel clearable :actions="[]" :shortcuts="dateShortcuts" class="custom-range-panel" />
              <div class="time-preset-list">
                <button v-for="option in timeOptions" :key="option.value" type="button" class="time-preset-button" :class="{ active: option.value === timePreset || (option.value === 'custom' && customRangeVisible) }" @click="selectTimePreset(option.value)">{{ option.label }}</button>
                <div v-if="customRangeVisible" class="time-picker-actions">
                  <NButton size="small" type="primary" @click="confirmCustomRange">确认</NButton>
                  <NButton size="small" @click="cancelTimeSelection">取消</NButton>
                </div>
              </div>
            </div>
          </NPopover>
          <NButton size="small" :loading="loading" @click="loadAlerts"><template #icon><RefreshOutline /></template>刷新</NButton>
        </NSpace>
      </template>
      <NAlert v-if="pagination.limitReached" type="warning" :bordered="false" style="margin-top: 12px;">当前筛选结果超过 TOP {{ pagination.maxResults }}；可提高 TOP 值继续查看。</NAlert>
      <NAlert v-if="error" type="error" :bordered="false" style="margin-top: 12px;">{{ error }}</NAlert>

      <div class="filters">
        <div class="filter-main">
          <NSpace wrap :size="10">
            <NSelect v-model:value="filters.severity" :options="severityOptions" style="width: 160px" @update:value="applyFilters" />
            <NSelect v-model:value="filters.category" :options="allCategoryOptions" style="width: 180px" @update:value="applyFilters" />
            <NInput v-model:value="filters.keyword" clearable placeholder="搜索名称、来源 IP 或事件 ID" style="width: 260px" @keyup.enter="applyFilters" />
            <NButton type="primary" @click="applyFilters">筛选</NButton>
            <NButton @click="resetFilters">重置</NButton>
          </NSpace>
        </div>
        <NSpace class="display-controls" wrap :size="10">
          <NSelect v-model:value="pageSize" :options="pageSizeOptions" style="width: 120px" @update:value="applyPageSize" />
          <NSelect v-model:value="resultLimitChoice" :options="resultLimitOptions" style="width: 180px" @update:value="!isCustomLimit && applyResultLimit()" />
          <NInputNumber v-if="isCustomLimit" v-model:value="customResultLimit" :min="pageSize" :max="3000" :precision="0" placeholder="最高 3000 条" style="width: 150px" />
          <NButton v-if="isCustomLimit" type="primary" @click="applyResultLimit">应用条数</NButton>
          <NButton :disabled="!alerts.length" @click="copyCurrentPage"><template #icon><CopyOutline /></template>复制内容</NButton>
          <NButton :loading="exportLoading" :disabled="!alerts.length" @click="exportCurrentPage"><template #icon><DownloadOutline /></template>导出 Excel</NButton>
        </NSpace>
      </div>

      <NDataTable :columns="columns" :data="alerts" :loading="loading" :bordered="false" :single-line="false" :scroll-x="980" :pagination="false">
        <template #empty><NEmpty description="当前时间范围内暂无可展示的 Syslog 告警" /></template>
      </NDataTable>
      <NSpace justify="space-between" align="center" style="margin-top: 16px;">
        <NText depth="3">已在当前读取窗口中匹配 {{ pagination.availableCount }} 条，TOP {{ pagination.maxResults }}。</NText>
        <NSpace align="center">
          <NButton :disabled="page <= 1 || loading" @click="changePage(page - 1)">上一页</NButton>
          <NText>第 {{ page }} 页</NText>
          <NButton :disabled="!pagination.hasMore || loading" @click="changePage(page + 1)">下一页</NButton>
        </NSpace>
      </NSpace>
    </NCard>

    <NDrawer v-model:show="detailVisible" :width="560" placement="right">
      <NDrawerContent title="告警详情" closable>
        <template v-if="selectedAlert">
          <NDescriptions label-placement="left" :column="1" bordered>
            <NDescriptionsItem label="告警名称">{{ selectedAlert.name }}</NDescriptionsItem>
            <NDescriptionsItem label="严重级别"><NTag :type="severityType(selectedAlert.severity)" :bordered="false">{{ selectedAlert.severity }}</NTag></NDescriptionsItem>
            <NDescriptionsItem label="告警类型">{{ selectedAlert.categoryLabel || selectedAlert.category }}</NDescriptionsItem>
            <NDescriptionsItem label="告警时间">{{ formatTime(selectedAlert.occurredAt) }}</NDescriptionsItem>
            <NDescriptionsItem label="来源">{{ selectedAlert.sourceHost }}</NDescriptionsItem>
            <NDescriptionsItem label="规则 ID">{{ selectedAlert.ruleId }}</NDescriptionsItem>
            <NDescriptionsItem label="事件 ID">{{ selectedAlert.eventId || '未记录' }}</NDescriptionsItem>
            <NDescriptionsItem label="告警描述">{{ selectedAlert.description || '未记录' }}</NDescriptionsItem>
            <NDescriptionsItem label="分组">{{ selectedAlert.groupPath || '未记录' }}</NDescriptionsItem>
          </NDescriptions>
          <NText strong style="display: block; margin: 20px 0 10px;">触发指标</NText>
          <NDataTable :columns="metricColumns" :data="selectedAlert.metrics" :bordered="false"><template #empty><NEmpty description="未记录指标" /></template></NDataTable>
          <NText strong style="display: block; margin: 20px 0 8px;">触发条件</NText>
          <NText depth="3" class="trigger-condition">{{ selectedAlert.triggerCondition || '未记录' }}</NText>
          <div class="alert-analysis-card">
            <div>
              <NText strong>分析告警</NText>
              <code class="alert-analysis-card__instruction">{{ selectedAnalysisInstruction || '未记录：该告警缺少 Event ID 或告警窗口。' }}</code>
            </div>
            <NButton type="primary" size="small" :disabled="!selectedAnalysisInstruction" @click="openAlertAnalysis">告警数据包详细分析</NButton>
          </div>
        </template>
      </NDrawerContent>
    </NDrawer>
  </section>
</template>

<style scoped>
.alerts-page { display: grid; gap: 16px; }
.time-toolbar { justify-content: flex-end; }
.time-trigger { min-width: 270px; }
.time-trigger-label { flex: 1; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.time-trigger-chevron { width: 14px; height: 14px; margin-left: 5px; }
.time-picker-popover { display: flex; width: 172px; padding: 8px; gap: 10px; overflow: hidden; border-radius: 8px; }
.time-picker-popover--custom { position: relative; z-index: 1; box-sizing: border-box; width: min(calc(100vw - 32px), 756px); align-items: flex-start; padding-bottom: 0; column-gap: 18px; border-radius: 0; outline: 6px solid var(--card-color, #fff); background: var(--card-color, #fff); box-shadow: 0 10px 26px rgba(16, 47, 34, .14); }
.time-preset-list { display: grid; flex: 0 0 156px; gap: 6px; align-content: start; }
.time-preset-button { width: 100%; padding: 7px 10px; border: 0; border-radius: 4px; background: var(--hover-color, #f4f6f8); color: var(--text-color-1, #1f2937); cursor: pointer; font: inherit; line-height: 1.2; text-align: left; transition: background-color .15s, color .15s; }
.time-preset-button:hover, .time-preset-button.active { background: var(--primary-color, #18a058); color: #fff; }
.time-picker-actions { display: flex; gap: 8px; margin-top: 4px; }
.custom-range-panel { flex: 1 1 auto; min-width: 540px; margin-top: -10px; }
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
  .time-trigger { min-width: 220px; }
  .time-picker-popover--custom { display: block; width: min(100vw - 24px, 540px); overflow: auto; transform: none; }
  .custom-range-panel { min-width: 0; width: 100%; margin-top: 0; }
  .time-preset-list { margin-top: 10px; }
  .alert-analysis-card { align-items: stretch; flex-direction: column; }
}
</style>
