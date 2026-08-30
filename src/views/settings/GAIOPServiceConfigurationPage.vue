<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  NAlert,
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NForm,
  NFormItem,
  NIcon,
  NInput,
  NSpin,
  NTag,
  useMessage,
} from 'naive-ui'
import { RefreshOutline, SaveOutline } from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'
import { useI18n } from 'vue-i18n'
import { localizeApiError } from '@/utils/api-error'

type ServiceState = 'connected' | 'disconnected'

interface ServiceConfig {
  endpoint: string
  accessTokenConfigured: boolean
  state: ServiceState
}

const router = useRouter()
defineProps<{ embedded?: boolean }>()
const authStore = useAuthStore()
const message = useMessage()
const { t } = useI18n()
const loading = ref(false)
const saving = ref(false)
const endpoint = ref('')
const accessToken = ref('')
const service = ref<ServiceConfig | null>(null)
const canManage = computed(() => authStore.isAdmin)

const connected = computed(() => service.value?.state === 'connected')
const statusText = computed(() => connected.value ? t('pages.gaiop.systemConfig.connected') : t('pages.gaiop.systemConfig.disconnected'))
const statusType = computed(() => connected.value ? 'success' : 'warning')

function headers(includeJson = false) {
  return {
    Authorization: `Bearer ${authStore.getToken() || ''}`,
    ...(includeJson ? { 'Content-Type': 'application/json' } : {}),
  }
}

async function loadService() {
  loading.value = true
  try {
    const response = await fetch('/api/system-config/gaiop-service', { headers: headers() })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(localizeApiError(result, t('pages.gaiop.systemConfig.loadFailed')))
    service.value = result.service
    endpoint.value = result.service.endpoint || ''
    accessToken.value = ''
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('pages.gaiop.systemConfig.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function saveService() {
  if (!canManage.value) return
  saving.value = true
  try {
    const body: { endpoint: string; accessToken?: string } = { endpoint: endpoint.value.trim() }
    if (accessToken.value) body.accessToken = accessToken.value
    const response = await fetch('/api/system-config/gaiop-service', {
      method: 'PUT',
      headers: headers(true),
      body: JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok || !result.ok) throw new Error(localizeApiError(result, t('pages.gaiop.systemConfig.saveFailed')))
    service.value = result.service
    accessToken.value = ''
    message.success(t('pages.gaiop.systemConfig.saveSuccess'))
    window.setTimeout(() => { void loadService() }, 900)
  } catch (error) {
    message.error(error instanceof Error ? error.message : t('pages.gaiop.systemConfig.saveFailed'))
  } finally {
    saving.value = false
  }
}

onMounted(() => { void loadService() })
</script>

<template>
  <section class="gaiop-service-page">
    <NButton v-if="!embedded" quaternary class="back-button" @click="router.push({ name: 'SystemConfiguration' })">← {{ t('pages.gaiop.systemConfig.back') }}</NButton>

    <NSpin :show="loading">
      <NCard v-if="!embedded" class="app-card service-hero">
        <div class="service-hero__header">
          <div>
            <NTag type="success" round :bordered="false">{{ t('pages.gaiop.systemConfig.serviceConfig') }}</NTag>
            <h1>{{ t('pages.gaiop.systemConfig.connection') }}</h1>
            <p>{{ t('pages.gaiop.systemConfig.connectionDescription') }}</p>
          </div>
          <NTag :type="statusType" round size="large">{{ statusText }}</NTag>
        </div>

      </NCard>

      <div class="service-grid">
        <NCard class="app-card" :title="t('pages.gaiop.systemConfig.connectionConfig')">
          <NAlert v-if="!canManage" type="info" :bordered="false" class="read-only-tip">
            当前模块为只读；只有管理员可以修改连接配置。
          </NAlert>
          <NForm label-placement="top" class="service-form">
            <NFormItem :label="t('pages.gaiop.systemConfig.endpoint')">
              <NInput v-model:value="endpoint" :disabled="!canManage" placeholder="例如：ws://127.0.0.1:3003" />
            </NFormItem>
            <NFormItem :label="t('pages.gaiop.systemConfig.token')">
              <NInput
                v-model:value="accessToken"
                type="password"
                show-password-on="click"
                :disabled="!canManage"
                :placeholder="service?.accessTokenConfigured ? t('pages.gaiop.systemConfig.tokenConfigured') : t('pages.gaiop.systemConfig.tokenRequired')"
              />
            </NFormItem>
            <NButton type="primary" :disabled="!canManage" :loading="saving" @click="saveService">
              <template #icon><NIcon :component="SaveOutline" /></template>
              {{ t('pages.gaiop.systemConfig.saveReconnect') }}
            </NButton>
          </NForm>
        </NCard>

        <NCard class="app-card" :title="t('pages.gaiop.systemConfig.currentStatus')">
          <template #header-extra>
            <NButton size="small" :loading="loading" @click="loadService">
              <template #icon><NIcon :component="RefreshOutline" /></template>
              {{ t('pages.gaiop.systemConfig.refreshStatus') }}
            </NButton>
          </template>
          <NDescriptions label-placement="left" :column="1" bordered size="small">
            <NDescriptionsItem :label="t('pages.gaiop.systemConfig.currentStatus')"><NTag :type="statusType" size="small">{{ statusText }}</NTag></NDescriptionsItem>
            <NDescriptionsItem :label="t('pages.gaiop.systemConfig.token')"><NTag :type="service?.accessTokenConfigured ? 'success' : 'warning'" size="small">{{ service?.accessTokenConfigured ? t('pages.gaiop.systemConfig.configured') : t('pages.gaiop.systemConfig.notConfigured') }}</NTag></NDescriptionsItem>
          </NDescriptions>
        </NCard>
      </div>
    </NSpin>
  </section>
</template>

<style scoped>
.gaiop-service-page { display: grid; gap: 16px; }
.back-button { justify-self: start; margin: -6px 0 -2px; color: #478063; }
.service-hero { overflow: hidden; background: linear-gradient(118deg, #fff, #edf9f1); }
.service-hero__header { display: flex; align-items: start; justify-content: space-between; gap: 20px; padding: 4px; }
.service-hero h1 { margin: 13px 0 7px; color: #174d38; font-size: 24px; }
.service-hero p { margin: 0; color: #6d8b7c; line-height: 1.65; }
.service-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(300px, .8fr); gap: 16px; }
.service-form { max-width: 620px; }
.read-only-tip { margin-bottom: 16px; }
:global([data-theme='dark'] .back-button) { color: #8fc5a6; }
:global([data-theme='dark'] .service-hero) { background: linear-gradient(118deg, #1d2421, #17251d); }
:global([data-theme='dark'] .service-hero h1) { color: #d5eadc; }
:global([data-theme='dark'] .service-hero p) { color: #91a79a; }
@media (max-width: 760px) { .service-hero__header { flex-direction: column; } .service-grid { grid-template-columns: 1fr; } }
</style>
