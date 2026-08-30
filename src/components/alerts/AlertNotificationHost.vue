<script setup lang="ts">
import { computed, h, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NButtonGroup, NDrawer, NDrawerContent, NEmpty, NIcon, NList, NListItem, NModal, NSelect, NTag, NText, NSpace, useNotification } from 'naive-ui'
import { ChevronDownOutline, ChevronUpOutline, EyeOutline, SettingsOutline, TrashOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAlertRealtimeStore, type AlertRealtimeItem } from '@/stores/alert-realtime'
import { alertActionLabel, alertSeverityLabel, alertSeverityType, alertSource, alertSummary, formatAlertTime } from '@/alerts/presentation'
import { alertNotificationDuration, alertNotificationType } from '@/alerts/notification-policy'
import { destroyActiveNotification, destroyAllActiveNotifications, forgetActiveNotification } from '@/alerts/notification-lifecycle'
import { playAlertNotificationSound } from '@/alerts/notification-sound'
import AlertNotificationPreferencesPanel from './AlertNotificationPreferencesPanel.vue'

const router = useRouter()
const { t, locale } = useI18n()
const alerts = useAlertRealtimeStore()
const notification = useNotification()
const detailCursor = ref<number | null>(null)
const severityFilter = ref('__all__')
const freshCursor = ref<number | null>(null)
const preferencesVisible = ref(false)
const activeNotifications = new Map<number, { destroy: () => void }>()
let freshTimer: ReturnType<typeof setTimeout> | null = null

const severityOptions = computed(() => [
  { label: t('pages.gaiop.alerts.allSeverity'), value: '__all__' },
  ...['紧急', '重大', '轻微'].map((severity) => ({ label: alertSeverityLabel(severity, locale.value), value: severity })),
])
const filteredEvents = computed(() => alerts.recentEvents.filter((item) => severityFilter.value === '__all__'
  || String(item.payload.severity || '') === severityFilter.value))
const selectedSeverity = computed(() => severityFilter.value === '__all__' ? null : severityFilter.value)
const filteredUnreadCount = computed(() => filteredEvents.value.filter((item) => !item.read).length)
const markAllLabel = computed(() => selectedSeverity.value === null ? t('pages.gaiop.alertCenter.markAllRead') : t('pages.gaiop.alertCenter.markFilteredRead'))
const clearLabel = computed(() => selectedSeverity.value === null ? t('pages.gaiop.alertCenter.clear') : t('pages.gaiop.alertCenter.clearFiltered'))

function notRecorded() { return t('pages.gaiop.alerts.notRecorded') }
function showDetails(item: AlertRealtimeItem) {
  alerts.markRead(item.cursor)
  destroyActiveNotification(activeNotifications, item.cursor)
  alerts.closeMessageCenter()
  const current = router.currentRoute.value
  if (current.name === 'AlertNotifications' && String(current.query.focusAlert || '') === String(item.payload.id || '')) {
    alerts.requestDetailFocus()
  }
  void router.push({ name: 'AlertNotifications', query: { focusAlert: item.payload.id } })
}

function notificationDescription(item: AlertRealtimeItem) {
  const payload = item.payload as Record<string, unknown>
  return `${alertSummary(payload, notRecorded())} · ${alertSource(payload, notRecorded())} · ${formatAlertTime(payload.occurredAt, locale.value, notRecorded())}`
}

function briefFields(item: AlertRealtimeItem) {
  const payload = item.payload as Record<string, unknown>
  const fields: Array<{ label: string; value: string }> = []
  const add = (label: string, value: unknown) => {
    const text = typeof value === 'string' ? value.trim() : String(value || '').trim()
    if (text) fields.push({ label, value: text })
  }
  add(t('pages.gaiop.alertCenter.alertType'), payload.categoryLabel || payload.category)
  add(t('pages.gaiop.alertCenter.alertNumber'), payload.alertNumber)
  const metrics = Array.isArray(payload.metrics) ? payload.metrics
    .map((metric) => {
      const entry = metric as Record<string, unknown>
      return [entry.name, entry.value, entry.unit].map((value) => String(value || '').trim()).filter(Boolean).join(' ')
    }).filter(Boolean).join('；') : ''
  add(t('pages.gaiop.alertCenter.triggeredMetrics'), metrics)
  add(t('pages.gaiop.alertCenter.triggerCondition'), payload.triggerCondition)
  add(t('pages.gaiop.alertCenter.description'), payload.description)
  return fields
}

function markFilteredRead() { alerts.markReadBySeverity(selectedSeverity.value) }
function clearFiltered() { alerts.clearBySeverity(selectedSeverity.value) }

function notifyNext() {
  if (alerts.messageCenterOpen || alerts.alertDetailOpen) return
  const item = alerts.dequeueNotification()
  if (!item) return
  const payload = item.payload as Record<string, unknown>
  const notice = notification.create({
    title: `${alertSeverityLabel(String(payload.severity || ''), locale.value)} · ${t('pages.gaiop.alertCenter.triggered')}`,
    content: notificationDescription(item),
    type: alertNotificationType(String(payload.severity || '')),
    duration: alertNotificationDuration(String(payload.severity || '')),
    onAfterLeave: () => forgetActiveNotification(activeNotifications, item.cursor),
    action: () => h(NButton, { size: 'small', onClick: () => showDetails(item) }, { default: () => t('pages.gaiop.alertCenter.viewDetails') }),
  })
  activeNotifications.set(item.cursor, notice)
  // Sound is tied to an actually-created live popup, never merely to a
  // received SSE event or an item that only entered the notification drawer.
  if (alerts.preferences.realtimeEnabled && alerts.preferences.soundEnabled) playAlertNotificationSound()
}

watch(() => alerts.notificationQueue.length, () => notifyNext(), { immediate: true })
watch(() => alerts.messageCenterOpen, (open) => {
  if (!open) return
  destroyAllActiveNotifications(activeNotifications)
})
watch(() => alerts.alertDetailOpen, (open) => {
  if (open) destroyAllActiveNotifications(activeNotifications)
})
watch(() => alerts.activeAccount, () => destroyAllActiveNotifications(activeNotifications))
watch(() => alerts.recentEvents[0]?.cursor, (cursor) => {
  const newest = alerts.recentEvents[0]
  if (!newest || cursor === undefined) return
  if (alerts.messageCenterOpen) {
    freshCursor.value = cursor
    if (freshTimer) clearTimeout(freshTimer)
    freshTimer = setTimeout(() => { freshCursor.value = null }, 4_000)
  }
})
let lastPreferencesError: string | null = null
watch(() => alerts.preferencesLoadError, (error) => {
  if (!error || error === lastPreferencesError) return
  lastPreferencesError = error
  notification.warning({
    title: locale.value === 'zh-CN' ? '告警通知设置暂不可用' : 'Alert notification settings are unavailable',
    content: locale.value === 'zh-CN'
      ? '已按安全默认值保持全部提醒开启；请在告警通知设置中重试。'
      : 'All alerts remain enabled as the safe default. Retry in Alert notification settings.',
    duration: 0,
  })
})
onUnmounted(() => {
  if (freshTimer) clearTimeout(freshTimer)
  destroyAllActiveNotifications(activeNotifications)
})

function toggleExpanded(item: AlertRealtimeItem) {
  alerts.markRead(item.cursor)
  detailCursor.value = detailCursor.value === item.cursor ? null : item.cursor
}
function isExpanded(cursor: number) { return detailCursor.value === cursor }
function streamText() {
  if (alerts.hasActiveGap) return t('pages.gaiop.alertCenter.historyRefreshRequired')
  if (alerts.streamState !== 'connected' && alerts.streamState !== 'idle') return t('pages.gaiop.alertCenter.streamState', { state: alerts.streamState })
  return ''
}
</script>

<template>
  <NDrawer v-model:show="alerts.messageCenterOpen" placement="right" :width="420">
    <NDrawerContent :title="t('pages.gaiop.alertCenter.title')" closable>
      <NButtonGroup size="small" class="alert-center-toolbar">
        <NButton :disabled="!filteredUnreadCount" @click="markFilteredRead">{{ markAllLabel }}</NButton>
        <NButton :disabled="!filteredEvents.length" @click="clearFiltered">{{ clearLabel }}</NButton>
      </NButtonGroup>
      <NButton size="small" secondary class="alert-center-preferences" @click="preferencesVisible = true"><template #icon><NIcon :component="SettingsOutline" /></template>{{ t('pages.gaiop.alertCenter.preferences') }}</NButton>
      <NSelect v-model:value="severityFilter" :options="severityOptions" :aria-label="t('pages.gaiop.alertCenter.severityFilter')" class="alert-center-filter" />
      <NAlert v-if="streamText()" type="warning" :bordered="false" class="alert-center-status">{{ streamText() }}</NAlert>
      <NList v-if="filteredEvents.length" hoverable clickable>
        <NListItem v-for="item in filteredEvents" :key="item.cursor" :class="{ 'alert-center-read': item.read, 'alert-center-fresh': freshCursor === item.cursor }">
          <template #prefix><NTag :type="alertSeverityType(String(item.payload.severity || ''))" :bordered="false">{{ alertSeverityLabel(String(item.payload.severity || ''), locale) }}</NTag></template>
          <template #suffix>
            <NButton quaternary circle size="small" :aria-label="t('pages.gaiop.alertCenter.remove')" @click.stop="alerts.remove(item.cursor)"><template #icon><NIcon :component="TrashOutline" /></template></NButton>
          </template>
          <div class="alert-center-item" @click="alerts.markRead(item.cursor)">
            <NText strong>{{ alertSummary(item.payload, notRecorded()) }}</NText>
            <div class="alert-center-meta">
              <span>{{ alertActionLabel(item.action, locale) }}</span>
              <span>{{ t('pages.gaiop.alertCenter.dataSource') }}: {{ alertSource(item.payload, notRecorded()) }}</span>
            </div>
            <NText depth="3" class="alert-center-time">{{ formatAlertTime(item.payload.occurredAt, locale, notRecorded()) }}</NText>
            <NSpace class="alert-center-actions" :size="6">
              <NButton text size="small" @click.stop="toggleExpanded(item)"><template #icon><NIcon :component="isExpanded(item.cursor) ? ChevronUpOutline : ChevronDownOutline" /></template>{{ t('pages.gaiop.alertCenter.brief') }}</NButton>
              <NButton text type="primary" size="small" @click.stop="showDetails(item)"><template #icon><NIcon :component="EyeOutline" /></template>{{ t('pages.gaiop.alertCenter.viewDetails') }}</NButton>
            </NSpace>
            <div v-if="isExpanded(item.cursor)" class="alert-center-brief">
              <NText v-for="field in briefFields(item)" :key="field.label"><strong>{{ field.label }}:</strong> {{ field.value }}</NText>
            </div>
          </div>
        </NListItem>
      </NList>
      <NEmpty v-else :description="t('pages.gaiop.alertCenter.empty')" />
    </NDrawerContent>
  </NDrawer>
  <NModal v-model:show="preferencesVisible" preset="card" :title="t('pages.gaiop.alertCenter.preferences')" style="width: min(680px, 94vw)">
    <AlertNotificationPreferencesPanel />
  </NModal>
</template>

<style scoped>
.alert-center-status { margin-bottom: 12px; }
.alert-center-toolbar { margin-bottom: 12px; }
.alert-center-preferences { margin: 0 0 12px; }
.alert-center-filter { width: 100%; margin-bottom: 12px; }
.alert-center-item { display: grid; gap: 5px; cursor: pointer; }
.alert-center-meta { display: flex; flex-wrap: wrap; gap: 2px 12px; color: var(--text-color-3, #8a8f98); font-size: 12px; line-height: 1.5; }
.alert-center-time { font-size: 12px; line-height: 1.5; }
.alert-center-actions { margin-top: 2px; }
.alert-center-brief { display: grid; gap: 5px; margin-top: 5px; font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.alert-center-read { opacity: .68; }
.alert-center-fresh { background: color-mix(in srgb, var(--primary-color) 10%, transparent); transition: background .35s ease; }
</style>
