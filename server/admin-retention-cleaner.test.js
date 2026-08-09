import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSingleInstanceLock, runAdminRetentionCleanup } from './admin-retention-cleaner.js'

test('Admin retention defaults to no deletion and writes only the bounded audit summary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaiop-admin-retention-disabled-'))
  try {
    const result = runAdminRetentionCleanup({
      enabled: false,
      now: Date.UTC(2026, 7, 9, 12),
      auditLogPath: join(directory, 'audit.jsonl'),
      lockPath: join(directory, 'cleanup.lock'),
    })
    assert.equal(result.acquired, true)
    assert.equal(result.records.length, 1)
    assert.deepEqual(Object.keys(result.records[0]).sort(), [
      'category', 'completedAt', 'cutoffTime', 'failed', 'failureReasons', 'freedBytes',
      'policyVersion', 'skipped', 'startedAt', 'success',
    ].sort())
    assert.equal(result.records[0].success, 0)
    assert.equal(result.records[0].failureReasons.auto_delete_disabled, 1)
    assert.equal(readFileSync(join(directory, 'audit.jsonl'), 'utf8').includes('token'), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Admin retention allows only one instance and forwards a bounded batch to each owned cleaner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaiop-admin-retention-lock-'))
  const lockPath = join(directory, 'cleanup.lock')
  try {
    const release = acquireSingleInstanceLock(lockPath)
    assert.equal(typeof release, 'function')
    const blocked = runAdminRetentionCleanup({
      enabled: true,
      auditLogPath: join(directory, 'audit.jsonl'),
      lockPath,
    })
    assert.equal(blocked.acquired, false)
    release()

    const received = []
    const completed = runAdminRetentionCleanup({
      enabled: true,
      now: Date.UTC(2026, 7, 9, 12),
      maxItems: 7,
      reportProvenanceDirectory: join(directory, 'report-provenance'),
      upgradeUploadStagingDirectory: join(directory, 'upgrade-upload-staging'),
      auditLogPath: join(directory, 'audit.jsonl'),
      lockPath,
      cleanupProvenance: (options) => {
        received.push(options)
        return { category: 'report_provenance_envelope', cutoffTime: '2026-08-07T12:00:00.000Z', success: 1, skipped: 2, failed: 0, freedBytes: 10, reasons: { unknown_filename: 2, 'token=do-not-log': 1 } }
      },
      cleanupUpgradeStaging: (options) => {
        received.push(options)
        return { category: 'admin_upgrade_upload_staging', cutoffTime: '2026-08-08T12:00:00.000Z', success: 0, skipped: 1, failed: 1, freedBytes: 0, reasons: { delete_failed: 1 } }
      },
    })
    assert.equal(completed.acquired, true)
    assert.equal(received.length, 2)
    assert.equal(received[0].maxItems, 7)
    assert.equal(received[1].maxItems, 7)
    const audit = readFileSync(join(directory, 'audit.jsonl'), 'utf8')
    assert.equal(audit.includes('do-not-log'), false)
    assert.equal(audit.includes('token='), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
