import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ConnectionState } from '@/api/types'
import { useWebSocketStore } from './websocket'
import { useAuthStore } from './auth'
import type { AuthUser } from './auth'

const RECENT_LIMIT = 150
const SEEN_LIMIT = 800
const COMPENSATION_PAGE_LIMIT = 200
const COMPENSATION_MAX_EVENTS = 1_000
const CURSOR_PREFIX = 'gaiop.alert.realtime.cursor.'

export type AlertRealtimeEvent = {
  type: 'alert'
  action: 'triggered' | 'recovered'
  cursor: number
  payload: { id: string; [key: string]: unknown }
}

export type AlertDeliverySource = 'live' | 'compensation'
export type AlertRealtimeItem = AlertRealtimeEvent & {
  deliverySource: AlertDeliverySource
  read: boolean
}

type AlertStreamState = {
  state: string
  code?: string
  gapState?: string
  historyRefreshRequired?: boolean
  latestCursor?: number | null
  latestSequence?: number | null
  lastProcessedCursor?: number | null
}

function accountKey(user: AuthUser) {
  return encodeURIComponent(String(user.id || user.username).trim())
}

function validCursor(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const cursor = Number(value)
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null
}

export const useAlertRealtimeStore = defineStore('alertRealtime', () => {
  const activeAccount = ref<string | null>(null)
  const lastCursor = ref<number | null>(null)
  const recentEvents = ref<AlertRealtimeItem[]>([])
  const unreadCount = ref(0)
  const notificationQueue = ref<AlertRealtimeItem[]>([])
  const messageCenterOpen = ref(false)
  // This is deliberately only a monotonically increasing in-memory signal.
  // It lets an already-open alert page refresh when its current focus ID is
  // requested again, without adding non-essential data to the deep link.
  const detailFocusRequest = ref(0)
  const streamState = ref('idle')
  const gapState = ref<string | null>(null)
  const historyRefreshRequired = ref(false)
  const lastErrorCode = ref<string | null>(null)
  const seenCursors = new Set<number>()
  const seenIds = new Set<string>()
  let subscriptions: Array<() => void> = []
  let compensating: Promise<void> | null = null
  let compensationController: AbortController | null = null
  let compensationGeneration = 0
  let compensationRace: { generation: number; cursors: Set<number>; ids: Set<string> } | null = null

  const hasActiveGap = computed(() => historyRefreshRequired.value || Boolean(gapState.value))

  function cursorStorageKey(account: string) {
    return `${CURSOR_PREFIX}${account}`
  }

  function saveCursor() {
    if (activeAccount.value && lastCursor.value !== null) {
      localStorage.setItem(cursorStorageKey(activeAccount.value), String(lastCursor.value))
    }
  }

  function resetMemory({ preserveCursor = true } = {}) {
    recentEvents.value = []
    unreadCount.value = 0
    notificationQueue.value = []
    messageCenterOpen.value = false
    detailFocusRequest.value = 0
    seenCursors.clear()
    seenIds.clear()
    streamState.value = 'idle'
    gapState.value = null
    historyRefreshRequired.value = false
    lastErrorCode.value = null
    if (!preserveCursor) lastCursor.value = null
  }

  function activate(user: AuthUser | null) {
    const next = user ? accountKey(user) : null
    if (next === activeAccount.value) return
    cancelCompensation()
    resetMemory({ preserveCursor: false })
    activeAccount.value = next
    if (next) {
      const stored = validCursor(localStorage.getItem(cursorStorageKey(next)))
      lastCursor.value = stored
    }
  }

  function boundedRemember<T>(set: Set<T>, value: T, limit = SEEN_LIMIT) {
    set.add(value)
    if (set.size > limit) set.delete(set.values().next().value as T)
  }

  function addEvent(event: AlertRealtimeEvent, { compensationAfter }: { compensationAfter?: number } = {}): boolean {
    const cursor = validCursor(event.cursor)
    const id = String(event.payload?.id || '').trim()
    if (cursor === null || !id) return false
    const isCompensation = compensationAfter !== undefined
    if (isCompensation && cursor <= compensationAfter!) return false
    // The normal SSE path is strictly forward-only for this account. A bounded
    // seen set is only a race optimisation and must never re-admit old cursors.
    if (!isCompensation && lastCursor.value !== null && cursor <= lastCursor.value) return false
    if (!isCompensation && compensationRace) {
      boundedRemember(compensationRace.cursors, cursor, COMPENSATION_MAX_EVENTS)
      boundedRemember(compensationRace.ids, id, COMPENSATION_MAX_EVENTS)
    }
    if (isCompensation && compensationRace
      && (compensationRace.cursors.has(cursor) || compensationRace.ids.has(id))) return false
    const cursorSeen = seenCursors.has(cursor)
    const idSeen = seenIds.has(id)
    boundedRemember(seenCursors, cursor)
    boundedRemember(seenIds, id)
    if (lastCursor.value === null || cursor > lastCursor.value) {
      lastCursor.value = cursor
      saveCursor()
    }
    if (cursorSeen || idSeen) return false
    const item: AlertRealtimeItem = {
      ...event,
      deliverySource: isCompensation ? 'compensation' : 'live',
      read: false,
    }
    const nextEvents = [item, ...recentEvents.value].slice(0, RECENT_LIMIT)
    const evictedUnread = recentEvents.value.slice(RECENT_LIMIT - 1).filter((entry) => !entry.read).length
    recentEvents.value = nextEvents
    unreadCount.value += 1
    if (evictedUnread) unreadCount.value = Math.max(0, unreadCount.value - evictedUnread)
    // History recovery is intentionally visible only in the center. A recovery
    // event also updates the center without competing with new-alert notices.
    if (!isCompensation && event.action === 'triggered' && !messageCenterOpen.value) {
      notificationQueue.value = [...notificationQueue.value, item].slice(-RECENT_LIMIT)
    }
    return true
  }

  function handleStreamState(value: unknown) {
    const state = value as AlertStreamState
    if (!state || typeof state.state !== 'string') return
    streamState.value = state.state
    if (typeof state.code === 'string') lastErrorCode.value = state.code
    if (typeof state.gapState === 'string') gapState.value = state.gapState
    if (state.historyRefreshRequired === true) {
      historyRefreshRequired.value = true
      void compensate()
    }
  }

  async function fetchChanges(afterSequence: number | null, signal: AbortSignal) {
    const query = new URLSearchParams({ limit: String(COMPENSATION_PAGE_LIMIT) })
    if (afterSequence !== null) query.set('afterSequence', String(afterSequence))
    const token = useAuthStore().getToken()
    let response: Response
    try {
      response = await fetch(`/api/alerts/changes?${query.toString()}`, {
        headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal,
      })
    } catch {
      return { changes: null, errorCode: signal.aborted ? null : 'ALERT_COMPENSATION_UNAVAILABLE' }
    }
    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.ok) {
      return { changes: null, errorCode: String(body?.code || `HTTP_${response.status}`) }
    }
    return { changes: body as {
      events: AlertRealtimeEvent[]
      latestSequence: number
      hasMore: boolean
      historyRefreshRequired: boolean
      oldestAvailableSequence?: number | null
    }, errorCode: null }
  }

  function isCurrentCompensation(account: string, generation: number) {
    return activeAccount.value === account && compensationGeneration === generation
  }

  function cancelCompensation() {
    compensationGeneration += 1
    compensationController?.abort()
    compensationController = null
    compensating = null
    compensationRace = null
  }

  async function compensate() {
    if (!activeAccount.value) return
    if (compensating) return compensating
    const account = activeAccount.value
    const generation = compensationGeneration
    const controller = new AbortController()
    compensationController = controller
    compensationRace = { generation, cursors: new Set(), ids: new Set() }
    const run = (async () => {
      let pages = 0
      let processed = 0
      // Keep the batch cursor separate from lastCursor: SSE can jump ahead
      // while this request is in flight, but its missing middle must still be
      // consumed from the server's ordered response.
      let batchAfter = lastCursor.value
      while (pages < 6 && processed < COMPENSATION_MAX_EVENTS) {
        const before = batchAfter
        const result = await fetchChanges(before, controller.signal)
        if (!isCurrentCompensation(account, generation)) return
        if (!result.changes) {
          if (result.errorCode) lastErrorCode.value = result.errorCode
          return
        }
        const changes = result.changes
        if (changes.historyRefreshRequired) {
          historyRefreshRequired.value = true
          gapState.value ||= 'unresolved'
          return
        }
        // A first account session is intentionally a live baseline, never a
        // notification replay. SSE events that arrived while this request was
        // in flight have already advanced lastCursor and remain untouched.
        if (before === null) {
          const baseline = validCursor(changes.latestSequence)
          if (lastCursor.value === null && baseline !== null) {
            lastCursor.value = baseline
            saveCursor()
          }
          return
        }
        for (const event of changes.events || []) {
          addEvent(event, { compensationAfter: before })
          processed += 1
        }
        const lastBatchEvent = changes.events?.[changes.events.length - 1]
        const nextAfter = validCursor(lastBatchEvent?.cursor)
        if (changes.hasMore && (nextAfter === null || nextAfter <= before)) {
          historyRefreshRequired.value = true
          gapState.value ||= 'compensation_invalid'
          lastErrorCode.value = 'ALERT_COMPENSATION_CURSOR_INVALID'
          return
        }
        if (!changes.hasMore) {
          return
        }
        batchAfter = nextAfter
        pages += 1
      }
      historyRefreshRequired.value = true
      gapState.value ||= 'compensation_limit'
      lastErrorCode.value = 'ALERT_COMPENSATION_LIMIT'
    })()
    compensating = run
    void run.finally(() => {
      if (compensating === run) compensating = null
      if (compensationController === controller) compensationController = null
      if (compensationRace?.generation === generation) compensationRace = null
    }).catch(() => {})
    return run
  }

  function start() {
    if (subscriptions.length) return
    const ws = useWebSocketStore()
    subscriptions = [
      ws.subscribe('alert', (event: unknown) => addEvent(event as AlertRealtimeEvent)),
      ws.subscribe('alertStreamState', handleStreamState),
      ws.subscribe('connected', () => { void compensate() }),
      ws.subscribe('stateChange', (state: unknown) => {
        if (state === ConnectionState.CONNECTED) void compensate()
      }),
    ]
  }

  function stop() {
    subscriptions.forEach((unsubscribe) => unsubscribe())
    subscriptions = []
    cancelCompensation()
  }

  function markRead(cursor?: number) {
    if (cursor === undefined) unreadCount.value = 0
    else {
      const item = recentEvents.value.find((event) => event.cursor === cursor)
      if (item && !item.read) {
        item.read = true
        unreadCount.value = Math.max(0, unreadCount.value - 1)
      }
    }
    if (cursor === undefined) recentEvents.value.forEach((event) => { event.read = true })
  }

  function remove(cursor: number) {
    const removed = recentEvents.value.find((event) => event.cursor === cursor)
    recentEvents.value = recentEvents.value.filter((event) => event.cursor !== cursor)
    if (removed && !removed.read) unreadCount.value = Math.max(0, unreadCount.value - 1)
    notificationQueue.value = notificationQueue.value.filter((event) => event.cursor !== cursor)
  }

  function clear() {
    recentEvents.value = []
    unreadCount.value = 0
    notificationQueue.value = []
  }

  function dequeueNotification() {
    const next = notificationQueue.value[0] || null
    if (next) notificationQueue.value = notificationQueue.value.slice(1)
    return next
  }

  function openMessageCenter() {
    messageCenterOpen.value = true
    // New events remain unread and visibly refresh the open center, rather
    // than competing with a floating notification over the current task.
    notificationQueue.value = []
  }
  function closeMessageCenter() { messageCenterOpen.value = false }
  function requestDetailFocus() { detailFocusRequest.value += 1 }

  function clearForLogout() {
    cancelCompensation()
    resetMemory({ preserveCursor: true })
    activeAccount.value = null
  }

  return {
    activeAccount, lastCursor, recentEvents, unreadCount, notificationQueue, messageCenterOpen, detailFocusRequest, streamState, gapState,
    historyRefreshRequired, lastErrorCode, hasActiveGap,
    activate, start, stop, addEvent, handleStreamState, compensate,
    markRead, remove, clear, dequeueNotification, openMessageCenter, closeMessageCenter, requestDetailFocus, clearForLogout,
  }
})
