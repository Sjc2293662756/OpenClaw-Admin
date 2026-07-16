import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import { readSessionSettings, validateSessionSettings } from '../lib/session-settings.js'
import { applyGatewaySessionSettings, readGatewaySessionState } from '../lib/gateway-session-settings.js'

export function createSessionSettingsRouter({ db, authMiddleware, adminMiddleware, recordAudit, gateway }) {
  const router = Router()

  router.get('/', authMiddleware, async (_req, res) => {
    const settings = readSessionSettings(db)
    sendOk(res, {
      settings,
      historyCleanupStatus: 'planned',
      runtime: await readGatewaySessionState(gateway, settings),
    })
  })

  router.put('/', adminMiddleware, async (req, res) => {
    const validated = validateSessionSettings(req.body)
    if (!validated.ok) return sendError(res, { status: 400, code: 'SESSION_SETTINGS_INVALID', message: validated.error })

    const settings = validated.value
    let gatewaySync
    try {
      gatewaySync = await applyGatewaySessionSettings(gateway, settings)
    } catch (error) {
      return sendError(res, {
        status: error?.code === 'GATEWAY_UNAVAILABLE' ? 503 : 502,
        code: error?.code || 'GATEWAY_SESSION_SYNC_FAILED',
        message: 'GAIOP 智能体服务会话策略同步失败，未保存管理策略',
      })
    }
    const updatedAt = Date.now()
    try {
      db.prepare(`
        INSERT INTO session_settings (id, login_session_hours, idle_timeout_minutes, agent_context_idle_minutes, history_retention_days, updated_at)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          login_session_hours = excluded.login_session_hours,
          idle_timeout_minutes = excluded.idle_timeout_minutes,
          agent_context_idle_minutes = excluded.agent_context_idle_minutes,
          history_retention_days = excluded.history_retention_days,
          updated_at = excluded.updated_at
      `).run(settings.loginSessionHours, settings.idleTimeoutMinutes, settings.agentContextIdleMinutes, settings.historyRetentionDays, updatedAt)
    } catch {
      return sendError(res, {
        status: 500,
        code: 'SESSION_SETTINGS_PERSIST_FAILED',
        message: 'GAIOP 智能体服务已同步，但管理策略保存失败，请重试以恢复一致状态',
      })
    }

    recordAudit(
      req.user,
      '保存会话设置',
      '系统设置',
      `登录会话：${settings.loginSessionHours}小时；后台空闲超时：${settings.idleTimeoutMinutes}分钟；智能体上下文保持：${settings.agentContextIdleMinutes}分钟；历史保留：${settings.historyRetentionDays}天`,
    )
    const savedSettings = readSessionSettings(db)
    sendOk(res, {
      settings: savedSettings,
      historyCleanupStatus: 'planned',
      runtime: { ...(await readGatewaySessionState(gateway, savedSettings)), patchMode: gatewaySync.mode },
    })
  })

  return router
}
