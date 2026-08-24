import { syncGeneratedReports, syncReportDeliveries } from './routes/reports.js'

const DEFAULT_INTERVAL_MS = 30_000

function resolveIntervalMs(env, requested) {
  const value = requested ?? Number.parseInt(String(env.GAIOP_REPORT_REGISTRY_SYNC_INTERVAL_MS || ''), 10)
  return Number.isFinite(value) && value >= 5_000 ? value : DEFAULT_INTERVAL_MS
}

export function syncReportRegistry(db) {
  const before = Number(db.prepare('SELECT COUNT(*) AS count FROM report_files').get()?.count || 0)
  syncGeneratedReports(db)
  syncReportDeliveries(db)
  const after = Number(db.prepare('SELECT COUNT(*) AS count FROM report_files').get()?.count || 0)
  return {
    registered: Math.max(0, after - before),
    reportCount: after,
  }
}

export function startReportRegistrySync(db, {
  env = process.env,
  intervalMs,
  syncFn = syncReportRegistry,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onError = () => console.error('[Reports] Background registry sync failed'),
} = {}) {
  const run = () => {
    try {
      const result = syncFn(db)
      if (result?.registered > 0) {
        console.log(`[Reports] Background registry sync registered ${result.registered} report(s)`)
      }
    } catch {
      onError()
    }
  }

  run()
  const timer = setIntervalFn(run, resolveIntervalMs(env, intervalMs))
  timer?.unref?.()
  return () => clearIntervalFn(timer)
}

export const __test__ = { resolveIntervalMs }
