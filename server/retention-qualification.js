import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, resolve } from 'node:path'

export const QUALIFICATION_POLICY_VERSION = 'gaiop_retention_qualification.v1'
export const PROVENANCE_RETENTION_MS = 48 * 60 * 60 * 1000
export const ADMIN_STAGING_RETENTION_MS = 24 * 60 * 60 * 1000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
const MAX_PROVENANCE_FILE_BYTES = 64 * 1024
const PROVENANCE_VERSION = 'gaiop_report_provenance.v3'
const PROVENANCE_PATTERN = /^([a-f0-9]{64})\.json$/
const TEMP_PROVENANCE_PATTERN = /^\.gaiop-report-provenance-([a-f0-9]{64})\.(\d{1,10})\.(\d{13})\.tmp$/
const UUID_V4_ZIP_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.zip$/i

function createSummary(category) {
  return {
    category,
    safe_candidate: { count: 0, bytes: 0, earliestUtc: null, latestUtc: null },
    protected: { count: 0, reasons: {} },
    unknown_or_error: { count: 0, reasons: {} },
  }
}

function addReason(bucket, reason, count = 1) {
  bucket.count += count
  bucket.reasons[reason] = (bucket.reasons[reason] || 0) + count
}

function addCandidate(summary, size, timeMs) {
  const item = summary.safe_candidate
  item.count += 1
  item.bytes += Number.isFinite(size) && size > 0 ? size : 0
  if (Number.isFinite(timeMs)) {
    const value = new Date(timeMs).toISOString()
    if (!item.earliestUtc || value < item.earliestUtc) item.earliestUtc = value
    if (!item.latestUtc || value > item.latestUtc) item.latestUtc = value
  }
}

function isInsideRoot(root, target) {
  return target !== root && (target.startsWith(root + '/') || target.startsWith(root + '\\'))
}

function createIo(overrides = {}) {
  return {
    existsSync: overrides.existsSync || existsSync,
    lstatSync: overrides.lstatSync || lstatSync,
    readdirSync: overrides.readdirSync || readdirSync,
    readFileSync: overrides.readFileSync || readFileSync,
  }
}

function readManagedEntries(rootDirectory, expectedName, io, summary) {
  const root = resolve(String(rootDirectory || ''))
  if (basename(root) !== expectedName) {
    addReason(summary.unknown_or_error, 'unexpected_root_name')
    return null
  }
  if (!rootDirectory || !io.existsSync(root)) {
    addReason(summary.unknown_or_error, 'managed_root_not_found')
    return null
  }
  let rootStat
  try {
    rootStat = io.lstatSync(root)
  } catch {
    addReason(summary.unknown_or_error, 'managed_root_stat_failed')
    return null
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    addReason(summary.unknown_or_error, 'managed_root_unsafe')
    return null
  }
  try {
    return { root, entries: io.readdirSync(root, { withFileTypes: true }) }
  } catch {
    addReason(summary.unknown_or_error, 'managed_root_read_failed')
    return null
  }
}

function validTimestamp(value, nowMs) {
  return Number.isFinite(value) && value > 0 && value <= nowMs + MAX_CLOCK_SKEW_MS
}

function validEnvelope(envelope, digest, nowMs) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false
  if (envelope.version !== PROVENANCE_VERSION) return false
  if (typeof envelope.userId !== 'string' || !envelope.userId.trim()) return false
  if (typeof envelope.sessionId !== 'string' || !envelope.sessionId.trim()) return false
  if (typeof envelope.signature !== 'string' || !envelope.signature.trim()) return false
  if (!validTimestamp(Number(envelope.issuedAt), nowMs)) return false
  if (createHash('sha256').update(envelope.sessionId, 'utf8').digest('hex') !== digest) return false
  if (envelope.sourceChannel != null && typeof envelope.sourceChannel !== 'string') return false
  if (envelope.dataSourceId != null && typeof envelope.dataSourceId !== 'string') return false
  return true
}

function associationState(resolver, value) {
  if (typeof resolver !== 'function') return { known: false }
  try {
    const result = resolver(value)
    return { known: result?.known === true, active: result?.active === true, locked: result?.locked === true }
  } catch {
    return { known: false }
  }
}

export function createReportProvenanceAssociationResolver(db) {
  if (!db) return null
  let reportStatement
  let deliveryStatement
  try {
    reportStatement = db.prepare(`
      SELECT COUNT(*) AS count
      FROM report_files
      WHERE source_session_id = ? AND status <> 'failed'
    `)
    deliveryStatement = db.prepare(`
      SELECT COUNT(*) AS count
      FROM report_deliveries d
      JOIN report_files r ON r.id = d.report_id
      WHERE r.source_session_id = ? AND d.status IN ('prepared', 'handed_off')
    `)
  } catch {
    return null
  }
  return (sessionId) => {
    try {
      const reports = Number(reportStatement.get(sessionId)?.count || 0)
      const deliveries = Number(deliveryStatement.get(sessionId)?.count || 0)
      return { known: true, active: reports > 0 || deliveries > 0 }
    } catch {
      return { known: false }
    }
  }
}

export function openReadonlyAdminDatabase(dbPath, DatabaseClass) {
  const Database = DatabaseClass || createRequire(import.meta.url)('better-sqlite3')
  const db = new DatabaseClass(dbPath, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  return db
}

export function qualifyReportProvenance({ storeDirectory, now = Date.now(), associationResolver, fs: fsOverrides = {} } = {}) {
  const summary = createSummary('admin_report_provenance_envelope')
  const nowMs = Number(now)
  if (!Number.isFinite(nowMs)) {
    addReason(summary.unknown_or_error, 'invalid_now')
    return summary
  }
  const io = createIo(fsOverrides)
  const managed = readManagedEntries(storeDirectory, 'report-provenance', io, summary)
  if (!managed) return summary
  const cutoffMs = nowMs - PROVENANCE_RETENTION_MS

  for (const entry of managed.entries) {
    const target = resolve(managed.root, entry.name)
    if (!isInsideRoot(managed.root, target)) {
      addReason(summary.protected, 'path_outside_root')
      continue
    }
    let stat
    try {
      stat = io.lstatSync(target)
    } catch {
      addReason(summary.unknown_or_error, 'entry_stat_failed')
      continue
    }
    if (stat.isSymbolicLink()) {
      addReason(summary.protected, 'symbolic_link')
      continue
    }
    if (!stat.isFile()) {
      addReason(summary.protected, entry.isDirectory() ? 'unknown_directory' : 'unknown_file_type')
      continue
    }
    const match = PROVENANCE_PATTERN.exec(entry.name)
    const tempMatch = TEMP_PROVENANCE_PATTERN.exec(entry.name)
    if (!match && !tempMatch) {
      addReason(summary.protected, 'unknown_filename')
      continue
    }
    if (!validTimestamp(Number(stat.mtimeMs), nowMs)) {
      addReason(summary.protected, 'invalid_timestamp')
      continue
    }
    if (tempMatch) {
      addReason(summary.unknown_or_error, 'temporary_envelope_unowned')
      continue
    }
    if (!Number.isFinite(stat.size) || stat.size <= 0 || stat.size > MAX_PROVENANCE_FILE_BYTES) {
      addReason(summary.protected, 'invalid_file_size')
      continue
    }
    let envelope
    try {
      envelope = JSON.parse(io.readFileSync(target, 'utf8'))
    } catch {
      addReason(summary.protected, 'invalid_envelope')
      continue
    }
    if (!validEnvelope(envelope, match[1], nowMs)) {
      addReason(summary.protected, 'invalid_envelope')
      continue
    }
    const issuedAt = Number(envelope.issuedAt)
    if (issuedAt >= cutoffMs || Number(stat.mtimeMs) >= cutoffMs) {
      addReason(summary.protected, 'not_expired')
      continue
    }
    const association = associationState(associationResolver, envelope.sessionId)
    if (!association.known) {
      addReason(summary.unknown_or_error, 'association_unknown')
      continue
    }
    if (association.active) {
      addReason(summary.protected, 'active_or_pending_reference')
      continue
    }
    addCandidate(summary, stat.size, Math.max(issuedAt, Number(stat.mtimeMs)))
  }
  return summary
}

export function qualifyAdminUpgradeStaging({ stagingDirectory, now = Date.now(), activityResolver, fs: fsOverrides = {} } = {}) {
  const summary = createSummary('admin_upgrade_upload_staging')
  const nowMs = Number(now)
  if (!Number.isFinite(nowMs)) {
    addReason(summary.unknown_or_error, 'invalid_now')
    return summary
  }
  const io = createIo(fsOverrides)
  const managed = readManagedEntries(stagingDirectory, 'upgrade-upload-staging', io, summary)
  if (!managed) return summary
  const cutoffMs = nowMs - ADMIN_STAGING_RETENTION_MS

  for (const entry of managed.entries) {
    const target = resolve(managed.root, entry.name)
    if (!isInsideRoot(managed.root, target)) {
      addReason(summary.protected, 'path_outside_root')
      continue
    }
    let stat
    try {
      stat = io.lstatSync(target)
    } catch {
      addReason(summary.unknown_or_error, 'entry_stat_failed')
      continue
    }
    if (stat.isSymbolicLink()) {
      addReason(summary.protected, 'symbolic_link')
      continue
    }
    if (!stat.isFile()) {
      addReason(summary.protected, entry.isDirectory() ? 'unknown_directory' : 'unknown_file_type')
      continue
    }
    if (!UUID_V4_ZIP_PATTERN.test(entry.name)) {
      addReason(summary.protected, 'unknown_filename')
      continue
    }
    if (!validTimestamp(Number(stat.mtimeMs), nowMs)) {
      addReason(summary.protected, 'invalid_timestamp')
      continue
    }
    if (Number(stat.mtimeMs) >= cutoffMs) {
      addReason(summary.protected, 'not_expired')
      continue
    }
    const activity = associationState(activityResolver, entry.name.slice(0, -4).toLowerCase())
    if (!activity.known) {
      addReason(summary.unknown_or_error, 'activity_unknown')
      continue
    }
    if (activity.active) {
      addReason(summary.protected, activity.locked ? 'active_lock' : 'active_or_pending_reference')
      continue
    }
    addCandidate(summary, stat.size, Number(stat.mtimeMs))
  }
  return summary
}
