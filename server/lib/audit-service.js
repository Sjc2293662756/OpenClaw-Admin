import { randomUUID } from 'crypto'
import { AsyncLocalStorage } from 'async_hooks'

const MAX_AUDIT_TEXT = 500
const MAX_AUDIT_TARGET = 200
const MAX_AUDIT_PATH = 240
const AUDIT_RESULTS = new Set(['success', 'failed', 'denied'])
const AUDIT_SOURCES = new Set(['auth', 'rest', 'rpc', 'system'])
const HIDDEN_RESOURCE_CODES = new Set(['SESSION_NOT_FOUND', 'REPORT_NOT_FOUND', 'MEDIA_NOT_FOUND'])
const SENSITIVE_VALUE_PATTERN = /\b(password|passwd|token|secret|authorization|cookie|api[_-]?key|credential)\s*[:=]\s*[^\s,;，；]+/gi
const SENSITIVE_CHINESE_VALUE_PATTERN = /(密码|令牌|密钥|凭据)\s*[:：=]\s*[^\s,;，；]+/g
const requestAuditContext = new AsyncLocalStorage()

function clampText(value, limit) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit)
}

export function redactSensitiveAuditText(value, limit = MAX_AUDIT_TEXT) {
  return clampText(value, limit)
    .replace(SENSITIVE_VALUE_PATTERN, '$1=[REDACTED]')
    .replace(SENSITIVE_CHINESE_VALUE_PATTERN, '$1：[已脱敏]')
    .slice(0, limit)
}

export function normalizeAuditPath(req) {
  const base = clampText(req.baseUrl, MAX_AUDIT_PATH)
  const route = typeof req.route?.path === 'string' ? req.route.path : ''
  if (base && route) return `${base}${route}`.slice(0, MAX_AUDIT_PATH)
  if (base) return base
  const rawPath = String(req.originalUrl || req.url || '').split('?')[0]
  const segments = rawPath.split('/').filter(Boolean).map((segment) => {
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment) || /^\d+$/.test(segment) || segment.length > 80) return ':id'
    return segment.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64)
  })
  return `/${segments.join('/')}`.slice(0, MAX_AUDIT_PATH) || '/'
}

export function getSafeSourceAddress(req) {
  const address = String(req.socket?.remoteAddress || '').trim()
  if (!address) return null
  return address.startsWith('::ffff:') ? address.slice(7, 80) : address.slice(0, 80)
}

function normalizeResult(value, fallback = 'success') {
  return AUDIT_RESULTS.has(value) ? value : fallback
}

function normalizeSource(value, fallback = 'system') {
  return AUDIT_SOURCES.has(value) ? value : fallback
}

function normalizeRpcMethod(value) {
  const method = String(value || '').trim()
  return /^[a-zA-Z0-9._-]{1,160}$/.test(method) ? method : null
}

function normalizeErrorCode(value) {
  const code = String(value || '').trim()
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : null
}

function legacyResult(action) {
  return /失败|锁定/.test(String(action || '')) ? 'failed' : 'success'
}

export function migrateAuditLogColumns(db) {
  const columns = [
    ['category', 'TEXT'],
    ['result', "TEXT CHECK (result IS NULL OR result IN ('success', 'failed', 'denied'))"],
    ['source', "TEXT CHECK (source IS NULL OR source IN ('auth', 'rest', 'rpc', 'system'))"],
    ['rest_method', 'TEXT'],
    ['rest_path', 'TEXT'],
    ['rpc_method', 'TEXT'],
    ['error_code', 'TEXT'],
    ['request_id', 'TEXT'],
    ['source_address', 'TEXT'],
  ]
  for (const [name, definition] of columns) {
    try {
      db.exec(`ALTER TABLE audit_logs ADD COLUMN ${name} ${definition}`)
    } catch (error) {
      if (!String(error?.message || '').includes('duplicate column name')) throw error
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_id ON audit_logs(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_filters ON audit_logs(category, result, source, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON audit_logs(actor_username, actor_role, created_at DESC);
  `)
}

export function createAuditRecorder(db, { createId = randomUUID, now = () => Date.now() } = {}) {
  const insert = db.prepare(`
    INSERT INTO audit_logs (
      id, actor_user_id, actor_username, actor_role, action, target, detail, created_at,
      category, result, source, rest_method, rest_path, rpc_method, error_code, request_id, source_address
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  function recordAuditEvent({
    user, action, target = '', detail = '', category = 'operation', result = 'success', source = 'system',
    restMethod = null, restPath = null, rpcMethod = null, errorCode = null, requestId = null, sourceAddress = null,
  } = {}) {
    try {
      insert.run(
        createId(), user?.id || null, redactSensitiveAuditText(user?.username || 'system', 200) || 'system',
        clampText(user?.role || 'system', 32) || 'system', redactSensitiveAuditText(action || '系统操作', 200) || '系统操作',
        redactSensitiveAuditText(target, MAX_AUDIT_TARGET), redactSensitiveAuditText(detail, MAX_AUDIT_TEXT), now(),
        clampText(category, 64) || 'operation', normalizeResult(result), normalizeSource(source),
        /^[A-Z]{3,10}$/.test(String(restMethod || '')) ? String(restMethod) : null,
        restPath ? clampText(restPath, MAX_AUDIT_PATH) : null, normalizeRpcMethod(rpcMethod), normalizeErrorCode(errorCode),
        /^[0-9a-f-]{36}$/i.test(String(requestId || '')) ? String(requestId) : null,
        sourceAddress ? clampText(sourceAddress, 80) : null,
      )
      return true
    } catch (error) {
      console.error('[Audit] Failed to record event:', error instanceof Error ? error.message : 'unknown error')
      return false
    }
  }

  // Legacy callers intentionally retain the four-argument contract. New code
  // may supply structured metadata as the optional fifth argument.
  function recordAudit(user, action, target = '', detail = '', metadata = {}) {
    const req = metadata?.req || requestAuditContext.getStore()?.req
    const inferredPath = metadata?.restPath || (req ? normalizeAuditPath(req) : null)
    const inferredRpcMethod = metadata?.rpcMethod || (inferredPath === '/api/rpc' ? normalizeRpcMethod(req?.body?.method) : null)
    const inferredSource = inferredRpcMethod ? 'rpc' : (req ? (inferredPath?.startsWith('/api/auth') ? 'auth' : 'rest') : 'system')
    return recordAuditEvent({
      user, action, target, detail,
      category: metadata?.category || ((metadata?.source || inferredSource) === 'auth' ? 'authentication' : 'operation'),
      result: metadata?.result || legacyResult(action), source: metadata?.source || inferredSource,
      restMethod: metadata?.restMethod || (req ? req.method : null),
      restPath: inferredPath, rpcMethod: inferredRpcMethod,
      errorCode: metadata?.errorCode, requestId: metadata?.requestId || req?.auditRequestId || null,
      sourceAddress: metadata?.sourceAddress || (req ? getSafeSourceAddress(req) : null),
    })
  }
  return { recordAudit, recordAuditEvent }
}

export function createBoundedAuditRateLimiter({ limit = 8, windowMs = 60_000, maxKeys = 1_000, now = () => Date.now() } = {}) {
  const entries = new Map()
  return {
    allow(key) {
      const timestamp = now()
      const existing = entries.get(key)
      if (!existing || existing.startedAt + windowMs <= timestamp) {
        if (!existing && entries.size >= maxKeys) entries.delete(entries.keys().next().value)
        entries.set(key, { startedAt: timestamp, count: 1 })
        return true
      }
      if (existing.count >= limit) return false
      existing.count += 1
      return true
    },
    size: () => entries.size,
  }
}

function rejectionMetadata(req, status, code) {
  const path = normalizeAuditPath(req)
  const rpcMethod = path === '/api/rpc' ? normalizeRpcMethod(req.body?.method) : null
  const source = status === 410 ? 'system' : (rpcMethod ? 'rpc' : (path.startsWith('/api/auth') || code === 'UNAUTHORIZED' || code === 'PASSWORD_CHANGE_REQUIRED' ? 'auth' : 'rest'))
  const category = status === 410 ? 'system' : (HIDDEN_RESOURCE_CODES.has(code) ? 'resource_access' : (source === 'auth' ? 'authentication' : 'authorization'))
  return { path, rpcMethod, source, category }
}

export function createAuditRejectionMiddleware({ recordAuditEvent, rateLimiter = createBoundedAuditRateLimiter() }) {
  return (req, res, next) => {
    req.auditRequestId = randomUUID()
    requestAuditContext.run({ req }, () => {
      let responseCode = null
      const originalJson = res.json.bind(res)
      res.json = (body) => {
        if (body && typeof body === 'object' && typeof body.code === 'string') responseCode = body.code
        return originalJson(body)
      }
      res.on('finish', () => {
        const status = res.statusCode
        const code = normalizeErrorCode(responseCode)
        const hiddenResource = status === 404 && HIDDEN_RESOURCE_CODES.has(code)
        if (res.locals.auditRejectionRecorded || (!([401, 403, 410].includes(status) || hiddenResource))) return
        const metadata = rejectionMetadata(req, status, code)
        const rateKey = `${status}:${metadata.source}:${metadata.path}:${getSafeSourceAddress(req) || 'unknown'}`
        if ((status === 401 || status === 410) && !rateLimiter.allow(rateKey)) return
        recordAuditEvent({
          user: req.user, action: status === 410 ? '访问已退役接口被拒绝' : (hiddenResource ? '访问受保护资源被拒绝' : '权限校验被拒绝'),
          target: metadata.rpcMethod || metadata.path, detail: '', category: metadata.category, result: 'denied', source: metadata.source,
          restMethod: req.method, restPath: metadata.path, rpcMethod: metadata.rpcMethod,
          errorCode: code || `HTTP_${status}`, requestId: req.auditRequestId, sourceAddress: getSafeSourceAddress(req),
        })
      })
      next()
    })
  }
}

export const __test__ = { HIDDEN_RESOURCE_CODES, rejectionMetadata }
