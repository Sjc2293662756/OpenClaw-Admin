import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Return the one deployment-controlled root shared by GAIOP-Admin and the
 * GAIOP report Skill. This is intentionally read-only configuration: callers
 * must not accept a path from the browser.
 */
export function getReportStorageRoot(env = process.env) {
  return resolve(env.GAIOP_REPORTS_DIR || join(__dirname, '../../data/reports'))
}

export function getReportRecoveryRoot(env = process.env) {
  return resolve(env.GAIOP_REPORT_RECOVERY_DIR || join(__dirname, '../../data/report-recovery'))
}
