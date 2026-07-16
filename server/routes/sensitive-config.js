import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'

export function createSensitiveConfigRouter({
  db,
  adminMiddleware,
  recordAudit,
  encryptSensitiveConfigValue,
  isSensitiveConfigEncryptionReady,
  toPublicSystemSensitiveConfig,
  validateSystemSensitiveConfigInput,
}) {
  const router = Router()

  router.get('/', adminMiddleware, (_req, res) => {
    const rows = db.prepare(`SELECT config_key, category, description, is_sensitive, value_plain, value_encrypted, updated_at
      FROM system_sensitive_configs ORDER BY category, config_key`).all()
    sendOk(res, { configs: rows.map(toPublicSystemSensitiveConfig) })
  })

  router.put('/:key', adminMiddleware, (req, res) => {
    const input = { ...req.body, key: req.params.key }
    const validated = validateSystemSensitiveConfigInput(input)
    if (!validated.ok) return sendError(res, { status: 400, code: 'INVALID_SENSITIVE_CONFIG_INPUT', message: validated.error })

    const value = validated.value
    if (value.isSensitive && !isSensitiveConfigEncryptionReady()) {
      return sendError(res, {
        status: 503,
        code: 'SENSITIVE_CONFIG_ENCRYPTION_KEY_MISSING',
        message: '敏感配置加密密钥未配置，请在服务端设置 SENSITIVE_CONFIG_ENCRYPTION_KEY',
      })
    }

    try {
      const now = Date.now()
      const valuePlain = value.isSensitive ? null : value.value
      const valueEncrypted = value.isSensitive ? encryptSensitiveConfigValue(value.value) : null
      db.prepare(`INSERT INTO system_sensitive_configs (config_key, category, description, is_sensitive, value_plain, value_encrypted, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(config_key) DO UPDATE SET category = excluded.category, description = excluded.description,
          is_sensitive = excluded.is_sensitive, value_plain = excluded.value_plain,
          value_encrypted = excluded.value_encrypted, updated_at = excluded.updated_at`)
        .run(value.key, value.category, value.description, value.isSensitive ? 1 : 0, valuePlain, valueEncrypted, now)
      const row = db.prepare('SELECT * FROM system_sensitive_configs WHERE config_key = ?').get(value.key)
      recordAudit(req.user, '保存环境与敏感配置', value.key, `分类：${value.category}；敏感：${value.isSensitive ? '是' : '否'}`)
      sendOk(res, { config: toPublicSystemSensitiveConfig(row) })
    } catch (_error) {
      sendError(res, { code: 'SENSITIVE_CONFIG_SAVE_FAILED', message: '保存环境与敏感配置失败' })
    }
  })

  router.delete('/:key', adminMiddleware, (req, res) => {
    const key = String(req.params.key || '').trim()
    const existing = db.prepare('SELECT config_key FROM system_sensitive_configs WHERE config_key = ?').get(key)
    if (!existing) return sendError(res, { status: 404, code: 'SENSITIVE_CONFIG_NOT_FOUND', message: '配置项不存在' })
    db.prepare('DELETE FROM system_sensitive_configs WHERE config_key = ?').run(key)
    recordAudit(req.user, '删除环境与敏感配置', key, '')
    sendOk(res)
  })

  return router
}
