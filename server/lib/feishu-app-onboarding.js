import { randomUUID } from 'crypto'
import QRCode from 'qrcode'
import { registerApp } from '@larksuiteoapi/node-sdk'

const DEFAULT_TTL_MS = 10 * 60 * 1000
const MAX_APP_NAME_LENGTH = 64
const VALID_DM_POLICIES = new Set(['pairing', 'allowlist', 'open', 'disabled'])

function cleanText(value, fallback, maxLength = MAX_APP_NAME_LENGTH) {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized ? normalized.slice(0, maxLength) : fallback
}

function publicSession(session) {
  return {
    id: session.id,
    status: session.status,
    appName: session.appName,
    dmPolicy: session.dmPolicy,
    verificationUrl: session.verificationUrl || undefined,
    qrDataUrl: session.qrDataUrl || undefined,
    expiresAt: session.expiresAt || undefined,
    completedAt: session.completedAt || undefined,
    errorCode: session.errorCode || undefined,
  }
}

function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code.trim().toLowerCase() : ''
  if (['access_denied', 'expired_token', 'abort'].includes(code)) return code
  return 'registration_failed'
}

function createDeferred() {
  let resolve
  const promise = new Promise((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

/**
 * Keeps short-lived Feishu smart-app onboarding sessions in memory only.
 * App credentials never enter the returned session view or Admin SQLite.
 */
export function createFeishuAppOnboarding({
  register = registerApp,
  toDataUrl = QRCode.toDataURL,
  provision,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (typeof provision !== 'function') throw new Error('Feishu onboarding provision handler is required')

  const sessions = new Map()

  function clearExpired() {
    const current = now()
    for (const [id, session] of sessions) {
      const expiresAt = session.expiresAt || session.createdAt + ttlMs
      if (expiresAt <= current && ['starting', 'waiting_for_scan'].includes(session.status)) {
        session.status = 'expired'
        session.abortController.abort()
      }
      if (expiresAt + ttlMs <= current) sessions.delete(id)
    }
  }

  function getForOwner(id, ownerId) {
    clearExpired()
    const session = sessions.get(id)
    if (!session || session.ownerId !== ownerId) return null
    return publicSession(session)
  }

  async function start({ ownerId, actor, appName, dmPolicy }) {
    clearExpired()
    const existing = Array.from(sessions.values()).find((session) =>
      session.ownerId === ownerId && ['starting', 'waiting_for_scan', 'configuring'].includes(session.status)
    )
    if (existing) return publicSession(existing)

    const session = {
      id: randomUUID(),
      ownerId,
      actor,
      appName: cleanText(appName, 'GAIOP 智能助手'),
      dmPolicy: VALID_DM_POLICIES.has(dmPolicy) ? dmPolicy : 'open',
      status: 'starting',
      createdAt: now(),
      expiresAt: now() + ttlMs,
      abortController: new AbortController(),
      qrReady: createDeferred(),
    }
    sessions.set(session.id, session)

    session.task = Promise.resolve().then(async () => {
      const credentials = await register({
        source: 'gaiop-admin',
        signal: session.abortController.signal,
        createOnly: true,
        appPreset: {
          name: session.appName,
          desc: 'GAIOP 企业智能运维助手',
        },
        onQRCodeReady: async ({ url, expireIn }) => {
          session.verificationUrl = url
          session.expiresAt = now() + Math.max(1, Number(expireIn) || 600) * 1000
          session.qrDataUrl = await toDataUrl(url, {
            errorCorrectionLevel: 'M',
            margin: 1,
            width: 280,
          })
          session.status = 'waiting_for_scan'
          session.qrReady.resolve()
        },
        onStatusChange: ({ status }) => {
          if (status === 'slow_down' && session.status === 'waiting_for_scan') session.status = 'waiting_for_scan'
        },
      })

      session.status = 'configuring'
      await provision({
        appId: credentials.client_id,
        appSecret: credentials.client_secret,
        dmPolicy: session.dmPolicy,
      }, session)
      session.status = 'configured'
      session.completedAt = now()
      // The QR URL is itself a short-lived device-authorization artifact.
      // It is no longer needed once the credential handoff succeeds.
      session.verificationUrl = undefined
      session.qrDataUrl = undefined
    }).catch((error) => {
      if (session.status === 'expired' || session.status === 'cancelled') return
      session.status = safeErrorCode(error) === 'expired_token' ? 'expired' : 'failed'
      session.errorCode = safeErrorCode(error)
    }).finally(() => {
      session.qrReady.resolve()
    })

    await Promise.race([
      session.qrReady.promise,
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
    return publicSession(session)
  }

  function cancel({ id, ownerId }) {
    const session = sessions.get(id)
    if (!session || session.ownerId !== ownerId) return false
    if (['configured', 'failed', 'expired'].includes(session.status)) return false
    session.status = 'cancelled'
    session.abortController.abort()
    return true
  }

  return { start, getForOwner, cancel }
}
