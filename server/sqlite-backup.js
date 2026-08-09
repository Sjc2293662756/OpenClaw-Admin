import { join, resolve } from 'path'
import { runSqliteBackup } from './lib/sqlite-backup-service.js'

function enabled(value) {
  return String(value || '').trim().toLowerCase() === 'true'
}

export async function runAdminSqliteBackup(env = process.env) {
  const dataRoot = resolve(env.GAIOP_ADMIN_DATA_DIR || join(process.cwd(), 'data'))
  return runSqliteBackup({
    component: 'admin',
    expectedDatabaseName: 'wizard.db',
    databasePath: join(dataRoot, 'wizard.db'),
    backupRoot: env.GAIOP_ADMIN_SQLITE_BACKUP_DIR || join(dataRoot, 'sqlite-backups'),
    lockPath: env.GAIOP_ADMIN_SQLITE_BACKUP_LOCK_PATH || join(dataRoot, '.sqlite-backup.lock'),
    createEnabled: enabled(env.GAIOP_ADMIN_SQLITE_BACKUP_CREATE_ENABLED),
    cleanupEnabled: enabled(env.GAIOP_ADMIN_SQLITE_BACKUP_CLEANUP_ENABLED),
  })
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const result = await runAdminSqliteBackup()
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.ok) process.exitCode = 1
}

export const __test__ = { enabled }
