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
import { useI18n } from 'vue-i18n'
import { localizeApiError } from '@/utils/api-error'

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
defineProps<{ embedded?: boolean }>()
const authStore = useAuthStore()
const { locale } = useI18n()
const message = useMessage()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const loading = ref(false)
const saving = ref(false)
const enabled = ref(true)
const settings = ref<Settings | null>(null)
const runtime = ref<Runtime | null>(null)

const runtimeLabel = computed(() => ({
  pending: text('待部署联调', 'Pending deployment'),
  applied: text('已应用', 'Applied'),
  failed: text('接收器不可用', 'Receiver unavailable'),
  unknown: text('状态未知', 'Unknown status'),
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
  return value ? new Date(value).toLocaleString(locale.value, { hour12: false }) : text('未记录', 'Not recorded')
}

async function loadConfiguration() {
  loading.value = true
  try {
    const response = await fetch('/api/system-config/alert-ingestion', { headers: headers() })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(localizeApiError(result, text('读取告警接入配置失败', 'Failed to load alert ingestion configuration')))
    settings.value = result.settings
    runtime.value = result.runtime
    enabled.value = result.settings.enabled
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('读取告警接入配置失败', 'Failed to load alert ingestion configuration'))
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
    if (!response.ok || !result.ok) throw new Error(localizeApiError(result, text('保存告警接入配置失败', 'Failed to save alert ingestion configuration')))
    settings.value = result.settings
    runtime.value = result.runtime
    message.success(result.runtime.state === 'applied' ? text('已保存并同步到告警接收器', 'Saved and synchronized with the alert receiver') : text('已保存；等待部署侧告警接收器应用', 'Saved; waiting for the deployed alert receiver to apply it'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('保存告警接入配置失败', 'Failed to save alert ingestion configuration'))
  } finally {
    saving.value = false
  }
}

onMounted(() => { void loadConfiguration() })
</script>

<template>
  <section class="alert-ingestion-page">
<NButton v-if="!embedded" quaternary class="back-button" @click="router.push({ name: 'SystemConfiguration' })">← {{ text('返回高级配置', 'Back to advanced configuration') }}</NButton>

    <NSpin :show="loading">
      <NCard v-if="!embedded" class="app-card ingestion-hero">
        <div class="ingestion-hero__header">
          <div>
            <NTag type="error" round :bordered="false">{{ text('告警接入配置', 'Alert ingestion configuration') }}</NTag>
            <h1>{{ text('Syslog 告警接收', 'Syslog alert reception') }}</h1>
            <p>{{ text('管理 GAIOP 对 NAPM Syslog 告警的接收状态。安装、端口开放和发送端配置由 ISO 部署流程处理。', 'Manage how GAIOP receives NAPM Syslog alerts. Installation, port access, and sender configuration are handled by the ISO deployment process.') }}</p>
          </div>
          <NTag :type="runtimeType" round size="large">{{ runtimeLabel }}</NTag>
        </div>
      </NCard>

      <NAlert type="info" :show-icon="true">
        {{ text('企业微信、Webhook 等通知频道不在此处配置；它们将统一由“频道管理”维护。本页不会下载或安装系统软件，也不会修改防火墙或 NAPM。', 'WeCom, Webhook, and other notification channels are not configured here; manage them in Channel Management. This page does not download or install software, or modify the firewall or NAPM.') }}
      </NAlert>

      <div class="ingestion-grid">
        <NCard class="app-card" :title="text('接收策略', 'Reception policy')">
          <NDescriptions label-placement="left" :column="1" bordered size="small">
            <NDescriptionsItem :label="text('接收协议', 'Reception protocol')">UDP Syslog</NDescriptionsItem>
            <NDescriptionsItem :label="text('监听端口', 'Listening port')">514</NDescriptionsItem>
            <NDescriptionsItem :label="text('接收服务', 'Reception service')">
              <NTag :type="enabled ? 'success' : 'default'" size="small">{{ enabled ? text('目标启用', 'Target enabled') : text('目标停用', 'Target disabled') }}</NTag>
            </NDescriptionsItem>
          </NDescriptions>
          <div class="enabled-row">
            <div>
              <strong>{{ text('启用 Syslog 告警接收', 'Enable Syslog alert reception') }}</strong>
              <p>{{ text('保存的是 GAIOP 的目标运行策略；接收器未部署时会保持“待部署联调”。', 'This saves GAIOP\'s target operating policy. It remains pending deployment when the receiver is not deployed.') }}</p>
            </div>
            <NSwitch v-model:value="enabled" />
          </div>
          <NButton type="primary" :loading="saving" @click="saveConfiguration">
            <template #icon><NIcon :component="SaveOutline" /></template>
            {{ text('保存接收策略', 'Save reception policy') }}
          </NButton>
        </NCard>

        <NCard class="app-card" :title="text('运行状态', 'Runtime status')">
          <template #header-extra>
            <NButton size="small" :loading="loading" @click="loadConfiguration">
              <template #icon><NIcon :component="RefreshOutline" /></template>
              {{ text('刷新状态', 'Refresh status') }}
            </NButton>
          </template>
          <NDescriptions label-placement="left" :column="1" bordered size="small">
            <NDescriptionsItem :label="text('运行状态', 'Runtime status')"><NTag :type="runtimeType" size="small">{{ runtimeLabel }}</NTag></NDescriptionsItem>
            <NDescriptionsItem :label="text('接收器连接', 'Receiver connection')">{{ runtime?.receiver === 'reachable' ? text('可访问', 'Reachable') : runtime?.receiver === 'unavailable' ? text('不可访问', 'Unavailable') : text('未配置', 'Not configured') }}</NDescriptionsItem>
            <NDescriptionsItem :label="text('最近接收时间', 'Last received')">{{ formatTime(runtime?.lastReceivedAt || null) }}</NDescriptionsItem>
            <NDescriptionsItem :label="text('最近错误', 'Last error')">{{ runtime?.lastErrorCode || text('未记录', 'Not recorded') }}</NDescriptionsItem>
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
:global([data-theme='dark'] .back-button) { color: #8fc5a6; }
:global([data-theme='dark'] .ingestion-hero) { background: linear-gradient(118deg, #241e1e, #2b1d1d); }
:global([data-theme='dark'] .ingestion-hero h1) { color: #f0caca; }
:global([data-theme='dark'] .ingestion-hero p),
:global([data-theme='dark'] .enabled-row p) { color: #bca4a4; }
@media (max-width: 760px) { .ingestion-hero__header, .enabled-row { align-items: flex-start; flex-direction: column; } .ingestion-grid { grid-template-columns: 1fr; } }
</style>
