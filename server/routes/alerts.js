import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import { createAlertExportWorkbook, normalizeAlertExportRows, normalizeExportLocale } from '../lib/alert-export.js'
import { ALERT_CATEGORY_LABELS, filterAlerts } from '../lib/syslog-alerts.js'
import { readGAIOPAlertChanges, readGAIOPAlerts } from '../lib/gaiop-alert-source.js'

const ALERT_VIEWER_ROLES = new Set(['standard', 'auditor', 'admin'])

function readFilter(value, maxLength = 120) {
  return String(value || '').trim().slice(0, maxLength)
}

function readBoundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback
}

function readTimestamp(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function createAlertsRouter({ authMiddleware, recordAudit, readAlertSource = readGAIOPAlerts, readAlertChanges = readGAIOPAlertChanges }) {
  const router = Router()
  router.post('/export', authMiddleware, (req, res) => {
    const locale = normalizeExportLocale(req.body?.locale)
    const rows = normalizeAlertExportRows(req.body?.rows, locale)
    if (!rows.length) {
      return sendError(res, { status: 400, code: 'ALERT_EXPORT_EMPTY', message: '当前页没有可导出的告警记录' })
    }
    recordAudit(req.user, '导出 Syslog 告警', '告警通知', `导出当前页 ${rows.length} 条记录`)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    const fileName = `${locale === 'en-US' ? 'GAIOP-alerts-current-page' : 'GAIOP-告警通知-当前页'}.xlsx`
    res.setHeader('Content-Disposition', `attachment; filename="GAIOP-alerts.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    return res.send(createAlertExportWorkbook(req.body?.rows, locale))
  })
  router.get('/time', authMiddleware, (_req, res) => {
    sendOk(res, { now: Date.now() })
  })
  router.get('/changes', authMiddleware, async (req, res) => {
    if (!ALERT_VIEWER_ROLES.has(req.user?.role)) {
      return sendError(res, { status: 403, code: 'ALERT_ACCESS_DENIED', message: '当前账号无权读取告警实时补偿' })
    }
    const rawAfter = req.query.afterSequence
    const afterText = rawAfter === undefined ? '' : String(rawAfter).trim()
    const afterSequence = afterText === '' ? null : Number(afterText)
    if (afterSequence !== null && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
      return sendError(res, { status: 400, code: 'ALERT_CURSOR_INVALID', message: '告警游标无效' })
    }
    const limit = readBoundedInteger(req.query.limit, 200, 1, 300)
    try {
      const changes = await readAlertChanges(process.env, { afterSequence, limit })
      return sendOk(res, changes)
    } catch {
      return sendError(res, { status: 503, code: 'ALERT_SOURCE_UNAVAILABLE', message: 'GAIOP 告警接收器暂不可用，请联系管理员检查接收器服务状态' })
    }
  })
  router.get('/', authMiddleware, async (req, res) => {
    try {
      const filters = {
        severity: readFilter(req.query.severity, 60),
        category: readFilter(req.query.category, 60),
        keyword: readFilter(req.query.keyword),
        startAt: readTimestamp(req.query.startAt),
        endAt: readTimestamp(req.query.endAt),
      }
      if (filters.startAt !== null && filters.endAt !== null && filters.startAt > filters.endAt) {
        return sendError(res, { status: 400, code: 'ALERT_TIME_RANGE_INVALID', message: '告警开始时间不能晚于结束时间' })
      }
      const page = readBoundedInteger(req.query.page, 1, 1, 10_000)
      const pageSize = readBoundedInteger(req.query.pageSize, 10, 10, 100)
      const maxResults = readBoundedInteger(req.query.maxResults, 200, pageSize, 3000)
      // 正式接收器以 newest-first 存储，BFF 统一映射后维持既有页面排序和 TOP 语义。
      // 时间和字段过滤必须先于页面 TOP 截断。接收器查询固定拉取其完整窗口，
      // 并在支持服务端过滤的新版本上直接按同一组条件查询持久化历史。
      const source = await readAlertSource(process.env, filters)
      const filtered = filterAlerts(source.alerts, filters)
      const capped = filtered.slice(0, maxResults)
      const startIndex = (page - 1) * pageSize
      const alerts = capped.slice(startIndex, startIndex + pageSize)
      const hasMore = startIndex + pageSize < capped.length
      sendOk(res, {
        alerts,
        categoryOptions: Object.entries(ALERT_CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
        filters: { ...filters, page, pageSize, maxResults },
        pagination: {
          page,
          pageSize,
          maxResults,
          availableCount: capped.length,
          hasMore,
          limitReached: Number(source.availableCount) > maxResults || filtered.length > capped.length,
        },
      })
    } catch {
      sendError(res, { status: 503, code: 'ALERT_SOURCE_UNAVAILABLE', message: 'GAIOP 告警接收器暂不可用，请联系管理员检查接收器服务状态' })
    }
  })
  return router
}
