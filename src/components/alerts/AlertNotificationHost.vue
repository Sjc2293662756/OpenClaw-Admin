<script setup lang="ts">
import { computed, h, onUnmounted, ref, watch } from 'vue'
import { NAlert, NButton, NButtonGroup, NDrawer, NDrawerContent, NEmpty, NIcon, NList, NListItem, NSelect, NTag, NText, NSpace, useNotification } from 'naive-ui'
import { ChevronDownOutline, ChevronUpOutline, EyeOutline, TrashOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAlertRealtimeStore, type AlertRealtimeItem } from '@/stores/alert-realtime'
import { alertActionLabel, alertSeverityLabel, alertSeverityType, alertSource, alertSummary, formatAlertTime } from '@/alerts/presentation'
import { alertNotificationDuration, alertNotificationType } from '@/alerts/notification-policy'
import { destroyActiveNotification, destroyAllActiveNotifications, forgetActiveNotification } from '@/alerts/notification-lifecycle'

const router = useRouter()
const { t, locale } = useI18n()
const alerts = useAlertRealtimeStore()
const notification = useNotification()
const detailCursor = ref<number | null>(null)
const severityFilter = ref('__all__')
const freshCursor = ref<number | null>(null)
const activeNotifications = new Map<number, { destroy: () => void }>()
let freshTimer: ReturnType<typeof setTimeout> | null = null

const severityOptions = computed(() => [
  { label: t('pages.gaiop.alerts.allSeverity'), value: '__all__' },
  ...['紧急', '重大', '轻微'].map((severity) => ({ label: alertSeverityLabel(severity, locale.value), value: severity })),
])
const filteredEvents = computed(() => alerts.recentEvents.filter((item) => severityFilter.value === '__all__'
  || String(item.payload.severity || '') === severityFilter.value))

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

function notifyNext() {
  if (alerts.messageCenterOpen) return
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
}

watch(() => alerts.notificationQueue.length, () => notifyNext(), { immediate: true })
watch(() => alerts.messageCenterOpen, (open) => {
  if (!open) return
  destroyAllActiveNotifications(activeNotifications)
})
watch(() => alerts.activeAccount, () => destroyAllActiveNotifications(activeNotifications))
watch(() => alerts.recentEvents[0]?.cursor, (cursor) => {
  if (!alerts.messageCenterOpen || cursor === undefined) return
  freshCursor.value = cursor
  if (freshTimer) clearTimeout(freshTimer)
  freshTimer = setTimeout(() => { freshCursor.value = null }, 4_000)
})
onUnmounted(() => {
  if (freshTimer) clearTimeout(freshTimer)
  destroyAllActiveNotifications(activeNotifications)
})

function toggleExpanded(cursor: number) { detailCursor.value = detailCursor.value === cursor ? null : cursor }
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
        <NButton :disabled="!alerts.unreadCount" @click="alerts.markRead()">{{ t('pages.gaiop.alertCenter.markAllRead') }}</NButton>
        <NButton :disabled="!alerts.recentEvents.length" @click="alerts.clear()">{{ t('pages.gaiop.alertCenter.clear') }}</NButton>
      </NButtonGroup>
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
            <NText depth="3" class="alert-center-meta">{{ alertActionLabel(item.action, locale) }} · {{ alertSource(item.payload, notRecorded()) }} · {{ formatAlertTime(item.payload.occurredAt, locale, notRecorded()) }}</NText>
            <NSpace class="alert-center-actions" :size="6">
              <NButton text size="small" @click.stop="toggleExpanded(item.cursor)"><template #icon><NIcon :component="isExpanded(item.cursor) ? ChevronUpOutline : ChevronDownOutline" /></template>{{ t('pages.gaiop.alertCenter.brief') }}</NButton>
              <NButton text type="primary" size="small" @click.stop="showDetails(item)"><template #icon><NIcon :component="EyeOutline" /></template>{{ t('pages.gaiop.alertCenter.viewDetails') }}</NButton>
            </NSpace>
            <div v-if="isExpanded(item.cursor)" class="alert-center-brief">
              <NText>{{ t('pages.gaiop.alertCenter.source') }}: {{ alertSource(item.payload, notRecorded()) }}</NText>
              <NText>{{ t('pages.gaiop.alertCenter.time') }}: {{ formatAlertTime(item.payload.occurredAt, locale, notRecorded()) }}</NText>
              <NText>{{ t('pages.gaiop.alertCenter.delivery') }}: {{ item.deliverySource === 'live' ? t('pages.gaiop.alertCenter.live') : t('pages.gaiop.alertCenter.compensation') }}</NText>
            </div>
          </div>
        </NListItem>
      </NList>
      <NEmpty v-else :description="t('pages.gaiop.alertCenter.empty')" />
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.alert-center-status { margin-bottom: 12px; }
.alert-center-toolbar { margin-bottom: 12px; }
.alert-center-filter { width: 100%; margin-bottom: 12px; }
.alert-center-item { display: grid; gap: 5px; cursor: pointer; }
.alert-center-meta { font-size: 12px; line-height: 1.5; }
.alert-center-actions { margin-top: 2px; }
.alert-center-brief { display: grid; gap: 3px; margin-top: 5px; font-size: 12px; }
.alert-center-read { opacity: .68; }
.alert-center-fresh { background: color-mix(in srgb, var(--primary-color) 10%, transparent); transition: background .35s ease; }
</style>
