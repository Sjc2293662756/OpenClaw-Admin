import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import { readAlertIngestionSettings, validateAlertIngestionSettings } from '../lib/alert-ingestion-settings.js'
import { applyAlertIngestionRuntime, readAlertIngestionRuntime } from '../lib/alert-ingestion-runtime.js'

export function createAlertIngestionRouter({
  db,
  adminMiddleware,
  recordAudit,
  readRuntime = readAlertIngestionRuntime,
  applyRuntime = applyAlertIngestionRuntime,
}) {
  const router = Router()

  router.get('/', adminMiddleware, async (_req, res) => {
    sendOk(res, { settings: readAlertIngestionSettings(db), runtime: await readRuntime() })
  })

  router.put('/', adminMiddleware, async (req, res) => {
    const validated = validateAlertIngestionSettings(req.body)
    if (!validated.ok) return sendError(res, { status: 400, code: 'ALERT_INGESTION_CONFIG_INVALID', message: validated.error })

    const updatedAt = Date.now()
    try {
      db.prepare(`
        INSERT INTO alert_ingestion_settings (id, enabled, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
      `).run(validated.value.enabled ? 1 : 0, updatedAt)
    } catch {
      return sendError(res, { status: 500, code: 'ALERT_INGESTION_CONFIG_SAVE_FAILED', message: '告警接入配置保存失败' })
    }

    const runtime = await applyRuntime(validated.value.enabled)
    recordAudit(
      req.user,
      '保存告警接入配置',
      '系统配置',
      `Syslog 接收目标：${validated.value.enabled ? '启用' : '停用'}；运行时状态：${runtime.state}`,
    )
    sendOk(res, { settings: readAlertIngestionSettings(db), runtime })
  })

  return router
}
