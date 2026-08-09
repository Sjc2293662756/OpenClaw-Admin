import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { runSqliteBackup, verifyBackupRestore } from './sqlite-backup-service.js'
import { runAdminSqliteBackup } from '../sqlite-backup.js'

const NOW = Date.parse('2026-08-10T03:00:00.000Z')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'gaiop-admin-sqlite-backup-'))
  const databasePath = join(root, 'wizard.db')
  const backupRoot = join(root, 'backups')
  const temporaryRoot = join(root, 'restore-tests')
  const lockPath = join(root, 'run', 'backup.lock')
  const db = new Database(databasePath)
  db.pragma('journal_mode = WAL')
  db.pragma('user_version = 17')
  db.exec('CREATE TABLE protected_data (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT INTO protected_data (value) VALUES (?)').run('SECRET-BUSINESS-CONTENT')
  db.close()
  return {
    root, databasePath, backupRoot, temporaryRoot, lockPath,
    close: () => rmSync(root, { recursive: true, force: true }),
  }
}

function options(context, now, extra = {}) {
  return {
    component: 'admin', expectedDatabaseName: 'wizard.db', databasePath: context.databasePath,
    backupRoot: context.backupRoot, lockPath: context.lockPath, createEnabled: true,
    cleanupEnabled: false, now, ...extra,
  }
}

test('online SQLite backup creates verified daily, weekly and monthly manifests without business content', async () => {
  const context = setup()
  try {
    const result = await runSqliteBackup(options(context, NOW))
    assert.equal(result.ok, true)
    assert.deepEqual(result.created.map((item) => item.tier), ['daily', 'weekly', 'monthly'])
    const files = readdirSync(context.backupRoot).sort()
    assert.equal(files.filter((name) => name.endsWith('.sqlite3')).length, 3)
    assert.equal(files.filter((name) => name.endsWith('.manifest.json')).length, 3)
    for (const name of files.filter((entry) => entry.endsWith('.manifest.json'))) {
      const text = readFileSync(join(context.backupRoot, name), 'utf8')
      assert.doesNotMatch(text, /SECRET-BUSINESS-CONTENT/)
      const manifest = JSON.parse(text)
      assert.equal(manifest.component, 'admin')
      assert.equal(manifest.databaseVersion.userVersion, 17)
      assert.match(manifest.sha256, /^[a-f0-9]{64}$/)
      assert.ok(manifest.sizeBytes > 0)
    }
    const repeated = await runSqliteBackup(options(context, NOW + 1000, { cleanupEnabled: true }))
    assert.equal(repeated.created.length, 0)
    assert.equal(repeated.cleanup.status, 'no_new_verified_backup')
  } finally { context.close() }
})

test('restore verification writes only a generated temporary database and preserves the source backup', async () => {
  const context = setup()
  try {
    await runSqliteBackup(options(context, NOW))
    const backupFile = join(context.backupRoot, 'admin-daily-2026-08-10.sqlite3')
    const before = readFileSync(backupFile)
    const productionBefore = readFileSync(context.databasePath)
    const result = await verifyBackupRestore({ backupFile, backupRoot: context.backupRoot, temporaryRoot: context.temporaryRoot, component: 'admin' })
    assert.equal(result.status, 'verified')
    assert.deepEqual(readFileSync(backupFile), before)
    assert.deepEqual(readFileSync(context.databasePath), productionBefore)
    assert.deepEqual(readdirSync(context.temporaryRoot), [])
    const restored = new Database(backupFile, { readonly: true })
    assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok')
    assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM protected_data').get().count, 1)
    restored.close()
    writeFileSync(backupFile, Buffer.concat([before, Buffer.from('damaged')]))
    await assert.rejects(
      verifyBackupRestore({ backupFile, backupRoot: context.backupRoot, temporaryRoot: context.temporaryRoot, component: 'admin' }),
      (error) => error.code === 'manifest_mismatch',
    )
  } finally { context.close() }
})

test('retention keeps 30 daily periods, 12 weekly periods and 12 monthly periods', async () => {
  const context = setup()
  try {
    for (const time of [
      Date.parse('2025-07-01T03:00:00Z'),
      Date.parse('2026-05-11T03:00:00Z'),
      Date.parse('2026-07-11T03:00:00Z'),
      Date.parse('2026-07-12T03:00:00Z'),
    ]) await runSqliteBackup(options(context, time))
    const result = await runSqliteBackup(options(context, NOW, { cleanupEnabled: true }))
    assert.equal(result.ok, true)
    assert.equal(result.cleanup.status, 'completed')
    assert.ok(result.cleanup.deleted >= 6)
    assert.equal(existsSync(join(context.backupRoot, 'admin-daily-2026-07-11.sqlite3')), false)
    assert.equal(existsSync(join(context.backupRoot, 'admin-daily-2026-07-12.sqlite3')), true)
    assert.equal(existsSync(join(context.backupRoot, 'admin-weekly-2026-W20.sqlite3')), false)
    assert.equal(existsSync(join(context.backupRoot, 'admin-monthly-2026-05.sqlite3')), true)
    assert.equal(existsSync(join(context.backupRoot, 'admin-monthly-2025-07.sqlite3')), false)
  } finally { context.close() }
})

test('backup or integrity failure never starts expiry cleanup and can be retried', async () => {
  const context = setup()
  try {
    await runSqliteBackup(options(context, Date.parse('2025-07-01T03:00:00Z')))
    const oldBackup = join(context.backupRoot, 'admin-daily-2025-07-01.sqlite3')
    const failed = await runSqliteBackup(options(context, NOW, {
      cleanupEnabled: true,
      snapshot: async () => { const error = new Error('private'); error.code = 'snapshot_failed'; throw error },
    }))
    assert.equal(failed.ok, false)
    assert.equal(failed.cleanup.status, 'not_run')
    assert.equal(existsSync(oldBackup), true)
    const retry = await runSqliteBackup(options(context, NOW, { cleanupEnabled: true }))
    assert.equal(retry.ok, true)
    assert.equal(existsSync(oldBackup), false)
  } finally { context.close() }
})

test('cleanup is independently disabled and corrupt or unknown entries remain protected', async () => {
  const context = setup()
  try {
    await runSqliteBackup(options(context, Date.parse('2025-07-01T03:00:00Z')))
    const oldBackup = join(context.backupRoot, 'admin-daily-2025-07-01.sqlite3')
    writeFileSync(join(context.backupRoot, 'unknown.db'), 'protect')
    const disabled = await runSqliteBackup(options(context, NOW, { cleanupEnabled: false }))
    assert.equal(disabled.cleanup.status, 'disabled')
    assert.equal(existsSync(oldBackup), true)
    writeFileSync(join(context.backupRoot, 'admin-daily-2025-07-01.manifest.json'), '{"damaged":true}')
    const nextDay = await runSqliteBackup(options(context, NOW + 86400000, { cleanupEnabled: true }))
    assert.equal(nextDay.cleanup.failed, 1)
    assert.equal(existsSync(oldBackup), true)
    assert.equal(existsSync(join(context.backupRoot, 'unknown.db')), true)
  } finally { context.close() }
})

test('Admin runner defaults both switches off and never opens a database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaiop-admin-sqlite-disabled-'))
  try {
    const result = await runAdminSqliteBackup({ GAIOP_ADMIN_DATA_DIR: root })
    assert.equal(result.status, 'create_disabled')
    assert.equal(existsSync(join(root, 'wizard.db')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('single-instance lock and service templates preserve least privilege defaults', async () => {
  const context = setup()
  try {
    mkdirSync(join(context.root, 'run'), { recursive: true })
    writeFileSync(context.lockPath, 'held')
    const result = await runSqliteBackup(options(context, NOW))
    assert.equal(result.status, 'lock_held')
    assert.equal(existsSync(context.backupRoot), false)
  } finally { context.close() }

  const env = readFileSync(join(process.cwd(), 'deploy', 'iso', 'env', 'admin.env.example'), 'utf8')
  const service = readFileSync(join(process.cwd(), 'deploy', 'systemd', 'gaiop-admin-sqlite-backup.service'), 'utf8')
  const timer = readFileSync(join(process.cwd(), 'deploy', 'systemd', 'gaiop-admin-sqlite-backup.timer'), 'utf8')
  assert.match(env, /^GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED=false$/m)
  assert.match(env, /^GAIOP_ADMIN_SQLITE_BACKUP_CLEANUP_ENABLED=false$/m)
  assert.match(service, /^UMask=0077$/m)
  assert.match(service, /^ReadWritePaths=\/var\/lib\/gaiop\/admin\/sqlite-backups$/m)
  assert.match(service, /^InaccessiblePaths=-\/var\/lib\/gaiop\/upgrade$/m)
  assert.match(service, /^InaccessiblePaths=-\/var\/lib\/gaiop\/alerts$/m)
  assert.doesNotMatch(service, /upgrade\.db/)
  assert.doesNotMatch(service, /^ReadWritePaths=.*\/var\/lib\/gaiop\/upgrade/m)
  assert.match(timer, /^OnCalendar=\*-\*-\* 01:20:00 UTC$/m)
  assert.match(timer, /^Persistent=true$/m)
})
