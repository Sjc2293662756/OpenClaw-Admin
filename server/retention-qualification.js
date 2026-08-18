import { createRequire } from 'node:module'
import { cleanupExpiredReportProvenance } from './report-provenance-service.js'
import { cleanupExpiredUpgradeUploadStaging } from './routes/system-upgrade.js'

export const QUALIFICATION_POLICY_VERSION = 'gaiop_retention_qualification.v1'

function summaryFromResult(result) {
  const reasons = (value) => Object.fromEntries(Object.entries(value || {}).filter(([key, count]) => /^[a-z0-9_]{1,80}$/.test(key) && Number.isInteger(count) && count > 0))
  return {
    category: result.category,
    safe_candidate: {
      count: Math.max(0, Number(result.candidateCount) || 0),
      bytes: Math.max(0, Number(result.candidateBytes) || 0),
      earliestUtc: result.earliestCandidateTime || null,
      latestUtc: result.latestCandidateTime || null,
    },
    protected: { count: Math.max(0, Number(result.skipped) || 0), reasons: reasons(result.reasons) },
    unknown_or_error: { count: Math.max(0, Number(result.failed) || 0), reasons: reasons(result.reasons) },
  }
}

export function openReadonlyAdminDatabase(dbPath, DatabaseClass) {
  const Database = DatabaseClass || createRequire(import.meta.url)('better-sqlite3')
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  return db
}

export function qualifyReportProvenance(options = {}) {
  return summaryFromResult(cleanupExpiredReportProvenance({ ...options, dryRun: true }))
}

export function qualifyAdminUpgradeStaging(options = {}) {
  return summaryFromResult(cleanupExpiredUpgradeUploadStaging({ ...options, dryRun: true }))
}

export function qualifyAdminRetention({ reportProvenanceDirectory, upgradeUploadStagingDirectory, now = Date.now(), retentionMs, tempRetentionMs, maxItems = 100, fs: fsOverrides = {} } = {}) {
  return {
    policyVersion: QUALIFICATION_POLICY_VERSION,
    categories: {
      reportProvenance: qualifyReportProvenance({ storeDirectory: reportProvenanceDirectory, now, retentionMs, tempRetentionMs, fs: fsOverrides }),
      adminUpgradeStaging: qualifyAdminUpgradeStaging({ stagingDirectory: upgradeUploadStagingDirectory, now, retentionMs, maxItems, fs: fsOverrides }),
    },
  }
}
