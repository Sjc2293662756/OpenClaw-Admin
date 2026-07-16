<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { NAlert, NButton, NCard, NDataTable, NDatePicker, NEmpty, NIcon, NInputNumber, NPopover, NSelect, NSpace, NTag, NText, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { CalendarOutline, ChevronDownOutline, DownloadOutline, RefreshOutline, TrashOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'

type ReportStatus = 'ready' | 'missing' | 'failed'
type TimePreset = 'lastHour' | 'today' | 'yesterday' | 'last7days' | 'last30days' | 'thisMonth' | 'custom'

type ReportFile = {
  id: string
  name: string
  reportType: string
  sourceUserId?: string | null
  sourceSessionId?: string | null
  dataSourceId?: string | null
  mimeType: string
  size: number
  status: ReportStatus
  createdAt: number
}

const authStore = useAuthStore()
const message = useMessage()
const dialog = useDialog()
const loading = ref(false)
const reports = ref<ReportFile[]>([])
const serverNow = ref(Date.now())
const reportTypeFilter = ref('all')
const timePreset = ref<TimePreset>('last30days')
const appliedRange = ref<[number, number]>([serverNow.value - 30 * 24 * 60 * 60 * 1000, serverNow.value])
const customRange = ref<[number, number] | null>(null)
const timePopoverVisible = ref(false)
const customRangeVisible = ref(false)
const pageSize = ref(10)
const resultLimitChoice = ref('200')
const customResultLimit = ref<number | null>(null)
const page = ref(1)

const isAdmin = computed(() => authStore.isAdmin)
const isCustomLimit = computed(() => resultLimitChoice.value === 'custom')
const activeResultLimit = computed(() => {
  const requested = isCustomLimit.value ? Number(customResultLimit.value) || 200 : Number(resultLimitChoice.value)
  return Math.min(Math.max(requested, pageSize.value), 3000)
})
const statusMap: Record<ReportStatus, { label: string; type: 'success' | 'warning' | 'error' }> = {
  ready: { label: '可用', type: 'success' },
  missing: { label: '文件缺失', type: 'warning' },
  failed: { label: '生成失败', type: 'error' },
}
const reportTypeMap: Record<string, string> = {
  quick_report: '快速报告',
  diagnostic_report: '故障分析报告',
  comparative_report: '对比报告',
  operation_report: '运维报告',
  inspection_report: '巡检报告',
  summary_report: '综述报告',
  analysis: '分析报告',
  diagnostic: '诊断报告',
  summary: '汇总报告',
  scheduled: '定时报表',
}
const supportedReportTypes = [
  { label: '快速报告', value: 'quick_report' },
  { label: '故障分析报告', value: 'diagnostic_report' },
  { label: '对比报告', value: 'comparative_report' },
  { label: '运维报告', value: 'operation_report' },
  { label: '巡检报告', value: 'inspection_report' },
  { label: '综述报告', value: 'summary_report' },
]
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
const reportTypeOptions = computed(() => {
  const supported = new Set(supportedReportTypes.map((type) => type.value))
  const historicalTypes = [...new Set(reports.value.map((report) => report.reportType).filter((type) => type && !supported.has(type)))]
  return [
    { label: '全部报告类型', value: 'all' },
    ...supportedReportTypes,
    ...historicalTypes.map((type) => ({ label: `${reportTypeMap[type] || type}（历史类型）`, value: type })),
  ]
})

function headers() {
  return { Authorization: `Bearer ${authStore.getToken()}` }
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

const timeRangeLabel = computed(() => `${formatRangeTime(appliedRange.value[0])} - ${formatRangeTime(appliedRange.value[1])}`)
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

async function refresh(showMessage = true) {
  loading.value = true
  try {
    const response = await fetch('/api/reports', { headers: headers() })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || '获取报告列表失败')
    const responseTime = Date.parse(response.headers.get('date') || '')
    if (Number.isFinite(responseTime)) serverNow.value = responseTime
    reports.value = data.reports || []
    page.value = 1
    if (showMessage) message.success('报告列表已刷新')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '获取报告列表失败')
  } finally {
    loading.value = false
  }
}

async function download(report: ReportFile) {
  try {
    const response = await fetch(`/api/reports/${report.id}/download`, { headers: headers() })
    if (!response.ok) {
      const data = await response.json().catch(() => null)
      throw new Error(data?.error || '报告下载失败')
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
    message.error(error instanceof Error ? error.message : '报告下载失败')
  }
}

function remove(report: ReportFile) {
  dialog.error({
    title: '删除报告文件',
    content: `确定删除“${report.name}”吗？此操作不可恢复。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const response = await fetch(`/api/reports/${report.id}`, { method: 'DELETE', headers: headers() })
        const data = await response.json()
        if (!response.ok || !data.ok) throw new Error(data.error || '报告删除失败')
        message.success('报告文件已删除')
        await refresh(false)
      } catch (error) {
        message.error(error instanceof Error ? error.message : '报告删除失败')
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
async function selectTimePreset(preset: TimePreset) {
  if (preset === 'custom') {
    customRange.value = [...appliedRange.value] as [number, number]
    customRangeVisible.value = true
    return
  }
  serverNow.value = Date.now()
  timePreset.value = preset
  appliedRange.value = rangeForPreset(preset)
  customRangeVisible.value = false
  timePopoverVisible.value = false
  page.value = 1
}
function confirmCustomRange() {
  if (!customRange.value) { message.warning('请选择自定义的开始和结束时间'); return }
  timePreset.value = 'custom'
  appliedRange.value = [...customRange.value] as [number, number]
  customRangeVisible.value = false
  timePopoverVisible.value = false
  page.value = 1
}
function cancelTimeSelection() {
  customRange.value = null
  customRangeVisible.value = false
  timePopoverVisible.value = false
}
function resetFilters() {
  reportTypeFilter.value = 'all'
  serverNow.value = Date.now()
  timePreset.value = 'last30days'
  appliedRange.value = rangeForPreset('last30days')
  customRange.value = null
  page.value = 1
}

const columns: DataTableColumns<ReportFile> = [
  { title: '报告名称', key: 'name', minWidth: 260, ellipsis: { tooltip: true } },
  { title: '类型', key: 'reportType', width: 140, render: row => reportTypeMap[row.reportType] || row.reportType },
  { title: '生成时间', key: 'createdAt', width: 180, render: row => formatTime(row.createdAt) },
  { title: '来源用户', key: 'sourceUserId', minWidth: 140, ellipsis: { tooltip: true }, render: row => row.sourceUserId || '未记录' },
  { title: '来源会话', key: 'sourceSessionId', minWidth: 170, ellipsis: { tooltip: true }, render: row => row.sourceSessionId || '未记录' },
  { title: '来源数据源', key: 'dataSourceId', minWidth: 150, ellipsis: { tooltip: true }, render: row => row.dataSourceId || '未记录' },
  { title: '文件大小', key: 'size', width: 110, render: row => formatSize(row.size) },
  { title: '状态', key: 'status', width: 100, render: row => h(NTag, { type: statusMap[row.status]?.type || 'default', bordered: false }, { default: () => statusMap[row.status]?.label || row.status }) },
  {
    title: '操作', key: 'actions', width: 180, minWidth: 180, fixed: 'right', render: row => h('div', { style: { display: 'flex', flexWrap: 'nowrap', gap: '10px', whiteSpace: 'nowrap' } }, [
      h(NButton, { size: 'small', type: 'primary', secondary: true, disabled: row.status !== 'ready', onClick: () => download(row) }, { icon: () => h(NIcon, null, { default: () => h(DownloadOutline) }), default: () => '下载' }),
      h(NButton, { size: 'small', type: 'error', ghost: true, disabled: !isAdmin.value, onClick: () => remove(row) }, { icon: () => h(NIcon, null, { default: () => h(TrashOutline) }), default: () => '删除' }),
    ]),
  },
]

onMounted(() => { void refresh(false) })
</script>

<template>
  <section class="report-page">
    <NAlert type="info" :bordered="false" class="report-note">
      报告仅由会话中的 GAIOP AI 自动生成，不支持手动上传或编辑。当前已导入的 OpenClaw 历史报告为本地过渡副本；管理员删除时只删除本地副本，不影响原始报告。历史审计未记录来源用户、会话或数据源时统一显示“未记录”。
    </NAlert>
    <NCard title="报告文件管理" :bordered="false" class="report-card">
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
          <NButton size="small" :loading="loading" @click="refresh()"><template #icon><RefreshOutline /></template>刷新</NButton>
        </NSpace>
      </template>

      <div class="filters">
        <NSpace wrap :size="10">
          <NSelect v-model:value="reportTypeFilter" :options="reportTypeOptions" style="width: 180px" @update:value="applyFilters" />
          <NButton type="primary" :disabled="loading" @click="applyFilters">筛选</NButton>
          <NButton secondary :disabled="loading" @click="resetFilters">重置</NButton>
        </NSpace>
        <NSpace class="display-controls" wrap :size="10">
          <NSelect v-model:value="pageSize" :options="pageSizeOptions" style="width: 120px" @update:value="applyPageSize" />
          <NSelect v-model:value="resultLimitChoice" :options="resultLimitOptions" style="width: 180px" @update:value="!isCustomLimit && applyResultLimit()" />
          <NInputNumber v-if="isCustomLimit" v-model:value="customResultLimit" :min="pageSize" :max="3000" :precision="0" placeholder="最高 3000 条" style="width: 150px" />
          <NButton v-if="isCustomLimit" type="primary" @click="applyResultLimit">应用条数</NButton>
        </NSpace>
      </div>

      <NDataTable :columns="columns" :data="pagedReports" :loading="loading" :bordered="false" :single-line="false" :scroll-x="1420" :pagination="false">
        <template #empty><NEmpty description="当前筛选条件下暂无报告文件" /></template>
      </NDataTable>
      <NSpace justify="space-between" align="center" style="margin-top: 16px;">
        <NText depth="3">当前筛选 {{ filteredReports.length }} 条，TOP {{ activeResultLimit }}。</NText>
        <NSpace align="center">
          <NButton :disabled="page <= 1 || loading" @click="changePage(page - 1)">上一页</NButton>
          <NText>第 {{ Math.min(page, pageCount) }} / {{ pageCount }} 页</NText>
          <NButton :disabled="!hasMore || loading" @click="changePage(page + 1)">下一页</NButton>
        </NSpace>
      </NSpace>
    </NCard>
  </section>
</template>

<style scoped>
.report-page { display: grid; gap: 16px; }
.report-note { line-height: 1.65; }
.report-card { min-height: 420px; }
.time-toolbar { justify-content: flex-end; }
.time-trigger { display: inline-flex; width: 292px; max-width: min(292px, calc(100vw - 112px)); }
.time-trigger-label { flex: 1; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
.time-trigger-chevron { width: 14px; height: 14px; margin-left: 5px; }
.time-picker-popover { display: flex; width: 172px; padding: 8px; gap: 10px; overflow: hidden; border-radius: 8px; }
.time-picker-popover--custom { position: relative; z-index: 1; box-sizing: border-box; width: min(calc(100vw - 32px), 756px); align-items: flex-start; padding-bottom: 0; column-gap: 18px; border-radius: 0; outline: 6px solid var(--card-color, #fff); background: var(--card-color, #fff); box-shadow: 0 10px 26px rgba(16, 47, 34, .14); }
.time-preset-list { display: grid; flex: 0 0 156px; gap: 6px; align-content: start; }
.time-preset-button { width: 100%; padding: 7px 10px; border: 0; border-radius: 4px; background: var(--hover-color, #f4f6f8); color: var(--text-color-1, #1f2937); cursor: pointer; font: inherit; line-height: 1.2; text-align: left; transition: background-color .15s, color .15s; }
.time-preset-button:hover, .time-preset-button.active { background: var(--primary-color, #18a058); color: #fff; }
.time-picker-actions { display: flex; gap: 8px; margin-top: 4px; }
.custom-range-panel { flex: 1 1 auto; min-width: 540px; margin-top: -10px; }
.filters { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 0 14px; }
.display-controls { justify-content: flex-end; }
@media (max-width: 900px) {
  .filters { align-items: flex-start; flex-direction: column; }
  .display-controls { justify-content: flex-start; }
}
@media (max-width: 720px) {
  .time-trigger { min-width: 220px; }
  .time-picker-popover--custom { display: block; width: min(100vw - 24px, 540px); overflow: auto; transform: none; }
  .custom-range-panel { min-width: 0; width: 100%; margin-top: 0; }
  .time-preset-list { margin-top: 10px; }
}
</style>
