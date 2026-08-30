<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NDataTable, NEmpty, NIcon, NInputNumber, NModal, NSelect, NSpace, NTag, NText, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { ArchiveOutline, DownloadOutline, EyeOutline, RefreshOutline, ReturnUpBackOutline, ShieldCheckmarkOutline } from '@vicons/ionicons5'
import TimeRangePicker from '@/components/common/TimeRangePicker.vue'
import PdfViewer from '@/components/common/PdfViewer.vue'
import { useAuthStore } from '@/stores/auth'
import { useI18n } from 'vue-i18n'
import { rangeForPreset, type TimeRange, type TimeRangePreset } from '@/utils/time-range'
import { localizeApiError } from '@/utils/api-error'
import { platformBranding } from '@/branding/platform'

type ReportStatus = 'ready' | 'missing' | 'failed'

type ReportFile = {
  id: string
  name: string
  reportType: string
  sourceUserId?: string | null
  sourceSessionId?: string | null
  sourceSessionTitle?: string | null
  sourceChannel?: string | null
  sourceChannelUserId?: string | null
  sourceChannelUserName?: string | null
  sourceMessageId?: string | null
  sourceMessagePreview?: string | null
  dataSourceId?: string | null
  dataSourceName?: string | null
  mimeType: string
  size: number
  status: ReportStatus
  longTermKeep: boolean
  retentionState: string
  createdAt: number
}

type RecoveryReport = {
  id: string
  name: string
  reportType: string
  retentionState: string
  quarantinedAt?: number | null
  recoverableUntil?: number | null
  errorCode?: string | null
}

const authStore = useAuthStore()
const { locale } = useI18n()
const message = useMessage()
const dialog = useDialog()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const loading = ref(false)
const reports = ref<ReportFile[]>([])
const recoveryReports = ref<RecoveryReport[]>([])
const recoveryVisible = ref(false)
const recoveryLoading = ref(false)
const previewVisible = ref(false)
const previewing = ref(false)
const previewReport = ref<ReportFile | null>(null)
const previewUrl = ref('')
const previewText = ref('')
const serverNow = ref(Date.now())
const reportTypeFilter = ref('all')
const timePreset = ref<TimeRangePreset>('last30days')
const appliedRange = ref<TimeRange>(rangeForPreset('last30days', serverNow.value))
const pageSize = ref(10)
const resultLimitChoice = ref('200')
const customResultLimit = ref<number | null>(null)
const page = ref(1)
let refreshTimer: ReturnType<typeof setInterval> | null = null

const isAdmin = computed(() => authStore.isAdmin)
const isCustomLimit = computed(() => resultLimitChoice.value === 'custom')
const activeResultLimit = computed(() => {
  const requested = isCustomLimit.value ? Number(customResultLimit.value) || 200 : Number(resultLimitChoice.value)
  return Math.min(Math.max(requested, pageSize.value), 3000)
})
const statusMap = computed<Record<ReportStatus, { label: string; type: 'success' | 'warning' | 'error' }>>(() => ({
  ready: { label: text('可用', 'Available'), type: 'success' },
  missing: { label: text('文件缺失', 'File missing'), type: 'warning' },
  failed: { label: text('生成失败', 'Generation failed'), type: 'error' },
}))
const reportTypeMap = computed<Record<string, string>>(() => ({
  quick_report: text('快速报告', 'Quick report'),
  diagnostic_report: text('故障分析报告', 'Fault analysis report'),
  comparative_report: text('对比报告', 'Comparison report'),
  operation_report: text('运维报告', 'Operations report'),
  inspection_report: text('巡检报告', 'Inspection report'),
  summary_report: text('综述报告', 'Summary report'),
  analysis: text('分析报告', 'Analysis report'),
  diagnostic: text('诊断报告', 'Diagnostic report'),
  summary: text('汇总报告', 'Summary report'),
  scheduled: text('定时报表', 'Scheduled report'),
}))
const channelLabelMap = computed<Record<string, string>>(() => ({
  web: 'webchat',
  historical_import: text('历史归档', 'Historical archive'),
  feishu: text('飞书', 'Feishu'),
  lark: text('飞书', 'Feishu'),
  'openclaw-lark': text('飞书', 'Feishu'),
  dingtalk: text('钉钉', 'DingTalk'),
  'dingtalk-connector': text('钉钉', 'DingTalk'),
  wecom: text('企业微信', 'WeCom'),
  'wecom-openclaw-plugin': text('企业微信', 'WeCom'),
  'openclaw-weixin': text('个人微信', 'Personal WeChat'),
  weixin: text('个人微信', 'Personal WeChat'),
}))
const supportedReportTypes = computed(() => [
  { label: reportTypeMap.value.quick_report, value: 'quick_report' },
  { label: reportTypeMap.value.diagnostic_report, value: 'diagnostic_report' },
  { label: reportTypeMap.value.comparative_report, value: 'comparative_report' },
  { label: reportTypeMap.value.operation_report, value: 'operation_report' },
  { label: reportTypeMap.value.inspection_report, value: 'inspection_report' },
  { label: reportTypeMap.value.summary_report, value: 'summary_report' },
])
const pageSizeOptions = computed(() => [10, 20, 50, 100].map((value) => ({ label: text(`${value} 条/页`, `${value} per page`), value })))
const resultLimitOptions = computed(() => [50, 100, 200, 500, 1000].map((value) => ({ label: `TOP ${value}`, value: String(value) })).concat([{ label: text('自定义 TOP', 'Custom TOP'), value: 'custom' }]))
const reportTypeOptions = computed(() => {
  const supported = new Set(supportedReportTypes.value.map((type) => type.value))
  const historicalTypes = [...new Set(reports.value.map((report) => report.reportType).filter((type) => type && !supported.has(type)))]
  return [
    { label: text('全部报告类型', 'All report types'), value: 'all' },
    ...supportedReportTypes.value,
    ...historicalTypes.map((type) => ({ label: `${reportTypeMap.value[type] || type}${text('（历史类型）', ' (historical type)')}`, value: type })),
  ]
})

function headers() {
  return { Authorization: `Bearer ${authStore.getToken()}` }
}

async function readJsonResponse(response: Response, fallbackMessage: string) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  if (!contentType.includes('application/json')) {
    const status = response.status ? text(`（HTTP ${response.status}）`, ` (HTTP ${response.status})`) : ''
    throw new Error(text(`${fallbackMessage}${status}：服务返回了非预期响应，请刷新页面；若仍持续，请联系管理员查看 BFF 日志。`, `${fallbackMessage}${status}: the service returned an unexpected response. Refresh the page and contact an administrator to review BFF logs if it persists.`))
  }
  return response.json()
}

function pad(value: number) { return String(value).padStart(2, '0') }
function formatRangeTime(value: number) {
  const date = new Date(value)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
function formatTime(timestamp?: number) {
  return timestamp ? `${formatRangeTime(timestamp)}:${pad(new Date(timestamp).getSeconds())}` : '—'
}
function formatSize(size?: number) {
  const bytes = Number(size || 0)
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}
function formatChannel(channel?: string | null) {
  const value = String(channel || '').trim().toLowerCase()
  return channelLabelMap.value[value] || channel || text('未记录', 'Not recorded')
}
function formatSourceUser(report: ReportFile) {
  const user = report.sourceChannelUserName || report.sourceChannelUserId || report.sourceUserId
  if (!user) return text('未记录', 'Not recorded')
  if (String(report.sourceChannel || '').trim().toLowerCase() === 'feishu' && /^ou_[a-z0-9_-]+$/i.test(user)) {
    return text(`飞书用户（${user}）`, `Feishu user (${user})`)
  }
  return user
}
function formatSourceSession(report: ReportFile) {
  const savedTitle = String(report.sourceSessionTitle || '').trim()
  if (savedTitle) return savedTitle
  if (String(report.sourceChannel || '').trim().toLowerCase() === 'historical_import') return text('历史报告（原会话未保留）', 'Historical report (original session not retained)')
  if (String(report.sourceChannel || '').trim().toLowerCase() === 'web') return text('历史 webchat 会话', 'Historical webchat session')
  return report.sourceSessionId ? text(`${formatChannel(report.sourceChannel)} 会话`, `${formatChannel(report.sourceChannel)} session`) : text('未记录', 'Not recorded')
}
const filteredReports = computed(() => reports.value
  .filter((report) => reportTypeFilter.value === 'all' || report.reportType === reportTypeFilter.value)
  .filter((report) => Number(report.createdAt) >= appliedRange.value[0] && Number(report.createdAt) <= appliedRange.value[1])
  .sort((left, right) => Number(right.createdAt) - Number(left.createdAt)))
const reportsWithinLimit = computed(() => filteredReports.value.slice(0, activeResultLimit.value))
const pageCount = computed(() => Math.max(1, Math.ceil(reportsWithinLimit.value.length / pageSize.value)))
const pagedReports = computed(() => {
  const safePage = Math.min(page.value, pageCount.value)
  const start = (safePage - 1) * pageSize.value
  return reportsWithinLimit.value.slice(start, start + pageSize.value)
})
const hasMore = computed(() => page.value < pageCount.value)

async function refresh(showMessage = true, background = false) {
  if (!background) loading.value = true
  try {
    const response = await fetch('/api/reports', { headers: headers() })
    const data = await readJsonResponse(response, text('获取报告列表失败', 'Failed to load reports'))
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('获取报告列表失败', 'Failed to load reports')))
    const responseTime = Date.parse(response.headers.get('date') || '')
    if (Number.isFinite(responseTime)) serverNow.value = responseTime
    reports.value = data.reports || []
    if (!background) page.value = 1
    if (showMessage) message.success(text('报告列表已刷新', 'Report list refreshed'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('获取报告列表失败', 'Failed to load reports'))
  } finally {
    if (!background) loading.value = false
  }
}

async function download(report: ReportFile) {
  try {
    const response = await fetch(`/api/reports/${report.id}/download`, { headers: headers() })
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      throw new Error(data?.error || text('报告下载失败', 'Failed to download report'))
    }
    const objectUrl = URL.createObjectURL(await response.blob())
    const link = document.createElement('a')
    link.href = objectUrl
    link.download = report.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(objectUrl)
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('报告下载失败', 'Failed to download report'))
  }
}

function releasePreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  previewText.value = ''
  previewReport.value = null
}

function isPdfReport(report: ReportFile) {
  return report.mimeType === 'application/pdf' || report.name.toLowerCase().endsWith('.pdf')
}

function isPreviewable(report: ReportFile) {
  return isPdfReport(report) || /\.(txt|md|json|csv|log)$/i.test(report.name)
}

async function preview(report: ReportFile) {
  releasePreview()
  previewReport.value = report
  previewVisible.value = true
  previewing.value = true
  try {
    const response = await fetch(`/api/reports/${encodeURIComponent(report.id)}/preview`, { headers: headers() })
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      throw new Error(localizeApiError(data, text('报告预览失败', 'Failed to preview report')))
    }
    const blob = await response.blob()
    if (isPdfReport(report)) previewUrl.value = URL.createObjectURL(blob)
    else previewText.value = await blob.text()
  } catch (error) {
    previewVisible.value = false
    releasePreview()
    message.error(error instanceof Error ? error.message : text('报告预览失败', 'Failed to preview report'))
  } finally {
    previewing.value = false
  }
}

async function updateLongTermKeep(report: ReportFile) {
  try {
    const response = await fetch(`/api/reports/${report.id}/retention`, {
      method: 'PATCH',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ longTermKeep: !report.longTermKeep }),
    })
    const data = await readJsonResponse(response, text('更新长期保留标记失败', 'Failed to update long-term retention'))
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('更新长期保留标记失败', 'Failed to update long-term retention')))
    report.longTermKeep = Boolean(data.longTermKeep)
    message.success(report.longTermKeep ? text('已设为长期保留', 'Marked for long-term retention') : text('已取消长期保留', 'Long-term retention removed'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('更新长期保留标记失败', 'Failed to update long-term retention'))
  }
}

async function openRecovery() {
  recoveryVisible.value = true
  recoveryLoading.value = true
  try {
    const response = await fetch('/api/reports/retention/recovery', { headers: headers() })
    const data = await readJsonResponse(response, text('获取报告恢复区失败', 'Failed to load report recovery area'))
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('获取报告恢复区失败', 'Failed to load report recovery area')))
    recoveryReports.value = data.reports || []
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('获取报告恢复区失败', 'Failed to load report recovery area'))
  } finally {
    recoveryLoading.value = false
  }
}

async function restoreReport(report: RecoveryReport) {
  try {
    const response = await fetch(`/api/reports/${report.id}/restore`, { method: 'POST', headers: headers() })
    const data = await readJsonResponse(response, text('恢复报告失败', 'Failed to restore report'))
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('恢复报告失败', 'Failed to restore report')))
    message.success(text('报告及配对记录已整体恢复', 'The report and paired records were restored'))
    await Promise.all([openRecovery(), refresh(false)])
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('恢复报告失败', 'Failed to restore report'))
  }
}

function remove(report: ReportFile) {
  dialog.warning({
    title: text('移入7天恢复区', 'Move to 7-day recovery'),
    content: text(`仅当数据库时间和文件时间都已超过365天时，才会将“${report.name}”及配对记录整体移入恢复区。`, `“${report.name}” and its paired records will move together only when both database and file times exceed 365 days.`),
    positiveText: text('移入恢复区', 'Move to recovery'),
    negativeText: text('取消', 'Cancel'),
    onPositiveClick: async () => {
      try {
        const response = await fetch(`/api/reports/${report.id}`, { method: 'DELETE', headers: headers() })
        const data = await response.json()
        if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('报告移入恢复区失败', 'Failed to move report to recovery')))
        message.success(text('报告已移入7天恢复区', 'Report moved to 7-day recovery'))
        await refresh(false)
      } catch (error) {
        message.error(error instanceof Error ? error.message : text('报告移入恢复区失败', 'Failed to move report to recovery'))
      }
    },
  })
}

function applyFilters() { page.value = 1 }
function applyPageSize() {
  if (activeResultLimit.value < pageSize.value) resultLimitChoice.value = String(pageSize.value)
  page.value = 1
}
function applyResultLimit() { page.value = 1 }
function changePage(next: number) {
  if (next < 1 || next > pageCount.value) return
  page.value = next
}
function applyTimeRange(range: TimeRange, preset: TimeRangePreset) {
  timePreset.value = preset
  appliedRange.value = range
  page.value = 1
}
function resetFilters() {
  reportTypeFilter.value = 'all'
  serverNow.value = Date.now()
  timePreset.value = 'last30days'
  appliedRange.value = rangeForPreset('last30days', serverNow.value)
  page.value = 1
}

const columns = computed<DataTableColumns<ReportFile>>(() => [
  { title: text('报告名称', 'Report name'), key: 'name', minWidth: 260, ellipsis: { tooltip: true } },
  { title: text('类型', 'Type'), key: 'reportType', width: 170, render: row => reportTypeMap.value[row.reportType] || row.reportType },
  { title: text('生成时间', 'Generated at'), key: 'createdAt', width: 180, render: row => formatTime(row.createdAt) },
  { title: text('来源渠道', 'Source channel'), key: 'sourceChannel', width: 130, render: row => formatChannel(row.sourceChannel) },
  { title: text('来源用户', 'Source user'), key: 'sourceChannelUserName', minWidth: 150, ellipsis: { tooltip: true }, render: row => formatSourceUser(row) },
  { title: text('来源会话', 'Source session'), key: 'sourceSessionTitle', minWidth: 190, ellipsis: { tooltip: true }, render: row => formatSourceSession(row) },
  { title: text('来源数据源', 'Source data source'), key: 'dataSourceName', minWidth: 180, ellipsis: { tooltip: true }, render: row => row.dataSourceName || row.dataSourceId || text('未记录', 'Not recorded') },
  { title: text('文件大小', 'File size'), key: 'size', width: 110, render: row => formatSize(row.size) },
  { title: text('状态', 'Status'), key: 'status', width: 110, render: row => h(NTag, { type: statusMap.value[row.status]?.type || 'default', bordered: false }, { default: () => statusMap.value[row.status]?.label || row.status }) },
  { title: text('留存', 'Retention'), key: 'longTermKeep', width: 110, render: row => h(NTag, { type: row.longTermKeep ? 'warning' : 'default', bordered: false }, { default: () => row.longTermKeep ? text('长期保留', 'Long-term') : text('365天', '365 days') }) },
  {
    title: text('操作', 'Actions'),
    key: 'actions',
    width: 360,
    minWidth: 360,
    fixed: 'right',
    render: row => {
      const actions = [
        h(NButton, { size: 'small', secondary: true, disabled: row.status !== 'ready' || !isPreviewable(row), onClick: () => preview(row) }, { icon: () => h(NIcon, null, { default: () => h(EyeOutline) }), default: () => text('预览', 'Preview') }),
        h(NButton, { size: 'small', type: 'primary', secondary: true, disabled: row.status !== 'ready', onClick: () => download(row) }, { icon: () => h(NIcon, null, { default: () => h(DownloadOutline) }), default: () => text('下载', 'Download') }),
      ]
      if (isAdmin.value) {
        actions.push(h(NButton, { size: 'small', type: row.longTermKeep ? 'warning' : 'default', secondary: true, onClick: () => updateLongTermKeep(row) }, { icon: () => h(NIcon, null, { default: () => h(ShieldCheckmarkOutline) }), default: () => row.longTermKeep ? text('取消长期', 'Unpin') : text('长期保留', 'Keep') }))
        actions.push(h(NButton, { size: 'small', type: 'warning', ghost: true, disabled: row.longTermKeep || Number(row.createdAt) >= serverNow.value - 365 * 24 * 60 * 60 * 1000, onClick: () => remove(row) }, { icon: () => h(NIcon, null, { default: () => h(ArchiveOutline) }), default: () => text('恢复区', 'Recoverable') }))
      }
      return h('div', { style: { display: 'flex', flexWrap: 'nowrap', gap: '10px', whiteSpace: 'nowrap' } }, actions)
    },
  },
])

const recoveryColumns = computed<DataTableColumns<RecoveryReport>>(() => [
  { title: text('报告名称', 'Report name'), key: 'name', minWidth: 260, ellipsis: { tooltip: true } },
  { title: text('移入时间', 'Moved at'), key: 'quarantinedAt', width: 180, render: row => formatTime(row.quarantinedAt || undefined) },
  { title: text('可恢复截止', 'Recoverable until'), key: 'recoverableUntil', width: 180, render: row => formatTime(row.recoverableUntil || undefined) },
  { title: text('状态', 'State'), key: 'retentionState', width: 150, render: row => row.errorCode ? `${row.retentionState} (${row.errorCode})` : row.retentionState },
  { title: text('操作', 'Actions'), key: 'actions', width: 120, render: row => h(NButton, { size: 'small', type: 'primary', secondary: true, onClick: () => restoreReport(row) }, { icon: () => h(NIcon, null, { default: () => h(ReturnUpBackOutline) }), default: () => text('恢复', 'Restore') }) },
])

onMounted(() => {
  void refresh(false)
  refreshTimer = setInterval(() => { void refresh(false, true) }, 5000)
})
onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
  releasePreview()
})
</script>

<template>
  <section class="report-page">
    <NAlert type="info" :bordered="false" class="report-note">
      {{ text(`报告仅由会话中的 ${platformBranding.productCode} AI 自动生成，不支持手动上传或编辑。正式报告在线保存365天；到期后仅能整体移入7天恢复区，长期保留报告不参加自动处理。历史审计未记录来源用户、会话或数据源时统一显示“未记录”。`, `Reports are generated automatically by ${platformBranding.productCode} AI in sessions and cannot be uploaded or edited manually. Formal reports remain online for 365 days, then can only move as a group into a 7-day recovery area. Long-term reports are excluded from automatic processing.`) }}
    </NAlert>
    <NCard :title="text('报告文件管理', 'Report Management')" :bordered="false" class="report-card">
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
          <NButton v-if="isAdmin" size="small" secondary @click="openRecovery"><template #icon><ArchiveOutline /></template>{{ text('报告恢复区', 'Report recovery') }}</NButton>
          <NButton size="small" :loading="loading" @click="refresh()"><template #icon><RefreshOutline /></template>{{ text('刷新', 'Refresh') }}</NButton>
        </NSpace>
      </template>

      <div class="filters">
        <NSpace wrap :size="10">
          <NSelect v-model:value="reportTypeFilter" :options="reportTypeOptions" style="width: 180px" @update:value="applyFilters" />
          <NButton type="primary" :disabled="loading" @click="applyFilters">{{ text('筛选', 'Filter') }}</NButton>
          <NButton secondary :disabled="loading" @click="resetFilters">{{ text('重置', 'Reset') }}</NButton>
        </NSpace>
        <NSpace class="display-controls" wrap :size="10">
          <NSelect v-model:value="pageSize" :options="pageSizeOptions" style="width: 120px" @update:value="applyPageSize" />
          <NSelect v-model:value="resultLimitChoice" :options="resultLimitOptions" style="width: 180px" @update:value="!isCustomLimit && applyResultLimit()" />
          <NInputNumber v-if="isCustomLimit" v-model:value="customResultLimit" :min="pageSize" :max="3000" :precision="0" :placeholder="text('最高 3000 条', 'Up to 3000')" style="width: 150px" />
          <NButton v-if="isCustomLimit" type="primary" @click="applyResultLimit">{{ text('应用条数', 'Apply limit') }}</NButton>
        </NSpace>
      </div>

      <NDataTable :columns="columns" :data="pagedReports" :loading="loading" :bordered="false" :single-line="false" :scroll-x="1420" :pagination="false">
        <template #empty><NEmpty :description="text('当前筛选条件下暂无报告文件', 'No report files match the current filters')" /></template>
      </NDataTable>
      <NSpace justify="space-between" align="center" style="margin-top: 16px;">
        <NText depth="3">{{ text(`当前筛选 ${filteredReports.length} 条，TOP ${activeResultLimit}。`, `${filteredReports.length} matching reports, TOP ${activeResultLimit}.`) }}</NText>
        <NSpace align="center">
          <NButton :disabled="page <= 1 || loading" @click="changePage(page - 1)">{{ text('上一页', 'Previous') }}</NButton>
          <NText>{{ text(`第 ${Math.min(page, pageCount)} / ${pageCount} 页`, `Page ${Math.min(page, pageCount)} / ${pageCount}`) }}</NText>
          <NButton :disabled="!hasMore || loading" @click="changePage(page + 1)">{{ text('下一页', 'Next') }}</NButton>
        </NSpace>
      </NSpace>
    </NCard>
    <NModal v-model:show="recoveryVisible" preset="card" :title="text('报告7天恢复区', '7-day Report Recovery')" style="width: min(960px, 92vw)">
      <NAlert type="warning" :bordered="false" style="margin-bottom: 12px">
        {{ text('这里只显示已从正常报告列表隐藏的报告。恢复会把正式文件、审计JSON和交付事件整体放回原登记位置。', 'Only reports hidden from the normal list appear here. Restore returns the formal file, audit JSON, and delivery events to their registered locations as one group.') }}
      </NAlert>
      <NDataTable :columns="recoveryColumns" :data="recoveryReports" :loading="recoveryLoading" :bordered="false" :single-line="false" :scroll-x="890">
        <template #empty><NEmpty :description="text('恢复区暂无报告', 'No reports in recovery')" /></template>
      </NDataTable>
    </NModal>
    <NModal v-model:show="previewVisible" preset="card" :title="previewReport ? `${text('预览报告', 'Preview report')}：${previewReport.name}` : text('预览报告', 'Preview report')" style="width: min(1100px, 96vw)" @after-leave="releasePreview">
      <NText v-if="previewing" depth="3">{{ text('正在加载报告预览…', 'Loading report preview…') }}</NText>
      <PdfViewer v-else-if="previewUrl" :url="previewUrl" />
      <pre v-else class="report-text-preview">{{ previewText }}</pre>
    </NModal>
  </section>
</template>

<style scoped>
.report-page { display: grid; gap: 16px; }
.report-note { line-height: 1.65; }
.report-card { min-height: 420px; }
.report-text-preview { max-height: 70vh; margin: 0; overflow: auto; padding: 14px; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 8px; background: var(--code-color, var(--body-color)); }
.time-toolbar { justify-content: flex-end; }
.filters { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0 14px; }
.display-controls { justify-content: flex-end; }
@media (max-width: 900px) {
  .filters { align-items: flex-start; flex-direction: column; }
  .display-controls { justify-content: flex-start; }
}
@media (max-width: 720px) {
  .time-toolbar { max-width: 100%; }
}
</style>
