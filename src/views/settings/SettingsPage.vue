<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NCard, NForm, NFormItem, NSelect, NSpace, NSwitch, NText, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { localizeApiError } from '@/utils/api-error'
import { useAuthStore } from '@/stores/auth'
import { canAccessPage } from '@/permissions/access-control'
import { useLocaleStore } from '@/stores/locale'
import { useThemeStore, type ThemeMode } from '@/stores/theme'
import { DEFAULT_ALERT_NOTIFICATION_PREFERENCES, LOCAL_ALERT_SOUND_DEMO, useAlertRealtimeStore, type AlertNotificationPreferences, type AlertNotificationSeverity } from '@/stores/alert-realtime'
import { isAlertSoundId, playAlertNotificationSound, primeAlertNotificationSound, type AlertSoundId } from '@/alerts/notification-sound'
import type { AppLocale } from '@/i18n/locale'
import SessionManagementPage from './SessionManagementPage.vue'
import ChatDisplayPreferencesPanel from '@/components/chat/ChatDisplayPreferencesPanel.vue'

type AlertPreferenceBooleanKey = Exclude<keyof AlertNotificationPreferences, 'updatedAt' | 'minorSound' | 'majorSound' | 'criticalSound'>
type AlertPreferenceSoundKey = Extract<keyof AlertNotificationPreferences, 'minorSound' | 'majorSound' | 'criticalSound'>

const authStore = useAuthStore()
const localeStore = useLocaleStore()
const themeStore = useThemeStore()
const alerts = useAlertRealtimeStore()
const { t, locale } = useI18n()
const message = useMessage()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const reportStorageConfigured = ref(false)
const reportStorageRoot = ref('')
const reportStorageLoading = ref(false)
const reportStorageError = ref(false)
const canConfigureAlertNotifications = computed(() => LOCAL_ALERT_SOUND_DEMO || canAccessPage(authStore.currentUser?.effectiveModules, 'alerts.notifications'))
const alertPreferencesDraft = ref<AlertNotificationPreferences>({ ...DEFAULT_ALERT_NOTIFICATION_PREFERENCES })
const alertPreferencesLoaded = ref(false)
const alertPreferenceRows = computed(() => [
  { label: text('轻微', 'Minor'), popup: 'minorPopupEnabled', notification: 'minorNotificationEnabled', sound: 'minorSound' },
  { label: text('重大', 'Major'), popup: 'majorPopupEnabled', notification: 'majorNotificationEnabled', sound: 'majorSound' },
  { label: text('紧急', 'Critical'), popup: 'criticalPopupEnabled', notification: 'criticalNotificationEnabled', sound: 'criticalSound' },
] as Array<{ label: string; popup: AlertPreferenceBooleanKey; notification: AlertPreferenceBooleanKey; sound: AlertPreferenceSoundKey }>)
const alertSoundOptions = computed(() => [
  { label: text('系统单音', 'System single tone'), value: 'minor-soft' },
  { label: text('系统双音', 'System double tone'), value: 'major-chime' },
  { label: text('紧急短促音', 'Urgent short tone'), value: 'critical-pulse' },
  { label: text('清晰双音', 'Clear double tone'), value: 'rising-bell' },
  { label: text('低频提示音', 'Low tone'), value: 'falling-bell' },
  { label: text('数字短音', 'Digital short tone'), value: 'digital-ping' },
  { label: text('双击提醒音', 'Double reminder'), value: 'woodblock' },
  { label: text('重复提醒音', 'Repeating reminder'), value: 'rapid-signal' },
  { label: text('静音', 'Silent'), value: 'none' },
])
const hasEnabledPagePopup = computed(() => alertPreferenceRows.value.some((row) => (
  alertPreferencesDraft.value[row.popup] === true && alertPreferencesDraft.value[row.notification] === true
)))
const alertPreferencesDirty = computed(() => Object.keys(DEFAULT_ALERT_NOTIFICATION_PREFERENCES)
  .some((key) => alertPreferencesDraft.value[key as keyof AlertNotificationPreferences] !== alerts.preferences[key as keyof AlertNotificationPreferences]))
const localDemoRunning = ref(false)
let localDemoTimer: ReturnType<typeof setInterval> | null = null
let localDemoNotificationId = 900_000

const themeOptions = computed(() => ([
  { label: t('pages.settings.themeLight'), value: 'light' },
  { label: t('pages.settings.themeDark'), value: 'dark' },
]))

const localeOptions = computed(() => ([
  { label: t('common.languageZh'), value: 'zh-CN' },
  { label: t('common.languageEn'), value: 'en-US' },
]))

function handleThemeChange(mode: ThemeMode) {
  themeStore.setMode(mode)
}

function handleLocaleChange(locale: string) {
  if (locale === 'zh-CN' || locale === 'en-US') {
    localeStore.setLocale(locale as AppLocale)
  }
}

async function loadReportStorageStatus() {
  if (!authStore.isAdmin) return
  reportStorageLoading.value = true
  reportStorageError.value = false
  try {
    const response = await fetch('/api/system-settings/report-storage', {
      headers: { Authorization: `Bearer ${authStore.getToken() || ''}` },
    })
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      throw new Error(text('Admin BFF 尚未加载报告存储状态接口，请重启本地 Admin BFF 后重试', 'The Admin BFF has not loaded the report-storage status API. Restart the local Admin BFF and try again.'))
    }
    const data = await response.json()
    if (
      !response.ok
      || !data.ok
      || typeof data.reportStorageConfigured !== 'boolean'
      || typeof data.reportStorageRoot !== 'string'
      || !data.reportStorageRoot.trim()
    ) {
      throw new Error(localizeApiError(data, text('读取报告存储状态失败', 'Failed to load report-storage status')))
    }
    reportStorageConfigured.value = data.reportStorageConfigured
    reportStorageRoot.value = data.reportStorageRoot
  } catch (error) {
    reportStorageError.value = true
    message.error(error instanceof Error ? error.message : text('读取报告存储状态失败', 'Failed to load report-storage status'))
  } finally {
    reportStorageLoading.value = false
  }
}

function resetAlertPreferencesDraft() {
  alertPreferencesDraft.value = { ...alerts.preferences }
  alertPreferencesLoaded.value = alerts.preferencesReady
}

function updatePopupPreference(key: AlertPreferenceBooleanKey, value: boolean) {
  alertPreferencesDraft.value[key] = value
}

function updateSoundPreference(key: AlertPreferenceSoundKey, value: unknown) {
  if (isAlertSoundId(value)) alertPreferencesDraft.value[key] = value
}

async function previewAlertSound(sound: AlertSoundId) {
  await primeAlertNotificationSound()
  playAlertNotificationSound(sound)
}

function simulateAlert(severity: AlertNotificationSeverity) {
  if (!LOCAL_ALERT_SOUND_DEMO) return
  localDemoNotificationId += 1
  alerts.addEvent({
    type: 'alert',
    action: 'triggered',
    cursor: localDemoNotificationId,
    notificationId: localDemoNotificationId,
    receiverGeneration: 1,
    payload: {
      id: `local-alert-${localDemoNotificationId}`,
      severity,
      categoryLabel: '本地演示告警',
      name: `${severity}级模拟告警`,
      source: '本地演示',
      occurredAt: new Date().toISOString(),
    },
  })
}

function toggleLocalDemo() {
  if (!LOCAL_ALERT_SOUND_DEMO) return
  if (localDemoTimer) {
    clearInterval(localDemoTimer)
    localDemoTimer = null
    localDemoRunning.value = false
    return
  }
  const levels: AlertNotificationSeverity[] = ['轻微', '重大', '紧急']
  let index = 0
  simulateAlert(levels[index++] || '轻微')
  localDemoTimer = setInterval(() => simulateAlert(levels[index++ % levels.length] || '轻微'), 4_000)
  localDemoRunning.value = true
}

async function loadAlertPreferences() {
  if (!canConfigureAlertNotifications.value) return
  await alerts.loadPreferences()
  resetAlertPreferencesDraft()
}

async function saveAlertPreferences() {
  try {
    const saved = await alerts.savePreferences({ ...alertPreferencesDraft.value })
    alertPreferencesDraft.value = { ...saved }
    message.success(LOCAL_ALERT_SOUND_DEMO
      ? text('本地演示设置已更新。', 'Local demo settings were updated.')
      : text('告警通知设置已保存；仅影响之后到达的新事件。', 'Alert notification settings saved. They affect only newly arriving events.'))
  } catch {
    message.error(text('保存告警通知设置失败，请检查连接后重试。', 'Failed to save alert notification settings. Check the connection and try again.'))
  }
}

watch(() => alerts.preferences, resetAlertPreferencesDraft, { deep: true })

onMounted(() => {
  void loadReportStorageStatus()
  void loadAlertPreferences()
})

onUnmounted(() => {
  if (localDemoTimer) clearInterval(localDemoTimer)
})
</script>

<template>
  <NSpace vertical :size="16">
    <NCard :title="text('基本信息', 'Basic information')" class="app-card">
      <NText strong style="font-size: 18px;">{{ t('app.brand') }}</NText>
      <NText depth="3" style="display: block; margin-top: 8px;">{{ text('当前产品版本：v1', 'Current product version: v1') }}</NText>
      <NText depth="3" style="display: block; margin-top: 12px;">{{ text('系统设置仅维护平台使用策略；NAPM 连接信息请在数据源管理中维护。', 'System settings maintain platform usage policies only. Maintain NAPM connection details in Data Source Management.') }}</NText>
    </NCard>

    <section id="session-settings">
      <SessionManagementPage />
    </section>

    <NCard :title="text('报告存储', 'Report storage')" class="app-card">
      <NAlert type="info" :bordered="false">{{ text('以下为正式报告的真实存储路径，由部署配置只读控制，不能在网页中修改。报告的查看、筛选、下载与删除请在“报告文件管理”页面进行。', 'The path below is the real storage location for formal reports. Deployment configuration controls it as read-only and it cannot be changed in the browser. View, filter, download, and delete reports in Report Management.') }}</NAlert>
      <NForm v-if="authStore.isAdmin" label-placement="left" label-width="150" style="max-width: 760px; margin-top: 16px;">
        <NFormItem :label="text('真实存储路径', 'Actual storage path')">
          <NText :type="reportStorageConfigured ? 'success' : 'warning'">{{ reportStorageLoading ? text('正在读取…', 'Loading…') : reportStorageRoot }}</NText>
        </NFormItem>
      </NForm>
      <NAlert v-else type="warning" :bordered="false" style="margin-top: 16px;">{{ text('仅管理员可查看报告真实存储路径。', 'Only administrators can view the actual report storage path.') }}</NAlert>
      <NAlert v-if="reportStorageError && authStore.isAdmin" type="warning" :bordered="false" style="margin-top: 12px;">{{ text('暂时无法读取报告存储状态，请确认 Admin BFF 已启动并完成部署配置。', 'Report-storage status is temporarily unavailable. Confirm that the Admin BFF is running and deployment configuration is complete.') }}</NAlert>
    </NCard>

    <NCard v-if="canConfigureAlertNotifications" :title="text('告警通知设置', 'Alert notification settings')" class="app-card alert-preferences-card">
      <NAlert type="info" :bordered="false">
        {{ text('设置仅属于当前账户。页面弹窗依赖同级告警通知：关闭通知会暂时关闭弹窗，重新打开后恢复原选择。关闭实时告警提醒时也会保留各子项选择；保存后仅影响新到达的告警，现有告警通知不会被移除。', 'Settings belong only to your account. A page popup depends on alert notification for the same severity: turning notification off temporarily disables the popup and restores its saved choice when notification is turned back on. Turning off real-time alerts also preserves each choice. Saved changes affect only new alerts and do not remove existing notifications.') }}
      </NAlert>
      <NAlert v-if="alerts.preferencesLoadError" type="warning" :bordered="false" class="alert-preferences-message">
        {{ text('暂时无法读取已保存设置，当前已按全部开启的安全默认值继续接收告警；请重试。', 'Saved settings could not be loaded. Alerts remain enabled using the safe default; please retry.') }}
      </NAlert>
      <NAlert v-if="alerts.preferencesSaveError" type="error" :bordered="false" class="alert-preferences-message">
        {{ text('上一次保存没有成功，页面保留未保存的选择。', 'The last save did not succeed. Your unsaved choices are still shown.') }}
      </NAlert>
      <div v-if="alerts.preferencesLoading && !alertPreferencesLoaded" class="alert-preferences-loading">{{ text('正在读取账户设置…', 'Loading account settings…') }}</div>
      <template v-else>
        <NAlert v-if="LOCAL_ALERT_SOUND_DEMO" type="warning" :bordered="false" class="alert-preferences-message">
          {{ text('本地演示模式：设置只保存在当前浏览器内存，不读取、不写入 237。可用下方按钮模拟实时告警。', 'Local demo mode: settings stay only in browser memory and never read or write 237. Use the buttons below to simulate live alerts.') }}
        </NAlert>
        <div class="alert-preferences-master">
          <div><NText strong>{{ text('实时告警提醒', 'Real-time alert reminders') }}</NText><NText depth="3">{{ text('控制本账户新到达告警的页面弹窗、声音和通知条目。', 'Controls popups, sound, and notification entries for new alerts in this account.') }}</NText></div>
          <NSwitch v-model:value="alertPreferencesDraft.realtimeEnabled" />
        </div>
        <div class="alert-preferences-sound">
          <div><NText strong>{{ text('声音提醒', 'Sound reminders') }}</NText><NText depth="3">{{ text('仅在实际创建页面弹窗时播放；没有可用页面弹窗时不会发声。', 'Only plays when a popup is actually created; it stays silent when no page popup is enabled.') }}</NText></div>
          <NSwitch v-model:value="alertPreferencesDraft.soundEnabled" :disabled="!alertPreferencesDraft.realtimeEnabled || !hasEnabledPagePopup" />
        </div>
        <div class="alert-preferences-grid" :class="{ 'is-disabled': !alertPreferencesDraft.realtimeEnabled }">
          <div class="alert-preferences-grid-header">{{ text('级别', 'Severity') }}</div>
          <div class="alert-preferences-grid-header">{{ text('页面弹窗', 'Page popup') }}</div>
          <div class="alert-preferences-grid-header">{{ text('告警通知', 'Alert notification') }}</div>
          <div class="alert-preferences-grid-header">{{ text('提示音', 'Sound') }}</div>
          <div class="alert-preferences-grid-header">{{ text('试听', 'Preview') }}</div>
          <template v-for="row in alertPreferenceRows" :key="row.popup">
            <NText>{{ row.label }}</NText>
            <NSwitch
              :value="alertPreferencesDraft[row.popup] && alertPreferencesDraft[row.notification]"
              :disabled="!alertPreferencesDraft.realtimeEnabled || !alertPreferencesDraft[row.notification]"
              @update:value="updatePopupPreference(row.popup, $event)"
            />
            <NSwitch v-model:value="alertPreferencesDraft[row.notification]" :disabled="!alertPreferencesDraft.realtimeEnabled" />
            <div class="alert-preferences-control-cell"><NSelect :value="alertPreferencesDraft[row.sound]" :options="alertSoundOptions" :disabled="!alertPreferencesDraft.realtimeEnabled" @update:value="updateSoundPreference(row.sound, $event)" /></div>
            <div class="alert-preferences-control-cell"><NButton size="small" :disabled="!alertPreferencesDraft.realtimeEnabled || alertPreferencesDraft[row.sound] === 'none'" @click="previewAlertSound(alertPreferencesDraft[row.sound])">{{ text('试听', 'Preview') }}</NButton></div>
          </template>
        </div>
        <NSpace v-if="LOCAL_ALERT_SOUND_DEMO" class="alert-preferences-demo" wrap>
          <NText strong>{{ text('模拟实时告警：', 'Simulate live alerts:') }}</NText>
          <NButton size="small" @click="simulateAlert('轻微')">{{ text('模拟轻微', 'Simulate minor') }}</NButton>
          <NButton size="small" @click="simulateAlert('重大')">{{ text('模拟重大', 'Simulate major') }}</NButton>
          <NButton size="small" @click="simulateAlert('紧急')">{{ text('模拟紧急', 'Simulate critical') }}</NButton>
          <NButton size="small" type="primary" @click="toggleLocalDemo">{{ localDemoRunning ? text('停止自动连续告警', 'Stop automatic alerts') : text('开启自动连续告警', 'Start automatic alerts') }}</NButton>
        </NSpace>
        <NSpace justify="end" class="alert-preferences-actions">
          <NButton :disabled="!alertPreferencesDirty || alerts.preferencesSaving" @click="resetAlertPreferencesDraft">{{ text('放弃修改', 'Discard changes') }}</NButton>
          <NButton type="primary" :loading="alerts.preferencesSaving" :disabled="!alertPreferencesDirty || alerts.preferencesLoading" @click="saveAlertPreferences">{{ text('保存设置', 'Save settings') }}</NButton>
        </NSpace>
      </template>
    </NCard>

    <NCard :title="text('界面偏好', 'Interface preferences')" class="app-card">
      <NForm label-placement="left" label-width="120" style="max-width: 500px;">
        <ChatDisplayPreferencesPanel />
        <NFormItem :label="t('pages.settings.interfaceLanguage')">
          <NSelect
            :value="localeStore.locale"
            :options="localeOptions"
            @update:value="handleLocaleChange"
          />
        </NFormItem>
        <NFormItem :label="t('pages.settings.themeMode')">
          <NSelect
            :value="themeStore.mode"
            :options="themeOptions"
            @update:value="handleThemeChange"
          />
        </NFormItem>
      </NForm>
    </NCard>
  </NSpace>
</template>

<style scoped>
.alert-preferences-card :deep(.n-alert) { margin-bottom: 16px; }
.alert-preferences-message { margin-top: 12px; }
.alert-preferences-loading { color: var(--text-color-3); padding: 18px 0 4px; }
.alert-preferences-master, .alert-preferences-sound { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 14px 0; }
.alert-preferences-master :deep(.n-text--depth-3), .alert-preferences-sound :deep(.n-text--depth-3) { display: block; margin-top: 4px; line-height: 1.5; }
.alert-preferences-sound { border-top: 1px solid var(--border-color); }
.alert-preferences-grid { display: grid; grid-template-columns: minmax(70px, .8fr) minmax(92px, 1fr) minmax(108px, 1fr) minmax(154px, 1.45fr) minmax(66px, .65fr); align-items: center; gap: 0; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; }
.alert-preferences-grid > * { min-height: 48px; display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border-color); }
.alert-preferences-grid > *:nth-last-child(-n + 5) { border-bottom: 0; }
.alert-preferences-grid > *:not(:nth-child(5n + 1)) { border-left: 1px solid var(--border-color); justify-content: center; }
.alert-preferences-grid-header { font-size: 13px; color: var(--text-color-3); background: var(--table-header-color, var(--card-color)); }
.alert-preferences-grid.is-disabled { opacity: .66; }
.alert-preferences-control-cell :deep(.n-base-selection), .alert-preferences-control-cell :deep(.n-button) { width: 100%; }
.alert-preferences-actions { margin-top: 16px; }
.alert-preferences-demo { align-items: center; margin-top: 16px; }
@media (max-width: 560px) {
  .alert-preferences-master, .alert-preferences-sound { align-items: flex-start; }
  .alert-preferences-grid { grid-template-columns: 1fr 88px; font-size: 13px; }
  .alert-preferences-grid > * { min-height: 42px; padding: 9px 10px; }
  .alert-preferences-grid > *:nth-last-child(-n + 5) { border-bottom: 1px solid var(--border-color); }
  .alert-preferences-grid > *:not(:nth-child(5n + 1)) { justify-content: flex-start; border-left: 0; }
  .alert-preferences-grid > *:nth-child(5n + 1) { grid-column: 1 / -1; padding-bottom: 2px; border-bottom: 0; background: var(--table-header-color, var(--card-color)); }
  .alert-preferences-grid-header { display: none; }
}
</style>
