import { describe, expect, it, vi } from 'vitest'
import { createGlobalSseLifecycle, shouldLoginCreateUnauthenticatedConnection } from './global-sse-lifecycle'

function createContext() {
  const websocket = { connect: vi.fn(), disconnect: vi.fn() }
  const alerts = { activate: vi.fn(), loadPreferences: vi.fn().mockResolvedValue(true), start: vi.fn(), stop: vi.fn(), clearForLogout: vi.fn() }
  return { websocket, alerts, lifecycle: createGlobalSseLifecycle(websocket, alerts) }
}

describe('global SSE lifecycle', () => {
  it('loads account preferences before owning one authenticated connection across route-like repeated synchronizations', async () => {
    const context = createContext()
    const user = { id: 'one', username: 'one', role: 'admin' as const }
    await context.lifecycle.sync('token-one', user)
    await context.lifecycle.sync('token-one', user)
    await context.lifecycle.sync('token-one', { ...user })
    expect(context.websocket.connect).toHaveBeenCalledOnce()
    expect(context.websocket.disconnect).not.toHaveBeenCalled()
    // The WebSocket store makes repeated connect calls idempotent; lifecycle
    // never performs route-driven disconnect/recreate work.
    expect(context.alerts.activate).toHaveBeenCalledOnce()
    expect(context.alerts.loadPreferences).toHaveBeenCalledOnce()
  })

  it('disconnects and clears alert memory on logout or a changed authenticated account', async () => {
    const context = createContext()
    await context.lifecycle.sync('one-token', { id: 'one', username: 'one', role: 'admin' })
    await context.lifecycle.sync('two-token', { id: 'two', username: 'two', role: 'standard' })
    await context.lifecycle.sync(null, null)
    expect(context.websocket.disconnect).toHaveBeenCalledTimes(2)
    expect(context.alerts.clearForLogout).toHaveBeenCalledOnce()
  })

  it('keeps Login auth-disabled ownership disjoint from App authenticated ownership', () => {
    expect(shouldLoginCreateUnauthenticatedConnection(false)).toBe(true)
    expect(shouldLoginCreateUnauthenticatedConnection(true)).toBe(false)
  })
})
