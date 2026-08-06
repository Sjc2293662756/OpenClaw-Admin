import { randomUUID } from 'crypto'
import QRCode from 'qrcode'
import { validatePersonalWechatRegistration } from './personal-wechat-metadata.js'

const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_RETENTION_MS = 10 * 60 * 1000
const ACTIVE_STATUSES = new Set(['starting', 'waiting_for_scan', 'scanned'])
const TERMINAL_STATUSES = new Set(['success', 'expired', 'failed', 'cancelled'])

function publicSession(session) {
  return {
    id: session.id,
    status: session.status,
    displayName: session.displayName,
    note: session.note || undefined,
    qrDataUrl: session.qrDataUrl,
    expiresAt: session.expiresAt,
    accountId: session.accountId,
    wechatId: session.wechatId,
    nickname: session.nickname,
    requiresVerificationCode: session.status === 'verification_required' || undefined,
    errorCode: session.errorCode,
  }
}

function safeActor(actor) {
  return {
    id: String(actor?.id || '').slice(0, 128),
    username: String(actor?.username || '').slice(0, 200),
    role: String(actor?.role || '').slice(0, 32),
  }
}

function safeRuntimeErrorCode(error) {
  const code = String(error?.code || '').trim().toUpperCase()
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : 'PERSONAL_WECHAT_ONBOARDING_FAILED'
}

function clearQrArtifacts(session) {
  session.qrDataUrl = undefined
  session.loginId = undefined
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createPersonalWechatOnboarding({
  runtime,
  metadataStore,
  toDataUrl = QRCode.toDataURL,
  createId = randomUUID,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  retentionMs = DEFAULT_RETENTION_MS,
  onConnected,
} = {}) {
  if (!runtime || !metadataStore) throw new Error('Personal WeChat onboarding dependencies are required')
  const sessions = new Map()

  function expireSession(session) {
    if (!session || TERMINAL_STATUSES.has(session.status)) return
    session.status = 'expired'
    session.errorCode = 'PERSONAL_WECHAT_QR_EXPIRED'
    session.completedAt = now()
    clearQrArtifacts(session)
  }

  function clearExpired() {
    const timestamp = now()
    for (const [id, session] of sessions) {
      if (!TERMINAL_STATUSES.has(session.status) && session.expiresAt <= timestamp) expireSession(session)
      if (TERMINAL_STATUSES.has(session.status) && (session.completedAt || session.expiresAt) + retentionMs <= timestamp) {
        sessions.delete(id)
      }
    }
  }

  async function persistConnectedAccount(session, snapshot) {
    if (!snapshot.accountId) {
      const error = new Error('个人微信扫码成功但未返回账号标识')
      error.code = 'PERSONAL_WECHAT_ACCOUNT_ID_MISSING'
      throw error
    }
    const account = metadataStore.saveLinkedAccount({
      accountId: snapshot.accountId,
      displayName: session.displayName,
      note: session.note,
      wechatId: snapshot.wechatId,
      nickname: snapshot.nickname,
      actorId: session.ownerId,
    })
    session.status = 'success'
    session.accountId = account.accountId
    session.wechatId = account.wechatId
    session.nickname = account.nickname
    session.completedAt = now()
    session.errorCode = undefined
    clearQrArtifacts(session)
    try {
      await onConnected?.({ actor: session.actor, account, sessionId: session.id })
    } catch {
      // A successful plugin login and metadata write must not be rolled back by audit failure.
    }
  }

  async function applySnapshot(session, snapshot) {
    if (!session.loginId || snapshot.loginId !== session.loginId) {
      const error = new Error('个人微信扫码会话状态不匹配')
      error.code = 'PERSONAL_WECHAT_ONBOARDING_MISMATCH'
      throw error
    }
    if (snapshot.expiresAt) session.expiresAt = snapshot.expiresAt
    if (snapshot.qrText && ['waiting', 'scanned', 'need_verify_code'].includes(snapshot.status)) {
      session.qrDataUrl = await toDataUrl(snapshot.qrText, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 280,
      })
    }

    switch (snapshot.status) {
      case 'waiting':
        session.status = 'waiting_for_scan'
        break
      case 'scanned':
        session.status = 'scanned'
        break
      case 'need_verify_code':
        session.status = 'verification_required'
        break
      case 'connected':
      case 'already_connected':
        await persistConnectedAccount(session, snapshot)
        break
      case 'expired':
        expireSession(session)
        break
      case 'failed':
        session.status = 'failed'
        session.errorCode = 'PERSONAL_WECHAT_LOGIN_FAILED'
        session.completedAt = now()
        clearQrArtifacts(session)
        break
      case 'canceled':
        session.status = 'cancelled'
        session.completedAt = now()
        session.errorCode = undefined
        clearQrArtifacts(session)
        break
      default:
        break
    }
  }

  async function waitLoop(session) {
    while (ACTIVE_STATUSES.has(session.status)) {
      if (session.expiresAt <= now()) {
        expireSession(session)
        return
      }
      try {
        const snapshot = await runtime.waitQr(session.loginId, 25_000)
        if (TERMINAL_STATUSES.has(session.status)) return
        await applySnapshot(session, snapshot)
        if (ACTIVE_STATUSES.has(session.status)) await sleep(250)
      } catch (error) {
        if (error?.code === 'PERSONAL_WECHAT_RUNTIME_TIMEOUT' && session.expiresAt > now()) continue
        if (!TERMINAL_STATUSES.has(session.status)) {
          session.status = 'failed'
          session.errorCode = safeRuntimeErrorCode(error)
          session.completedAt = now()
          clearQrArtifacts(session)
        }
        return
      }
    }
  }

  function startWaitLoop(session) {
    if (session.task || !ACTIVE_STATUSES.has(session.status)) return
    const task = Promise.resolve()
      .then(() => waitLoop(session))
      .catch(() => {})
      .finally(() => {
        if (session.task === task) session.task = null
      })
    session.task = task
  }

  async function start({ ownerId, actor, displayName, note }) {
    clearExpired()
    const registration = validatePersonalWechatRegistration({ displayName, note })
    if (!registration.ok) {
      const error = new Error(registration.error)
      error.code = 'PERSONAL_WECHAT_REGISTRATION_INVALID'
      throw error
    }
    const existing = Array.from(sessions.values()).find((session) =>
      session.ownerId === ownerId && (ACTIVE_STATUSES.has(session.status) || session.status === 'verification_required')
    )
    if (existing) return publicSession(existing)

    const session = {
      id: createId(),
      ownerId: String(ownerId || ''),
      actor: safeActor(actor),
      displayName: registration.value.displayName,
      note: registration.value.note,
      status: 'starting',
      createdAt: now(),
      expiresAt: now() + ttlMs,
      task: null,
    }
    sessions.set(session.id, session)

    try {
      const snapshot = await runtime.startQr()
      session.loginId = snapshot.loginId
      await applySnapshot(session, snapshot)
      startWaitLoop(session)
    } catch (error) {
      session.status = 'failed'
      session.errorCode = safeRuntimeErrorCode(error)
      session.completedAt = now()
      clearQrArtifacts(session)
    }
    return publicSession(session)
  }

  function getForOwner(id, ownerId) {
    clearExpired()
    const session = sessions.get(String(id || ''))
    if (!session || session.ownerId !== String(ownerId || '')) return null
    return publicSession(session)
  }

  async function verify({ id, ownerId, code }) {
    clearExpired()
    const session = sessions.get(String(id || ''))
    if (!session || session.ownerId !== String(ownerId || '')) return null
    if (session.status !== 'verification_required' || !session.loginId) {
      const error = new Error('当前扫码会话不需要验证码')
      error.code = 'PERSONAL_WECHAT_VERIFICATION_NOT_REQUIRED'
      throw error
    }
    const snapshot = await runtime.verifyQr(session.loginId, code)
    await applySnapshot(session, snapshot)
    startWaitLoop(session)
    return publicSession(session)
  }

  async function cancel({ id, ownerId }) {
    clearExpired()
    const session = sessions.get(String(id || ''))
    if (!session || session.ownerId !== String(ownerId || '')) return null
    if (TERMINAL_STATUSES.has(session.status)) {
      const error = new Error('当前扫码会话无法取消')
      error.code = 'PERSONAL_WECHAT_ONBOARDING_NOT_CANCELLABLE'
      throw error
    }
    const snapshot = await runtime.cancelQr(session.loginId)
    await applySnapshot(session, snapshot)
    return publicSession(session)
  }

  return { start, getForOwner, verify, cancel }
}

export const __test__ = { ACTIVE_STATUSES, TERMINAL_STATUSES, publicSession }
