import type { AuthUser } from '@/stores/auth'

type ConnectionStore = { connect: () => void; disconnect: () => void }
type AlertStore = {
  activate: (user: AuthUser) => void
  loadPreferences: () => Promise<boolean>
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
  let syncGeneration = 0

  function accountOf(user: AuthUser | null) {
    return user ? `${String(user.id || user.username)}:${Number(user.permissionVersion || 0)}` : null
  }

  async function sync(token: string | null, user: AuthUser | null) {
    const account = accountOf(user)
    if (token && user) {
      if (previousToken === token && previousAccount === account) return
      const generation = ++syncGeneration
      if ((previousToken && previousToken !== token) || (previousAccount && previousAccount !== account)) {
        websocket.disconnect()
      }
      previousToken = token
      previousAccount = account
      alerts.activate(user)
      const notificationsAllowed = user.effectiveModules?.['alerts.notifications'] === true
      // A saved all-off preference must be known before the browser starts
      // consuming its one alert SSE stream. This prevents a just-logged-in
      // account from flashing a notification while its setting is loading.
      if (notificationsAllowed) await alerts.loadPreferences()
      if (generation !== syncGeneration || previousToken !== token || previousAccount !== account) return
      if (notificationsAllowed) alerts.start()
      else alerts.stop()
      websocket.connect()
    } else {
      if (previousToken === null && previousAccount === null) return
      syncGeneration += 1
      websocket.disconnect()
      alerts.clearForLogout()
      previousToken = null
      previousAccount = null
    }
  }

  function dispose() {
    alerts.stop()
    websocket.disconnect()
    syncGeneration += 1
    previousToken = null
    previousAccount = null
  }

  return { sync, dispose }
}
