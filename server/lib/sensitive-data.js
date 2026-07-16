const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|token|secret|password|credential|authorization|private[_-]?key|access[_-]?key)/i
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
 * 非管理员读取智能体配置时使用的最小脱敏处理。
 * 管理员仍走现有兼容路径；后续“环境与敏感配置”模块会替代这条旧配置读取方式。
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
