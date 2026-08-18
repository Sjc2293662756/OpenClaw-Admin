import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { acquireSingleInstanceLock, runAdminRetentionCleanup } from './admin-retention-cleaner.js'
import { openReadonlyAdminDatabase } from './retention-qualification.js'

test('Admin retention defaults to a complete read-only dry-run with no audit write', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaiop-admin-retention-disabled-'))
  try {
    const result = runAdminRetentionCleanup({
      enabled: false,
      now: Date.UTC(2026, 7, 9, 12),
      auditLogPath: join(directory, 'audit.jsonl'),
      lockPath: join(directory, 'cleanup.lock'),
    })
    assert.equal(result.acquired, true)
    assert.equal(result.records.length, 2)
    assert.deepEqual(result.records.map((record) => record.category), ['report_provenance_envelope', 'admin_upgrade_upload_staging'])
    assert.deepEqual(Object.keys(result.records[0]).sort(), [
      'candidateBytes', 'candidateCount', 'category', 'completedAt', 'cutoffTime',
      'earliestCandidateTime', 'failed', 'failureReasons', 'freedBytes',
      'latestCandidateTime', 'phase', 'policyVersion', 'skipped', 'startedAt', 'success',
    ].sort())
    assert.equal(result.records[0].success, 0)
    assert.equal(result.records[0].phase, 'completed')
    assert.equal(result.dryRun, true)
    assert.equal(existsSync(join(directory, 'audit.jsonl')), false)
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
    assert.equal(received.length, 4)
    assert.deepEqual(received.map((options) => options.dryRun), [true, true, undefined, undefined])
    assert.equal(received[0].maxItems, 7)
    assert.equal(received[1].maxItems, 7)
    assert.equal(readFileSync(join(directory, 'audit.jsonl'), 'utf8').includes('do-not-log'), false)
    assert.equal(readFileSync(join(directory, 'audit.jsonl'), 'utf8').includes('token='), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Admin audit reservation failure leaves the discovered candidate untouched', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaiop-admin-retention-reservation-'))
  const staging = join(directory, 'upgrade-upload-staging')
  const target = join(staging, '00000000-0000-4000-8000-000000000099.zip')
  const now = Date.UTC(2026, 7, 9, 12)
  mkdirSync(staging)
  writeFileSync(target, 'candidate')
  utimesSync(target, (now - 48 * 60 * 60 * 1000) / 1000, (now - 48 * 60 * 60 * 1000) / 1000)
  try {
    const result = runAdminRetentionCleanup({
      enabled: true,
      now,
      reportProvenanceDirectory: join(directory, 'report-provenance'),
      upgradeUploadStagingDirectory: staging,
      auditLogPath: join(directory, 'audit.jsonl'),
      lockPath: join(directory, 'cleanup.lock'),
      appendAudit: () => { throw new Error('reservation_failed') },
    })
    assert.equal(result.auditReserved, false)
    assert.equal(existsSync(target), true)
    assert.equal(result.records.every((record) => record.failureReasons.audit_reservation_failed === 1), true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Admin readonly database helper calls the supplied constructor with readonly options', () => {
  const calls = []
  class FakeDatabase {
    constructor(...args) { calls.push(args) }
    pragma(value) { assert.equal(value, 'query_only = ON') }
  }
  const db = openReadonlyAdminDatabase('temporary-wizard.db', FakeDatabase)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], ['temporary-wizard.db', { readonly: true, fileMustExist: true }])
  assert.ok(db)
})

test('Admin readonly database helper opens a real database through its default constructor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaiop-admin-readonly-db-'))
  const databasePath = join(directory, 'wizard.db')
  try {
    const writable = new Database(databasePath)
    writable.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)')
    writable.close()
    const readonly = openReadonlyAdminDatabase(databasePath)
    assert.equal(readonly.pragma('query_only', { simple: true }), 1)
    assert.throws(() => readonly.exec('INSERT INTO sample DEFAULT VALUES'), /readonly/i)
    readonly.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
