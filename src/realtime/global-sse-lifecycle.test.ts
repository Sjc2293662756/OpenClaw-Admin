import { describe, expect, it, vi } from 'vitest'
import { createGlobalSseLifecycle, shouldLoginCreateUnauthenticatedConnection } from './global-sse-lifecycle'

function createContext() {
  const websocket = { connect: vi.fn(), disconnect: vi.fn() }
  const alerts = {
    activeAccount: null as string | null,
    activate: vi.fn((account: { id?: string; username: string }) => {
      alerts.activeAccount = String(account.id || account.username)
    }),
    loadPreferences: vi.fn().mockResolvedValue(true),
    loadNotifications: vi.fn().mockResolvedValue(true),
    start: vi.fn(),
    stop: vi.fn(),
    clearForLogout: vi.fn(() => { alerts.activeAccount = null }),
  }
  return { websocket, alerts, lifecycle: createGlobalSseLifecycle(websocket, alerts) }
}

function user(id: string, permissionVersion = 0, notifications = true) {
  return {
    id,
    username: id,
    role: 'admin' as const,
    permissionVersion,
    effectiveModules: { 'alerts.notifications': notifications },
  }
}

describe('global SSE lifecycle', () => {
  it('loads account preferences before owning one authenticated connection across route-like repeated synchronizations', async () => {
    const context = createContext()
    const account = user('one')
    await context.lifecycle.sync('token-one', account)
    await context.lifecycle.sync('token-one', account)
    await context.lifecycle.sync('token-one', { ...account })
    expect(context.websocket.connect).toHaveBeenCalledOnce()
    expect(context.websocket.disconnect).not.toHaveBeenCalled()
    // The WebSocket store makes repeated connect calls idempotent; lifecycle
    // never performs route-driven disconnect/recreate work.
    expect(context.alerts.activate).toHaveBeenCalledOnce()
    expect(context.alerts.loadPreferences).toHaveBeenCalledOnce()
    expect(context.alerts.loadNotifications).toHaveBeenCalledOnce()
  })

  it('disconnects and clears alert memory on logout or a changed authenticated account', async () => {
    const context = createContext()
    await context.lifecycle.sync('one-token', user('one'))
    await context.lifecycle.sync('two-token', { ...user('two'), role: 'standard' })
    await context.lifecycle.sync(null, null)
    expect(context.websocket.disconnect).toHaveBeenCalledTimes(2)
    expect(context.alerts.clearForLogout).toHaveBeenCalledOnce()
  })

  it('rebuilds the stream when permissionVersion changes and skips alert preference APIs when notifications are denied', async () => {
    const context = createContext()
    await context.lifecycle.sync('token', user('one', 1, true))
    await context.lifecycle.sync('token', user('one', 2, false))
    expect(context.websocket.disconnect).toHaveBeenCalledOnce()
    expect(context.websocket.connect).toHaveBeenCalledTimes(2)
    expect(context.alerts.loadPreferences).toHaveBeenCalledOnce()
    expect(context.alerts.loadNotifications).toHaveBeenCalledOnce()
    expect(context.alerts.stop).toHaveBeenCalledOnce()
  })

  it('does not start a stream after preference loading clears an expired account', async () => {
    const context = createContext()
    context.alerts.loadPreferences.mockImplementationOnce(async () => {
      context.alerts.activeAccount = null
      return false
    })

    await context.lifecycle.sync('expired-token', user('one'))

    expect(context.alerts.loadNotifications).not.toHaveBeenCalled()
    expect(context.alerts.start).not.toHaveBeenCalled()
    expect(context.websocket.connect).not.toHaveBeenCalled()
  })

  it('keeps Login auth-disabled ownership disjoint from App authenticated ownership', () => {
    expect(shouldLoginCreateUnauthenticatedConnection(false)).toBe(true)
    expect(shouldLoginCreateUnauthenticatedConnection(true)).toBe(false)
  })
})
