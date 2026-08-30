import { canAccessEffectiveModule } from './module-permissions.js'

export function canReceiveSseData(user, data, {
  extractSessionKey,
  canAccessSession,
} = {}) {
  if (data?.type === 'permissionsChanged') return String(data.userId || '') === String(user?.id || '')
  if (data?.type === 'alert' || data?.type === 'alertStreamState') {
    return canAccessEffectiveModule(user, 'alerts.notifications')
  }
  if (data?.type !== 'event' || user?.role === 'admin') return true
  const sessionKey = extractSessionKey?.(data.payload)
  return Boolean(sessionKey && canAccessSession?.(user, sessionKey))
}
