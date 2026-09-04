<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NButtonGroup, NSelect, NSwitch, NText } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  DEFAULT_ALERT_NOTIFICATION_PREFERENCES,
  useAlertRealtimeStore,
  type AlertNotificationPreferences,
} from '@/stores/alert-realtime'
import { isAlertSoundId, playAlertNotificationSound, primeAlertNotificationSound, type AlertSoundId } from '@/alerts/notification-sound'

type AlertPreferenceBooleanKey = Exclude<keyof AlertNotificationPreferences, 'updatedAt' | 'minorSound' | 'majorSound' | 'criticalSound'>
type AlertPreferenceSoundKey = Extract<keyof AlertNotificationPreferences, 'minorSound' | 'majorSound' | 'criticalSound'>

const { locale } = useI18n()
const alerts = useAlertRealtimeStore()
const text = (zhCN: string, enUS: string) => locale.value === 'zh-CN' ? zhCN : enUS
const draft = ref<AlertNotificationPreferences>({ ...DEFAULT_ALERT_NOTIFICATION_PREFERENCES })
const loaded = ref(false)
const rows = computed(() => [
  { label: text('轻微', 'Minor'), popup: 'minorPopupEnabled', notification: 'minorNotificationEnabled', sound: 'minorSound' },
  { label: text('重大', 'Major'), popup: 'majorPopupEnabled', notification: 'majorNotificationEnabled', sound: 'majorSound' },
  { label: text('紧急', 'Critical'), popup: 'criticalPopupEnabled', notification: 'criticalNotificationEnabled', sound: 'criticalSound' },
] as Array<{ label: string; popup: AlertPreferenceBooleanKey; notification: AlertPreferenceBooleanKey; sound: AlertPreferenceSoundKey }>)
const soundOptions = computed(() => [
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
const hasEnabledPagePopup = computed(() => rows.value.some((row) => draft.value[row.popup] && draft.value[row.notification]))
const dirty = computed(() => Object.keys(DEFAULT_ALERT_NOTIFICATION_PREFERENCES)
  .some((key) => draft.value[key as keyof AlertNotificationPreferences] !== alerts.preferences[key as keyof AlertNotificationPreferences]))

function reset() {
  draft.value = { ...alerts.preferences }
  loaded.value = alerts.preferencesReady
}

function updatePopup(key: AlertPreferenceBooleanKey, value: boolean) {
  draft.value[key] = value
}

function updateSound(key: AlertPreferenceSoundKey, value: unknown) {
  if (isAlertSoundId(value)) draft.value[key] = value
}

async function previewSound(sound: AlertSoundId) {
  await primeAlertNotificationSound()
  playAlertNotificationSound(sound)
}

async function save() {
  try {
    const saved = await alerts.savePreferences({ ...draft.value })
    draft.value = { ...saved }
  } catch {
    // The visible error below preserves the draft for an explicit retry.
  }
}

async function retry() {
  await alerts.retryPreferences()
  reset()
}

watch(() => alerts.preferences, reset, { deep: true })
onMounted(async () => {
  await alerts.loadPreferences()
  reset()
})
</script>

<template>
  <section class="alert-preferences">
    <NAlert type="info" :bordered="false">
      {{ text('设置仅属于当前账户，只影响之后到达的新告警。页面弹窗依赖同级告警通知；关闭通知会暂时关闭弹窗并保留原选择。', 'Settings belong only to this account and affect only future alerts. A page popup depends on alert notification for the same severity; disabling notification temporarily disables the popup while preserving its choice.') }}
    </NAlert>
    <NAlert v-if="alerts.preferencesLoadError" type="warning" :bordered="false">
      {{ text('暂时无法读取已保存设置，当前按全部开启的安全默认值继续接收告警；请在此重试。', 'Saved settings could not be loaded. Alerts remain enabled using the safe default; retry here.') }}
    </NAlert>
    <NButton v-if="alerts.preferencesLoadError" size="small" :loading="alerts.preferencesLoading" class="alert-preferences-retry" @click="retry">{{ text('重试', 'Retry') }}</NButton>
    <NAlert v-if="alerts.preferencesSaveError" type="error" :bordered="false">
      {{ text('上一次保存没有成功，当前保留未保存的选择。', 'The last save did not succeed. Your unsaved choices are still shown.') }}
    </NAlert>
    <div v-if="alerts.preferencesLoading && !loaded" class="alert-preferences-loading">{{ text('正在读取账户设置…', 'Loading account settings…') }}</div>
    <template v-else>
      <div class="alert-preferences-row">
        <div><NText strong>{{ text('实时告警提醒', 'Real-time alert reminders') }}</NText><NText depth="3">{{ text('控制本账户的新通知、页面弹窗和声音。', 'Controls this account’s new notifications, popups, and sound.') }}</NText></div>
        <NSwitch v-model:value="draft.realtimeEnabled" />
      </div>
      <div class="alert-preferences-row">
        <div><NText strong>{{ text('声音提醒', 'Sound reminders') }}</NText><NText depth="3">{{ text('仅在实际创建页面弹窗时播放。', 'Plays only when a page popup is actually created.') }}</NText></div>
        <NSwitch v-model:value="draft.soundEnabled" :disabled="!draft.realtimeEnabled || !hasEnabledPagePopup" />
      </div>
      <div class="alert-preferences-grid" :class="{ 'is-disabled': !draft.realtimeEnabled }">
        <div class="alert-preferences-grid-header">{{ text('级别', 'Severity') }}</div>
        <div class="alert-preferences-grid-header">{{ text('页面弹窗', 'Page popup') }}</div>
        <div class="alert-preferences-grid-header">{{ text('告警通知', 'Alert notification') }}</div>
        <div class="alert-preferences-grid-header">{{ text('提示音', 'Sound') }}</div>
        <div class="alert-preferences-grid-header">{{ text('试听', 'Preview') }}</div>
        <template v-for="row in rows" :key="row.popup">
          <NText>{{ row.label }}</NText>
          <NSwitch :value="draft[row.popup] && draft[row.notification]" :disabled="!draft.realtimeEnabled || !draft[row.notification]" @update:value="updatePopup(row.popup, $event)" />
          <NSwitch v-model:value="draft[row.notification]" :disabled="!draft.realtimeEnabled" />
          <div class="alert-preferences-control-cell"><NSelect :value="draft[row.sound]" :options="soundOptions" :disabled="!draft.realtimeEnabled" @update:value="updateSound(row.sound, $event)" /></div>
          <div class="alert-preferences-control-cell"><NButton size="small" :disabled="!draft.realtimeEnabled || draft[row.sound] === 'none'" @click="previewSound(draft[row.sound])">{{ text('试听', 'Preview') }}</NButton></div>
        </template>
      </div>
      <NButtonGroup class="alert-preferences-actions">
        <NButton :disabled="!dirty || alerts.preferencesSaving" @click="reset">{{ text('放弃修改', 'Discard') }}</NButton>
        <NButton type="primary" :loading="alerts.preferencesSaving" :disabled="!dirty || alerts.preferencesLoading" @click="save">{{ text('保存设置', 'Save settings') }}</NButton>
      </NButtonGroup>
    </template>
  </section>
</template>

<style scoped>
.alert-preferences { display: grid; gap: 12px; }
.alert-preferences-loading { color: var(--text-color-3); padding: 18px 0 4px; }
.alert-preferences-retry { justify-self: start; margin-top: -4px; }
.alert-preferences-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 10px 0; border-bottom: 1px solid var(--border-color); }
.alert-preferences-row :deep(.n-text--depth-3) { display: block; margin-top: 4px; line-height: 1.5; }
.alert-preferences-grid { display: grid; grid-template-columns: minmax(70px, .8fr) minmax(92px, 1fr) minmax(108px, 1fr) minmax(154px, 1.45fr) minmax(66px, .65fr); align-items: center; overflow: hidden; border: 1px solid var(--border-color); border-radius: 8px; }
.alert-preferences-grid > * { display: flex; align-items: center; min-height: 48px; padding: 10px 14px; border-bottom: 1px solid var(--border-color); }
.alert-preferences-grid > *:nth-last-child(-n + 5) { border-bottom: 0; }
.alert-preferences-grid > *:not(:nth-child(5n + 1)) { justify-content: center; border-left: 1px solid var(--border-color); }
.alert-preferences-grid-header { font-size: 13px; color: var(--text-color-3); background: var(--table-header-color, var(--card-color)); }
.alert-preferences-grid.is-disabled { opacity: .66; }
.alert-preferences-control-cell :deep(.n-base-selection), .alert-preferences-control-cell :deep(.n-button) { width: 100%; }
.alert-preferences-actions { justify-self: end; }
@media (max-width: 560px) {
  .alert-preferences-row { align-items: flex-start; }
  .alert-preferences-grid { grid-template-columns: 1fr 88px; font-size: 13px; }
  .alert-preferences-grid > * { min-height: 42px; padding: 9px 10px; }
  .alert-preferences-grid > *:nth-last-child(-n + 5) { border-bottom: 1px solid var(--border-color); }
  .alert-preferences-grid > *:not(:nth-child(5n + 1)) { justify-content: flex-start; border-left: 0; }
  .alert-preferences-grid > *:nth-child(5n + 1) { grid-column: 1 / -1; padding-bottom: 2px; border-bottom: 0; background: var(--table-header-color, var(--card-color)); }
  .alert-preferences-grid-header { display: none; }
}
</style>
