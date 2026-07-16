import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

const CONFIG_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/
const CONFIG_CATEGORIES = new Set(['runtime', 'integration', 'security', 'certificate'])

function getEncryptionKey() {
  // 独立密钥优先；为兼容已部署的数据源配置，尚未迁移时可回退使用现有密钥。
  const secret = String(process.env.SENSITIVE_CONFIG_ENCRYPTION_KEY || process.env.DATA_SOURCE_ENCRYPTION_KEY || '')
  if (!secret) return null
  return createHash('sha256').update(secret, 'utf8').digest()
}

export function isSensitiveConfigEncryptionReady() {
  return !!getEncryptionKey()
}

export function encryptSensitiveConfigValue(value) {
  const key = getEncryptionKey()
  if (!key) throw new Error('敏感配置加密密钥未配置')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

// 当前接口不向浏览器回传敏感值；该函数仅为未来服务端运行时加载配置预留。
export function decryptSensitiveConfigValue(payload) {
  const key = getEncryptionKey()
  if (!key) throw new Error('敏感配置加密密钥未配置')
  const [version, ivText, tagText, cipherText] = String(payload || '').split(':')
  if (version !== 'v1' || !ivText || !tagText || !cipherText) throw new Error('敏感配置格式无效')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64')), decipher.final()]).toString('utf8')
}

export function validateSystemSensitiveConfigInput(input) {
  const key = String(input?.key || '').trim()
  const category = String(input?.category || '').trim()
  const description = String(input?.description || '').trim()
  const isSensitive = input?.isSensitive !== false
  const value = input?.value === undefined ? undefined : String(input.value)

  if (!CONFIG_KEY_PATTERN.test(key)) return { ok: false, error: '配置键仅支持大写字母、数字和下划线，且必须以字母开头' }
  if (!CONFIG_CATEGORIES.has(category)) return { ok: false, error: '配置分类不受支持' }
  if (description.length > 300) return { ok: false, error: '描述不能超过 300 个字符' }
  if (value === undefined || value.length > 16384) return { ok: false, error: '请输入长度不超过 16384 个字符的配置值' }

  return { ok: true, value: { key, category, description, isSensitive, value } }
}

export function toPublicSystemSensitiveConfig(row) {
  const base = {
    key: row.config_key,
    category: row.category,
    description: row.description || '',
    isSensitive: !!row.is_sensitive,
    valueConfigured: row.is_sensitive ? !!row.value_encrypted : row.value_plain !== null,
    updatedAt: row.updated_at,
  }
  return row.is_sensitive ? base : { ...base, value: row.value_plain || '' }
}
