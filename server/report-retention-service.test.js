import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { migrateReportRetention } from './lib/report-retention-schema.js'
import { REPORT_RECOVERY_DAYS, REPORT_RETENTION_DAYS, ReportRetentionService, __test__ } from './report-retention-service.js'
import { runReportRetentionCleanup } from './report-retention-cleanup.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-08-10T12:00:00.000Z')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gaiop-report-retention-'))
  const reportRoot = join(root, 'reports')
  const recoveryRoot = join(root, 'recovery')
  mkdirSync(reportRoot)
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE report_files (
      id TEXT PRIMARY KEY, stored_name TEXT NOT NULL UNIQUE, audit_name TEXT,
      original_name TEXT NOT NULL, report_type TEXT NOT NULL,
      source_session_id TEXT, source_user_id TEXT, source_channel TEXT,
      source_channel_user_id TEXT, source_channel_user_name TEXT,
      source_message_id TEXT, source_message_preview TEXT, data_source_id TEXT,
      mime_type TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE report_deliveries (
      id TEXT PRIMARY KEY, report_id TEXT NOT NULL, event_name TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL, status TEXT NOT NULL, prepared_at INTEGER,
      handed_off_at INTEGER, confirmed_at INTEGER, failed_at INTEGER,
      error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  migrateReportRetention(db)
  return {
    root, reportRoot, recoveryRoot, db,
    service: new ReportRetentionService({ db, reportRoot, recoveryRoot }),
    close() {
      db.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

function writeAt(root, name, content, mtime) {
  const target = join(root, ...name.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  const date = new Date(mtime)
  utimesSync(target, date, date)
  return target
}

function addReport(context, {
  id, createdAt, fileMtime = createdAt, extension = '.docx',
  longTermKeep = false, delivery = true, declaredSize = null,
}) {
  const directory = `owner/summary_report/${id}`
  const storedName = `${directory}/report${extension}`
  const auditName = `${directory}/audit.json`
  const reportContent = `binary-${id}`
  const reportPath = writeAt(context.reportRoot, storedName, reportContent, fileMtime)
  writeAt(context.reportRoot, auditName, JSON.stringify({ reportId: id, relativeFilePath: storedName, relativeAuditPath: auditName }), fileMtime)
  context.db.prepare(`
    INSERT INTO report_files (
      id, stored_name, audit_name, original_name, report_type,
      source_user_id, source_session_id, source_channel, mime_type,
      size, status, created_at, updated_at, long_term_keep
    ) VALUES (?, ?, ?, ?, 'summary_report', 'owner', 'session', 'web', ?, ?, 'ready', ?, ?, ?)
  `).run(
    id, storedName, auditName, `Report ${id}${extension}`,
    extension === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    declaredSize ?? Buffer.byteLength(reportContent), createdAt, fileMtime, longTermKeep ? 1 : 0,
  )
  let eventName = null
  if (delivery) {
    eventName = `.delivery-events/${id}.json`
    writeAt(context.reportRoot, eventName, JSON.stringify({ schemaVersion: 'gaiop.report-delivery.v1', eventType: 'report_delivery', attemptId: `delivery-${id}`, reportId: id, channel: 'wecom' }), fileMtime)
    context.db.prepare(`INSERT INTO report_deliveries (id, report_id, event_name, channel, status, created_at, updated_at) VALUES (?, ?, ?, 'wecom', 'confirmed', ?, ?)`)
      .run(`delivery-${id}`, id, eventName, createdAt, createdAt)
  }
  return { storedName, auditName, eventName, reportPath }
}

test('retention schema adds protected state, artifact plan and three-year audit tables idempotently', () => {
  const context = setup()
  try {
    migrateReportRetention(context.db)
    const columns = context.db.prepare('PRAGMA table_info(report_files)').all().map((entry) => entry.name)
    assert.ok(columns.includes('long_term_keep'))
    assert.ok(columns.includes('retention_state'))
    assert.ok(context.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_retention_artifacts'").get())
    assert.ok(context.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'report_retention_audits'").get())
  } finally { context.close() }
})

test('database and report file must both be strictly older than 365 days', () => {
  const context = setup()
  const cutoff = NOW - REPORT_RETENTION_DAYS * DAY
  try {
    const expired = addReport(context, { id: 'expired', createdAt: cutoff - 1, fileMtime: cutoff - 1 })
    addReport(context, { id: 'database-boundary', createdAt: cutoff, fileMtime: cutoff - 1 })
    addReport(context, { id: 'fresh-file', createdAt: cutoff - 1, fileMtime: cutoff })
    addReport(context, { id: 'kept', createdAt: cutoff - DAY, fileMtime: cutoff - DAY, longTermKeep: true })
    const result = context.service.runAutomatic({ now: NOW, maxItems: 20 })
    assert.equal(result.quarantine.success, 1)
    assert.equal(result.quarantine.failed, 1)
    assert.equal(context.db.prepare('SELECT retention_state FROM report_files WHERE id = ?').get('expired').retention_state, 'quarantined')
    assert.equal(context.db.prepare('SELECT retention_state FROM report_files WHERE id = ?').get('database-boundary').retention_state, 'active')
    assert.equal(context.db.prepare('SELECT retention_state FROM report_files WHERE id = ?').get('fresh-file').retention_state, 'quarantine_error')
    assert.equal(context.db.prepare('SELECT retention_state FROM report_files WHERE id = ?').get('kept').retention_state, 'active')
    for (const name of [expired.storedName, expired.auditName, expired.eventName]) assert.equal(existsSync(join(context.reportRoot, name)), false)
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM report_files').get().count, 4)
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM report_deliveries WHERE report_id = ?').get('expired').count, 1)
  } finally { context.close() }
})

test('report, audit and delivery restore as one database-owned group', () => {
  const context = setup()
  try {
    const names = addReport(context, { id: 'restore-me', createdAt: NOW - 400 * DAY })
    assert.equal(context.service.quarantineReport('restore-me', { now: NOW }).ok, true)
    assert.equal(context.service.listRecovery().length, 1)
    assert.equal(context.service.restoreReport('restore-me', { now: NOW + DAY }).ok, true)
    for (const name of [names.storedName, names.auditName, names.eventName]) assert.equal(existsSync(join(context.reportRoot, name)), true)
    assert.deepEqual(context.db.prepare('SELECT retention_state, quarantined_at FROM report_files WHERE id = ?').get('restore-me'), { retention_state: 'active', quarantined_at: null })
    assert.deepEqual(context.db.prepare('SELECT source_user_id, source_session_id, source_channel FROM report_files WHERE id = ?').get('restore-me'), { source_user_id: 'owner', source_session_id: 'session', source_channel: 'web' })
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM report_deliveries WHERE report_id = ?').get('restore-me').count, 1)
  } finally { context.close() }
})

test('permanent deletion requires strictly more than seven days and retains content-free audit', () => {
  const context = setup()
  try {
    addReport(context, { id: 'purge-me', createdAt: NOW - 400 * DAY })
    assert.equal(context.service.quarantineReport('purge-me', { now: NOW }).ok, true)
    assert.equal(context.service.permanentlyDeleteReport('purge-me', { now: NOW + REPORT_RECOVERY_DAYS * DAY }).code, 'recovery_period_active')
    assert.equal(context.service.permanentlyDeleteReport('purge-me', { now: NOW + REPORT_RECOVERY_DAYS * DAY + 1 }).ok, true)
    assert.equal(context.db.prepare('SELECT * FROM report_files WHERE id = ?').get('purge-me'), undefined)
    assert.equal(context.db.prepare('SELECT * FROM report_deliveries WHERE report_id = ?').get('purge-me'), undefined)
    const audit = context.db.prepare("SELECT * FROM report_retention_audits WHERE report_id = ? AND action = 'permanent_delete'").get('purge-me')
    assert.equal(audit.outcome, 'success')
    assert.equal(Object.values(audit).some((value) => String(value).includes('Report purge-me')), false)
  } finally { context.close() }
})

test('move and delete failures retain database records with explicit retry state', () => {
  const context = setup()
  try {
    addReport(context, { id: 'retry', createdAt: NOW - 400 * DAY })
    const failingMove = new ReportRetentionService({ db: context.db, reportRoot: context.reportRoot, recoveryRoot: context.recoveryRoot, operations: { rename: () => { const error = new Error('private'); error.code = 'EACCES'; throw error } } })
    assert.equal(failingMove.quarantineReport('retry', { now: NOW }).ok, false)
    assert.equal(context.db.prepare('SELECT retention_state FROM report_files WHERE id = ?').get('retry').retention_state, 'quarantine_error')
    assert.equal(context.service.quarantineReport('retry', { now: NOW + 1 }).ok, true)
    const failingDelete = new ReportRetentionService({ db: context.db, reportRoot: context.reportRoot, recoveryRoot: context.recoveryRoot, operations: { unlink: () => { const error = new Error('private'); error.code = 'EBUSY'; throw error } } })
    assert.equal(failingDelete.permanentlyDeleteReport('retry', { now: NOW + 8 * DAY }).ok, false)
    assert.equal(context.db.prepare('SELECT retention_state FROM report_files WHERE id = ?').get('retry').retention_state, 'delete_error')
    assert.equal(context.service.permanentlyDeleteReport('retry', { now: NOW + 8 * DAY + 1 }).ok, true)
  } finally { context.close() }
})

test('permanent deletion does not start when its content-free audit cannot be written', () => {
  const context = setup()
  try {
    addReport(context, { id: 'audit-required', createdAt: NOW - 400 * DAY })
    assert.equal(context.service.quarantineReport('audit-required', { now: NOW }).ok, true)
    const artifact = context.db.prepare('SELECT recovery_name FROM report_retention_artifacts WHERE report_id = ? ORDER BY id LIMIT 1').get('audit-required')
    const recoveryPath = join(context.recoveryRoot, artifact.recovery_name)
    context.db.exec(`
      CREATE TRIGGER reject_report_retention_audit
      BEFORE INSERT ON report_retention_audits
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;
    `)
    const result = context.service.permanentlyDeleteReport('audit-required', { now: NOW + 8 * DAY })
    assert.equal(result.code, 'audit_write_failed')
    assert.equal(existsSync(recoveryPath), true)
    assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM report_files WHERE id = ?').get('audit-required').count, 1)
  } finally { context.close() }
})

test('path traversal, symlinks, size mismatch and unknown recovery entries are protected', () => {
  const context = setup()
  try {
    const old = NOW - 400 * DAY
    const mismatch = addReport(context, { id: 'size-mismatch', createdAt: old, declaredSize: 999 })
    assert.equal(context.service.quarantineReport('size-mismatch', { now: NOW }).code, 'report_size_mismatch')
    assert.equal(existsSync(join(context.reportRoot, mismatch.storedName)), true)
    const outside = writeAt(context.root, 'outside.docx', 'outside', old)
    context.db.prepare(`INSERT INTO report_files (id, stored_name, audit_name, original_name, report_type, mime_type, size, status, created_at, updated_at) VALUES ('traversal', '../outside.docx', 'audit.json', 'outside.docx', 'summary', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 7, 'ready', ?, ?)`)
      .run(old, old)
    assert.equal(context.service.quarantineReport('traversal', { now: NOW }).code, 'registered_path_invalid')
    assert.equal(existsSync(outside), true)
    const symlinked = addReport(context, { id: 'symlinked', createdAt: old })
    const symlinkedDirectory = dirname(symlinked.reportPath)
    const outsideDirectory = join(context.root, 'outside-directory')
    mkdirSync(outsideDirectory)
    rmSync(symlinkedDirectory, { recursive: true })
    symlinkSync(outsideDirectory, symlinkedDirectory, 'junction')
    assert.equal(context.service.quarantineReport('symlinked', { now: NOW }).code, 'registered_path_symlink')
    addReport(context, { id: 'unknown-recovery', createdAt: old })
    const directory = join(context.recoveryRoot, __test__.reportDirectoryName('unknown-recovery'))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'unknown.txt'), 'protect')
    assert.equal(context.service.quarantineReport('unknown-recovery', { now: NOW }).code, 'recovery_directory_unknown_entry')
    addReport(context, { id: 'overlapping-roots', createdAt: old })
    const overlapping = new ReportRetentionService({ db: context.db, reportRoot: context.reportRoot, recoveryRoot: join(context.reportRoot, 'recovery') })
    assert.equal(overlapping.quarantineReport('overlapping-roots', { now: NOW }).code, 'controlled_roots_overlap')
  } finally { context.close() }
})

test('batch limit, long-term keep toggle and default-off runner are enforced', async () => {
  const context = setup()
  try {
    for (let index = 0; index < 3; index += 1) addReport(context, { id: `batch-${index}`, createdAt: NOW - (400 + index) * DAY, delivery: false })
    assert.equal(context.service.runAutomatic({ now: NOW, maxItems: 1 }).quarantine.success, 1)
    assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM report_files WHERE retention_state = 'quarantined'").get().count, 1)
    assert.equal(context.service.setLongTermKeep('batch-0', true, { now: NOW }).longTermKeep, true)
    context.service.runAutomatic({ now: NOW + 1, maxItems: 10 })
    assert.equal(context.db.prepare('SELECT retention_state FROM report_files WHERE id = ?').get('batch-0').retention_state, 'active')
    assert.equal(context.service.setLongTermKeep('batch-0', false, { now: NOW }).longTermKeep, false)
  } finally { context.close() }
  const root = mkdtempSync(join(tmpdir(), 'gaiop-report-retention-disabled-'))
  try {
    const result = await runReportRetentionCleanup({ env: { GAIOP_ADMIN_DATA_DIR: root, GAIOP_REPORT_RETENTION_AUTO_PROCESS: 'false' }, now: NOW })
    assert.equal(result.status, 'auto_process_disabled')
    assert.equal(existsSync(join(root, 'wizard.db')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
