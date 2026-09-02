import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatDisplayPreferencesStore } from './chat-display-preferences'

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
  })
  setActivePinia(createPinia())
  vi.restoreAllMocks()
})

describe('chat display preferences store', () => {
  it('defaults to showing the process and loads and saves the current account preference', async () => {
    const store = useChatDisplayPreferencesStore()
    expect(store.preferences.showThinkingProcess).toBe(true)
    store.activate({ id: 'user-one' })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, preferences: { showThinkingProcess: false, updatedAt: 10 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, preferences: { showThinkingProcess: true, updatedAt: 20 } }))))
    await expect(store.loadPreferences()).resolves.toBe(true)
    expect(store.preferences.showThinkingProcess).toBe(false)
    await expect(store.savePreferences(true)).resolves.toMatchObject({ showThinkingProcess: true, updatedAt: 20 })
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]?.method).toBe('PUT')
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]?.body).toBe('{"showThinkingProcess":true}')
  })

  it('resets to the safe default and aborts stale requests when accounts change', async () => {
    const store = useChatDisplayPreferencesStore()
    const late = deferred<Response>()
    const signals: AbortSignal[] = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal)
      return late.promise
    }))
    store.activate({ id: 'user-one' })
    const loading = store.loadPreferences()
    store.activate({ id: 'user-two' })
    expect(signals[0]?.aborted).toBe(true)
    expect(store.preferences.showThinkingProcess).toBe(true)
    late.resolve(new Response(JSON.stringify({ ok: true, preferences: { showThinkingProcess: false, updatedAt: 10 } })))
    await expect(loading).resolves.toBe(false)
    expect(store.activeAccount).toBe('user-two')
    expect(store.preferences.showThinkingProcess).toBe(true)
    expect(store.preferencesReady).toBe(false)
  })

  it('keeps the persisted value visible after a save failure', async () => {
    const store = useChatDisplayPreferencesStore()
    store.activate({ id: 'user-one' })
    store.preferences = { showThinkingProcess: true, updatedAt: 10 }
    store.preferencesReady = true
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unavailable')))
    await expect(store.savePreferences(false)).rejects.toThrow('network unavailable')
    expect(store.preferences.showThinkingProcess).toBe(true)
    expect(store.preferencesSaveError).toContain('network unavailable')
  })
})
