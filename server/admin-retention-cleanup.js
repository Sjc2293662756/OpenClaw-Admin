import { resolve } from 'path'
import { runAdminRetentionCleanup } from './admin-retention-cleaner.js'

function isEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true'
}

const result = runAdminRetentionCleanup({
  enabled: isEnabled(process.env.GAIOP_ADMIN_RETENTION_AUTO_DELETE),
  maxItems: process.env.GAIOP_ADMIN_RETENTION_MAX_ITEMS,
  reportProvenanceDirectory: process.env.GAIOP_REPORT_PROVENANCE_STORE_DIR || '/var/lib/gaiop/runtime/report-provenance',
  upgradeUploadStagingDirectory: process.env.GAIOP_ADMIN_UPGRADE_UPLOAD_STAGING_DIR || resolve(process.cwd(), 'data', 'upgrade-upload-staging'),
  auditLogPath: process.env.GAIOP_ADMIN_RETENTION_AUDIT_LOG || resolve(process.cwd(), 'data', 'retention-cleanup-audit.jsonl'),
  lockPath: process.env.GAIOP_ADMIN_RETENTION_LOCK_PATH || resolve(process.cwd(), 'data', '.retention-cleanup.lock'),
})

for (const record of result.records) process.stdout.write(`${JSON.stringify(record)}\n`)
if (!result.acquired) {
  const timestamp = new Date().toISOString()
  process.stdout.write(`${JSON.stringify({
    policyVersion: 'gaiop_admin_retention.v1',
    category: 'admin_retention_lock',
    cutoffTime: null,
    success: 0,
    skipped: 1,
    failed: 0,
    freedBytes: 0,
    failureReasons: { lock_held: 1 },
    startedAt: timestamp,
    completedAt: timestamp,
  })}\n`)
}
