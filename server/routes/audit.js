import { Router } from 'express'
import { sendError } from '../lib/api-response.js'
import { createAuditExportWorkbook, normalizeExportLocale } from '../lib/audit-export.js'

const MAX_PAGE_SIZE = 200
const DEFAULT_MAX_RESULTS = 200
const MAX_RESULTS = 3000

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

function parseMaxResults(value, pageSize) {
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) return Math.max(DEFAULT_MAX_RESULTS, pageSize)
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed)) return Math.max(DEFAULT_MAX_RESULTS, pageSize)
  return Math.min(Math.max(parsed, pageSize), MAX_RESULTS)
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

function buildAuditQuery(input, pageSize = 1) {
  const filters = {
    from: parseTimestamp(input.from),
    to: parseTimestamp(input.to),
    username: parseText(input.username),
    role: parseText(input.role, 32),
    category: parseText(input.category, 64),
    result: parseText(input.result, 16),
    source: parseText(input.source, 16),
    errorCode: parseText(input.errorCode, 80),
    keyword: parseText(input.keyword),
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
  return { filters, where: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '', values, maxResults: parseMaxResults(input.maxResults, pageSize) }
}

function formatAuditRange(filters) {
  const format = (value) => {
    if (value === null) return '未限定'
    const date = new Date(value)
    return Number.isFinite(date.getTime()) ? date.toISOString().replace('T', ' ').replace('.000Z', 'Z') : '未限定'
  }
  return `${format(filters.from)} 至 ${format(filters.to)}`
}

function recordExportAudit(recordAudit, req, filters, maxResults, result, count, errorCode = null) {
  if (typeof recordAudit !== 'function') return
  const detail = result === 'success'
    ? `时间范围：${formatAuditRange(filters)}；TOP：${maxResults}；实际导出：${count}条`
    : `时间范围：${formatAuditRange(filters)}；TOP：${maxResults}；导出失败`
  recordAudit(req.user, '导出审计信息', '审计信息', detail, {
    req, category: 'operation', result, source: 'rest', errorCode,
  })
}

export function createAuditRouter({ db, auditViewerMiddleware, recordAudit }) {
  const router = Router()

  router.get('/', auditViewerMiddleware, (req, res) => {
    const hasExplicitPaging = req.query.page !== undefined || req.query.pageSize !== undefined
    const legacyLimit = parsePositiveInteger(req.query.limit, 100, MAX_PAGE_SIZE)
    const pageSize = parsePositiveInteger(req.query.pageSize, legacyLimit, MAX_PAGE_SIZE)
    const requestedPage = hasExplicitPaging ? parsePositiveInteger(req.query.page, 1, 1_000_000) : 1
    const { filters, where, values, maxResults } = buildAuditQuery(req.query, pageSize)
    const total = db.prepare(`SELECT COUNT(*) AS count FROM audit_logs${where}`).get(...values).count
    const browseTotal = Math.min(total, maxResults)
    const totalPages = Math.ceil(browseTotal / pageSize)
    const page = Math.min(requestedPage, Math.max(totalPages, 1))
    const offset = (page - 1) * pageSize
    const visibleLimit = Math.max(0, Math.min(pageSize, browseTotal - offset))
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
    `).all(...values, visibleLimit, offset)
    res.json({
      ok: true,
      logs: logs.map(publicAuditLog),
      filters: { ...filters, maxResults },
      pagination: { page, pageSize, total, browseTotal, maxResults, totalPages },
      summary: { total: summary.total, success: summary.success, failed: summary.failed, denied: summary.denied, unclassified: summary.unclassified },
    })
  })

  router.post('/export', auditViewerMiddleware, (req, res) => {
    const locale = normalizeExportLocale(req.body?.locale)
    const { filters, where, values, maxResults } = buildAuditQuery(req.body || {}, 1)
    try {
      const logs = db.prepare(`
        SELECT id, actor_user_id, actor_username, actor_role, action, target, detail, created_at,
          category, result, source, rest_method, rest_path, rpc_method, error_code, request_id, source_address
        FROM audit_logs${where}
        ORDER BY created_at DESC, id DESC LIMIT ?
      `).all(...values, maxResults)
      if (!logs.length) {
        recordExportAudit(recordAudit, req, filters, maxResults, 'failed', 0, 'AUDIT_EXPORT_EMPTY')
        return sendError(res, { status: 400, code: 'AUDIT_EXPORT_EMPTY', message: '当前筛选条件没有可导出的审计记录' })
      }
      const workbook = createAuditExportWorkbook(logs.map(publicAuditLog), locale)
      recordExportAudit(recordAudit, req, filters, maxResults, 'success', logs.length)
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      const fileName = `${locale === 'en-US' ? 'GAIOP-audit-logs' : 'GAIOP-审计信息'}.xlsx`
      res.setHeader('Content-Disposition', `attachment; filename="GAIOP-audit-logs.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      res.setHeader('X-GAIOP-Export-Count', String(logs.length))
      return res.send(workbook)
    } catch {
      recordExportAudit(recordAudit, req, filters, maxResults, 'failed', 0, 'AUDIT_EXPORT_FAILED')
      return sendError(res, { status: 500, code: 'AUDIT_EXPORT_FAILED', message: '导出审计信息失败' })
    }
  })

  return router
}

export const __test__ = { parseTimestamp, parsePositiveInteger, parseMaxResults, publicAuditLog, buildAuditQuery }
