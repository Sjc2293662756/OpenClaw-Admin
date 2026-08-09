import { join, resolve } from 'path'
import { verifyBackupRestore } from './lib/sqlite-backup-service.js'

export async function runAdminRestoreTest({ env = process.env, backupFile = process.argv[2] } = {}) {
  const dataRoot = resolve(env.GAIOP_ADMIN_DATA_DIR || join(process.cwd(), 'data'))
  return verifyBackupRestore({
    component: 'admin',
    backupFile,
    backupRoot: env.GAIOP_ADMIN_SQLITE_BACKUP_DIR || join(dataRoot, 'sqlite-backups'),
    temporaryRoot: env.GAIOP_ADMIN_SQLITE_RESTORE_TEST_DIR || join(dataRoot, 'sqlite-restore-tests'),
  })
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  try {
    const result = await runAdminRestoreTest()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, status: 'failed', reasonCode: String(error?.code || 'restore_test_failed') })}\n`)
    process.exitCode = 1
  }
}
