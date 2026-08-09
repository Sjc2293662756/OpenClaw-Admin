import { appendFileSync, closeSync, mkdirSync, openSync, unlinkSync } from 'fs'
import { dirname, resolve } from 'path'
import { cleanupExpiredReportProvenance } from './report-provenance-service.js'
import { cleanupExpiredUpgradeUploadStaging } from './routes/system-upgrade.js'

export const ADMIN_RETENTION_POLICY_VERSION = 'gaiop_admin_retention.v1'

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function auditProjection(result, startedAt, completedAt) {
  const allowedReasons = {}
  for (const [reason, count] of Object.entries(result.reasons || {})) {
    if (/^[a-z0-9_]{1,80}$/.test(reason) && Number.isInteger(count) && count > 0) allowedReasons[reason] = count
  }
  return {
    policyVersion: ADMIN_RETENTION_POLICY_VERSION,
    category: String(result.category || 'unknown').slice(0, 80),
    cutoffTime: typeof result.cutoffTime === 'string' ? result.cutoffTime : null,
    success: Math.max(0, Number(result.success) || 0),
    skipped: Math.max(0, Number(result.skipped) || 0),
    failed: Math.max(0, Number(result.failed) || 0),
    freedBytes: Math.max(0, Number(result.freedBytes) || 0),
    failureReasons: allowedReasons,
    startedAt,
    completedAt,
  }
}

export function appendCleanupAudit(auditLogPath, records, append = appendFileSync) {
  const target = resolve(String(auditLogPath || ''))
  if (!auditLogPath) throw new Error('audit_log_path_required')
  mkdirSync(dirname(target), { recursive: true, mode: 0o750 })
  const payload = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  append(target, payload, { encoding: 'utf8', mode: 0o640 })
}

export function acquireSingleInstanceLock(lockPath) {
  const target = resolve(String(lockPath || ''))
  if (!lockPath) throw new Error('lock_path_required')
  mkdirSync(dirname(target), { recursive: true, mode: 0o750 })
  try {
    const fd = openSync(target, 'wx', 0o600)
    return () => {
      try { closeSync(fd) } catch {}
      try { unlinkSync(target) } catch {}
    }
  } catch (error) {
    if (error?.code === 'EEXIST') return null
    throw error
  }
}

export function runAdminRetentionCleanup({
  enabled = false,
  now = Date.now(),
  maxItems = 100,
  reportProvenanceDirectory,
  upgradeUploadStagingDirectory,
  auditLogPath,
  lockPath,
  cleanupProvenance = cleanupExpiredReportProvenance,
  cleanupUpgradeStaging = cleanupExpiredUpgradeUploadStaging,
  appendAudit = appendCleanupAudit,
} = {}) {
  const releaseLock = acquireSingleInstanceLock(lockPath)
  if (!releaseLock) return { acquired: false, records: [] }

  const startedAt = new Date(now).toISOString()
  try {
    const results = enabled
      ? [
          cleanupProvenance({ storeDirectory: reportProvenanceDirectory, now, maxItems: positiveInteger(maxItems, 100) }),
          cleanupUpgradeStaging({ stagingDirectory: upgradeUploadStagingDirectory, now, maxItems: positiveInteger(maxItems, 100) }),
        ]
      : [{
          category: 'admin_retention_all',
          cutoffTime: null,
          success: 0,
          skipped: 1,
          failed: 0,
          freedBytes: 0,
          reasons: { auto_delete_disabled: 1 },
        }]
    const completedAt = new Date().toISOString()
    const records = results.map((result) => auditProjection(result, startedAt, completedAt))
    appendAudit(auditLogPath, records)
    return { acquired: true, records }
  } finally {
    releaseLock()
  }
}

export const __test__ = { auditProjection, positiveInteger }
