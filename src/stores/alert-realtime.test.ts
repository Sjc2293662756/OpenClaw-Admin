import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAlertRealtimeStore } from './alert-realtime'

function event(cursor: number, id = `alert-${cursor}`) {
  return { type: 'alert' as const, action: cursor % 2 ? 'triggered' as const : 'recovered' as const, cursor, payload: { id } }
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

describe('alert realtime store', () => {
  it('isolates cursors by account and clears in-memory alert content on account change', () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    store.addEvent(event(7))
    expect(store.lastCursor).toBe(7)
    store.activate({ id: 'two', username: 'two', role: 'standard' })
    expect(store.lastCursor).toBeNull()
    expect(store.recentEvents).toEqual([])
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    expect(store.lastCursor).toBe(7)
  })

  it('deduplicates cursor and business id while retaining triggered and recovered actions', () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    store.addEvent(event(1, 'same'))
    store.addEvent(event(1, 'other'))
    store.addEvent(event(2, 'same'))
    store.addEvent(event(3, 'third'))
    store.addEvent(event(4, 'recovered'))
    expect(store.recentEvents.map((item) => item.action)).toEqual(['recovered', 'triggered', 'triggered'])
    expect(store.lastCursor).toBe(4)
    expect(store.unreadCount).toBe(3)
  })

  it('bounds recent and seen structures without re-admitting cursors below the high-water mark', () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    for (let cursor = 1; cursor <= 900; cursor += 1) store.addEvent(event(cursor))
    expect(store.recentEvents).toHaveLength(150)
    expect(store.addEvent(event(1, 'fresh-after-eviction'))).toBe(false)
  })

  it('uses a no-cursor baseline without queuing history and reconciles raced SSE data once', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => response.promise))
    const running = store.compensate()
    store.addEvent(event(11))
    response.resolve(new Response(JSON.stringify({
      ok: true, events: [event(11)], latestSequence: 11, hasMore: false, historyRefreshRequired: false,
    }), { headers: { 'content-type': 'application/json' } }))
    await running
    expect(store.recentEvents).toHaveLength(1)
    expect(store.lastCursor).toBe(11)
  })

  it('does not let a connected state clear an unresolved gap', () => {
    const store = useAlertRealtimeStore()
    store.handleStreamState({ state: 'gap', gapState: 'unresolved', historyRefreshRequired: true, code: 'ALERT_CURSOR_EXPIRED' })
    store.handleStreamState({ state: 'connected' })
    expect(store.historyRefreshRequired).toBe(true)
    expect(store.gapState).toBe('unresolved')
  })

  it('accepts a missing middle cursor from a compensation batch while deduplicating its raced SSE event', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    store.addEvent(event(10))
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => response.promise))
    const running = store.compensate()
    store.addEvent(event(12))
    response.resolve(new Response(JSON.stringify({
      ok: true,
      events: [event(11), event(12)],
      latestSequence: 12,
      hasMore: false,
      historyRefreshRequired: false,
    }), { headers: { 'content-type': 'application/json' } }))
    await running
    expect(store.recentEvents.map((item) => item.cursor).sort()).toEqual([10, 11, 12])
    expect(store.lastCursor).toBe(12)
  })

  it('aborts and invalidates a late compensation response on account switch and logout', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    store.addEvent(event(10))
    const first = deferred<Response>()
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal)
      return first.promise
    }))
    const running = store.compensate()
    store.activate({ id: 'two', username: 'two', role: 'standard' })
    expect(signals[0]?.aborted).toBe(true)
    first.resolve(new Response(JSON.stringify({ ok: true, events: [event(11)], latestSequence: 11, hasMore: false, historyRefreshRequired: false }), { headers: { 'content-type': 'application/json' } }))
    await running
    expect(store.activeAccount).toContain('two')
    expect(store.recentEvents).toEqual([])
    expect(store.lastCursor).toBeNull()

    store.activate({ id: 'one', username: 'one', role: 'admin' })
    const second = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal)
      return second.promise
    }))
    const logoutRun = store.compensate()
    store.clearForLogout()
    expect(signals[signals.length - 1]?.aborted).toBe(true)
    second.resolve(new Response(JSON.stringify({ ok: true, events: [event(12)], latestSequence: 12, hasMore: false, historyRefreshRequired: false }), { headers: { 'content-type': 'application/json' } }))
    await logoutRun
    expect(store.activeAccount).toBeNull()
    expect(store.recentEvents).toEqual([])
  })
})
