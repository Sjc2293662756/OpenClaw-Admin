const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|token|secret|password|credential|authorization|private[_-]?key|access[_-]?key|encrypt|aes|signature|webhook)/i
const MASK = '******'

function trySanitizeRawConfig(value) {
  if (typeof value !== 'string' || !value.trim()) return value
  try {
    return JSON.stringify(sanitizeGatewayConfigPayload(JSON.parse(value)))
  } catch {
    return value
  }
}

/**
 * 非管理员读取通用智能体配置，以及所有角色读取频道专用配置时使用的脱敏处理。
 * 频道管理通过独立 BFF 路由调用，不向管理员浏览器返回旧频道凭据。
 */
export function sanitizeGatewayConfigPayload(value) {
  if (Array.isArray(value)) return value.map(item => sanitizeGatewayConfigPayload(item))
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === 'raw') return [key, trySanitizeRawConfig(item)]
    if (SENSITIVE_KEY_PATTERN.test(key)) return [key, MASK]
    return [key, sanitizeGatewayConfigPayload(item)]
  }))
}
