<script setup lang="ts">
import { h, watch } from 'vue'
import { NAlert, NButton, NButtonGroup, NDrawer, NDrawerContent, NEmpty, NIcon, NList, NListItem, NTag, NText, NSpace, useNotification } from 'naive-ui'
import { ChevronDownOutline, ChevronUpOutline, EyeOutline, TrashOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useAlertRealtimeStore, type AlertRealtimeItem } from '@/stores/alert-realtime'
import { alertActionLabel, alertSeverityLabel, alertSeverityType, alertSource, alertSummary, formatAlertTime } from '@/alerts/presentation'
import { alertNotificationDuration, alertNotificationType } from '@/alerts/notification-policy'

const router = useRouter()
const { t, locale } = useI18n()
const alerts = useAlertRealtimeStore()
const notification = useNotification()
let detailCursor: number | null = null

function notRecorded() { return t('pages.gaiop.alerts.notRecorded') }
function showDetails(item: AlertRealtimeItem) {
  alerts.markRead(item.cursor)
  void router.push({ name: 'AlertNotifications', query: { focusAlert: item.payload.id } })
}

function notificationDescription(item: AlertRealtimeItem) {
  const payload = item.payload as Record<string, unknown>
  return `${alertSummary(payload, notRecorded())} · ${alertSource(payload, notRecorded())} · ${formatAlertTime(payload.occurredAt, locale.value, notRecorded())}`
}

function notifyNext() {
  const item = alerts.dequeueNotification()
  if (!item) return
  const payload = item.payload as Record<string, unknown>
  notification.create({
    title: `${alertSeverityLabel(String(payload.severity || ''), locale.value)} · ${t('pages.gaiop.alertCenter.triggered')}`,
    content: notificationDescription(item),
    type: alertNotificationType(String(payload.severity || '')),
    duration: alertNotificationDuration(String(payload.severity || '')),
    action: () => h(NButton, { size: 'small', onClick: () => showDetails(item) }, { default: () => t('pages.gaiop.alertCenter.viewDetails') }),
  })
}

watch(() => alerts.notificationQueue.length, () => notifyNext(), { immediate: true })

function toggleExpanded(cursor: number) { detailCursor = detailCursor === cursor ? null : cursor }
function isExpanded(cursor: number) { return detailCursor === cursor }
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
      <NAlert v-if="streamText()" type="warning" :bordered="false" class="alert-center-status">{{ streamText() }}</NAlert>
      <NList v-if="alerts.recentEvents.length" hoverable clickable>
        <NListItem v-for="item in alerts.recentEvents" :key="item.cursor" :class="{ 'alert-center-read': item.read }">
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
.alert-center-item { display: grid; gap: 5px; cursor: pointer; }
.alert-center-meta { font-size: 12px; line-height: 1.5; }
.alert-center-actions { margin-top: 2px; }
.alert-center-brief { display: grid; gap: 3px; margin-top: 5px; font-size: 12px; }
.alert-center-read { opacity: .68; }
</style>
