<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { NAlert, NButton, NCard, NForm, NFormItem, NInputNumber, NSpace, NText, useMessage } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { useI18n } from 'vue-i18n'
import { localizeApiError } from '@/utils/api-error'
import { platformBranding } from '@/branding/platform'

const authStore = useAuthStore()
const { locale } = useI18n()
const message = useMessage()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const loading = ref(false)
const saving = ref(false)
const updatedAt = ref<number | null>(null)
const runtime = ref<{
  status: 'applied' | 'different' | 'unavailable'
  agentContextIdleMinutes?: number | null
  patchMode?: 'raw' | 'legacy'
}>({ status: 'unavailable' })
const settings = reactive({
  loginSessionHours: 24,
  idleTimeoutMinutes: 0,
  agentContextIdleMinutes: 30,
  historyRetentionDays: 180,
})

function authHeaders() {
  return { Authorization: `Bearer ${authStore.getToken() || ''}`, 'Content-Type': 'application/json' }
}

async function loadSettings() {
  loading.value = true
  try {
    const response = await fetch('/api/system-settings/sessions', { headers: authHeaders() })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('加载会话设置失败', 'Failed to load session settings')))
    Object.assign(settings, data.settings)
    updatedAt.value = data.settings.updatedAt || null
    runtime.value = data.runtime || { status: 'unavailable' }
    if (runtime.value.status === 'unavailable') {
      message.warning(text(`未能读取 ${platformBranding.productCode} 智能体服务的当前会话策略，页面显示的是最近保存值。`, `Could not read the current ${platformBranding.productCode} agent session policy; the latest saved values are shown.`))
    }
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('加载会话设置失败', 'Failed to load session settings'))
  } finally {
    loading.value = false
  }
}

async function saveSettings() {
  saving.value = true
  try {
    const response = await fetch('/api/system-settings/sessions', {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify(settings),
    })
    const data = await response.json()
    if (!response.ok || !data.ok) throw new Error(localizeApiError(data, text('保存会话设置失败', 'Failed to save session settings')))
    Object.assign(settings, data.settings)
    updatedAt.value = data.settings.updatedAt || null
    runtime.value = data.runtime || { status: 'unavailable' }
    message.success(text(`会话设置已保存，并已同步到 ${platformBranding.productCode} 智能体服务`, `Session settings saved and synchronized with the ${platformBranding.productCode} agent service`))
  } catch (error) {
    message.error(error instanceof Error ? error.message : text('保存会话设置失败', 'Failed to save session settings'))
  } finally {
    saving.value = false
  }
}

const runtimeDescription = computed(() => {
  if (runtime.value.status === 'applied') return text(`${platformBranding.productCode} 智能体服务已应用当前会话策略。`, `The ${platformBranding.productCode} agent service has applied the current session policy.`)
  if (runtime.value.status === 'different') return text(`${platformBranding.productCode} 智能体服务中的实际策略与最近保存值不一致，请由管理员重新保存以同步。`, `The active ${platformBranding.productCode} agent service policy differs from the last saved values. An administrator should save again to synchronize it.`)
  return text(`暂时无法读取 ${platformBranding.productCode} 智能体服务状态；保存时会先同步运行时，失败不会写入管理策略。`, `The ${platformBranding.productCode} agent service status is temporarily unavailable. Saving synchronizes runtime first and does not write the management policy if that fails.`)
})

onMounted(loadSettings)
</script>

<template>
  <NSpace vertical :size="16">
    <NAlert type="info" :bordered="false">
      {{ text(`浏览器只调用管理服务的会话设置接口；管理服务负责同步 ${platformBranding.productCode} 智能体服务、兼容 Gateway 参数版本并记录审计。超过设定时长后，用户下一条消息会自动使用新的分析上下文；历史会话不会被删除，${platformBranding.productCode} 工作台也不会强制跳转页面。`, `The browser calls only the management service session-settings API. The management service synchronizes the ${platformBranding.productCode} agent service, handles Gateway parameter compatibility, and records audits. After the configured duration, the user's next message uses a new analysis context; history is not deleted and the ${platformBranding.productCode} workspace does not force navigation.`) }}
    </NAlert>
    <NAlert :type="runtime.status === 'applied' ? 'success' : 'warning'" :bordered="false">
      {{ runtimeDescription }}
    </NAlert>

    <NCard :title="text('登录会话策略', 'Sign-in session policy')" class="app-card" :loading="loading">
      <NForm label-placement="left" label-width="180" style="max-width: 640px;">
        <NFormItem :label="text('登录会话时长（小时）', 'Sign-in session duration (hours)')">
          <NInputNumber v-model:value="settings.loginSessionHours" :min="1" :max="168" :precision="0" :disabled="!authStore.isAdmin" />
        </NFormItem>
        <NText depth="3" class="setting-help">{{ text('登录成功后，管理平台登录状态最长可保留 1 至 168 小时；修改后仅影响新登录。', 'After sign-in, the admin session can last from 1 to 168 hours. Changes affect new sign-ins only.') }}</NText>

        <NFormItem :label="text('空闲超时（分钟）', 'Idle timeout (minutes)')" style="margin-top: 18px;">
          <NInputNumber v-model:value="settings.idleTimeoutMinutes" :min="0" :max="1440" :precision="0" :disabled="!authStore.isAdmin" />
        </NFormItem>
        <NText depth="3" class="setting-help">{{ text('设为 0 表示不按空闲时间退出；其他值为连续无操作后的自动退出时间。', 'Set to 0 to disable idle logout; other values set the automatic logout time after continuous inactivity.') }}</NText>
      </NForm>
    </NCard>

    <NCard :title="text('智能体分析上下文策略', 'Agent analysis-context policy')" class="app-card" :loading="loading">
      <NForm label-placement="left" label-width="180" style="max-width: 640px;">
        <NFormItem :label="text('上下文保持时长（分钟）', 'Context retention (minutes)')">
          <NInputNumber v-model:value="settings.agentContextIdleMinutes" :min="1" :max="1440" :precision="0" :disabled="!authStore.isAdmin" />
        </NFormItem>
        <NText depth="3" class="setting-help">
          {{ text(`默认 30 分钟。企业微信、微信等外部渠道在连续无用户消息超过该时长后，下一条消息自动开启新的分析上下文。${platformBranding.productCode} 对话工作台不自动重置：用户打开历史会话后可继续原分析上下文，也可主动点击“开启新对话”。`, `The default is 30 minutes. After this period without a user message, external channels such as WeCom and WeChat automatically start a new analysis context on the next message. The ${platformBranding.productCode} chat workspace does not reset automatically: users can continue an analysis context after opening history or select New Chat.`) }}
        </NText>
      </NForm>
    </NCard>

    <NCard :title="text('分析会话留存策略', 'Analysis-session retention policy')" class="app-card" :loading="loading">
      <NForm label-placement="left" label-width="180" style="max-width: 640px;">
        <NFormItem :label="text('历史会话保留期（天）', 'History retention (days)')">
          <NInputNumber v-model:value="settings.historyRetentionDays" :min="0" :max="3650" :precision="0" :disabled="!authStore.isAdmin" />
        </NFormItem>
        <NText depth="3" class="setting-help">{{ text('设为 0 表示长期保留。当前用于统一记录平台规则；自动清理将在对接智能体会话维护能力时单独启用，不会因保存本页而删除数据。', 'Set to 0 to retain indefinitely. This currently records the platform-wide policy; automatic cleanup will be enabled separately when agent session-maintenance capability is integrated, and saving this page does not delete data.') }}</NText>
      </NForm>
    </NCard>

    <NCard v-if="authStore.isAdmin" class="app-card" :bordered="false">
      <NSpace justify="space-between" align="center">
        <NText depth="3">{{ updatedAt ? `${text('最近保存：', 'Last saved: ')}${new Date(updatedAt).toLocaleString(locale)}` : text('尚未保存过自定义会话设置', 'No custom session settings have been saved') }}</NText>
        <NButton type="primary" :loading="saving" @click="saveSettings">{{ text('保存会话设置', 'Save session settings') }}</NButton>
      </NSpace>
    </NCard>
    <NAlert v-else type="warning" :bordered="false">{{ text('仅管理员可以修改会话设置。', 'Only administrators can modify session settings.') }}</NAlert>
  </NSpace>
</template>

<style scoped>
.setting-help { display: block; margin: -12px 0 8px 180px; font-size: 13px; line-height: 1.7; }
@media (max-width: 720px) { .setting-help { margin-left: 0; } }
</style>
