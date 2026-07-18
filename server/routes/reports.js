import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'path'
import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import { getReportStorageRoot } from '../lib/report-storage-path.js'

const reportRoot = getReportStorageRoot()
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
    const entryPath = resolve(directory, entry.name)
    if (entry.isDirectory()) results.push(...listAuditPaths(entryPath))
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.json') results.push(entryPath)
  }
  return results
}

function safeText(value) {
  const text = String(value || '').trim()
  return text || null
}

function canReadReport(user, row) {
  if (!user || user.role === 'admin') return true
  const userId = safeText(user.id)
  return Boolean(userId && row.source_user_id && row.source_user_id === userId)
}

function readExactFilter(value) {
  const text = String(value || '').trim()
  return text ? text.slice(0, 160) : null
}

/**
 * The report skill writes an audit JSON beside each generated report. Import
 * only these paired artifacts from the dedicated report directory, avoiding
 * any dependency on the Gateway process or arbitrary host file access.
 */
function syncGeneratedReports(db) {
  ensureReportRoot()
  const insert = db.prepare(`
    INSERT INTO report_files (
      id, stored_name, audit_name, original_name, report_type,
      source_session_id, source_user_id, data_source_id, mime_type,
      size, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stored_name) DO UPDATE SET
      audit_name = excluded.audit_name,
      original_name = excluded.original_name,
      report_type = excluded.report_type,
      source_session_id = excluded.source_session_id,
      source_user_id = excluded.source_user_id,
      data_source_id = excluded.data_source_id,
      mime_type = excluded.mime_type,
      size = excluded.size,
      status = excluded.status,
      updated_at = excluded.updated_at
  `)

  for (const auditPath of listAuditPaths()) {
    const auditName = toStoredName(auditPath)
    if (!auditName) continue

    try {
      const audit = JSON.parse(readFileSync(auditPath, 'utf8'))
      const reportId = safeText(audit.reportId)
      const auditDirectory = dirname(auditName)
      const declaredAuditName = safeText(audit.relativeAuditPath)
      // New formal archives must self-identify the exact paired audit file.
      // Root-level historical imports did not have this field, so retain only
      // that narrow compatibility path.
      if (auditDirectory !== '.' && (!declaredAuditName || declaredAuditName.replace(/\\/g, '/') !== auditName)) continue
      const declaredName = safeText(audit.relativeFilePath) || safeText(audit.fileName)
      let storedName = declaredName && resolveStoredReportPath(declaredName) ? declaredName.replace(/\\/g, '/') : null
      if (!storedName) {
        const legacyName = basename(safeText(audit.filePath) || '')
        storedName = legacyName || null
      }
      if (storedName && auditDirectory !== '.' && !storedName.includes('/')) storedName = `${auditDirectory}/${storedName}`
      const reportPath = resolveStoredReportPath(storedName)
      if (!reportId || !storedName || !reportPath) continue
      // A JSON audit can only describe its sibling report file. This prevents a
      // malformed audit in one user/type directory from registering another
      // controlled file under an arbitrary ownership record.
      if (dirname(storedName) !== auditDirectory) continue
      const sourceUserId = safeText(audit.sourceUserId)
      const storedSegments = storedName.split('/')
      if (auditDirectory !== '.' && storedSegments[0] !== (sourceUserId || '_unattributed')) continue

      const exists = existsSync(reportPath)
      const createdAt = Date.parse(audit.generatedAt || '') || statSync(auditPath).mtimeMs || Date.now()
      const updatedAt = exists ? statSync(reportPath).mtimeMs : Date.now()
      insert.run(
        reportId,
        storedName,
        auditName,
        basename(safeText(audit.title) || storedName),
        safeText(audit.reportType) || 'analysis',
        safeText(audit.sourceSessionId),
        sourceUserId,
        safeText(audit.dataSourceId),
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

function publicReport(row) {
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
    sourceUserId: row.source_user_id || null,
    dataSourceId: row.data_source_id || null,
    mimeType: row.mime_type,
    size,
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function resolveReportOrError(db, id, res, user) {
  const row = db.prepare('SELECT * FROM report_files WHERE id = ?').get(id)
  if (!row || !canReadReport(user, row)) {
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

export function createReportsRouter({ db, authMiddleware, adminMiddleware, recordAudit }) {
  const router = Router()

  router.get('/', authMiddleware, (req, res) => {
    syncGeneratedReports(db)
    const filters = {
      sourceUserId: readExactFilter(req.query.sourceUserId),
      sourceSessionId: readExactFilter(req.query.sourceSessionId),
      dataSourceId: readExactFilter(req.query.dataSourceId),
    }
    const filterColumns = {
      sourceUserId: 'source_user_id',
      sourceSessionId: 'source_session_id',
      dataSourceId: 'data_source_id',
    }
    const conditions = []
    const values = []
    if (req.user?.role !== 'admin') {
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
    const rows = db.prepare(`SELECT * FROM report_files${where} ORDER BY created_at DESC`).all(...values)
    sendOk(res, { reports: rows.map(publicReport), filters, reportRootReady: true })
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
    const filePath = resolveStoredReportPath(row.stored_name)
    try {
      if (filePath && existsSync(filePath)) unlinkSync(filePath)
      const auditPath = resolveStoredReportPath(row.audit_name)
      if (auditPath && existsSync(auditPath)) unlinkSync(auditPath)
      db.prepare('DELETE FROM report_files WHERE id = ?').run(row.id)
      recordAudit(req.user, '删除报告文件', row.original_name, `报告类型：${row.report_type}`)
      sendOk(res)
    } catch (_error) {
      sendError(res, { code: 'REPORT_DELETE_FAILED', message: '报告文件删除失败' })
    }
  })

  return router
}

export const __test__ = { canReadReport, inferMimeType, readExactFilter, resolveStoredReportPath, syncGeneratedReports }
