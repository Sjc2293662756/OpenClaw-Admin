import { createHash } from 'crypto'
import { sanitizeGatewayConfigPayload } from './sensitive-data.js'

const CHANNEL_PATH_PATTERN = /^channels\.[a-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const SECRET_KEY_PATTERN = /(?:token|secret|password|credential|private[_-]?key|access[_-]?key|api[_-]?key)$/i
const MASK = '******'

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function looksLikeConfig(value) {
  const row = asRecord(value)
  return 'channels' in row || 'agents' in row || 'models' in row || 'gateway' in row
}

function parseRawConfig(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value)
    return looksLikeConfig(parsed) ? parsed : null
  } catch {
    return null
  }
}

function configCandidates(payload) {
  const row = asRecord(payload)
  return [row, asRecord(row.config), asRecord(row.data), asRecord(row.value), asRecord(row.payload), asRecord(row.result)]
}

export function extractGatewayConfig(payload) {
  for (const candidate of configCandidates(payload)) {
    if (looksLikeConfig(candidate)) return candidate
    const fromRaw = parseRawConfig(candidate.raw)
    if (fromRaw) return fromRaw
  }
  return {}
}

function extractSnapshotMeta(payload) {
  let exists = true
  let hash = ''
  let raw = ''
  for (const candidate of configCandidates(payload)) {
    if (typeof candidate.exists === 'boolean') exists = candidate.exists
    if (!hash && typeof candidate.hash === 'string') hash = candidate.hash.trim()
    if (!raw && typeof candidate.raw === 'string' && candidate.raw.trim()) raw = candidate.raw
  }
  if (!hash && raw) hash = createHash('sha256').update(raw).digest('hex')
  return { exists, hash }
}

function cloneJson(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

function buildSafePluginInventory(value) {
  const plugins = asRecord(value)
  const entries = asRecord(plugins.entries)
  const safeEntries = {}

  for (const [id, entry] of Object.entries(entries)) {
    const row = asRecord(entry)
    safeEntries[id] = typeof row.enabled === 'boolean' ? { enabled: row.enabled } : {}
  }

  return {
    allow: Array.isArray(plugins.allow)
      ? plugins.allow.filter((item) => typeof item === 'string')
      : [],
    entries: safeEntries,
  }
}

function setMergePatchValue(target, segments, value) {
  let cursor = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index]
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[segments[segments.length - 1]] = cloneJson(value)
}

function shouldFallbackToLegacyPatch(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('config.patch') && (
    message.includes('required property') ||
    message.includes('unexpected property') ||
    message.includes('additional properties')
  )
}

export function validateChannelPatches(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    return { ok: false, error: '频道配置变更数量不符合要求' }
  }

  const patches = []
  for (const item of value) {
    const path = typeof item?.path === 'string' ? item.path.trim() : ''
    const segments = path.split('.').filter(Boolean)
    if (!CHANNEL_PATH_PATTERN.test(path) || segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
      return { ok: false, error: '频道配置路径无效' }
    }
    if (SECRET_KEY_PATTERN.test(segments.at(-1) || '') && item.value === MASK) {
      return { ok: false, error: '掩码不能作为频道凭据保存' }
    }
    patches.push({ path, value: cloneJson(item.value) })
  }

  if (JSON.stringify(patches).length > 64 * 1024) {
    return { ok: false, error: '频道配置变更内容过大' }
  }
  return { ok: true, value: patches }
}

export async function readGatewayChannelConfig(gateway) {
  if (!gateway?.isConnected) {
    const error = new Error('GAIOP 智能体服务暂未连接')
    error.code = 'GATEWAY_UNAVAILABLE'
    throw error
  }
  const snapshot = await gateway.call('config.get', {})
  const config = extractGatewayConfig(snapshot)
  return sanitizeGatewayConfigPayload({
    channels: asRecord(config.channels),
    // 仅提供已登记组件的标识和启用状态，供页面判断 ISO 组件是否就绪。
    // 插件自身配置可能含凭据，绝不回传浏览器。
    plugins: buildSafePluginInventory(config.plugins),
  })
}

export async function patchGatewayChannelConfig(gateway, patches) {
  if (!gateway?.isConnected) {
    const error = new Error('GAIOP 智能体服务暂未连接')
    error.code = 'GATEWAY_UNAVAILABLE'
    throw error
  }

  const snapshot = await gateway.call('config.get', {})
  const meta = extractSnapshotMeta(snapshot)
  const mergePatch = {}
  for (const patch of patches) setMergePatchValue(mergePatch, patch.path.split('.'), patch.value)
  const params = { raw: JSON.stringify(mergePatch) }
  if (meta.exists && meta.hash) params.baseHash = meta.hash

  try {
    await gateway.call('config.patch', params)
    return { mode: 'raw' }
  } catch (error) {
    if (!shouldFallbackToLegacyPatch(error)) throw error
    await gateway.call('config.patch', { patches })
    return { mode: 'patches' }
  }
}
