import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'fs'
import { createHash, randomUUID } from 'crypto'
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'path'

export const REPORT_RETENTION_POLICY_VERSION = 'gaiop_report_retention.v1'
export const REPORT_RETENTION_DAYS = 365
export const REPORT_RECOVERY_DAYS = 7

const REPORT_EXTENSIONS = new Set(['.docx', '.pdf'])
const RETRYABLE_STATES = new Set(['active', 'quarantine_pending', 'quarantine_error'])

class RetentionError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function fail(code) {
  throw new RetentionError(code)
}

function safeCode(error, fallback = 'retention_failed') {
  const code = String(error?.code || '')
  return /^[a-z0-9_]{1,80}$/i.test(code) ? code.toLowerCase() : fallback
}

function normalizeName(value) {
  const name = String(value || '').trim().replace(/\\/g, '/')
  if (!name || name.startsWith('/') || isAbsolute(name)) return null
  const segments = name.split('/')
  if (segments.some((part) => !part || part === '.' || part === '..' || /[\x00-\x1f]/.test(part))) return null
  return name
}

function insideRoot(root, candidate) {
  const child = relative(root, candidate)
  return Boolean(child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function controlledRoot(rootPath, { create = false } = {}) {
  const root = resolve(String(rootPath || ''))
  if (!rootPath) fail('root_required')
  if (existsSync(root)) {
    const entry = lstatSync(root)
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail('root_not_regular_directory')
  } else if (create) {
    mkdirSync(root, { recursive: true, mode: 0o750 })
  } else {
    fail('root_missing')
  }
  const entry = lstatSync(root)
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail('root_not_regular_directory')
  return { path: root, real: realpathSync(root) }
}

function resolveRegisteredPath(root, registeredName, { mustExist = true } = {}) {
  const name = normalizeName(registeredName)
  if (!name) fail('registered_path_invalid')
  const candidate = resolve(root.path, ...name.split('/'))
  if (!insideRoot(root.path, candidate)) fail('registered_path_outside_root')

  let current = root.path
  const parts = name.split('/')
  for (let index = 0; index < parts.length - (mustExist ? 0 : 1); index += 1) {
    current = resolve(current, parts[index])
    if (!existsSync(current)) fail('registered_path_parent_missing')
    const entry = lstatSync(current)
    if (entry.isSymbolicLink()) fail('registered_path_symlink')
    if (index < parts.length - 1 && !entry.isDirectory()) fail('registered_path_parent_invalid')
  }

  if (mustExist) {
    if (!existsSync(candidate)) fail('registered_file_missing')
    const entry = lstatSync(candidate)
    if (entry.isSymbolicLink()) fail('registered_path_symlink')
    if (!entry.isFile()) fail('registered_path_not_file')
    const real = realpathSync(candidate)
    if (!insideRoot(root.real, real)) fail('registered_path_outside_root')
    return { name, path: candidate, stat: entry }
  }

  if (existsSync(candidate)) {
    const entry = lstatSync(candidate)
    if (entry.isSymbolicLink()) fail('registered_path_symlink')
  }
  return { name, path: candidate }
}

function reportDirectoryName(reportId) {
  return createHash('sha256').update(String(reportId)).digest('hex')
}

function deliveryRecoveryName(eventName) {
  return `delivery-${createHash('sha256').update(eventName).digest('hex').slice(0, 24)}.json`
}

function parseJsonFile(path, invalidCode) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(invalidCode)
    return value
  } catch (error) {
    if (error instanceof RetentionError) throw error
    fail(invalidCode)
  }
}

function auditMatches(row, audit, auditName) {
  if (String(audit.reportId || '').trim() !== row.id) return false
  const declaredAudit = normalizeName(audit.relativeAuditPath)
  if (declaredAudit && declaredAudit !== auditName) return false
  const declaredFile = normalizeName(audit.relativeFilePath)
  if (declaredFile) return declaredFile === row.stored_name
  const legacyName = String(audit.fileName || audit.filePath || '').trim().replace(/\\/g, '/').split('/').pop()
  return Boolean(legacyName && `${dirname(row.stored_name)}/${legacyName}`.replace(/^\.\//, '') === row.stored_name)
}

function eventMatches(reportId, delivery, event) {
  return event.schemaVersion === 'gaiop.report-delivery.v1'
    && event.eventType === 'report_delivery'
    && String(event.reportId || '').trim() === reportId
    && String(event.attemptId || '').trim() === delivery.id
}

function countByReason(results) {
  const reasons = {}
  for (const result of results) {
    if (result.ok) continue
    reasons[result.code] = (reasons[result.code] || 0) + 1
  }
  return reasons
}

export class ReportRetentionService {
  constructor({
    db,
    reportRoot,
    recoveryRoot,
    operations = {},
  }) {
    this.db = db
    this.reportRootPath = reportRoot
    this.recoveryRootPath = recoveryRoot
    this.operations = {
      rename: operations.rename || renameSync,
      unlink: operations.unlink || unlinkSync,
    }
  }

  _roots() {
    const reportPath = resolve(String(this.reportRootPath || ''))
    const recoveryPath = resolve(String(this.recoveryRootPath || ''))
    if (!this.reportRootPath || !this.recoveryRootPath || reportPath === recoveryPath || insideRoot(reportPath, recoveryPath) || insideRoot(recoveryPath, reportPath)) {
      fail('controlled_roots_overlap')
    }
    const reports = controlledRoot(this.reportRootPath)
    const recovery = controlledRoot(this.recoveryRootPath, { create: true })
    if (reports.real === recovery.real || insideRoot(reports.real, recovery.real) || insideRoot(recovery.real, reports.real)) {
      fail('controlled_roots_overlap')
    }
    return { reports, recovery }
  }

  _recordAudit({ reportId, action, outcome, reasonCode = null, artifactCount = 0, bytes = 0, startedAt, completedAt }) {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO report_retention_audits (
        id, report_id, action, outcome, reason_code, artifact_count,
        bytes, started_at, completed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, reportId, action, outcome, reasonCode,
      artifactCount, bytes, startedAt, completedAt, completedAt,
    )
    return id
  }

  _updateAudit(id, { outcome, reasonCode = null, artifactCount = 0, bytes = 0, completedAt }) {
    this.db.prepare(`
      UPDATE report_retention_audits
      SET outcome = ?, reason_code = ?, artifact_count = ?, bytes = ?,
          completed_at = ?, created_at = ?
      WHERE id = ?
    `).run(outcome, reasonCode, artifactCount, bytes, completedAt, completedAt, id)
  }

  _setError(reportId, state, code, now) {
    this.db.prepare(`
      UPDATE report_files
      SET retention_state = ?, retention_error_code = ?, retention_updated_at = ?
      WHERE id = ?
    `).run(state, code, now, reportId)
  }

  _report(reportId) {
    return this.db.prepare('SELECT * FROM report_files WHERE id = ?').get(reportId) || null
  }

  _deliveries(reportId) {
    return this.db.prepare('SELECT * FROM report_deliveries WHERE report_id = ? ORDER BY id').all(reportId)
  }

  _artifactRows(reportId) {
    return this.db.prepare('SELECT * FROM report_retention_artifacts WHERE report_id = ? ORDER BY id').all(reportId)
  }

  _validateAndDescribe(row, roots, { now, requireExpired }) {
    if (!RETRYABLE_STATES.has(row.retention_state || 'active')) fail('retention_state_invalid')
    if (Number(row.long_term_keep) === 1) fail('long_term_keep')
    const extension = extname(row.stored_name || '').toLowerCase()
    if (!REPORT_EXTENSIONS.has(extension)) fail('report_type_not_managed')
    const createdAt = Number(row.created_at)
    if (!Number.isFinite(createdAt) || createdAt <= 0) fail('database_time_invalid')
    const cutoff = now - REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000
    if (requireExpired && createdAt >= cutoff) fail('database_not_expired')

    const report = resolveRegisteredPath(roots.reports, row.stored_name)
    if (!Number.isFinite(report.stat.mtimeMs) || report.stat.mtimeMs <= 0) fail('file_time_invalid')
    if (requireExpired && report.stat.mtimeMs >= cutoff) fail('file_not_expired')
    if (!Number.isFinite(Number(row.size)) || Number(row.size) !== report.stat.size) fail('report_size_mismatch')

    const auditName = normalizeName(row.audit_name)
    if (!auditName || extname(auditName).toLowerCase() !== '.json') fail('audit_registration_invalid')
    const audit = resolveRegisteredPath(roots.reports, auditName)
    if (!auditMatches(row, parseJsonFile(audit.path, 'audit_json_invalid'), auditName)) fail('audit_pair_mismatch')

    const deliveries = this._deliveries(row.id)
    const descriptions = [
      { kind: 'audit', key: 'audit', source: audit, recoveryBase: 'audit.json' },
    ]
    for (const delivery of deliveries) {
      const eventName = normalizeName(delivery.event_name)
      if (!eventName || !eventName.startsWith('.delivery-events/') || extname(eventName).toLowerCase() !== '.json') {
        fail('delivery_registration_invalid')
      }
      const eventFile = resolveRegisteredPath(roots.reports, eventName)
      if (!eventMatches(row.id, delivery, parseJsonFile(eventFile.path, 'delivery_json_invalid'))) fail('delivery_pair_mismatch')
      descriptions.push({ kind: 'delivery', key: delivery.id, source: eventFile, recoveryBase: deliveryRecoveryName(eventName) })
    }
    descriptions.push({ kind: 'report', key: 'report', source: report, recoveryBase: `report${extension}` })

    const uniqueSources = new Set(descriptions.map((entry) => entry.source.name))
    if (uniqueSources.size !== descriptions.length) fail('artifact_registration_duplicate')
    const directory = reportDirectoryName(row.id)
    return descriptions.map((entry) => ({
      ...entry,
      recoveryName: `${directory}/${entry.recoveryBase}`,
    }))
  }

  _assertRecoveryDirectory(roots, reportId, artifactRows = []) {
    const directoryName = reportDirectoryName(reportId)
    const directoryPath = resolve(roots.recovery.path, directoryName)
    if (!insideRoot(roots.recovery.path, directoryPath)) fail('recovery_path_invalid')
    if (!existsSync(directoryPath)) {
      mkdirSync(directoryPath, { mode: 0o750 })
      return directoryPath
    }
    const entry = lstatSync(directoryPath)
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail('recovery_directory_invalid')
    const allowed = new Set(artifactRows.map((artifact) => artifact.recovery_name.split('/').pop()))
    for (const child of readdirSync(directoryPath, { withFileTypes: true })) {
      if (!allowed.has(child.name) || child.isSymbolicLink() || !child.isFile()) fail('recovery_directory_unknown_entry')
    }
    return directoryPath
  }

  _createPlan(row, descriptions, now) {
    const writePlan = this.db.transaction(() => {
      this.db.prepare('DELETE FROM report_retention_artifacts WHERE report_id = ?').run(row.id)
      const insert = this.db.prepare(`
        INSERT INTO report_retention_artifacts (
          report_id, artifact_kind, artifact_key, source_name, recovery_name,
          size, mtime_ms, state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `)
      for (const description of descriptions) {
        insert.run(
          row.id,
          description.kind,
          description.key,
          description.source.name,
          description.recoveryName,
          description.source.stat.size,
          Math.trunc(description.source.stat.mtimeMs),
        )
      }
      this.db.prepare(`
        UPDATE report_files
        SET retention_state = 'quarantine_pending', retention_error_code = NULL,
            retention_updated_at = ?
        WHERE id = ?
      `).run(now, row.id)
    })
    writePlan()
  }

  _movePlanToRecovery(row, roots, now) {
    let artifacts = this._artifactRows(row.id)
    this._assertRecoveryDirectory(roots, row.id, artifacts)
    for (const artifact of artifacts) {
      if (artifact.state === 'moved') continue
      const source = resolveRegisteredPath(roots.reports, artifact.source_name, { mustExist: false })
      const destination = resolveRegisteredPath(roots.recovery, artifact.recovery_name, { mustExist: false })
      const sourceExists = existsSync(source.path)
      const destinationExists = existsSync(destination.path)
      if (sourceExists && destinationExists) fail('artifact_duplicate_location')
      if (!sourceExists && !destinationExists) fail('artifact_missing_both_locations')
      if (sourceExists) {
        const entry = resolveRegisteredPath(roots.reports, artifact.source_name)
        if (entry.stat.size !== artifact.size || Math.trunc(entry.stat.mtimeMs) !== artifact.mtime_ms) fail('artifact_changed_before_move')
        this.operations.rename(entry.path, destination.path)
      } else {
        const entry = resolveRegisteredPath(roots.recovery, artifact.recovery_name)
        if (entry.stat.size !== artifact.size) fail('recovery_artifact_mismatch')
      }
      this.db.prepare(`
        UPDATE report_retention_artifacts SET state = 'moved', moved_at = ? WHERE id = ?
      `).run(now, artifact.id)
    }
    artifacts = this._artifactRows(row.id)
    if (artifacts.some((artifact) => artifact.state !== 'moved')) fail('quarantine_incomplete')
    this.db.prepare(`
      UPDATE report_files
      SET retention_state = 'quarantined', quarantined_at = ?,
          retention_error_code = NULL, retention_updated_at = ?
      WHERE id = ?
    `).run(now, now, row.id)
    return artifacts
  }

  quarantineReport(reportId, { now = Date.now(), requireExpired = true } = {}) {
    const startedAt = now
    const row = this._report(reportId)
    if (!row) return { ok: false, code: 'report_not_found' }
    if (Number(row.long_term_keep) === 1) return { ok: false, code: 'long_term_keep' }
    if (row.retention_state === 'quarantined') return { ok: true, alreadyQuarantined: true, quarantinedAt: row.quarantined_at }
    let auditId = null
    try {
      const roots = this._roots()
      const existing = this._artifactRows(row.id)
      if (existing.length === 0) {
        const descriptions = this._validateAndDescribe(row, roots, { now, requireExpired })
        this._assertRecoveryDirectory(roots, row.id)
        try {
          auditId = this._recordAudit({ reportId: row.id, action: 'quarantine', outcome: 'skipped', reasonCode: 'operation_started', startedAt, completedAt: startedAt })
        } catch {
          fail('audit_write_failed')
        }
        this._createPlan(row, descriptions, now)
      } else {
        try {
          auditId = this._recordAudit({ reportId: row.id, action: 'quarantine', outcome: 'skipped', reasonCode: 'operation_started', startedAt, completedAt: startedAt })
        } catch {
          fail('audit_write_failed')
        }
      }
      const artifacts = this._movePlanToRecovery(row, roots, now)
      const bytes = artifacts.reduce((sum, artifact) => sum + Number(artifact.size || 0), 0)
      this._updateAudit(auditId, {
        outcome: 'success',
        artifactCount: artifacts.length,
        bytes,
        completedAt: Date.now(),
      })
      return {
        ok: true,
        artifactCount: artifacts.length,
        bytes,
        quarantinedAt: now,
        recoverableUntil: now + REPORT_RECOVERY_DAYS * 24 * 60 * 60 * 1000,
      }
    } catch (error) {
      const code = safeCode(error)
      try { this._setError(row.id, 'quarantine_error', code, Date.now()) } catch {}
      try {
        if (auditId) this._updateAudit(auditId, { outcome: 'failed', reasonCode: code, completedAt: Date.now() })
        else this._recordAudit({ reportId: row.id, action: 'quarantine', outcome: 'failed', reasonCode: code, startedAt, completedAt: Date.now() })
      } catch {}
      return { ok: false, code }
    }
  }

  setLongTermKeep(reportId, enabled, { now = Date.now() } = {}) {
    const row = this._report(reportId)
    if (!row) return { ok: false, code: 'report_not_found' }
    this.db.prepare(`
      UPDATE report_files SET long_term_keep = ?, retention_updated_at = ? WHERE id = ?
    `).run(enabled ? 1 : 0, now, reportId)
    this._recordAudit({
      reportId,
      action: 'long_term_keep',
      outcome: 'success',
      reasonCode: enabled ? 'enabled' : 'disabled',
      startedAt: now,
      completedAt: now,
    })
    return { ok: true, longTermKeep: Boolean(enabled) }
  }

  listRecovery() {
    return this.db.prepare(`
      SELECT id, original_name, report_type, long_term_keep, retention_state,
             quarantined_at, retention_error_code, retention_updated_at
      FROM report_files
      WHERE retention_state IN ('quarantined', 'restore_error', 'delete_error')
      ORDER BY COALESCE(quarantined_at, retention_updated_at) DESC, id
    `).all().map((row) => ({
      id: row.id,
      name: row.original_name,
      reportType: row.report_type,
      longTermKeep: Number(row.long_term_keep) === 1,
      retentionState: row.retention_state,
      quarantinedAt: row.quarantined_at || null,
      recoverableUntil: row.quarantined_at
        ? row.quarantined_at + REPORT_RECOVERY_DAYS * 24 * 60 * 60 * 1000
        : null,
      errorCode: row.retention_error_code || null,
    }))
  }

  restoreReport(reportId, { now = Date.now() } = {}) {
    const startedAt = now
    const row = this._report(reportId)
    if (!row) return { ok: false, code: 'report_not_found' }
    if (!['quarantined', 'restore_error', 'delete_error'].includes(row.retention_state)) return { ok: false, code: 'report_not_quarantined' }
    let auditId = null
    try {
      const roots = this._roots()
      const artifacts = this._artifactRows(reportId)
      if (!artifacts.length) fail('recovery_plan_missing')
      this._assertRecoveryDirectory(roots, reportId, artifacts)
      try {
        auditId = this._recordAudit({ reportId, action: 'restore', outcome: 'skipped', reasonCode: 'operation_started', startedAt, completedAt: startedAt })
      } catch {
        fail('audit_write_failed')
      }
      const ordered = [...artifacts].sort((left, right) => (left.artifact_kind === 'report' ? 1 : 0) - (right.artifact_kind === 'report' ? 1 : 0))
      for (const artifact of ordered) {
        if (artifact.state === 'deleted') fail('artifact_already_deleted')
        const source = resolveRegisteredPath(roots.recovery, artifact.recovery_name, { mustExist: false })
        const destination = resolveRegisteredPath(roots.reports, artifact.source_name, { mustExist: false })
        const sourceExists = existsSync(source.path)
        const destinationExists = existsSync(destination.path)
        if (sourceExists && destinationExists) fail('artifact_duplicate_location')
        if (!sourceExists && !destinationExists) fail('artifact_missing_both_locations')
        if (sourceExists) {
          const entry = resolveRegisteredPath(roots.recovery, artifact.recovery_name)
          if (entry.stat.size !== artifact.size) fail('recovery_artifact_mismatch')
          this.operations.rename(entry.path, destination.path)
        }
      }
      const finish = this.db.transaction(() => {
        this.db.prepare('DELETE FROM report_retention_artifacts WHERE report_id = ?').run(reportId)
        this.db.prepare(`
          UPDATE report_files
          SET retention_state = 'active', quarantined_at = NULL,
              retention_error_code = NULL, retention_updated_at = ?
          WHERE id = ?
        `).run(now, reportId)
        this._updateAudit(auditId, { outcome: 'success', artifactCount: artifacts.length, completedAt: Date.now() })
      })
      finish()
      const directoryPath = resolve(roots.recovery.path, reportDirectoryName(reportId))
      if (existsSync(directoryPath)) rmdirSync(directoryPath)
      return { ok: true }
    } catch (error) {
      const code = safeCode(error, 'restore_failed')
      try { this._setError(reportId, 'restore_error', code, Date.now()) } catch {}
      try {
        if (auditId) this._updateAudit(auditId, { outcome: 'failed', reasonCode: code, completedAt: Date.now() })
        else this._recordAudit({ reportId, action: 'restore', outcome: 'failed', reasonCode: code, startedAt, completedAt: Date.now() })
      } catch {}
      return { ok: false, code }
    }
  }

  permanentlyDeleteReport(reportId, { now = Date.now() } = {}) {
    const startedAt = now
    const row = this._report(reportId)
    if (!row) return { ok: false, code: 'report_not_found' }
    if (Number(row.long_term_keep) === 1) return { ok: false, code: 'long_term_keep' }
    if (!['quarantined', 'delete_error'].includes(row.retention_state)) return { ok: false, code: 'report_not_quarantined' }
    const deleteBefore = now - REPORT_RECOVERY_DAYS * 24 * 60 * 60 * 1000
    if (!Number.isFinite(Number(row.quarantined_at)) || Number(row.quarantined_at) >= deleteBefore) {
      return { ok: false, code: 'recovery_period_active' }
    }
    let auditId = null
    try {
      const roots = this._roots()
      const artifacts = this._artifactRows(reportId)
      if (!artifacts.length) fail('recovery_plan_missing')
      this._assertRecoveryDirectory(roots, reportId, artifacts)
      try {
        auditId = this._recordAudit({
          reportId,
          action: 'permanent_delete',
          outcome: 'skipped',
          reasonCode: 'operation_started',
          startedAt,
          completedAt: startedAt,
        })
      } catch {
        fail('audit_write_failed')
      }
      for (const artifact of artifacts) {
        if (artifact.state === 'deleted') continue
        const original = resolveRegisteredPath(roots.reports, artifact.source_name, { mustExist: false })
        if (existsSync(original.path)) fail('artifact_present_in_report_root')
        const recovery = resolveRegisteredPath(roots.recovery, artifact.recovery_name)
        if (recovery.stat.size !== artifact.size) fail('recovery_artifact_mismatch')
        this.operations.unlink(recovery.path)
        this.db.prepare(`
          UPDATE report_retention_artifacts SET state = 'deleted', deleted_at = ? WHERE id = ?
        `).run(now, artifact.id)
      }
      const remaining = this._artifactRows(reportId)
      if (remaining.some((artifact) => artifact.state !== 'deleted')) fail('permanent_delete_incomplete')
      const bytes = remaining.reduce((sum, artifact) => sum + Number(artifact.size || 0), 0)
      const finish = this.db.transaction(() => {
        this.db.prepare('DELETE FROM report_deliveries WHERE report_id = ?').run(reportId)
        this.db.prepare('DELETE FROM report_retention_artifacts WHERE report_id = ?').run(reportId)
        this.db.prepare('DELETE FROM report_files WHERE id = ?').run(reportId)
        this._updateAudit(auditId, {
          outcome: 'success',
          artifactCount: remaining.length,
          bytes,
          completedAt: Date.now(),
        })
      })
      finish()
      const directoryPath = resolve(roots.recovery.path, reportDirectoryName(reportId))
      if (existsSync(directoryPath)) rmdirSync(directoryPath)
      return { ok: true, artifactCount: remaining.length, bytes }
    } catch (error) {
      const code = safeCode(error, 'permanent_delete_failed')
      try { this._setError(reportId, 'delete_error', code, Date.now()) } catch {}
      try {
        if (auditId) this._updateAudit(auditId, { outcome: 'failed', reasonCode: code, completedAt: Date.now() })
        else this._recordAudit({ reportId, action: 'permanent_delete', outcome: 'failed', reasonCode: code, startedAt, completedAt: Date.now() })
      } catch {}
      return { ok: false, code }
    }
  }

  runAutomatic({ now = Date.now(), maxItems = 50 } = {}) {
    const limit = Math.min(500, Math.max(1, Number.parseInt(String(maxItems), 10) || 50))
    const cutoff = now - REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000
    const candidates = this.db.prepare(`
      SELECT id FROM report_files
      WHERE retention_state IN ('active', 'quarantine_pending', 'quarantine_error')
        AND long_term_keep = 0
        AND created_at < ?
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(cutoff, limit)
    const quarantine = candidates.map((row) => this.quarantineReport(row.id, { now, requireExpired: true }))

    const purgeCutoff = now - REPORT_RECOVERY_DAYS * 24 * 60 * 60 * 1000
    const purgeCandidates = this.db.prepare(`
      SELECT id FROM report_files
      WHERE retention_state IN ('quarantined', 'delete_error')
        AND long_term_keep = 0
        AND quarantined_at < ?
      ORDER BY quarantined_at ASC, id ASC
      LIMIT ?
    `).all(purgeCutoff, limit)
    const permanentDelete = purgeCandidates.map((row) => this.permanentlyDeleteReport(row.id, { now }))
    return {
      policyVersion: REPORT_RETENTION_POLICY_VERSION,
      retentionDays: REPORT_RETENTION_DAYS,
      recoveryDays: REPORT_RECOVERY_DAYS,
      cutoffTime: new Date(cutoff).toISOString(),
      quarantine: {
        success: quarantine.filter((result) => result.ok).length,
        failed: quarantine.filter((result) => !result.ok).length,
        reasons: countByReason(quarantine),
      },
      permanentDelete: {
        success: permanentDelete.filter((result) => result.ok).length,
        failed: permanentDelete.filter((result) => !result.ok).length,
        reasons: countByReason(permanentDelete),
        freedBytes: permanentDelete.filter((result) => result.ok).reduce((sum, result) => sum + Number(result.bytes || 0), 0),
      },
    }
  }
}

export const __test__ = {
  auditMatches,
  controlledRoot,
  eventMatches,
  normalizeName,
  reportDirectoryName,
  resolveRegisteredPath,
}
