<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NDataTable, NDropdown, NEmpty, NIcon, NSpace, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { AddOutline, CreateOutline, EllipsisHorizontalOutline, PlayCircleOutline, RefreshOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'
import { dataSourceStatusText, dataSourceTypeText, type DataSourceDraft, type DataSourceStatus } from './dataSources'
import { useI18n } from 'vue-i18n'
import { localizeApiError } from '@/utils/api-error'

type RuntimeBridgeStatus = {
  ready: boolean
  generated: boolean
  mode: string
}

const router = useRouter()
const props = defineProps<{ embedded?: boolean }>()
const authStore = useAuthStore()
const dialog = useDialog()
const message = useMessage()
const { locale } = useI18n()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const loading = ref(false)
const dataSources = ref<DataSourceDraft[]>([])
const runtimeBridge = ref<RuntimeBridgeStatus | null>(null)
const isAdmin = computed(() => authStore.isAdmin)
const activeDataSource = computed(() => dataSources.value.find(item => item.isActive) || null)
const runtimeNotice = computed(() => {
  const runtime = runtimeBridge.value
  if (!runtime) return { type: 'info' as const, message: text('正在读取运行数据源桥接状态。', 'Loading runtime data-source bridge status.') }
  if (!runtime.ready) return { type: 'error' as const, message: text('运行数据源桥接未配置。启用数据源前，需要由部署人员配置管理服务与 GAIOP 核心共用的运行时目标。', 'The runtime data-source bridge is not configured. Before enabling a source, deployment personnel must configure the runtime target shared by the management service and GAIOP core.') }
  if (!activeDataSource.value) return { type: 'warning' as const, message: text('运行时桥接目标已准备，但尚未选择运行数据源。请选择并启用一条已维护的数据源。', 'The runtime bridge target is ready, but no runtime data source is selected. Select and enable a maintained data source.') }
  if (!runtime.generated) return { type: 'warning' as const, message: locale.value === 'zh-CN' ? `当前运行数据源为 ${activeDataSource.value.ip}，但运行时桥接文件尚未生成。请重新启用该数据源或检查服务端配置。` : `The runtime data source is ${activeDataSource.value.ip}, but the runtime bridge file has not been generated. Enable it again or check server configuration.` }
  return { type: 'success' as const, message: locale.value === 'zh-CN' ? `当前运行数据源为 ${activeDataSource.value.ip}。运行时桥接已生成，后续 GAIOP Skills 将读取该数据源。` : `The runtime data source is ${activeDataSource.value.ip}. The runtime bridge has been generated and subsequent GAIOP Skills will use it.` }
})

const runtimeSummary = computed(() => {
  const runtime = runtimeBridge.value
  if (!runtime) return text('正在读取运行状态。', 'Loading runtime status.')
  if (!runtime.ready) return text('运行时桥接未配置，暂不能启用数据源。', 'The runtime bridge is not configured, so data sources cannot be enabled.')
  if (!activeDataSource.value) return text('尚未启用运行数据源。', 'No runtime data source is enabled.')
  if (!runtime.generated) return locale.value === 'zh-CN' ? `已选择 ${activeDataSource.value.ip}，运行时配置尚未生成。` : `${activeDataSource.value.ip} is selected, but runtime configuration has not been generated.`
  return locale.value === 'zh-CN' ? `当前运行数据源：${activeDataSource.value.ip}` : `Current runtime data source: ${activeDataSource.value.ip}`
})

const statusType: Record<DataSourceStatus, 'success' | 'error' | 'warning' | 'default'> = {
  success: 'success', failed: 'error', untested: 'warning', disabled: 'default',
}

function formatTime(timestamp?: number) {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  return date.toLocaleString(locale.value, { hour12: false })
}

function headers() { return { Authorization: `Bearer ${authStore.getToken()}` } }

function unwrapApiData<T extends Record<string, unknown>>(payload: T) {
  return payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data as T
    : payload
}

async function refresh(showMessage = true) {
  loading.value = true
  try {
    const response = await fetch('/api/data-sources', { headers: headers() })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('获取数据源失败', 'Failed to load data sources')))
    const payload = unwrapApiData(data)
    dataSources.value = Array.isArray(payload.dataSources) ? payload.dataSources as DataSourceDraft[] : []
    runtimeBridge.value = (payload.runtime as RuntimeBridgeStatus | undefined) || null
    if (showMessage) message.success(text('数据源已刷新', 'Data sources refreshed'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('获取数据源失败', 'Failed to load data sources'))
  } finally {
    loading.value = false
  }
}

function edit(item: DataSourceDraft) {
  router.push({ name: 'DataSourceEdit', params: { id: item.id } })
}

async function testConnection(item: DataSourceDraft) {
  try {
    const response = await fetch(`/api/data-sources/${item.id}/test`, { method: 'POST', headers: headers() })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('连接测试失败', 'Connection test failed')))
    const payload = unwrapApiData(data)
    message.success((payload.result as { message?: string } | undefined)?.message || text('连接测试成功', 'Connection test passed'))
    await refresh(false)
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('连接测试失败', 'Connection test failed'))
  }
}

function activate(item: DataSourceDraft) {
  const testHint = item.status === 'success'
    ? text('该数据源已通过最近一次连接测试。', 'This data source passed its most recent connection test.')
    : text('该数据源尚未通过最近一次连接测试，启用后后续智能运维分析将优先使用它。', 'This data source has not passed its most recent connection test. When enabled, later intelligent-operations analyses will use it first.')
  dialog.warning({
    title: text('设为运行数据源', 'Set as runtime data source'),
    content: locale.value === 'zh-CN' ? `${testHint} 确认将“${item.ip}”设为当前 GAIOP 运行数据源吗？` : `${testHint} Set “${item.ip}” as the current GAIOP runtime data source?`,
    positiveText: text('确认启用', 'Enable'),
    negativeText: text('取消', 'Cancel'),
    onPositiveClick: async () => {
      try {
        const response = await fetch(`/api/data-sources/${item.id}/activate`, { method: 'POST', headers: headers() })
        const data = await response.json()
        if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('启用运行数据源失败', 'Failed to enable runtime data source')))
        message.success(text('已设为运行数据源，后续分析将读取该数据源配置', 'Set as runtime data source. Subsequent analyses will use its configuration.'))
        await refresh(false)
      } catch (error) {
        message.error(error instanceof Error ? error.message : text('启用运行数据源失败', 'Failed to enable runtime data source'))
      }
    },
  })
}

function remove(item: DataSourceDraft) {
  dialog.error({
    title: text('删除数据源', 'Delete data source'),
    content: locale.value === 'zh-CN' ? `确定删除数据源“${item.ip}”吗？此操作不可恢复。` : `Delete data source “${item.ip}”? This action cannot be undone.`,
    positiveText: text('确认删除', 'Delete'), negativeText: text('取消', 'Cancel'),
    onPositiveClick: async () => {
      try {
        const response = await fetch(`/api/data-sources/${item.id}`, { method: 'DELETE', headers: headers() })
        const data = await response.json()
        if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('删除失败', 'Delete failed')))
        message.success(text('数据源已删除', 'Data source deleted'))
        await refresh(false)
      } catch (error) {
        message.error(error instanceof Error ? error.message : text('删除失败', 'Delete failed'))
      }
    },
  })
}

const columns = computed<DataTableColumns<DataSourceDraft>>(() => [
  { title: text('状态', 'Status'), key: 'status', width: 92, render: row => h(NTag, { type: statusType[row.status], bordered: false }, { default: () => dataSourceStatusText(row.status, locale.value) }) },
  { title: text('运行', 'Runtime'), key: 'isActive', width: 92, render: row => h(NTag, { type: row.isActive ? 'success' : 'default', bordered: false }, { default: () => row.isActive ? text('运行中', 'Active') : text('未启用', 'Disabled') }) },
  { title: text('数据源', 'Data source'), key: 'ip', minWidth: 180, render: row => h('div', [h('strong', row.ip), h('div', { class: 'data-source-meta' }, `${dataSourceTypeText(row.type, locale.value)} · ${row.description || text('未填写说明', 'No description')}`)] ) },
  { title: text('最近测试', 'Last tested'), key: 'lastTestedAt', width: 168, render: row => formatTime(row.lastTestedAt) },
  {
    title: text('操作', 'Actions'), key: 'actions', width: 214, fixed: 'right', render: row => h(NSpace, { size: 'small', wrap: false }, { default: () => [
      h(NButton, { size: 'small', disabled: !isAdmin.value, onClick: () => edit(row) }, { icon: () => h(NIcon, null, { default: () => h(CreateOutline) }), default: () => text('详情', 'Details') }),
      h(NButton, { size: 'small', type: row.isActive ? 'success' : 'primary', secondary: !row.isActive, disabled: !isAdmin.value || !!row.isActive, onClick: () => activate(row) }, { icon: () => h(NIcon, null, { default: () => h(PlayCircleOutline) }), default: () => row.isActive ? text('运行中', 'Active') : text('启用', 'Enable') }),
      h(NDropdown, { trigger: 'click', options: [{ label: text('测试连接', 'Test connection'), key: 'test' }, { label: text('删除数据源', 'Delete data source'), key: 'remove', disabled: !isAdmin.value }], onSelect: (key: string) => key === 'test' ? testConnection(row) : remove(row) }, { default: () => h(NButton, { size: 'small', quaternary: true, 'aria-label': text('更多操作', 'More actions') }, { icon: () => h(NIcon, null, { default: () => h(EllipsisHorizontalOutline) }) }) }),
    ] })
  },
])

onMounted(() => { refresh(false) })
</script>

<template>
  <section class="data-source-page">
    <NAlert :type="runtimeNotice.type" :bordered="false" class="runtime-note">
      {{ props.embedded ? runtimeSummary : runtimeNotice.message }}
    </NAlert>
    <NCard :title="text('已添加数据源列表', 'Added data sources')" :bordered="false" class="data-source-card">
      <template #header-extra>
        <NSpace>
          <NButton :disabled="!isAdmin" type="primary" @click="router.push({ name: 'DataSourceCreate' })">
            <template #icon><NIcon><AddOutline /></NIcon></template>{{ text('添加', 'Add') }}
          </NButton>
          <NButton :loading="loading" @click="refresh()">
            <template #icon><NIcon><RefreshOutline /></NIcon></template>{{ text('刷新', 'Refresh') }}
          </NButton>
        </NSpace>
      </template>
      <NDataTable :columns="columns" :data="dataSources" :loading="loading" :bordered="false" :single-line="false" :scroll-x="760" :pagination="{ pageSize: 10 }">
        <template #empty><NEmpty :description="text('尚未添加数据源', 'No data sources added')" /></template>
      </NDataTable>
    </NCard>
  </section>
</template>

<style scoped>
.data-source-page { display: grid; min-width: 0; gap: 14px; }
.runtime-note { line-height: 1.65; }
.data-source-card { min-width: 0; min-height: 360px; }
.data-source-meta { margin-top: 3px; color: #7b8e83; font-size: 12px; line-height: 1.4; }
:global([data-theme='dark'] .data-source-meta) { color: #91a79a; }
</style>
