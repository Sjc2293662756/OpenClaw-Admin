<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NIcon,
  NSpin,
  NSwitch,
  NTag,
  useMessage,
} from 'naive-ui'
import { RefreshOutline, SaveOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'

type RuntimeState = 'pending' | 'applied' | 'failed' | 'unknown'

interface Settings {
  enabled: boolean
  protocol: 'udp'
  port: number
  updatedAt: number | null
}

interface Runtime {
  state: RuntimeState
  receiver: 'not-configured' | 'reachable' | 'unavailable'
  lastReceivedAt: number | null
  lastErrorCode: string | null
}

const router = useRouter()
const authStore = useAuthStore()
const message = useMessage()
const loading = ref(false)
const saving = ref(false)
const enabled = ref(true)
const settings = ref<Settings | null>(null)
const runtime = ref<Runtime | null>(null)

const runtimeLabel = computed(() => ({
  pending: '待部署联调',
  applied: '已应用',
  failed: '接收器不可用',
  unknown: '状态未知',
}[runtime.value?.state || 'unknown']))

const runtimeType = computed(() => ({
  pending: 'warning',
  applied: 'success',
  failed: 'error',
  unknown: 'default',
}[runtime.value?.state || 'unknown'] as 'warning' | 'success' | 'error' | 'default'))

function headers(includeJson = false) {
  return {
    Authorization: `Bearer ${authStore.getToken() || ''}`,
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
  }
}

function formatTime(value: number | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录'
}

async function loadConfiguration() {
  loading.value = true
  try {
    const response = await fetch('/api/system-config/alert-ingestion', { headers: headers() })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error || '读取告警接入配置失败')
    settings.value = result.settings
    runtime.value = result.runtime
    enabled.value = result.settings.enabled
  } catch (error) {
    message.error(error instanceof Error ? error.message : '读取告警接入配置失败')
  } finally {
    loading.value = false
  }
}

async function saveConfiguration() {
  saving.value = true
  try {
    const response = await fetch('/api/system-config/alert-ingestion', {
      method: 'PUT',
      headers: headers(true),
      body: JSON.stringify({ enabled: enabled.value }),
    })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(result.error || '保存告警接入配置失败')
    settings.value = result.settings
    runtime.value = result.runtime
    message.success(result.runtime.state === 'applied' ? '已保存并同步到告警接收器' : '已保存；等待部署侧告警接收器应用')
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存告警接入配置失败')
  } finally {
    saving.value = false
  }
}

onMounted(() => { void loadConfiguration() })
</script>

<template>
  <section class="alert-ingestion-page">
    <NButton quaternary class="back-button" @click="router.push({ name: 'SystemConfiguration' })">← 返回系统配置</NButton>

    <NSpin :show="loading">
      <NCard class="app-card ingestion-hero">
        <div class="ingestion-hero__header">
          <div>
            <NTag type="error" round :bordered="false">告警接入配置</NTag>
            <h1>Syslog 告警接收</h1>
            <p>管理 GAIOP 对 NAPM Syslog 告警的接收状态。安装、端口开放和发送端配置由 ISO 部署流程处理。</p>
          </div>
          <NTag :type="runtimeType" round size="large">{{ runtimeLabel }}</NTag>
        </div>
      </NCard>

      <NAlert type="info" :show-icon="true">
        企业微信、Webhook 等通知频道不在此处配置；它们将统一由“频道管理”维护。本页不会下载或安装系统软件，也不会修改防火墙或 NAPM。
      </NAlert>

      <div class="ingestion-grid">
        <NCard class="app-card" title="接收策略">
          <NDescriptions label-placement="left" :column="1" bordered size="small">
            <NDescriptionsItem label="接收协议">UDP Syslog</NDescriptionsItem>
            <NDescriptionsItem label="监听端口">514</NDescriptionsItem>
            <NDescriptionsItem label="接收服务">
              <NTag :type="enabled ? 'success' : 'default'" size="small">{{ enabled ? '目标启用' : '目标停用' }}</NTag>
            </NDescriptionsItem>
          </NDescriptions>
          <div class="enabled-row">
            <div>
              <strong>启用 Syslog 告警接收</strong>
              <p>保存的是 GAIOP 的目标运行策略；接收器未部署时会保持“待部署联调”。</p>
            </div>
            <NSwitch v-model:value="enabled" />
          </div>
          <NButton type="primary" :loading="saving" @click="saveConfiguration">
            <template #icon><NIcon :component="SaveOutline" /></template>
            保存接收策略
          </NButton>
        </NCard>

        <NCard class="app-card" title="运行状态">
          <template #header-extra>
            <NButton size="small" :loading="loading" @click="loadConfiguration">
              <template #icon><NIcon :component="RefreshOutline" /></template>
              刷新状态
            </NButton>
          </template>
          <NDescriptions label-placement="left" :column="1" bordered size="small">
            <NDescriptionsItem label="运行状态"><NTag :type="runtimeType" size="small">{{ runtimeLabel }}</NTag></NDescriptionsItem>
            <NDescriptionsItem label="接收器连接">{{ runtime?.receiver === 'reachable' ? '可访问' : runtime?.receiver === 'unavailable' ? '不可访问' : '未配置' }}</NDescriptionsItem>
            <NDescriptionsItem label="最近接收时间">{{ formatTime(runtime?.lastReceivedAt || null) }}</NDescriptionsItem>
            <NDescriptionsItem label="最近错误">{{ runtime?.lastErrorCode || '未记录' }}</NDescriptionsItem>
          </NDescriptions>
        </NCard>
      </div>
    </NSpin>
  </section>
</template>

<style scoped>
.alert-ingestion-page { display: grid; gap: 16px; }
.back-button { justify-self: start; margin: -6px 0 -2px; color: #478063; }
.ingestion-hero { overflow: hidden; background: linear-gradient(118deg, #fff, #fff0f0); }
.ingestion-hero__header { display: flex; align-items: start; justify-content: space-between; gap: 20px; padding: 4px; }
.ingestion-hero h1 { margin: 13px 0 7px; color: #6e2525; font-size: 24px; }
.ingestion-hero p, .enabled-row p { margin: 0; color: #7e6a6a; line-height: 1.65; }
.ingestion-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(300px, .8fr); gap: 16px; }
.enabled-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin: 20px 0; }
.enabled-row strong { display: block; margin-bottom: 6px; }
@media (max-width: 760px) { .ingestion-hero__header, .enabled-row { align-items: flex-start; flex-direction: column; } .ingestion-grid { grid-template-columns: 1fr; } }
</style>
