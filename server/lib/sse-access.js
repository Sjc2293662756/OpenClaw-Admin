const ALERT_VIEWER_ROLES = new Set(['standard', 'auditor', 'admin'])

export function canReceiveSseData(user, data, {
  extractSessionKey,
  canAccessSession,
} = {}) {
  if (data?.type === 'alert' || data?.type === 'alertStreamState') {
    return ALERT_VIEWER_ROLES.has(user?.role)
  }
  if (data?.type !== 'event' || user?.role === 'admin') return true
  const sessionKey = extractSessionKey?.(data.payload)
  return Boolean(sessionKey && canAccessSession?.(user, sessionKey))
}

export const __test__ = { ALERT_VIEWER_ROLES }
