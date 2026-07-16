export const ALERT_INGESTION_DEFAULTS = Object.freeze({
  enabled: true,
  protocol: 'udp',
  port: 514,
})

export function readAlertIngestionSettings(db) {
  const row = db.prepare('SELECT enabled, updated_at FROM alert_ingestion_settings WHERE id = 1').get()
  return {
    enabled: row ? Boolean(row.enabled) : ALERT_INGESTION_DEFAULTS.enabled,
    protocol: ALERT_INGESTION_DEFAULTS.protocol,
    port: ALERT_INGESTION_DEFAULTS.port,
    updatedAt: row?.updated_at || null,
  }
}

export function validateAlertIngestionSettings(input) {
  if (typeof input?.enabled !== 'boolean') {
    return { ok: false, error: '告警接收启用状态必须为布尔值' }
  }
  return { ok: true, value: { enabled: input.enabled } }
}
