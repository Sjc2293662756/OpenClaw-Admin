import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAlertRealtimeStore, type AlertNotificationCounts, type AlertRealtimeEvent } from './alert-realtime'

function event(notificationId: number, {
  cursor = notificationId,
  id = `alert-${notificationId}`,
  severity = '轻微',
  action = 'triggered',
}: {
  cursor?: number
  id?: string
  severity?: string
  action?: 'triggered' | 'recovered'
} = {}): AlertRealtimeEvent {
  return {
    type: 'alert',
    action,
    cursor,
    notificationId,
    receiverGeneration: 1,
    payload: { id, severity },
  }
}

function storedEvent(notificationId: number, options: Parameters<typeof event>[1] = {}) {
  return {
    ...event(notificationId, options),
    read: false,
    readAt: null,
    createdOffline: false,
    createdAt: notificationId,
    receivedAt: notificationId,
  }
}

function counts(total = 0, unread = total): AlertNotificationCounts {
  return {
    total,
    unread,
    filteredTotal: total,
    filteredUnread: unread,
    bySeverity: {
      轻微: { total, unread },
      重大: { total: 0, unread: 0 },
      紧急: { total: 0, unread: 0 },
    },
  }
}

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ ok: status < 400, ...body }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function listResponse(notifications: unknown[], value = counts(notifications.length), {
  hasMore = false,
  nextBeforeId = null as number | null,
  snapshotThroughId = notifications.length,
} = {}) {
  return response({
    notifications,
    counts: value,
    page: { limit: 30, hasMore, nextBeforeId, snapshotThroughId },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  })
  setActivePinia(createPinia())
  vi.restoreAllMocks()
})

describe('server-backed alert notification store', () => {
  it('uses notification ids for idempotence and retains triggered and recovered actions for one alert', () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    expect(store.addEvent(event(1, { id: 'same-alert' }))).toBe(true)
    expect(store.addEvent(event(1, { id: 'other-alert' }))).toBe(false)
    expect(store.addEvent(event(2, { id: 'same-alert', action: 'recovered' }))).toBe(true)
    expect(store.recentEvents.map((item) => item.action)).toEqual(['recovered', 'triggered'])
    expect(store.notificationQueue.map((item) => item.notificationId)).toEqual([1])
    expect(store.unreadCount).toBe(2)
  })

  it('keeps persisted live items visible while popup and sound preferences only govern online prompts', () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    store.preferences = { ...store.preferences, minorPopupEnabled: false }
    store.addEvent(event(1))
    store.preferences = { ...store.preferences, realtimeEnabled: false }
    store.addEvent(event(2))
    expect(store.recentEvents.map((item) => item.notificationId)).toEqual([2, 1])
    expect(store.notificationQueue).toEqual([])
    expect(store.unreadCount).toBe(2)
  })

  it('loads stable keyset pages from the server without a browser item cap', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    const first = Array.from({ length: 30 }, (_, index) => storedEvent(100 - index))
    const second = Array.from({ length: 25 }, (_, index) => storedEvent(70 - index))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(listResponse(first, counts(55), { hasMore: true, nextBeforeId: 71, snapshotThroughId: 100 }))
      .mockResolvedValueOnce(listResponse(second, counts(55), { snapshotThroughId: 100 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(store.loadNotifications()).resolves.toBe(true)
    await expect(store.loadMoreNotifications()).resolves.toBe(true)
    expect(store.recentEvents).toHaveLength(55)
    expect(store.recentEvents[0]?.notificationId).toBe(100)
    expect(store.recentEvents[store.recentEvents.length - 1]?.notificationId).toBe(46)
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('beforeId=71')
    expect(store.notificationsHasMore).toBe(false)
  })

  it('merges an SSE event that races a page snapshot without duplication or scroll-list replacement', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => pending.promise))
    const loading = store.loadNotifications()
    store.addEvent(event(4))
    pending.resolve(listResponse([storedEvent(3), storedEvent(2), storedEvent(1)], counts(3), { snapshotThroughId: 3 }))
    await expect(loading).resolves.toBe(true)
    expect(store.recentEvents.map((item) => item.notificationId)).toEqual([4, 3, 2, 1])
    expect(store.notificationCounts.total).toBe(4)
    expect(store.notificationCounts.unread).toBe(4)
  })

  it('keeps global counts accurate when a racing SSE event is outside the current filter', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    store.notificationSeverity = '紧急'
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => pending.promise))
    const loading = store.loadNotifications()
    store.addEvent(event(4, { severity: '轻微' }))
    const snapshotCounts = counts(0, 0)
    snapshotCounts.total = 1
    snapshotCounts.unread = 1
    snapshotCounts.filteredTotal = 1
    snapshotCounts.filteredUnread = 1
    snapshotCounts.bySeverity.紧急 = { total: 1, unread: 1 }
    pending.resolve(listResponse([storedEvent(3, { severity: '紧急' })], snapshotCounts, { snapshotThroughId: 3 }))
    await expect(loading).resolves.toBe(true)
    expect(store.recentEvents.map((item) => item.notificationId)).toEqual([3])
    expect(store.notificationCounts.total).toBe(2)
    expect(store.notificationCounts.unread).toBe(2)
    expect(store.notificationCounts.filteredTotal).toBe(1)
    expect(store.notificationCounts.bySeverity.轻微.total).toBe(1)
    expect(store.notificationCounts.bySeverity.紧急.total).toBe(1)
  })

  it('sends severity and unread filters to the server and applies an offline summary range', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    const fetchMock = vi.fn().mockResolvedValue(listResponse([], counts(0), { snapshotThroughId: 10 }))
    vi.stubGlobal('fetch', fetchMock)
    await store.setNotificationFilters('紧急', 'unread')
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`severity=${encodeURIComponent('紧急')}`)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('readState=unread')

    const summary = {
      claimToken: 'claim', afterId: 3, throughId: 10, total: 1,
      bySeverity: { 轻微: 0, 重大: 0, 紧急: 1 }, expiresAt: Date.now() + 30_000,
    }
    store.openOfflineSummary(summary)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(store.notificationSeverity).toBeNull()
    expect(store.notificationReadState).toBe('all')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('offlineAfterId=3')
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('throughId=10')
    store.addEvent(event(11, { severity: '紧急' }))
    expect(store.recentEvents).toEqual([])
    expect(store.notificationCounts.total).toBe(1)
    expect(store.notificationCounts.filteredTotal).toBe(0)
  })

  it('persists one-item read state and keeps the server count as badge authority', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    store.addEvent(event(1))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ changed: true, notificationId: 1, readAt: 20 }))
      .mockResolvedValueOnce(listResponse([{ ...storedEvent(1), read: true, readAt: 20 }], counts(1, 0), { snapshotThroughId: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(store.markRead(1)).resolves.toBe(true)
    expect(store.recentEvents[0]?.read).toBe(true)
    expect(store.unreadCount).toBe(0)
    await expect(store.markRead(1)).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('persists popup read state even when the active list filter excludes the item', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    store.notificationSeverity = '紧急'
    store.addEvent(event(1, { severity: '轻微' }))
    expect(store.recentEvents).toEqual([])
    expect(store.notificationQueue.map((item) => item.notificationId)).toEqual([1])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ changed: true, notificationId: 1, readAt: 20 }))
      .mockResolvedValueOnce(listResponse([], counts(1, 0), { snapshotThroughId: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(store.markRead(1)).resolves.toBe(true)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/alerts/notifications/1/read')
    expect(store.unreadCount).toBe(0)
  })

  it('persists filtered batch read and clear using the active server filters', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    const afterRead = counts(2, 1)
    afterRead.filteredTotal = 1
    afterRead.filteredUnread = 0
    const afterClear = counts(1, 1)
    afterClear.filteredTotal = 0
    afterClear.filteredUnread = 0
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ changed: 1, counts: afterRead }))
      .mockResolvedValueOnce(response({ changed: 1, counts: afterClear }))
    vi.stubGlobal('fetch', fetchMock)
    store.notificationSeverity = '重大'
    store.notificationReadState = 'unread'
    await expect(store.markFilteredRead()).resolves.toBe(1)
    await expect(store.clearFiltered()).resolves.toBe(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ severity: '重大', readState: 'unread' })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ severity: '重大', readState: 'unread' })
    expect(store.unreadCount).toBe(1)
  })

  it('claims and confirms one offline summary without changing notification read state', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    const summary = {
      claimToken: 'claim-one', afterId: 0, throughId: 7, total: 3,
      bySeverity: { 轻微: 1, 重大: 1, 紧急: 1 }, expiresAt: Date.now() + 30_000,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ summary, claimInProgress: false, retryAfter: null }))
      .mockResolvedValueOnce(response({ confirmedThrough: 7 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(store.claimOfflineSummary()).resolves.toEqual(summary)
    expect(store.offlineSummary).toEqual(summary)
    await expect(store.confirmOfflineSummary(summary)).resolves.toBe(true)
    expect(store.offlineSummary).toBeNull()
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/alerts/notifications/offline-summary/confirm')
  })

  it('retries after another tab claim lease expires and still lets the server choose one winner', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    const summary = {
      claimToken: 'replacement', afterId: 0, throughId: 2, total: 2,
      bySeverity: { 轻微: 2, 重大: 0, 紧急: 0 }, expiresAt: Date.now() + 30_000,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ summary: null, claimInProgress: true, retryAfter: Date.now() + 100 }))
      .mockResolvedValueOnce(response({ summary, claimInProgress: false, retryAfter: null }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(store.claimOfflineSummary()).resolves.toBeNull()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(store.offlineSummary).toEqual(summary)
    store.clearForLogout()
  })

  it('aborts and ignores a late list response after an account switch', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    const pending = deferred<Response>()
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal
      return pending.promise
    }))
    const loading = store.loadNotifications()
    store.activate({ id: 'two', username: 'two', role: 'standard' })
    expect(signal?.aborted).toBe(true)
    pending.resolve(listResponse([storedEvent(1)], counts(1), { snapshotThroughId: 1 }))
    await expect(loading).resolves.toBe(false)
    expect(store.recentEvents).toEqual([])
    expect(store.unreadCount).toBe(0)
  })

  it('loads and saves current-account preferences and rejects stale account responses', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    const loaded = {
      realtimeEnabled: true, soundEnabled: false,
      minorPopupEnabled: true, minorNotificationEnabled: true,
      majorPopupEnabled: true, majorNotificationEnabled: true,
      criticalPopupEnabled: false, criticalNotificationEnabled: true,
    }
    const late = deferred<Response>()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ preferences: loaded }))
      .mockResolvedValueOnce(response({ preferences: { ...loaded, realtimeEnabled: false } }))
      .mockImplementationOnce(() => late.promise)
    vi.stubGlobal('fetch', fetchMock)
    await expect(store.loadPreferences()).resolves.toBe(true)
    await expect(store.savePreferences({ ...store.preferences, realtimeEnabled: false })).resolves.toMatchObject({ realtimeEnabled: false })
    store.activate({ id: 'two', username: 'two', role: 'admin' })
    const stale = store.loadPreferences()
    store.activate({ id: 'three', username: 'three', role: 'admin' })
    late.resolve(response({ preferences: loaded }))
    await expect(stale).resolves.toBe(false)
    expect(store.activeAccount).toContain('three')
  })

  it('retains an unresolved upstream gap as diagnostics without replaying Receiver history into notifications', () => {
    const store = useAlertRealtimeStore()
    store.handleStreamState({ state: 'gap', gapState: 'unresolved', historyRefreshRequired: true, code: 'ALERT_CURSOR_EXPIRED' })
    store.handleStreamState({ state: 'connected' })
    expect(store.historyRefreshRequired).toBe(true)
    expect(store.gapState).toBe('unresolved')
    expect(store.recentEvents).toEqual([])
  })
})
