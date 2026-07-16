function receiverUrl() {
  const explicitUrl = String(process.env.GAIOP_ALERT_RECEIVER_URL || '').trim()
  const raw = explicitUrl || (process.env.NODE_ENV === 'production' ? '' : 'http://127.0.0.1:3004')
  if (!raw) return null
  try {
    const url = new URL(raw)
    return ['http:', 'https:'].includes(url.protocol) ? url : null
  } catch {
    return null
  }
}

function receiverHeaders() {
  const token = String(process.env.GAIOP_ALERT_RECEIVER_TOKEN || '')
  return token ? { 'x-gaiop-alert-token': token } : {}
}

export async function readAlertIngestionRuntime() {
  const baseUrl = receiverUrl()
  if (!baseUrl) {
    return { state: 'pending', receiver: 'not-configured', lastReceivedAt: null, lastErrorCode: null }
  }

  try {
    const response = await fetch(new URL('/health', baseUrl), { headers: receiverHeaders(), signal: AbortSignal.timeout(3000) })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      return { state: 'failed', receiver: 'unavailable', lastReceivedAt: null, lastErrorCode: 'ALERT_RECEIVER_UNAVAILABLE' }
    }
    return {
      state: payload.health?.state === 'healthy' ? 'applied' : 'unknown',
      receiver: 'reachable',
      lastReceivedAt: payload.health?.lastReceivedAt || null,
      lastErrorCode: payload.health?.lastErrorCode || null,
    }
  } catch {
    return { state: 'failed', receiver: 'unavailable', lastReceivedAt: null, lastErrorCode: 'ALERT_RECEIVER_UNAVAILABLE' }
  }
}

export async function applyAlertIngestionRuntime(enabled) {
  const baseUrl = receiverUrl()
  if (!baseUrl) return { state: 'pending', receiver: 'not-configured', lastReceivedAt: null, lastErrorCode: null }

  try {
    const response = await fetch(new URL('/config', baseUrl), {
      method: 'PUT',
      headers: { ...receiverHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return { state: 'failed', receiver: 'unavailable', lastReceivedAt: null, lastErrorCode: 'ALERT_RECEIVER_APPLY_FAILED' }
    return readAlertIngestionRuntime()
  } catch {
    return { state: 'failed', receiver: 'unavailable', lastReceivedAt: null, lastErrorCode: 'ALERT_RECEIVER_APPLY_FAILED' }
  }
}
