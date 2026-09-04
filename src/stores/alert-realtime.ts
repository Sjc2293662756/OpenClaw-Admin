import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useWebSocketStore } from './websocket'
import { useAuthStore } from './auth'
import type { AuthUser } from './auth'
import { DEFAULT_ALERT_SOUNDS, isAlertSoundId, type AlertSoundId } from '@/alerts/notification-sound'

const NOTIFICATION_PAGE_SIZE = 30
const NOTIFICATION_QUEUE_LIMIT = 100
const SEEN_NOTIFICATION_LIMIT = 1_000
const ALERT_SEVERITIES = ['轻微', '重大', '紧急'] as const
export const LOCAL_ALERT_SOUND_DEMO = import.meta.env.DEV
  && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('alertSoundDemo')

export type AlertNotificationReadState = 'all' | 'unread'
export type AlertNotificationSeverity = typeof ALERT_SEVERITIES[number]

export type AlertRealtimeEvent = {
  type: 'alert'
  action: 'triggered' | 'recovered'
  cursor: number
  notificationId: number
  receiverGeneration: number
  payload: { id: string; [key: string]: unknown }
}

export type AlertDeliverySource = 'live' | 'offline'
export type AlertRealtimeItem = AlertRealtimeEvent & {
  deliverySource: AlertDeliverySource
  read: boolean
  readAt: number | null
  createdOffline: boolean
  createdAt: number | null
  receivedAt: number | null
}

type AlertStreamState = {
  state: string
  code?: string
  gapState?: string
  historyRefreshRequired?: boolean
  latestCursor?: number | null
  latestSequence?: number | null
  lastProcessedCursor?: number | null
  receiverGeneration?: number
}

export type AlertNotificationPreferences = {
  realtimeEnabled: boolean
  soundEnabled: boolean
  minorSound: AlertSoundId
  majorSound: AlertSoundId
  criticalSound: AlertSoundId
  minorPopupEnabled: boolean
  minorNotificationEnabled: boolean
  majorPopupEnabled: boolean
  majorNotificationEnabled: boolean
  criticalPopupEnabled: boolean
  criticalNotificationEnabled: boolean
  updatedAt?: number | null
}

export type AlertNotificationCounts = {
  total: number
  unread: number
  filteredTotal: number
  filteredUnread: number
  bySeverity: Record<AlertNotificationSeverity, { total: number; unread: number }>
}

type AlertNotificationPage = {
  limit: number
  hasMore: boolean
  nextBeforeId: number | null
  snapshotThroughId: number
}

export type OfflineAlertSummary = {
  claimToken: string
  afterId: number
  throughId: number
  total: number
  bySeverity: Record<AlertNotificationSeverity, number>
  expiresAt: number
}

type OfflineAlertRange = { afterId: number; throughId: number }

type ApiFailure = Error & { status?: number; code?: string }

export const DEFAULT_ALERT_NOTIFICATION_PREFERENCES: AlertNotificationPreferences = Object.freeze({
  realtimeEnabled: true,
  soundEnabled: true,
  ...DEFAULT_ALERT_SOUNDS,
  minorPopupEnabled: true,
  minorNotificationEnabled: true,
  majorPopupEnabled: true,
  majorNotificationEnabled: true,
  criticalPopupEnabled: true,
  criticalNotificationEnabled: true,
})

const PREFERENCE_FIELDS = Object.keys(DEFAULT_ALERT_NOTIFICATION_PREFERENCES) as Array<keyof AlertNotificationPreferences>

function emptyCounts(): AlertNotificationCounts {
  return {
    total: 0,
    unread: 0,
    filteredTotal: 0,
    filteredUnread: 0,
    bySeverity: {
      轻微: { total: 0, unread: 0 },
      重大: { total: 0, unread: 0 },
      紧急: { total: 0, unread: 0 },
    },
  }
}

function readPreferences(value: unknown): AlertNotificationPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const soundFields = ['minorSound', 'majorSound', 'criticalSound'] as const
  const booleanFields = PREFERENCE_FIELDS.filter((field) => !soundFields.includes(field as typeof soundFields[number]))
  if (booleanFields.some((field) => typeof source[field] !== 'boolean')) return null
  return {
    ...Object.fromEntries(booleanFields.map((field) => [field, source[field]])),
    ...Object.fromEntries(soundFields.map((field) => [field, isAlertSoundId(source[field]) ? source[field] : DEFAULT_ALERT_SOUNDS[field]])),
  } as AlertNotificationPreferences
}

function levelPreferencePrefix(severity: unknown) {
  if (severity === '轻微') return 'minor'
  if (severity === '重大') return 'major'
  if (severity === '紧急') return 'critical'
  return null
}

function accountKey(user: AuthUser) {
  return encodeURIComponent(String(user.id || user.username).trim())
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null
}

function nonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function isSeverity(value: unknown): value is AlertNotificationSeverity {
  return ALERT_SEVERITIES.includes(value as AlertNotificationSeverity)
}

function normalizeNotification(value: unknown): AlertRealtimeItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const payload = source.payload
  const notificationId = positiveInteger(source.notificationId)
  const cursor = positiveInteger(source.cursor)
  const receiverGeneration = positiveInteger(source.receiverGeneration)
  if (!notificationId || !cursor || !receiverGeneration
    || (source.action !== 'triggered' && source.action !== 'recovered')
    || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || !String((payload as Record<string, unknown>).id || '').trim()) return null
  const createdOffline = source.createdOffline === true
  return {
    type: 'alert',
    action: source.action,
    cursor,
    notificationId,
    receiverGeneration,
    payload: payload as AlertRealtimeItem['payload'],
    deliverySource: createdOffline ? 'offline' : 'live',
    read: source.read === true,
    readAt: nonNegativeInteger(source.readAt),
    createdOffline,
    createdAt: nonNegativeInteger(source.createdAt),
    receivedAt: nonNegativeInteger(source.receivedAt),
  }
}

function normalizeCounts(value: unknown): AlertNotificationCounts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const total = nonNegativeInteger(source.total)
  const unread = nonNegativeInteger(source.unread)
  const filteredTotal = nonNegativeInteger(source.filteredTotal)
  const filteredUnread = nonNegativeInteger(source.filteredUnread)
  const rawBySeverity = source.bySeverity
  if (total === null || unread === null || filteredTotal === null || filteredUnread === null
    || !rawBySeverity || typeof rawBySeverity !== 'object' || Array.isArray(rawBySeverity)) return null
  const bySeverity = emptyCounts().bySeverity
  for (const severity of ALERT_SEVERITIES) {
    const entry = (rawBySeverity as Record<string, unknown>)[severity]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const count = entry as Record<string, unknown>
    const severityTotal = nonNegativeInteger(count.total)
    const severityUnread = nonNegativeInteger(count.unread)
    if (severityTotal === null || severityUnread === null) return null
    bySeverity[severity] = { total: severityTotal, unread: severityUnread }
  }
  return { total, unread, filteredTotal, filteredUnread, bySeverity }
}

function normalizePage(value: unknown): AlertNotificationPage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const limit = positiveInteger(source.limit)
  const snapshotThroughId = nonNegativeInteger(source.snapshotThroughId)
  const nextBeforeId = source.nextBeforeId === null ? null : positiveInteger(source.nextBeforeId)
  if (!limit || snapshotThroughId === null || (source.hasMore !== true && source.hasMore !== false)
    || (source.hasMore === true && nextBeforeId === null)) return null
  return { limit, hasMore: source.hasMore, nextBeforeId, snapshotThroughId }
}

function normalizeOfflineSummary(value: unknown): OfflineAlertSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const claimToken = String(source.claimToken || '').trim()
  const afterId = nonNegativeInteger(source.afterId)
  const throughId = positiveInteger(source.throughId)
  const total = positiveInteger(source.total)
  const expiresAt = positiveInteger(source.expiresAt)
  const rawBySeverity = source.bySeverity
  if (!claimToken || claimToken.length > 200 || afterId === null || !throughId || throughId <= afterId
    || !total || !expiresAt || !rawBySeverity || typeof rawBySeverity !== 'object' || Array.isArray(rawBySeverity)) return null
  const bySeverity = {} as Record<AlertNotificationSeverity, number>
  for (const severity of ALERT_SEVERITIES) {
    const count = nonNegativeInteger((rawBySeverity as Record<string, unknown>)[severity])
    if (count === null) return null
    bySeverity[severity] = count
  }
  if (Object.values(bySeverity).reduce((sum, count) => sum + count, 0) !== total) return null
  return { claimToken, afterId, throughId, total, bySeverity, expiresAt }
}

function deduplicateNotifications(items: AlertRealtimeItem[]) {
  const seen = new Set<number>()
  return items
    .sort((left, right) => right.notificationId - left.notificationId)
    .filter((item) => {
      if (seen.has(item.notificationId)) return false
      seen.add(item.notificationId)
      return true
    })
}

export const useAlertRealtimeStore = defineStore('alertRealtime', () => {
  const activeAccount = ref<string | null>(null)
  const recentEvents = ref<AlertRealtimeItem[]>([])
  const notificationCounts = ref<AlertNotificationCounts>(emptyCounts())
  const notificationQueue = ref<AlertRealtimeItem[]>([])
  const messageCenterOpen = ref(false)
  const alertDetailOpen = ref(false)
  const detailFocusRequest = ref(0)
  const streamState = ref('idle')
  const gapState = ref<string | null>(null)
  const historyRefreshRequired = ref(false)
  const lastErrorCode = ref<string | null>(null)
  const notificationSeverity = ref<AlertNotificationSeverity | null>(null)
  const notificationReadState = ref<AlertNotificationReadState>('all')
  const notificationsLoading = ref(false)
  const notificationsLoadingMore = ref(false)
  const notificationsLoadError = ref<string | null>(null)
  const notificationsMutationError = ref<string | null>(null)
  const notificationsHasMore = ref(false)
  const nextBeforeId = ref<number | null>(null)
  const notificationRange = ref<OfflineAlertRange | null>(null)
  const offlineSummary = ref<OfflineAlertSummary | null>(null)
  const offlineSummaryError = ref<string | null>(null)
  const preferences = ref<AlertNotificationPreferences>({ ...DEFAULT_ALERT_NOTIFICATION_PREFERENCES })
  const preferencesReady = ref(false)
  const preferencesLoading = ref(false)
  const preferencesLoadError = ref<string | null>(null)
  const preferencesSaving = ref(false)
  const preferencesSaveError = ref<string | null>(null)
  const seenNotificationIds = new Set<number>()
  const liveRaceEvents = new Map<number, AlertRealtimeItem>()
  let subscriptions: Array<() => void> = []
  let notificationController: AbortController | null = null
  let notificationGeneration = 0
  let preferenceController: AbortController | null = null
  let preferenceGeneration = 0
  let preferenceLoadPromise: Promise<boolean> | null = null
  let summaryClaiming = false
  let summaryRetryTimer: ReturnType<typeof setTimeout> | null = null

  const unreadCount = computed(() => notificationCounts.value.unread)
  const hasActiveGap = computed(() => historyRefreshRequired.value || Boolean(gapState.value))

  function currentTokenHeaders(json = false) {
    const token = useAuthStore().getToken()
    return {
      Accept: 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  async function requestJson(url: string, init: RequestInit = {}) {
    const response = await fetch(url, init)
    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.ok) {
      const failure = new Error(String(body?.error || body?.code || `HTTP_${response.status}`)) as ApiFailure
      failure.status = response.status
      failure.code = typeof body?.code === 'string' ? body.code : undefined
      throw failure
    }
    return body as Record<string, unknown>
  }

  function cancelNotificationRequest() {
    notificationGeneration += 1
    notificationController?.abort()
    notificationController = null
    notificationsLoading.value = false
    notificationsLoadingMore.value = false
  }

  function resetNotificationMemory() {
    cancelNotificationRequest()
    recentEvents.value = []
    notificationCounts.value = emptyCounts()
    notificationQueue.value = []
    messageCenterOpen.value = false
    alertDetailOpen.value = false
    detailFocusRequest.value = 0
    notificationSeverity.value = null
    notificationReadState.value = 'all'
    notificationsLoadError.value = null
    notificationsMutationError.value = null
    notificationsHasMore.value = false
    nextBeforeId.value = null
    notificationRange.value = null
    offlineSummary.value = null
    offlineSummaryError.value = null
    summaryClaiming = false
    if (summaryRetryTimer) clearTimeout(summaryRetryTimer)
    summaryRetryTimer = null
    seenNotificationIds.clear()
    liveRaceEvents.clear()
    streamState.value = 'idle'
    gapState.value = null
    historyRefreshRequired.value = false
    lastErrorCode.value = null
  }

  function resetPreferences() {
    preferenceController?.abort()
    preferenceController = null
    preferenceGeneration += 1
    preferenceLoadPromise = null
    preferences.value = { ...DEFAULT_ALERT_NOTIFICATION_PREFERENCES }
    preferencesReady.value = false
    preferencesLoading.value = false
    preferencesLoadError.value = null
    preferencesSaving.value = false
    preferencesSaveError.value = null
  }

  function activate(user: AuthUser | null) {
    const next = user ? accountKey(user) : null
    if (next === activeAccount.value) return
    resetPreferences()
    resetNotificationMemory()
    activeAccount.value = next
  }

  function isCurrentPreferenceRequest(account: string, generation: number) {
    return activeAccount.value === account && preferenceGeneration === generation
  }

  async function loadPreferences({ retry = false }: { retry?: boolean } = {}): Promise<boolean> {
    if (!activeAccount.value) return false
    if (LOCAL_ALERT_SOUND_DEMO) {
      preferences.value = { ...DEFAULT_ALERT_NOTIFICATION_PREFERENCES }
      preferencesReady.value = true
      preferencesLoading.value = false
      preferencesLoadError.value = null
      return true
    }
    if (preferencesReady.value && !retry) return true
    if (preferenceLoadPromise) return preferenceLoadPromise
    const account = activeAccount.value
    const generation = preferenceGeneration
    const controller = new AbortController()
    preferenceController = controller
    preferencesLoading.value = true
    preferencesLoadError.value = null
    const run = (async () => {
      try {
        const body = await requestJson('/api/alerts/preferences', {
          headers: currentTokenHeaders(),
          signal: controller.signal,
        })
        const loaded = readPreferences(body.preferences)
        if (!loaded) throw new Error('ALERT_NOTIFICATION_PREFERENCES_UNAVAILABLE')
        if (!isCurrentPreferenceRequest(account, generation)) return false
        preferences.value = loaded
        preferencesReady.value = true
        return true
      } catch (error) {
        if (!isCurrentPreferenceRequest(account, generation) || controller.signal.aborted) return false
        preferences.value = { ...DEFAULT_ALERT_NOTIFICATION_PREFERENCES }
        preferencesReady.value = false
        preferencesLoadError.value = error instanceof Error ? error.message : 'ALERT_NOTIFICATION_PREFERENCES_UNAVAILABLE'
        return false
      } finally {
        if (isCurrentPreferenceRequest(account, generation)) {
          preferencesLoading.value = false
          if (preferenceController === controller) preferenceController = null
        }
      }
    })()
    preferenceLoadPromise = run
    void run.finally(() => {
      if (preferenceLoadPromise === run) preferenceLoadPromise = null
    }).catch(() => {})
    return run
  }

  function retryPreferences(): Promise<boolean> {
    return loadPreferences({ retry: true })
  }

  async function savePreferences(next: AlertNotificationPreferences): Promise<AlertNotificationPreferences> {
    const validated = readPreferences(next)
    if (!validated || !activeAccount.value) throw new Error('ALERT_NOTIFICATION_PREFERENCES_INVALID')
    if (LOCAL_ALERT_SOUND_DEMO) {
      preferences.value = validated
      preferencesReady.value = true
      preferencesSaveError.value = null
      return validated
    }
    const account = activeAccount.value
    const generation = preferenceGeneration
    preferencesSaving.value = true
    preferencesSaveError.value = null
    try {
      const body = await requestJson('/api/alerts/preferences', {
        method: 'PUT',
        headers: currentTokenHeaders(true),
        body: JSON.stringify(validated),
      })
      const saved = readPreferences(body.preferences)
      if (!saved) throw new Error('ALERT_NOTIFICATION_PREFERENCES_SAVE_FAILED')
      if (!isCurrentPreferenceRequest(account, generation)) throw new Error('ALERT_NOTIFICATION_PREFERENCES_ACCOUNT_CHANGED')
      preferences.value = saved
      preferencesReady.value = true
      return saved
    } catch (error) {
      if (isCurrentPreferenceRequest(account, generation)) {
        preferencesSaveError.value = error instanceof Error ? error.message : 'ALERT_NOTIFICATION_PREFERENCES_SAVE_FAILED'
      }
      throw error
    } finally {
      if (isCurrentPreferenceRequest(account, generation)) preferencesSaving.value = false
    }
  }

  function matchesCurrentFilter(item: AlertRealtimeItem) {
    if (notificationRange.value && (!item.createdOffline
      || item.notificationId <= notificationRange.value.afterId
      || item.notificationId > notificationRange.value.throughId)) return false
    if (notificationSeverity.value && item.payload.severity !== notificationSeverity.value) return false
    return notificationReadState.value !== 'unread' || !item.read
  }

  function matchesSelectedMutation(item: AlertRealtimeItem) {
    if (notificationRange.value && (!item.createdOffline
      || item.notificationId <= notificationRange.value.afterId
      || item.notificationId > notificationRange.value.throughId)) return false
    if (notificationSeverity.value && item.payload.severity !== notificationSeverity.value) return false
    return notificationReadState.value !== 'unread' || !item.read
  }

  function incrementCounts(counts: AlertNotificationCounts, item: AlertRealtimeItem) {
    counts.total += 1
    if (!item.read) counts.unread += 1
    const severity = item.payload.severity
    if (isSeverity(severity)) {
      counts.bySeverity[severity].total += 1
      if (!item.read) counts.bySeverity[severity].unread += 1
    }
    if (matchesCurrentFilter(item)) {
      counts.filteredTotal += 1
      if (!item.read) counts.filteredUnread += 1
    }
  }

  function rememberNotificationId(id: number) {
    seenNotificationIds.add(id)
    if (seenNotificationIds.size > SEEN_NOTIFICATION_LIMIT) {
      seenNotificationIds.delete(seenNotificationIds.values().next().value as number)
    }
  }

  async function loadNotifications({ reset = true }: { reset?: boolean } = {}): Promise<boolean> {
    if (!activeAccount.value) return false
    if (reset) cancelNotificationRequest()
    else if (notificationsLoading.value || notificationsLoadingMore.value || !notificationsHasMore.value || nextBeforeId.value === null) return false
    const account = activeAccount.value
    const generation = ++notificationGeneration
    const controller = new AbortController()
    notificationController = controller
    if (reset) {
      notificationsLoading.value = true
      notificationsLoadError.value = null
    } else {
      notificationsLoadingMore.value = true
    }
    const query = new URLSearchParams({
      limit: String(NOTIFICATION_PAGE_SIZE),
      readState: notificationReadState.value,
    })
    if (notificationSeverity.value) query.set('severity', notificationSeverity.value)
    if (notificationRange.value) {
      query.set('offlineAfterId', String(notificationRange.value.afterId))
      query.set('throughId', String(notificationRange.value.throughId))
    }
    if (!reset && nextBeforeId.value !== null) query.set('beforeId', String(nextBeforeId.value))
    try {
      const body = await requestJson(`/api/alerts/notifications?${query.toString()}`, {
        headers: currentTokenHeaders(),
        signal: controller.signal,
      })
      if (activeAccount.value !== account || notificationGeneration !== generation) return false
      const page = normalizePage(body.page)
      const counts = normalizeCounts(body.counts)
      if (!page || !counts || !Array.isArray(body.notifications)) throw new Error('ALERT_NOTIFICATION_LIST_INVALID')
      const loaded = body.notifications.map(normalizeNotification)
      if (loaded.some((item) => item === null)) throw new Error('ALERT_NOTIFICATION_LIST_INVALID')
      const normalized = loaded as AlertRealtimeItem[]
      const racedEvents = [...liveRaceEvents.values()]
        .filter((item) => item.notificationId > page.snapshotThroughId)
      const raced = racedEvents.filter(matchesCurrentFilter)
      for (const item of racedEvents) {
        if (!normalized.some((candidate) => candidate.notificationId === item.notificationId)) incrementCounts(counts, item)
      }
      recentEvents.value = deduplicateNotifications(reset
        ? [...raced, ...normalized]
        : [...recentEvents.value, ...normalized])
      normalized.forEach((item) => rememberNotificationId(item.notificationId))
      for (const notificationId of liveRaceEvents.keys()) {
        if (notificationId <= page.snapshotThroughId) liveRaceEvents.delete(notificationId)
      }
      notificationCounts.value = counts
      notificationsHasMore.value = page.hasMore
      nextBeforeId.value = page.nextBeforeId
      notificationsLoadError.value = null
      return true
    } catch (error) {
      if (activeAccount.value !== account || notificationGeneration !== generation || controller.signal.aborted) return false
      notificationsLoadError.value = error instanceof Error ? error.message : 'ALERT_NOTIFICATION_LIST_FAILED'
      return false
    } finally {
      if (activeAccount.value === account && notificationGeneration === generation) {
        notificationsLoading.value = false
        notificationsLoadingMore.value = false
        if (notificationController === controller) notificationController = null
      }
    }
  }

  function loadMoreNotifications() {
    return loadNotifications({ reset: false })
  }

  function setNotificationFilters(severity: AlertNotificationSeverity | null, readState: AlertNotificationReadState) {
    if ((severity !== null && !isSeverity(severity)) || (readState !== 'all' && readState !== 'unread')) {
      return Promise.resolve(false)
    }
    notificationSeverity.value = severity
    notificationReadState.value = readState
    return loadNotifications({ reset: true })
  }

  async function claimOfflineSummary() {
    if (!activeAccount.value || summaryClaiming) return null
    const account = activeAccount.value
    if (summaryRetryTimer) clearTimeout(summaryRetryTimer)
    summaryRetryTimer = null
    summaryClaiming = true
    offlineSummaryError.value = null
    try {
      const body = await requestJson('/api/alerts/notifications/offline-summary/claim', {
        method: 'POST',
        headers: currentTokenHeaders(),
      })
      if (activeAccount.value !== account) return null
      if (body.summary === null) {
        const retryAfter = Number(body.retryAfter)
        if (body.claimInProgress === true && Number.isFinite(retryAfter) && retryAfter > Date.now()) {
          const delay = Math.min(300_000, Math.max(50, retryAfter - Date.now() + 25))
          summaryRetryTimer = setTimeout(() => {
            summaryRetryTimer = null
            if (activeAccount.value === account) void claimOfflineSummary()
          }, delay)
        }
        return null
      }
      const summary = normalizeOfflineSummary(body.summary)
      if (!summary) throw new Error('ALERT_NOTIFICATION_SUMMARY_INVALID')
      offlineSummary.value = summary
      return summary
    } catch (error) {
      if (activeAccount.value === account) {
        offlineSummaryError.value = error instanceof Error ? error.message : 'ALERT_NOTIFICATION_SUMMARY_CLAIM_FAILED'
      }
      return null
    } finally {
      if (activeAccount.value === account) summaryClaiming = false
    }
  }

  async function confirmOfflineSummary(summary: OfflineAlertSummary) {
    if (!activeAccount.value) return false
    const account = activeAccount.value
    try {
      await requestJson('/api/alerts/notifications/offline-summary/confirm', {
        method: 'POST',
        headers: currentTokenHeaders(true),
        body: JSON.stringify({ claimToken: summary.claimToken }),
      })
      if (activeAccount.value === account && offlineSummary.value?.claimToken === summary.claimToken) {
        offlineSummary.value = null
      }
      return true
    } catch (error) {
      if (activeAccount.value === account) {
        offlineSummaryError.value = error instanceof Error ? error.message : 'ALERT_NOTIFICATION_SUMMARY_CONFIRM_FAILED'
      }
      return false
    }
  }

  function openOfflineSummary(summary: OfflineAlertSummary) {
    notificationRange.value = { afterId: summary.afterId, throughId: summary.throughId }
    notificationSeverity.value = null
    notificationReadState.value = 'all'
    messageCenterOpen.value = true
    notificationQueue.value = []
    void loadNotifications({ reset: true })
  }

  function showAllNotifications() {
    notificationRange.value = null
    void loadNotifications({ reset: true })
  }

  function addEvent(event: AlertRealtimeEvent): boolean {
    const item = normalizeNotification({
      ...event,
      read: false,
      readAt: null,
      createdOffline: false,
      createdAt: Date.now(),
      receivedAt: Date.now(),
    })
    if (!item || seenNotificationIds.has(item.notificationId)
      || recentEvents.value.some((existing) => existing.notificationId === item.notificationId)) return false
    rememberNotificationId(item.notificationId)
    liveRaceEvents.set(item.notificationId, item)
    if (liveRaceEvents.size > SEEN_NOTIFICATION_LIMIT) {
      liveRaceEvents.delete(liveRaceEvents.keys().next().value as number)
    }
    incrementCounts(notificationCounts.value, item)
    if (matchesCurrentFilter(item)) recentEvents.value = [item, ...recentEvents.value]

    const prefix = levelPreferencePrefix(item.payload.severity)
    const notificationEnabled = prefix
      && preferences.value[`${prefix}NotificationEnabled` as keyof AlertNotificationPreferences] === true
    const popupEnabled = notificationEnabled
      && preferences.value.realtimeEnabled
      && item.action === 'triggered'
      && preferences.value[`${prefix}PopupEnabled` as keyof AlertNotificationPreferences] === true
    if (popupEnabled && !messageCenterOpen.value && !alertDetailOpen.value) {
      notificationQueue.value = [...notificationQueue.value, item].slice(-NOTIFICATION_QUEUE_LIMIT)
    }
    return true
  }

  function handleStreamState(value: unknown) {
    const state = value as AlertStreamState
    if (!state || typeof state.state !== 'string') return
    streamState.value = state.state
    if (typeof state.code === 'string') lastErrorCode.value = state.code
    if (typeof state.gapState === 'string') gapState.value = state.gapState
    if (state.historyRefreshRequired === true) historyRefreshRequired.value = true
  }

  function start() {
    if (subscriptions.length) return
    const ws = useWebSocketStore()
    subscriptions = [
      ws.subscribe('alert', (event: unknown) => addEvent(event as AlertRealtimeEvent)),
      ws.subscribe('alertStreamState', handleStreamState),
      ws.subscribe('sseConnected', () => { void claimOfflineSummary() }),
      ws.subscribe('alertNotificationStateChanged', () => { void loadNotifications({ reset: true }) }),
    ]
    // The SSE connected signal can arrive before this store finishes subscribing
    // during login. Claim once here as well, so a genuine offline period is not missed.
    void claimOfflineSummary()
  }

  function stop() {
    subscriptions.forEach((unsubscribe) => unsubscribe())
    subscriptions = []
    cancelNotificationRequest()
    if (summaryRetryTimer) clearTimeout(summaryRetryTimer)
    summaryRetryTimer = null
  }

  async function markRead(notificationId: number) {
    const item = recentEvents.value.find((event) => event.notificationId === notificationId)
    if (item?.read) return true
    notificationsMutationError.value = null
    try {
      await requestJson(`/api/alerts/notifications/${notificationId}/read`, {
        method: 'PUT',
        headers: currentTokenHeaders(),
      })
      await loadNotifications({ reset: true })
      return true
    } catch (error) {
      if ((error as ApiFailure).status === 404) await loadNotifications({ reset: true })
      else notificationsMutationError.value = error instanceof Error ? error.message : 'ALERT_NOTIFICATION_READ_FAILED'
      return false
    }
  }

  async function markFilteredRead() {
    notificationsMutationError.value = null
    try {
      const body = await requestJson('/api/alerts/notifications/read', {
        method: 'POST',
        headers: currentTokenHeaders(true),
        body: JSON.stringify({
          severity: notificationSeverity.value,
          readState: notificationReadState.value,
          ...(notificationRange.value ? {
            offlineAfterId: notificationRange.value.afterId,
            throughId: notificationRange.value.throughId,
          } : {}),
        }),
      })
      const counts = normalizeCounts(body.counts)
      if (!counts) throw new Error('ALERT_NOTIFICATION_COUNTS_INVALID')
      recentEvents.value.forEach((item) => {
        item.read = true
        item.readAt ||= Date.now()
      })
      if (notificationReadState.value === 'unread') recentEvents.value = []
      notificationCounts.value = counts
      return Number(body.changed || 0)
    } catch (error) {
      notificationsMutationError.value = error instanceof Error ? error.message : 'ALERT_NOTIFICATION_READ_FAILED'
      return 0
    }
  }

  async function remove(notificationId: number) {
    const item = recentEvents.value.find((event) => event.notificationId === notificationId)
    if (!item) return false
    notificationsMutationError.value = null
    try {
      await requestJson(`/api/alerts/notifications/${notificationId}`, {
        method: 'DELETE',
        headers: currentTokenHeaders(),
      })
      notificationQueue.value = notificationQueue.value.filter((entry) => entry.notificationId !== notificationId)
      await loadNotifications({ reset: true })
      return true
    } catch (error) {
      if ((error as ApiFailure).status === 404) await loadNotifications({ reset: true })
      else notificationsMutationError.value = error instanceof Error ? error.message : 'ALERT_NOTIFICATION_CLEAR_FAILED'
      return false
    }
  }

  async function clearFiltered() {
    notificationsMutationError.value = null
    try {
      const body = await requestJson('/api/alerts/notifications/clear', {
        method: 'POST',
        headers: currentTokenHeaders(true),
        body: JSON.stringify({
          severity: notificationSeverity.value,
          readState: notificationReadState.value,
          ...(notificationRange.value ? {
            offlineAfterId: notificationRange.value.afterId,
            throughId: notificationRange.value.throughId,
          } : {}),
        }),
      })
      const counts = normalizeCounts(body.counts)
      if (!counts) throw new Error('ALERT_NOTIFICATION_COUNTS_INVALID')
      const removedIds = new Set(recentEvents.value.filter(matchesSelectedMutation).map((item) => item.notificationId))
      recentEvents.value = []
      notificationQueue.value = notificationQueue.value.filter((item) => !removedIds.has(item.notificationId) && !matchesSelectedMutation(item))
      notificationCounts.value = counts
      notificationsHasMore.value = false
      nextBeforeId.value = null
      return Number(body.changed || 0)
    } catch (error) {
      notificationsMutationError.value = error instanceof Error ? error.message : 'ALERT_NOTIFICATION_CLEAR_FAILED'
      return 0
    }
  }

  function dequeueNotification() {
    const next = notificationQueue.value[0] || null
    if (next) notificationQueue.value = notificationQueue.value.slice(1)
    return next
  }

  function openMessageCenter() {
    notificationRange.value = null
    messageCenterOpen.value = true
    notificationQueue.value = []
    void loadNotifications({ reset: true })
  }

  function closeMessageCenter() { messageCenterOpen.value = false }

  function setAlertDetailOpen(open: boolean) {
    alertDetailOpen.value = open
    if (open) notificationQueue.value = []
  }

  function requestDetailFocus() { detailFocusRequest.value += 1 }

  function clearForLogout() {
    resetPreferences()
    resetNotificationMemory()
    activeAccount.value = null
  }

  return {
    activeAccount,
    recentEvents,
    unreadCount,
    notificationCounts,
    notificationQueue,
    messageCenterOpen,
    alertDetailOpen,
    detailFocusRequest,
    streamState,
    gapState,
    historyRefreshRequired,
    lastErrorCode,
    hasActiveGap,
    notificationSeverity,
    notificationReadState,
    notificationsLoading,
    notificationsLoadingMore,
    notificationsLoadError,
    notificationsMutationError,
    notificationsHasMore,
    notificationRange,
    offlineSummary,
    offlineSummaryError,
    preferences,
    preferencesReady,
    preferencesLoading,
    preferencesLoadError,
    preferencesSaving,
    preferencesSaveError,
    activate,
    loadPreferences,
    retryPreferences,
    savePreferences,
    loadNotifications,
    loadMoreNotifications,
    setNotificationFilters,
    claimOfflineSummary,
    confirmOfflineSummary,
    openOfflineSummary,
    showAllNotifications,
    start,
    stop,
    addEvent,
    handleStreamState,
    markRead,
    markFilteredRead,
    remove,
    clearFiltered,
    dequeueNotification,
    openMessageCenter,
    closeMessageCenter,
    setAlertDetailOpen,
    requestDetailFocus,
    clearForLogout,
  }
})
