import Database from 'better-sqlite3'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  STORAGE_WATERMARK_POLICY_VERSION,
  loadManagedRootConfig,
  migrateStorageWatermarkTables,
  runStorageWatermarkCycle,
} from './lib/storage-watermark-service.js'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const dataDirectory = process.env.GAIOP_ADMIN_DATA_DIR || join(moduleDirectory, '../data')
const configPath = process.env.GAIOP_STORAGE_WATERMARK_CONFIG || '/etc/gaiop/storage-watermark-roots.json'
let db

try {
  db = new Database(join(dataDirectory, 'wizard.db'), { fileMustExist: true })
  db.pragma('journal_mode = WAL')
  migrateStorageWatermarkTables(db)
  const roots = await loadManagedRootConfig(configPath)
  const result = await runStorageWatermarkCycle({
    db,
    roots,
    reminderMinutes: process.env.GAIOP_STORAGE_WATERMARK_REMINDER_MINUTES,
  })
  process.stdout.write(`${JSON.stringify({
    policyVersion: STORAGE_WATERMARK_POLICY_VERSION,
    completed: true,
    acquired: result.acquired,
    staleLockRecovered: result.staleLockRecovered,
    checkedFilesystems: result.checkedFilesystems,
    failedFilesystems: result.failedFilesystems || 0,
    emittedEventCount: result.emittedEvents.length,
    reasonCode: result.acquired ? 'check_completed' : 'lock_held',
  })}\n`)
} catch (error) {
  const reason = String(error?.message || '')
  process.stderr.write(`${JSON.stringify({
    policyVersion: STORAGE_WATERMARK_POLICY_VERSION,
    completed: false,
    reasonCode: /^[a-z0-9_]{1,80}$/i.test(reason) ? reason.toLowerCase() : 'monitor_failed',
  })}\n`)
  process.exitCode = 1
} finally {
  try { db?.close() } catch {}
}
