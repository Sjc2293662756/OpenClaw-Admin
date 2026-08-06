import { normalizePersonalWechatAccountId } from './personal-wechat-metadata.js'

export const DEFAULT_PERSONAL_WECHAT_ADAPTER_URL = 'http://127.0.0.1:19091'
export const PERSONAL_WECHAT_REQUEST_TIMEOUT_MS = 40_000

const QR_STATUSES = new Set([
  'waiting',
  'scanned',
  'need_verify_code',
  'expired',
  'connected',
  'already_connected',
  'failed',
  'canceled',
])

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function safeString(value, maxLength = 256) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength)
}

function safeOptionalTimestamp(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  const milliseconds = number < 10_000_000_000 ? number * 1000 : number
  return Math.floor(milliseconds)
}

function safeErrorCode(value) {
  const normalized = safeString(value, 80).toUpperCase()
  return /^[A-Z0-9_]{1,80}$/.test(normalized) ? normalized : undefined
}

function safeAccount(value) {
  const row = asRecord(value)
  const accountId = normalizePersonalWechatAccountId(row.accountId)
  if (!accountId) return null
  const lastErrorCode = safeErrorCode(row.lastErrorCode || row.lastError)
    || (row.lastError ? 'WEIXIN_ACCOUNT_ERROR' : undefined)
  return {
    accountId,
    wechatId: safeString(row.userId || row.wechatId, 256) || undefined,
    nickname: safeString(row.nickname, 128) || undefined,
    enabled: row.enabled !== false,
    configured: row.configured === true,
    running: row.running === true,
    lastErrorCode,
    lastEventAt: safeOptionalTimestamp(row.lastEventAt),
    lastInboundAt: safeOptionalTimestamp(row.lastInboundAt),
    lastOutboundAt: safeOptionalTimestamp(row.lastOutboundAt),
  }
}

function normalizeQrStatus(value) {
  const status = safeString(value, 40).toLowerCase()
  if (status === 'starting' || status === 'waiting_for_scan' || status === 'waiting') return 'waiting'
  if (status === 'verification_required' || status === 'need_verify_code') return 'need_verify_code'
  if (status === 'canceled' || status === 'cancelled') return 'canceled'
  return status
}

function safeQrSnapshot(value) {
  const row = asRecord(value)
  const loginId = safeString(row.loginId || row.sessionKey, 256)
  const status = normalizeQrStatus(row.status)
  if (!loginId || !QR_STATUSES.has(status)) {
    const error = new Error('个人微信扫码服务返回了无效状态')
    error.code = 'PERSONAL_WECHAT_RUNTIME_RESPONSE_INVALID'
    throw error
  }
  return {
    loginId,
    status,
    qrText: typeof row.qrText === 'string'
      ? row.qrText
      : (typeof row.qrcodeUrl === 'string' ? row.qrcodeUrl : undefined),
    expiresAt: safeOptionalTimestamp(row.expiresAt || row.expiresAtMs),
    accountId: normalizePersonalWechatAccountId(row.accountId) || undefined,
    wechatId: safeString(row.userId || row.wechatId, 256) || undefined,
    nickname: safeString(row.nickname, 128) || undefined,
  }
}

function toRuntimeError(error) {
  if (error?.code && String(error.code).startsWith('PERSONAL_WECHAT_')) return error
  const message = String(error?.message || error || '').toLowerCase()
  const next = new Error('个人微信运行时暂时不可用')
  if (error?.name === 'AbortError' || message.includes('timed out') || message.includes('timeout')) {
    next.code = 'PERSONAL_WECHAT_RUNTIME_TIMEOUT'
  } else if (message.includes('fetch failed') || message.includes('connect') || message.includes('econnrefused') || message.includes('socket')) {
    next.code = 'GATEWAY_UNAVAILABLE'
  } else {
    next.code = 'PERSONAL_WECHAT_RUNTIME_FAILED'
  }
  return next
}

/**
 * BFF-side client for the loopback Personal WeChat adapter.
 *
 * The adapter runs on 237 as the OpenClaw user and is the only component that
 * talks to the installed `@tencent-weixin/openclaw-weixin` plugin (QR login,
 * per-account credential persistence, account lifecycle). The BFF never
 * receives WeChat tokens or QR authorization payloads.
 */
export function createPersonalWechatRuntime({
  adapterBaseUrl = DEFAULT_PERSONAL_WECHAT_ADAPTER_URL,
  adapterToken,
  fetchImpl = fetch,
  requestTimeoutMs = PERSONAL_WECHAT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (!adapterBaseUrl || typeof fetchImpl !== 'function') {
    throw new Error('Personal WeChat adapter dependencies are required')
  }
  const base = String(adapterBaseUrl).replace(/\/+$/, '')
  const token = String(adapterToken || '').trim()

  async function request(method, pathname, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs)
    try {
      const headers = { Accept: 'application/json' }
      if (token) headers['X-GAIOP-Weixin-Token'] = token
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const response = await fetchImpl(`${base}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      const payload = asRecord(await response.json().catch(() => ({})))
      if (!response.ok) {
        const error = new Error(
          safeString(payload.error?.message || payload.message, 200) || '个人微信运行时请求失败',
        )
        error.code = safeErrorCode(payload.error?.code || payload.code)
          || 'PERSONAL_WECHAT_RUNTIME_FAILED'
        throw error
      }
      return payload
    } catch (error) {
      if (error?.code && String(error.code).startsWith('PERSONAL_WECHAT_')) throw error
      throw toRuntimeError(error)
    } finally {
      clearTimeout(timer)
    }
  }

  async function getStatus() {
    const row = await request('GET', '/status')
    return {
      available: row.available === true,
      version: safeString(row.version, 80) || undefined,
      accounts: Array.isArray(row.accounts) ? row.accounts.map(safeAccount).filter(Boolean) : [],
    }
  }

  async function startQr() {
    return safeQrSnapshot(await request('POST', '/qr/start'))
  }

  async function waitQr(loginId, timeoutMs = 25_000) {
    const normalizedLoginId = safeString(loginId, 256)
    if (!normalizedLoginId) {
      const error = new Error('个人微信扫码会话无效')
      error.code = 'PERSONAL_WECHAT_ONBOARDING_INVALID'
      throw error
    }
    const normalizedTimeout = Math.min(25_000, Math.max(1_000, Math.floor(Number(timeoutMs) || 25_000)))
    return safeQrSnapshot(await request('POST', '/qr/wait', {
      sessionKey: normalizedLoginId,
      timeoutMs: normalizedTimeout,
    }))
  }

  async function getQrStatus(loginId) {
    const normalizedLoginId = safeString(loginId, 256)
    if (!normalizedLoginId) {
      const error = new Error('个人微信扫码会话无效')
      error.code = 'PERSONAL_WECHAT_ONBOARDING_INVALID'
      throw error
    }
    return safeQrSnapshot(await request('POST', '/qr/status', {
      sessionKey: normalizedLoginId,
    }))
  }

  async function verifyQr(loginId, code) {
    const normalizedCode = safeString(code, 32)
    if (!/^[0-9A-Za-z]{4,12}$/.test(normalizedCode)) {
      const error = new Error('微信验证码格式无效')
      error.code = 'PERSONAL_WECHAT_VERIFICATION_CODE_INVALID'
      throw error
    }
    return safeQrSnapshot(await request('POST', '/qr/verify', {
      sessionKey: safeString(loginId, 256),
      code: normalizedCode,
    }))
  }

  async function cancelQr(loginId) {
    return safeQrSnapshot(await request('POST', '/qr/cancel', {
      sessionKey: safeString(loginId, 256),
    }))
  }

  async function setAccountEnabled(accountId, enabled) {
    const normalizedId = normalizePersonalWechatAccountId(accountId)
    if (!normalizedId || typeof enabled !== 'boolean') {
      const error = new Error('个人微信账号状态参数无效')
      error.code = 'PERSONAL_WECHAT_ACCOUNT_INPUT_INVALID'
      throw error
    }
    const row = await request('PUT', `/accounts/${encodeURIComponent(normalizedId)}/enabled`, {
      enabled,
    })
    return safeAccount({ ...row, accountId: row.accountId || normalizedId })
  }

  async function deleteAccount(accountId) {
    const normalizedId = normalizePersonalWechatAccountId(accountId)
    if (!normalizedId) {
      const error = new Error('个人微信账号标识无效')
      error.code = 'PERSONAL_WECHAT_ACCOUNT_INPUT_INVALID'
      throw error
    }
    const row = await request('DELETE', `/accounts/${encodeURIComponent(normalizedId)}`)
    if (row.deleted !== true || normalizePersonalWechatAccountId(row.accountId) !== normalizedId) {
      const error = new Error('个人微信账号删除未得到确认')
      error.code = 'PERSONAL_WECHAT_ACCOUNT_DELETE_UNCONFIRMED'
      throw error
    }
    return { accountId: normalizedId, deleted: true }
  }

  return {
    getStatus,
    startQr,
    waitQr,
    getQrStatus,
    verifyQr,
    cancelQr,
    setAccountEnabled,
    deleteAccount,
  }
}

export const __test__ = { safeAccount, safeQrSnapshot, toRuntimeError, normalizeQrStatus }
