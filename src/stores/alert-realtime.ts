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
  const recentEvents = ref<AlertRealtimeEvent[]>([])
  const unreadCount = ref(0)
  const streamState = ref('idle')
  const gapState = ref<string | null>(null)
  const historyRefreshRequired = ref(false)
  const lastErrorCode = ref<string | null>(null)
  const seenCursors = new Set<number>()
  const seenIds = new Set<string>()
  let subscriptions: Array<() => void> = []
  let compensating: Promise<void> | null = null

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
    resetMemory({ preserveCursor: false })
    activeAccount.value = next
    if (next) {
      const stored = validCursor(localStorage.getItem(cursorStorageKey(next)))
      lastCursor.value = stored
    }
  }

  function boundedRemember<T>(set: Set<T>, value: T) {
    set.add(value)
    if (set.size > SEEN_LIMIT) set.delete(set.values().next().value as T)
  }

  function addEvent(event: AlertRealtimeEvent): boolean {
    const cursor = validCursor(event.cursor)
    const id = String(event.payload?.id || '').trim()
    if (cursor === null || !id) return false
    const cursorSeen = seenCursors.has(cursor)
    const idSeen = seenIds.has(id)
    boundedRemember(seenCursors, cursor)
    boundedRemember(seenIds, id)
    if (lastCursor.value === null || cursor > lastCursor.value) {
      lastCursor.value = cursor
      saveCursor()
    }
    if (cursorSeen || idSeen) return false
    recentEvents.value = [event, ...recentEvents.value].slice(0, RECENT_LIMIT)
    unreadCount.value += 1
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

  async function fetchChanges(afterSequence: number | null) {
    const query = new URLSearchParams({ limit: String(COMPENSATION_PAGE_LIMIT) })
    if (afterSequence !== null) query.set('afterSequence', String(afterSequence))
    const token = useAuthStore().getToken()
    const response = await fetch(`/api/alerts/changes?${query.toString()}`, {
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.ok) {
      lastErrorCode.value = String(body?.code || `HTTP_${response.status}`)
      return null
    }
    return body as {
      events: AlertRealtimeEvent[]
      latestSequence: number
      hasMore: boolean
      historyRefreshRequired: boolean
      oldestAvailableSequence?: number | null
    }
  }

  async function compensate() {
    if (!activeAccount.value) return
    if (compensating) return compensating
    compensating = (async () => {
      let pages = 0
      let processed = 0
      while (pages < 6 && processed < COMPENSATION_MAX_EVENTS) {
        const before = lastCursor.value
        const changes = await fetchChanges(before)
        if (!changes) return
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
          addEvent(event)
          processed += 1
        }
        if (!changes.hasMore) {
          return
        }
        pages += 1
      }
      historyRefreshRequired.value = true
      gapState.value ||= 'compensation_limit'
      lastErrorCode.value = 'ALERT_COMPENSATION_LIMIT'
    })().finally(() => { compensating = null })
    return compensating
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
    compensating = null
  }

  function markRead(cursor?: number) {
    if (cursor === undefined) unreadCount.value = 0
    else if (recentEvents.value.some((event) => event.cursor === cursor)) unreadCount.value = Math.max(0, unreadCount.value - 1)
  }

  function remove(cursor: number) {
    const existed = recentEvents.value.some((event) => event.cursor === cursor)
    recentEvents.value = recentEvents.value.filter((event) => event.cursor !== cursor)
    if (existed) unreadCount.value = Math.max(0, unreadCount.value - 1)
  }

  function clear() {
    recentEvents.value = []
    unreadCount.value = 0
  }

  function clearForLogout() {
    resetMemory({ preserveCursor: true })
    activeAccount.value = null
  }

  return {
    activeAccount, lastCursor, recentEvents, unreadCount, streamState, gapState,
    historyRefreshRequired, lastErrorCode, hasActiveGap,
    activate, start, stop, addEvent, handleStreamState, compensate,
    markRead, remove, clear, clearForLogout,
  }
})
