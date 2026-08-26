import { describe, expect, it, vi } from 'vitest'
import { createGlobalSseLifecycle, shouldLoginCreateUnauthenticatedConnection } from './global-sse-lifecycle'

function createContext() {
  const websocket = { connect: vi.fn(), disconnect: vi.fn() }
  const alerts = { activate: vi.fn(), start: vi.fn(), stop: vi.fn(), clearForLogout: vi.fn() }
  return { websocket, alerts, lifecycle: createGlobalSseLifecycle(websocket, alerts) }
}

describe('global SSE lifecycle', () => {
  it('owns one authenticated connection across route-like repeated synchronizations', () => {
    const context = createContext()
    const user = { id: 'one', username: 'one', role: 'admin' as const }
    context.lifecycle.sync('token-one', user)
    context.lifecycle.sync('token-one', user)
    context.lifecycle.sync('token-one', { ...user })
    expect(context.websocket.connect).toHaveBeenCalledOnce()
    expect(context.websocket.disconnect).not.toHaveBeenCalled()
    // The WebSocket store makes repeated connect calls idempotent; lifecycle
    // never performs route-driven disconnect/recreate work.
    expect(context.alerts.activate).toHaveBeenCalledOnce()
  })

  it('disconnects and clears alert memory on logout or a changed authenticated account', () => {
    const context = createContext()
    context.lifecycle.sync('one-token', { id: 'one', username: 'one', role: 'admin' })
    context.lifecycle.sync('two-token', { id: 'two', username: 'two', role: 'standard' })
    context.lifecycle.sync(null, null)
    expect(context.websocket.disconnect).toHaveBeenCalledTimes(2)
    expect(context.alerts.clearForLogout).toHaveBeenCalledOnce()
  })

  it('keeps Login auth-disabled ownership disjoint from App authenticated ownership', () => {
    expect(shouldLoginCreateUnauthenticatedConnection(false)).toBe(true)
    expect(shouldLoginCreateUnauthenticatedConnection(true)).toBe(false)
  })
})
