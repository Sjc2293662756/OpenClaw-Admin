import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'path'
import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import { readReportAttributionIndex, resolveReportAttribution, resolveReportAttributionByAudit } from '../lib/report-attribution-index.js'
import { getReportRecoveryRoot, getReportStorageRoot } from '../lib/report-storage-path.js'
import { ReportRetentionService } from '../report-retention-service.js'

const reportRoot = getReportStorageRoot()
const reportRecoveryRoot = getReportRecoveryRoot()
const previewableTextExtensions = new Set(['.txt', '.md', '.json', '.csv', '.log'])

function inferMimeType(fileName) {
  switch (extname(fileName).toLowerCase()) {
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.pdf': return 'application/pdf'
    case '.csv': return 'text/csv; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.md':
    case '.txt':
    case '.log': return 'text/plain; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

function ensureReportRoot() {
  mkdirSync(reportRoot, { recursive: true, mode: 0o700 })
  return reportRoot
}

function resolveStoredReportPath(storedName) {
  const candidate = String(storedName || '').trim().replace(/\\/g, '/')
  if (!candidate || candidate.startsWith('/') || isAbsolute(candidate)) return null
  const segments = candidate.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\x00-\x1f]/.test(segment))) return null
  const filePath = resolve(reportRoot, ...segments)
  const insideRoot = relative(reportRoot, filePath)
  return insideRoot && !insideRoot.startsWith(`..${sep}`) && insideRoot !== '..' && !isAbsolute(insideRoot)
    ? filePath
    : null
}

function toStoredName(filePath) {
  const storedName = relative(reportRoot, filePath).split(sep).join('/')
  return resolveStoredReportPath(storedName) ? storedName : null
}

function listAuditPaths(directory = reportRoot) {
  const results = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === reportRoot && entry.name === '.delivery-events') continue
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) results.push(...listAuditPaths(entryPath))
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.json') results.push(entryPath)
  }
  return results
}

function listDeliveryEventPaths() {
  const directory = resolve(reportRoot, '.delivery-events')
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.json')
    .map((entry) => resolve(directory, entry.name))
}

function safeText(value) {
  const text = String(value || '').trim()
  return text || null
}

function personalWechatAccountIdFromSessionKey(sessionKey) {
  const parts = String(sessionKey || '').split(':')
  const channelIndex = parts.findIndex((part) => ['openclaw-weixin', 'weixin'].includes(part.toLowerCase()))
  if (channelIndex < 0) return null
  const accountId = safeText(parts[channelIndex + 1])
  const peerKind = String(parts[channelIndex + 2] || '').toLowerCase()
  if (!accountId || !['direct', 'group'].includes(peerKind)) return null
  return accountId
}

function enrichPersonalWechatAccountNames(db, rows) {
  if (!rows.some((row) => String(row.source_channel || '').toLowerCase() === 'openclaw-weixin')) return
  const namesByAccountId = new Map()
  const namesByWechatId = new Map()
  try {
    const accounts = db.prepare(
      'SELECT account_id, display_name, wechat_user_id FROM personal_wechat_accounts',
    ).all()
    for (const account of accounts) {
      const displayName = safeText(account.display_name)
      if (!displayName) continue
      const accountId = String(account.account_id || '').toLowerCase()
      const wechatId = String(account.wechat_user_id || '').toLowerCase()
      if (accountId) namesByAccountId.set(accountId, displayName)
      if (wechatId) namesByWechatId.set(wechatId, displayName)
    }
  } catch {
    // The personal WeChat metadata table may be absent on older databases.
    return
  }
  for (const row of rows) {
    if (String(row.source_channel || '').toLowerCase() !== 'openclaw-weixin' || row.source_channel_user_name) continue
    const accountId = personalWechatAccountIdFromSessionKey(row.source_session_id)
    const name = namesByAccountId.get(String(accountId || '').toLowerCase())
      || namesByWechatId.get(String(row.source_channel_user_id || '').toLowerCase())
    if (name) row.source_channel_user_name = name
  }
}

// Keep this derivation aligned with GAIOP ReportStorageService. The value is
// used only to verify a controlled archive directory; the database continues
// to retain the original trusted source ID for access control.
function archiveDirectorySegment(value, fallback) {
  const segment = String(value || '').trim()
  if (!segment || segment === '.' || segment === '..' || /[\\/\x00-\x1f]/.test(segment)) return fallback
  return segment.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 160) || fallback
}

function canReadReport(user, row) {
  if (!user || user.role === 'admin' || user.role === 'auditor') return true
  const userId = safeText(user.id)
  return Boolean(userId && row.source_user_id && row.source_user_id === userId)
}

function readExactFilter(value) {
  const text = String(value || '').trim()
  return text ? text.slice(0, 160) : null
}

function resolveReportDataSourceId(db, audit, attribution = null) {
  const declared = safeText(audit?.dataSourceId) || safeText(audit?.dataSource?.id) || safeText(attribution?.dataSourceId)
  if (declared) return declared
  try {
    const active = db.prepare('SELECT id FROM data_sources WHERE is_active = 1 ORDER BY id LIMIT 2').all()
    return active.length === 1 ? safeText(active[0].id) : null
  } catch {
    return null
  }
}

/**
 * The report skill writes an audit JSON beside each generated report. Import
 * only these paired artifacts from the dedicated report directory, avoiding
 * any dependency on the Gateway process or arbitrary host file access.
 */
function syncGeneratedReports(db) {
  ensureReportRoot()
  const attributionEntries = readReportAttributionIndex()
  const insert = db.prepare(`
    INSERT INTO report_files (
      id, stored_name, audit_name, original_name, report_type,
      source_session_id, source_user_id, source_channel, source_channel_user_id,
      source_channel_user_name, source_message_id, source_message_preview,
      data_source_id, mime_type, size, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stored_name) DO UPDATE SET
      audit_name = excluded.audit_name,
      original_name = excluded.original_name,
      report_type = excluded.report_type,
      source_session_id = excluded.source_session_id,
      source_user_id = excluded.source_user_id,
      source_channel = excluded.source_channel,
      source_channel_user_id = excluded.source_channel_user_id,
      source_channel_user_name = excluded.source_channel_user_name,
      source_message_id = excluded.source_message_id,
      source_message_preview = excluded.source_message_preview,
      data_source_id = excluded.data_source_id,
      mime_type = excluded.mime_type,
      size = excluded.size,
      status = excluded.status,
      updated_at = excluded.updated_at
  `)
  const existingById = db.prepare('SELECT stored_name FROM report_files WHERE id = ?')
  const enrichExisting = db.prepare(`
    UPDATE report_files SET
      source_session_id = COALESCE(source_session_id, ?),
      source_user_id = COALESCE(source_user_id, ?),
      source_channel = COALESCE(source_channel, ?),
      source_channel_user_id = COALESCE(source_channel_user_id, ?),
      source_channel_user_name = COALESCE(source_channel_user_name, ?),
      data_source_id = COALESCE(data_source_id, ?),
      updated_at = MAX(updated_at, ?)
    WHERE id = ?
  `)

  for (const auditPath of listAuditPaths()) {
    const auditName = toStoredName(auditPath)
    if (!auditName) continue

    try {
      const audit = JSON.parse(readFileSync(auditPath, 'utf8'))
      const reportId = safeText(audit.reportId)
      const auditDirectory = dirname(auditName)
      const sidecarAttribution = resolveReportAttributionByAudit(attributionEntries, { auditName, reportId })
      const sidecarPair = Boolean(
        sidecarAttribution
        && dirname(sidecarAttribution.storedName) === auditDirectory
        && resolveStoredReportPath(sidecarAttribution.storedName),
      )
      const declaredAuditName = safeText(audit.relativeAuditPath)
      const declaredFileName = safeText(audit.relativeFilePath)
      const legacyFileName = safeText(audit.fileName) || basename(safeText(audit.filePath) || '')
      // New formal archives must self-identify the exact paired audit file.
      // A deployed legacy generator omitted relativeAuditPath for otherwise
      // valid nested pairs. Accept only a same-directory fileName pair;
      // root-level historical imports remain the only other compatibility path.
      const legacyNestedPair = !declaredAuditName && !declaredFileName
        && legacyFileName && legacyFileName === basename(legacyFileName)
      if (!sidecarPair && auditDirectory !== '.' && declaredAuditName && declaredAuditName.replace(/\\/g, '/') !== auditName) continue
      if (auditDirectory !== '.' && !declaredAuditName && !legacyNestedPair) continue
      const declaredName = declaredFileName || legacyFileName
      let storedName = sidecarPair
        ? sidecarAttribution.storedName
        : declaredName && resolveStoredReportPath(declaredName) ? declaredName.replace(/\\/g, '/') : null
      if (!storedName) {
        const legacyName = basename(safeText(audit.filePath) || '')
        storedName = legacyName || null
      }
      if (storedName && auditDirectory !== '.' && !storedName.includes('/')) storedName = `${auditDirectory}/${storedName}`
      const reportPath = resolveStoredReportPath(storedName)
      if (!reportId || !storedName || !reportPath) continue
      if (auditDirectory !== '.' && legacyNestedPair && !existsSync(reportPath)) continue
      // A JSON audit can only describe its sibling report file. This prevents a
      // malformed audit in one user/type directory from registering another
      // controlled file under an arbitrary ownership record.
      if (dirname(storedName) !== auditDirectory) continue
      const attribution = sidecarPair
        ? sidecarAttribution
        : resolveReportAttribution(attributionEntries, { storedName, auditName, reportId })
      const declaredSourceUserId = safeText(audit.sourceUserId)
      const storedSegments = storedName.split('/')
      // Legacy archives without trusted provenance must remain unattributed.
      // Their historical directory labels are not an authorization source.
      const legacyUnattributedPair = auditDirectory !== '.' && legacyNestedPair && !declaredSourceUserId
      if (!sidecarPair && !legacyUnattributedPair && auditDirectory !== '.' && storedSegments[0] !== archiveDirectorySegment(declaredSourceUserId, '_unattributed')) continue
      if (!sidecarPair && !legacyUnattributedPair && auditDirectory !== '.' && storedSegments[1] !== archiveDirectorySegment(audit.reportType, 'report')) continue

      // The sidecar observes only successful official report tool results and
      // records attribution separately. It never edits the Skill's report or
      // audit JSON. Existing signed audit provenance remains authoritative.
      const sourceUserId = declaredSourceUserId || safeText(attribution?.sourceUserId)
      const sourceSessionId = safeText(audit.sourceSessionId) || safeText(attribution?.sourceSessionId)
      const sourceChannel = safeText(audit.sourceChannel) || safeText(attribution?.sourceChannel)
      const sourceChannelUserId = safeText(audit.sourceChannelUserId) || safeText(attribution?.sourceChannelUserId)
      const sourceChannelUserName = safeText(audit.sourceChannelUserName) || safeText(attribution?.sourceChannelUserName)
      const dataSourceId = resolveReportDataSourceId(db, audit, attribution)

      // Historical migrations may already have registered the same report ID
      // under a different storage path. In that case the sidecar is evidence
      // for attribution only; enrich the existing row and avoid a duplicate-ID
      // insert while preserving any provenance already recorded by the audit.
      const existing = attribution ? existingById.get(reportId) : null
      if (existing && existing.stored_name !== storedName) {
        enrichExisting.run(
          sourceSessionId,
          sourceUserId,
          sourceChannel,
          sourceChannelUserId,
          sourceChannelUserName,
          dataSourceId,
          Date.now(),
          reportId,
        )
        continue
      }

      const exists = existsSync(reportPath)
      const createdAt = Date.parse(audit.generatedAt || '') || statSync(auditPath).mtimeMs || Date.now()
      const updatedAt = exists ? statSync(reportPath).mtimeMs : Date.now()
      insert.run(
        reportId,
        storedName,
        auditName,
        basename(safeText(audit.title) || storedName),
        safeText(audit.reportType) || 'analysis',
        sourceSessionId,
        sourceUserId,
        sourceChannel,
        sourceChannelUserId,
        sourceChannelUserName,
        safeText(audit.sourceMessageId),
        safeText(audit.sourceMessagePreview),
        dataSourceId,
        inferMimeType(storedName),
        exists ? statSync(reportPath).size : 0,
        exists ? 'ready' : 'missing',
        createdAt,
        updatedAt,
      )
    } catch {
      // Ignore malformed or manually placed JSON that is not a report audit.
    }
  }
}

function readEventTimestamp(value) {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : null
}

function syncReportDeliveries(db) {
  const reportExists = db.prepare('SELECT id FROM report_files WHERE id = ?')
  const upsert = db.prepare(`
    INSERT INTO report_deliveries (
      id, report_id, event_name, channel, status,
      prepared_at, handed_off_at, confirmed_at, failed_at,
      error_code, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      report_id = excluded.report_id,
      event_name = excluded.event_name,
      channel = excluded.channel,
      status = excluded.status,
      prepared_at = excluded.prepared_at,
      handed_off_at = excluded.handed_off_at,
      confirmed_at = excluded.confirmed_at,
      failed_at = excluded.failed_at,
      error_code = excluded.error_code,
      updated_at = excluded.updated_at
  `)
  const allowedStatuses = new Set(['prepared', 'handed_off', 'confirmed', 'failed', 'expired'])

  for (const eventPath of listDeliveryEventPaths()) {
    const eventName = toStoredName(eventPath)
    if (!eventName || !eventName.startsWith('.delivery-events/')) continue
    try {
      const event = JSON.parse(readFileSync(eventPath, 'utf8'))
      if (event.schemaVersion !== 'gaiop.report-delivery.v1' || event.eventType !== 'report_delivery') continue
      const id = safeText(event.attemptId)
      const reportId = safeText(event.reportId)
      const channel = safeText(event.channel)?.toLowerCase()
      const status = safeText(event.status)?.toLowerCase()
      if (!id || !reportId || !channel || !allowedStatuses.has(status) || !reportExists.get(reportId)) continue
      const createdAt = readEventTimestamp(event.createdAt) || statSync(eventPath).mtimeMs || Date.now()
      const updatedAt = readEventTimestamp(event.updatedAt) || statSync(eventPath).mtimeMs || createdAt
      upsert.run(
        id,
        reportId,
        eventName,
        channel,
        status,
        readEventTimestamp(event.preparedAt),
        readEventTimestamp(event.handedOffAt),
        readEventTimestamp(event.confirmedAt),
        readEventTimestamp(event.failedAt),
        safeText(event.errorCode),
        createdAt,
        updatedAt,
      )
    } catch {
      // Ignore malformed delivery events. They never create report records.
    }
  }
}

function publicDelivery(row) {
  if (!row) return null
  return {
    attemptId: row.id,
    channel: row.channel,
    status: row.status,
    preparedAt: row.prepared_at || null,
    handedOffAt: row.handed_off_at || null,
    confirmedAt: row.confirmed_at || null,
    failedAt: row.failed_at || null,
    errorCode: row.error_code || null,
    updatedAt: row.updated_at,
  }
}

function publicReport(row, delivery = null) {
  const filePath = resolveStoredReportPath(row.stored_name)
  let status = row.status
  let size = Number(row.size || 0)
  if (!filePath || !existsSync(filePath)) {
    status = 'missing'
  } else {
    try { size = statSync(filePath).size } catch { status = 'missing' }
  }
  return {
    id: row.id,
    name: row.original_name,
    reportType: row.report_type,
    sourceSessionId: row.source_session_id || null,
    sourceSessionTitle: row.source_session_title || null,
    sourceUserId: row.source_user_id || null,
    sourceChannel: row.source_channel || null,
    sourceChannelUserId: row.source_channel_user_id || null,
    sourceChannelUserName: row.source_channel_user_name || null,
    sourceMessageId: row.source_message_id || null,
    sourceMessagePreview: row.source_message_preview || null,
    dataSourceId: row.data_source_id || null,
    dataSourceName: row.data_source_name || null,
    mimeType: row.mime_type,
    size,
    status,
    longTermKeep: Number(row.long_term_keep) === 1,
    retentionState: row.retention_state || 'active',
    delivery: publicDelivery(delivery),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function resolveReportOrError(db, id, res, user) {
  const row = db.prepare('SELECT * FROM report_files WHERE id = ?').get(id)
  const hasRecoveryPlan = row && (row.retention_state || 'active') !== 'active'
    ? Boolean(db.prepare('SELECT 1 FROM report_retention_artifacts WHERE report_id = ? LIMIT 1').get(row.id))
    : false
  if (!row || ['quarantined', 'restore_error', 'delete_error'].includes(row.retention_state) || hasRecoveryPlan || !canReadReport(user, row)) {
    sendError(res, { status: 404, code: 'REPORT_NOT_FOUND', message: '报告文件不存在' })
    return null
  }
  const filePath = resolveStoredReportPath(row.stored_name)
  if (!filePath || !existsSync(filePath)) {
    db.prepare("UPDATE report_files SET status = 'missing', updated_at = ? WHERE id = ?").run(Date.now(), row.id)
    sendError(res, { status: 404, code: 'REPORT_FILE_MISSING', message: '报告文件不存在或已被移除' })
    return null
  }
  return { row, filePath }
}

function streamReport(res, filePath, row, disposition) {
  const extension = extname(row.original_name).toLowerCase()
  const contentType = row.mime_type || (extension === '.pdf' ? 'application/pdf' : 'application/octet-stream')
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Length', statSync(filePath).size)
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(row.original_name)}`)
  const stream = createReadStream(filePath)
  stream.on('error', () => {
    if (!res.headersSent) sendError(res, { code: 'REPORT_STREAM_FAILED', message: '报告文件读取失败' })
    else res.destroy()
  })
  stream.pipe(res)
}

export function createReportsRouter({ db, authMiddleware, adminMiddleware, recordAudit, retentionService = null }) {
  const router = Router()
  const retention = retentionService || new ReportRetentionService({
    db,
    reportRoot,
    recoveryRoot: reportRecoveryRoot,
  })

  router.get('/', authMiddleware, (req, res) => {
    try {
      syncGeneratedReports(db)
      syncReportDeliveries(db)
      const filters = {
        sourceUserId: readExactFilter(req.query.sourceUserId),
        sourceSessionId: readExactFilter(req.query.sourceSessionId),
        dataSourceId: readExactFilter(req.query.dataSourceId),
      }
      const filterColumns = {
        sourceUserId: 'report_files.source_user_id',
        sourceSessionId: 'report_files.source_session_id',
        dataSourceId: 'report_files.data_source_id',
      }
      const conditions = []
      const values = []
      conditions.push(`(
        COALESCE(report_files.retention_state, 'active') = 'active'
        OR (
          report_files.retention_state = 'quarantine_error'
          AND NOT EXISTS (
            SELECT 1 FROM report_retention_artifacts
            WHERE report_retention_artifacts.report_id = report_files.id
          )
        )
      )`)
      if (req.user?.role !== 'admin' && req.user?.role !== 'auditor') {
        const userId = safeText(req.user?.id)
        if (!userId) {
          conditions.push('1 = 0')
        } else {
          filters.sourceUserId = userId
        }
      }
      for (const [key, column] of Object.entries(filterColumns)) {
        if (filters[key]) {
          conditions.push(`${column} = ?`)
          values.push(filters[key])
        }
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
      const rows = db.prepare(`
        SELECT
          report_files.*,
          workspace_sessions.session_title AS source_session_title,
          COALESCE(NULLIF(data_sources.description, ''), data_sources.ip) AS data_source_name
        FROM report_files
        LEFT JOIN workspace_sessions ON workspace_sessions.session_key = report_files.source_session_id
        LEFT JOIN data_sources ON data_sources.id = report_files.data_source_id
        ${where}
        ORDER BY report_files.created_at DESC
      `).all(...values)
      // The channel-user field is the contact/peer. Resolve the logged-in
      // account from the per-account session key before applying its GAIOP name.
      enrichPersonalWechatAccountNames(db, rows)
      const deliveries = db.prepare(`
        SELECT *
        FROM report_deliveries
        ORDER BY updated_at DESC, created_at DESC
      `).all()
      const latestDeliveryByReport = new Map()
      for (const delivery of deliveries) {
        if (!latestDeliveryByReport.has(delivery.report_id)) latestDeliveryByReport.set(delivery.report_id, delivery)
      }
      sendOk(res, {
        reports: rows.map((row) => publicReport(row, latestDeliveryByReport.get(row.id))),
        filters,
        reportRootReady: true,
      })
    } catch (error) {
      // Keep API failures JSON-shaped. Otherwise Express emits an HTML error
      // page and the SPA masks the useful failure with a JSON parse exception.
      console.error('[Reports] Failed to load report list:', error instanceof Error ? error.message : 'unknown error')
      sendError(res, { status: 500, code: 'REPORT_LIST_FAILED', message: '报告列表暂时无法读取，请稍后刷新或联系管理员查看服务日志' })
    }
  })

  router.get('/retention/recovery', adminMiddleware, (_req, res) => {
    try {
      sendOk(res, { reports: retention.listRecovery() })
    } catch {
      sendError(res, { code: 'REPORT_RECOVERY_LIST_FAILED', message: '报告恢复区暂时无法读取' })
    }
  })

  router.patch('/:id/retention', adminMiddleware, (req, res) => {
    if (typeof req.body?.longTermKeep !== 'boolean') {
      return sendError(res, { status: 400, code: 'REPORT_RETENTION_INPUT_INVALID', message: '长期保留标记必须是布尔值' })
    }
    const result = retention.setLongTermKeep(req.params.id, req.body.longTermKeep)
    if (!result.ok) return sendError(res, { status: 404, code: 'REPORT_NOT_FOUND', message: '报告文件不存在' })
    recordAudit(req.user, req.body.longTermKeep ? '设置报告长期保留' : '取消报告长期保留', req.params.id, '仅更新报告留存标记')
    sendOk(res, result)
  })

  router.post('/:id/restore', adminMiddleware, (req, res) => {
    const result = retention.restoreReport(req.params.id)
    if (!result.ok) {
      const status = result.code === 'report_not_found' ? 404 : 409
      return sendError(res, { status, code: String(result.code || 'REPORT_RESTORE_FAILED').toUpperCase(), message: '报告恢复失败，已保留可重试状态' })
    }
    recordAudit(req.user, '恢复报告文件', req.params.id, '从7天受控恢复区恢复')
    sendOk(res)
  })

  router.get('/:id/download', authMiddleware, (req, res) => {
    const report = resolveReportOrError(db, req.params.id, res, req.user)
    if (!report) return
    recordAudit(req.user, '下载报告文件', report.row.original_name, `报告类型：${report.row.report_type}`)
    streamReport(res, report.filePath, report.row, 'attachment')
  })

  router.get('/:id/preview', authMiddleware, (req, res) => {
    const report = resolveReportOrError(db, req.params.id, res, req.user)
    if (!report) return
    recordAudit(req.user, '预览报告文件', report.row.original_name, `报告类型：${report.row.report_type}`)
    const extension = extname(report.row.original_name).toLowerCase()
    if (extension !== '.pdf' && !previewableTextExtensions.has(extension)) {
      return sendError(res, { status: 415, code: 'REPORT_PREVIEW_UNSUPPORTED', message: '该报告格式暂不支持在线预览，请下载后查看' })
    }
    if (extension === '.pdf') return streamReport(res, report.filePath, report.row, 'inline')
    res.type('text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(report.row.original_name)}`)
    createReadStream(report.filePath).pipe(res)
  })

  router.delete('/:id', adminMiddleware, (req, res) => {
    const row = db.prepare('SELECT * FROM report_files WHERE id = ?').get(req.params.id)
    if (!row) return sendError(res, { status: 404, code: 'REPORT_NOT_FOUND', message: '报告文件不存在' })
    const result = retention.quarantineReport(row.id)
    if (!result.ok) {
      return sendError(res, { status: 409, code: String(result.code || 'REPORT_QUARANTINE_FAILED').toUpperCase(), message: '报告移入恢复区失败，原记录已保留' })
    }
    recordAudit(req.user, '将报告移入恢复区', row.original_name, '报告及配对记录保留7天后才允许永久删除')
    sendOk(res, { quarantined: true, recoverableUntil: result.recoverableUntil })
  })

  return router
}

export const __test__ = {
  archiveDirectorySegment,
  canReadReport,
  inferMimeType,
  readExactFilter,
  resolveStoredReportPath,
  syncGeneratedReports,
  syncReportDeliveries,
  personalWechatAccountIdFromSessionKey,
  enrichPersonalWechatAccountNames,
}
