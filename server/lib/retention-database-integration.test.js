import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrateReportRetention } from './report-retention-schema.js'
import { migrateSessionRetentionTables } from './session-retention-service.js'
import { migrateStorageWatermarkTables } from './storage-watermark-service.js'

test('a temporary Admin database initializes every retention migration idempotently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gaiop-admin-retention-integration-'))
  const previousDataDirectory = process.env.GAIOP_ADMIN_DATA_DIR
  process.env.GAIOP_ADMIN_DATA_DIR = directory
  let db

  try {
    const module = await import(`../database.js?retention-integration=${Date.now()}`)
    db = module.default

    const expectedTables = [
      'report_retention_artifacts',
      'report_retention_audits',
      'session_retention_records',
      'session_retention_attachments',
      'storage_watermark_status',
      'storage_watermark_targets',
      'storage_watermark_events',
      'storage_watermark_lock',
    ]
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
    for (const name of expectedTables) assert.equal(tables.has(name), true, name)

    migrateReportRetention(db)
    migrateSessionRetentionTables(db)
    migrateStorageWatermarkTables(db)
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
  } finally {
    if (db?.open) db.close()
    if (previousDataDirectory === undefined) delete process.env.GAIOP_ADMIN_DATA_DIR
    else process.env.GAIOP_ADMIN_DATA_DIR = previousDataDirectory
    rmSync(directory, { recursive: true, force: true })
  }
})
