import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAlertRealtimeStore } from './alert-realtime'

function event(cursor: number, id = `alert-${cursor}`) {
  return { type: 'alert' as const, action: cursor % 2 ? 'triggered' as const : 'recovered' as const, cursor, payload: { id } }
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

  it('bounds recent events and seen keys', () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    for (let cursor = 1; cursor <= 900; cursor += 1) store.addEvent(event(cursor))
    expect(store.recentEvents).toHaveLength(150)
    // The earliest seen key is evicted, therefore an old cursor can be treated as a new event.
    expect(store.addEvent(event(1, 'fresh-after-eviction'))).toBe(true)
  })

  it('uses a no-cursor baseline without queuing history and reconciles raced SSE data once', async () => {
    const store = useAlertRealtimeStore()
    store.activate({ id: 'one', username: 'one', role: 'admin' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true, events: [event(11)], latestSequence: 11, hasMore: false, historyRefreshRequired: false,
    }), { headers: { 'content-type': 'application/json' } })))
    await store.compensate()
    expect(store.recentEvents).toHaveLength(0)
    store.addEvent(event(11))
    await store.compensate()
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
})
