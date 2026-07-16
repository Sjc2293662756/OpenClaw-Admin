export const DEFAULT_SESSION_SETTINGS = Object.freeze({
  loginSessionHours: 24,
  idleTimeoutMinutes: 0,
  agentContextIdleMinutes: 30,
  historyRetentionDays: 180,
})

function toInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : fallback
}

export function readSessionSettings(db) {
  const row = db.prepare('SELECT * FROM session_settings WHERE id = 1').get()
  return {
    loginSessionHours: toInteger(row?.login_session_hours, DEFAULT_SESSION_SETTINGS.loginSessionHours),
    idleTimeoutMinutes: toInteger(row?.idle_timeout_minutes, DEFAULT_SESSION_SETTINGS.idleTimeoutMinutes),
    agentContextIdleMinutes: toInteger(row?.agent_context_idle_minutes, DEFAULT_SESSION_SETTINGS.agentContextIdleMinutes),
    historyRetentionDays: toInteger(row?.history_retention_days, DEFAULT_SESSION_SETTINGS.historyRetentionDays),
    updatedAt: row?.updated_at || null,
  }
}

export function validateSessionSettings(input = {}) {
  const loginSessionHours = toInteger(input.loginSessionHours, NaN)
  const idleTimeoutMinutes = toInteger(input.idleTimeoutMinutes, NaN)
  const agentContextIdleMinutes = toInteger(input.agentContextIdleMinutes, NaN)
  const historyRetentionDays = toInteger(input.historyRetentionDays, NaN)

  if (!Number.isInteger(loginSessionHours) || loginSessionHours < 1 || loginSessionHours > 168) {
    return { ok: false, error: '登录会话时长需为 1 至 168 小时的整数' }
  }
  if (!Number.isInteger(idleTimeoutMinutes) || idleTimeoutMinutes < 0 || idleTimeoutMinutes > 1440) {
    return { ok: false, error: '空闲超时需为 0 至 1440 分钟的整数' }
  }
  if (!Number.isInteger(agentContextIdleMinutes) || agentContextIdleMinutes < 1 || agentContextIdleMinutes > 1440) {
    return { ok: false, error: '智能体上下文保持时长需为 1 至 1440 分钟的整数' }
  }
  if (!Number.isInteger(historyRetentionDays) || historyRetentionDays < 0 || historyRetentionDays > 3650) {
    return { ok: false, error: '历史会话保留期需为 0 至 3650 天的整数' }
  }

  return { ok: true, value: { loginSessionHours, idleTimeoutMinutes, agentContextIdleMinutes, historyRetentionDays } }
}
