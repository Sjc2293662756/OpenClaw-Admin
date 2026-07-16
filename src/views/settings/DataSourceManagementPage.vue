<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NDataTable, NEmpty, NIcon, NSpace, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { AddOutline, CreateOutline, FlashOutline, PlayCircleOutline, RefreshOutline, TrashOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'
import { dataSourceStatusText, dataSourceTypeText, type DataSourceDraft, type DataSourceStatus } from './dataSources'

type RuntimeBridgeStatus = {
  ready: boolean
  generated: boolean
  mode: string
}

const router = useRouter()
const authStore = useAuthStore()
const dialog = useDialog()
const message = useMessage()
const loading = ref(false)
const dataSources = ref<DataSourceDraft[]>([])
const runtimeBridge = ref<RuntimeBridgeStatus | null>(null)
const isAdmin = computed(() => authStore.isAdmin)
const activeDataSource = computed(() => dataSources.value.find(item => item.isActive) || null)
const runtimeNotice = computed(() => {
  const runtime = runtimeBridge.value
  if (!runtime) return { type: 'info' as const, message: '正在读取运行数据源桥接状态。' }
  if (!runtime.ready) return { type: 'error' as const, message: '运行数据源桥接未配置。启用数据源前，需要由部署人员配置管理服务与 GAIOP 核心共用的运行时目标。' }
  if (!activeDataSource.value) return { type: 'warning' as const, message: '运行时桥接目标已准备，但尚未选择运行数据源。请选择并启用一条已维护的数据源。' }
  if (!runtime.generated) return { type: 'warning' as const, message: `当前运行数据源为 ${activeDataSource.value.ip}，但运行时桥接文件尚未生成。请重新启用该数据源或检查服务端配置。` }
  return { type: 'success' as const, message: `当前运行数据源为 ${activeDataSource.value.ip}。运行时桥接已生成，后续 GAIOP Skills 将读取该数据源。` }
})

const statusType: Record<DataSourceStatus, 'success' | 'error' | 'warning' | 'default'> = {
  success: 'success', failed: 'error', untested: 'warning', disabled: 'default',
}

function formatTime(timestamp?: number) {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
}

function headers() { return { Authorization: `Bearer ${authStore.getToken()}` } }

async function refresh(showMessage = true) {
  loading.value = true
  try {
    const response = await fetch('/api/data-sources', { headers: headers() })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(data.error || '获取数据源失败')
    dataSources.value = data.dataSources
    runtimeBridge.value = data.runtime || null
    if (showMessage) message.success('数据源已刷新')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '获取数据源失败')
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
    if (!response.ok || !data.ok) throw new Error(data.error || '连接测试失败')
    message.success(data.result?.message || '连接测试成功')
    await refresh(false)
  } catch (error) {
    message.error(error instanceof Error ? error.message : '连接测试失败')
  }
}

function activate(item: DataSourceDraft) {
  const testHint = item.status === 'success'
    ? '该数据源已通过最近一次连接测试。'
    : '该数据源尚未通过最近一次连接测试，启用后后续智能运维分析将优先使用它。'
  dialog.warning({
    title: '设为运行数据源',
    content: `${testHint} 确认将“${item.ip}”设为当前 GAIOP 运行数据源吗？`,
    positiveText: '确认启用',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const response = await fetch(`/api/data-sources/${item.id}/activate`, { method: 'POST', headers: headers() })
        const data = await response.json()
        if (!response.ok || !data.ok) throw new Error(data.error || '启用运行数据源失败')
        message.success('已设为运行数据源，后续分析将读取该数据源配置')
        await refresh(false)
      } catch (error) {
        message.error(error instanceof Error ? error.message : '启用运行数据源失败')
      }
    },
  })
}

function remove(item: DataSourceDraft) {
  dialog.error({
    title: '删除数据源',
    content: `确定删除数据源“${item.ip}”吗？此操作不可恢复。`,
    positiveText: '确认删除', negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const response = await fetch(`/api/data-sources/${item.id}`, { method: 'DELETE', headers: headers() })
        const data = await response.json()
        if (!response.ok || !data.ok) throw new Error(data.error || '删除失败')
        message.success('数据源已删除')
        await refresh(false)
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除失败')
      }
    },
  })
}

const columns: DataTableColumns<DataSourceDraft> = [
  { title: '状态', key: 'status', width: 105, render: row => h(NTag, { type: statusType[row.status], bordered: false }, { default: () => dataSourceStatusText[row.status] }) },
  { title: '运行状态', key: 'isActive', width: 106, render: row => h(NTag, { type: row.isActive ? 'success' : 'default', bordered: false }, { default: () => row.isActive ? '运行中' : '未启用' }) },
  { title: 'IP', key: 'ip', minWidth: 180 },
  { title: '描述', key: 'description', minWidth: 180, ellipsis: { tooltip: true }, render: row => row.description || '—' },
  { title: '类型', key: 'type', width: 100, render: row => dataSourceTypeText[row.type] },
  { title: '账号', key: 'username', minWidth: 130 },
  { title: '添加时间', key: 'createdAt', width: 180, render: row => formatTime(row.createdAt) },
  { title: '最近测试', key: 'lastTestedAt', width: 180, render: row => formatTime(row.lastTestedAt) },
  { title: '操作', key: 'actions', width: 326, fixed: 'right', render: row => h(NSpace, { size: 'small', wrap: false }, { default: () => [
    h(NButton, { size: 'small', type: row.isActive ? 'success' : 'primary', secondary: !row.isActive, disabled: !isAdmin.value || !!row.isActive, onClick: () => activate(row) }, { icon: () => h(NIcon, null, { default: () => h(PlayCircleOutline) }), default: () => row.isActive ? '运行中' : '启用' }),
    h(NButton, { size: 'small', disabled: !isAdmin.value, onClick: () => edit(row) }, { icon: () => h(NIcon, null, { default: () => h(CreateOutline) }), default: () => '编辑' }),
    h(NButton, { size: 'small', type: 'info', secondary: true, disabled: !isAdmin.value, onClick: () => testConnection(row) }, { icon: () => h(NIcon, null, { default: () => h(FlashOutline) }), default: () => '测试' }),
    h(NButton, { size: 'small', type: 'error', ghost: true, disabled: !isAdmin.value, onClick: () => remove(row) }, { icon: () => h(NIcon, null, { default: () => h(TrashOutline) }), default: () => '删除' }),
  ] }) },
]

onMounted(() => { refresh(false) })
</script>

<template>
  <section class="data-source-page">
    <NAlert type="info" :bordered="false" class="stage-note">
      管理员可维护 NAPM 数据源。密码仅加密保存在服务端，连接测试由 GAIOP 服务端发起，不会经过浏览器。当前只允许一个“运行中”数据源；启用后，后续 GAIOP 分析会优先读取该数据源。
    </NAlert>
    <NAlert :type="runtimeNotice.type" :bordered="false" class="runtime-note">
      {{ runtimeNotice.message }}
    </NAlert>
    <NCard title="已添加数据源列表" :bordered="false" class="data-source-card">
      <template #header-extra>
        <NSpace>
          <NButton :disabled="!isAdmin" type="primary" @click="router.push({ name: 'DataSourceCreate' })">
            <template #icon><NIcon><AddOutline /></NIcon></template>添加
          </NButton>
          <NButton :loading="loading" @click="refresh()">
            <template #icon><NIcon><RefreshOutline /></NIcon></template>刷新
          </NButton>
        </NSpace>
      </template>
      <NDataTable :columns="columns" :data="dataSources" :loading="loading" :bordered="false" :single-line="false" :scroll-x="1350" :pagination="{ pageSize: 10 }">
        <template #empty><NEmpty description="尚未添加数据源" /></template>
      </NDataTable>
    </NCard>
  </section>
</template>

<style scoped>
.data-source-page { display: grid; gap: 16px; }
.stage-note { line-height: 1.65; }
.runtime-note { line-height: 1.65; }
.data-source-card { min-height: 420px; }
</style>
