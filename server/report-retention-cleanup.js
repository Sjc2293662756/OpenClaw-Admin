import { resolve } from 'path'
import { acquireSingleInstanceLock } from './admin-retention-cleaner.js'
import { getReportRecoveryRoot, getReportStorageRoot } from './lib/report-storage-path.js'
import { REPORT_RECOVERY_DAYS, REPORT_RETENTION_DAYS, REPORT_RETENTION_POLICY_VERSION, ReportRetentionService } from './report-retention-service.js'

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'true'
}

function summary(status, details = {}) {
  const now = new Date().toISOString()
  return {
    policyVersion: REPORT_RETENTION_POLICY_VERSION,
    category: 'formal_reports',
    retentionDays: REPORT_RETENTION_DAYS,
    recoveryDays: REPORT_RECOVERY_DAYS,
    status,
    ...details,
    completedAt: now,
  }
}

export async function runReportRetentionCleanup({ env = process.env, now = Date.now() } = {}) {
  const startedAt = new Date(now).toISOString()
  if (!enabled(env.GAIOP_REPORT_RETENTION_AUTO_PROCESS)) {
    return summary('auto_process_disabled', { startedAt })
  }
  const lockPath = env.GAIOP_REPORT_RETENTION_LOCK_PATH || resolve(process.cwd(), 'data', '.report-retention.lock')
  const releaseLock = acquireSingleInstanceLock(lockPath)
  if (!releaseLock) return summary('lock_held', { startedAt })
  let db
  try {
    db = (await import('./database.js')).default
    const service = new ReportRetentionService({
      db,
      reportRoot: getReportStorageRoot(env),
      recoveryRoot: getReportRecoveryRoot(env),
    })
    const result = service.runAutomatic({
      now,
      maxItems: env.GAIOP_REPORT_RETENTION_MAX_ITEMS,
    })
    return summary('completed', {
      startedAt,
      cutoffTime: result.cutoffTime,
      quarantine: result.quarantine,
      permanentDelete: result.permanentDelete,
    })
  } catch {
    return summary('failed', { startedAt, reasonCode: 'report_retention_failed' })
  } finally {
    try { db?.close() } catch {}
    releaseLock()
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const result = await runReportRetentionCleanup()
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.status === 'failed') process.exitCode = 1
}

export const __test__ = { enabled, summary }
