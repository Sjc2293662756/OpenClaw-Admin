import type { AuthUser } from '@/stores/auth'

type ConnectionStore = { connect: () => void; disconnect: () => void }
type AlertStore = {
  activate: (user: AuthUser) => void
  start: () => void
  stop: () => void
  clearForLogout: () => void
}

export function shouldLoginCreateUnauthenticatedConnection(authEnabled: boolean) {
  return !authEnabled
}

// Keep the policy outside App.vue so connection ownership can be regression-tested
// without mounting layouts or depending on route rendering.
export function createGlobalSseLifecycle(websocket: ConnectionStore, alerts: AlertStore) {
  let previousToken: string | null = null
  let previousAccount: string | null = null

  function accountOf(user: AuthUser | null) {
    return user ? String(user.id || user.username) : null
  }

  function sync(token: string | null, user: AuthUser | null) {
    const account = accountOf(user)
    if (token && user) {
      if (previousToken === token && previousAccount === account) return
      if ((previousToken && previousToken !== token) || (previousAccount && previousAccount !== account)) {
        websocket.disconnect()
      }
      alerts.activate(user)
      alerts.start()
      websocket.connect()
    } else {
      if (previousToken === null && previousAccount === null) return
      websocket.disconnect()
      alerts.clearForLogout()
    }
    previousToken = token
    previousAccount = account
  }

  function dispose() {
    alerts.stop()
    websocket.disconnect()
    previousToken = null
    previousAccount = null
  }

  return { sync, dispose }
}
