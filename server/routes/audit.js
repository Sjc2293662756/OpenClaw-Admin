import { Router } from 'express'

const MAX_PAGE_SIZE = 200

function parseTimestamp(value) {
  const text = String(value || '').trim()
  if (!text) return null
  if (/^\d{1,16}$/.test(text)) {
    const numeric = Number(text)
    return Number.isSafeInteger(numeric) ? numeric : null
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function parseText(value, maxLength = 160) {
  const text = String(value || '').trim()
  return text ? text.slice(0, maxLength) : null
}

function parsePositiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : fallback
}

function publicAuditLog(log) {
  return {
    id: log.id,
    actorUserId: log.actor_user_id || null,
    username: log.actor_username,
    role: log.actor_role,
    action: log.action,
    target: log.target || '',
    detail: log.detail || '',
    createdAt: log.created_at,
    category: log.category || null,
    result: log.result || null,
    source: log.source || null,
    restMethod: log.rest_method || null,
    restPath: log.rest_path || null,
    rpcMethod: log.rpc_method || null,
    errorCode: log.error_code || null,
    requestId: log.request_id || null,
    sourceAddress: log.source_address || null,
  }
}

export function createAuditRouter({ db, auditViewerMiddleware }) {
  const router = Router()

  router.get('/', auditViewerMiddleware, (req, res) => {
    const hasExplicitPaging = req.query.page !== undefined || req.query.pageSize !== undefined
    const legacyLimit = parsePositiveInteger(req.query.limit, 100, MAX_PAGE_SIZE)
    const pageSize = parsePositiveInteger(req.query.pageSize, legacyLimit, MAX_PAGE_SIZE)
    const page = hasExplicitPaging ? parsePositiveInteger(req.query.page, 1, 1_000_000) : 1
    const filters = {
      from: parseTimestamp(req.query.from),
      to: parseTimestamp(req.query.to),
      username: parseText(req.query.username),
      role: parseText(req.query.role, 32),
      category: parseText(req.query.category, 64),
      result: parseText(req.query.result, 16),
      source: parseText(req.query.source, 16),
      errorCode: parseText(req.query.errorCode, 80),
      keyword: parseText(req.query.keyword),
    }
    const conditions = []
    const values = []
    if (filters.from !== null) { conditions.push('created_at >= ?'); values.push(filters.from) }
    if (filters.to !== null) { conditions.push('created_at <= ?'); values.push(filters.to) }
    for (const [key, column] of Object.entries({
      username: 'actor_username', role: 'actor_role', category: 'category', result: 'result', source: 'source', errorCode: 'error_code',
    })) {
      if (filters[key]) { conditions.push(`${column} = ?`); values.push(filters[key]) }
    }
    if (filters.keyword) {
      conditions.push("(actor_username LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\')")
      const keyword = `%${filters.keyword.replace(/[\\%_]/g, '\\$&')}%`
      values.push(keyword, keyword, keyword, keyword)
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) AS count FROM audit_logs${where}`).get(...values).count
    const summary = db.prepare(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END), 0) AS success,
        COALESCE(SUM(CASE WHEN result = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN result = 'denied' THEN 1 ELSE 0 END), 0) AS denied,
        COALESCE(SUM(CASE WHEN result IS NULL OR result NOT IN ('success', 'failed', 'denied') THEN 1 ELSE 0 END), 0) AS unclassified
      FROM audit_logs${where}
    `).get(...values)
    const logs = db.prepare(`
      SELECT id, actor_user_id, actor_username, actor_role, action, target, detail, created_at,
        category, result, source, rest_method, rest_path, rpc_method, error_code, request_id, source_address
      FROM audit_logs${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...values, pageSize, (page - 1) * pageSize)
    res.json({
      ok: true,
      logs: logs.map(publicAuditLog),
      filters,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      summary: { total: summary.total, success: summary.success, failed: summary.failed, denied: summary.denied, unclassified: summary.unclassified },
    })
  })

  return router
}

export const __test__ = { parseTimestamp, parsePositiveInteger, publicAuditLog }
