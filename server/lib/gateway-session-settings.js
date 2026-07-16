import { createHash } from 'crypto'

const WEBCHAT_IDLE_MINUTES = 5_256_000

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asPositiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 1 ? number : null
}

function readConfigRoot(payload) {
  const row = asRecord(payload)
  const candidates = [payload, row.config, row.data, row.value, row.payload, row.result]
  return candidates.find((candidate) => {
    const config = asRecord(candidate)
    return 'session' in config || 'agents' in config || 'channels' in config || 'gateway' in config
  }) || {}
}

function readConfigSnapshotMeta(payload) {
  const row = asRecord(payload)
  const candidates = [row, asRecord(row.payload), asRecord(row.data), asRecord(row.result)]
  let exists = true
  let hash = null
  let raw = null

  for (const candidate of candidates) {
    if (typeof candidate.exists === 'boolean') exists = candidate.exists
    if (typeof candidate.hash === 'string' && candidate.hash.trim()) hash = candidate.hash.trim()
    if (typeof candidate.raw === 'string' && candidate.raw.trim()) raw = candidate.raw
    if (hash) break
  }

  return { exists, hash, raw }
}

function shouldUseLegacyPatch(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  const normalized = message.toLowerCase()
  return normalized.includes('config.patch') && (
    normalized.includes("required property 'patches'") ||
    normalized.includes('required property "patches"') ||
    normalized.includes("unexpected property 'raw'") ||
    normalized.includes('unexpected property "raw"') ||
    normalized.includes('must not have additional properties')
  )
}

export function buildGatewaySessionPatches(settings) {
  return [
    { path: 'session.dmScope', value: 'per-channel-peer' },
    { path: 'session.reset', value: { mode: 'idle', idleMinutes: settings.agentContextIdleMinutes } },
    { path: 'session.resetByChannel.webchat', value: { mode: 'idle', idleMinutes: WEBCHAT_IDLE_MINUTES } },
  ]
}

export function buildGatewayPatchRaw(patches) {
  const payload = {}
  for (const patch of patches) {
    const segments = String(patch?.path || '').split('.').map((item) => item.trim()).filter(Boolean)
    if (segments.length === 0) continue
    let cursor = payload
    for (const segment of segments.slice(0, -1)) {
      const current = cursor[segment]
      if (!current || typeof current !== 'object' || Array.isArray(current)) cursor[segment] = {}
      cursor = cursor[segment]
    }
    cursor[segments.at(-1)] = patch.value === undefined ? null : JSON.parse(JSON.stringify(patch.value))
  }
  return JSON.stringify(payload)
}

export function toPublicGatewaySessionState(payload, expectedSettings) {
  const config = asRecord(readConfigRoot(payload))
  const session = asRecord(config.session)
  const reset = asRecord(session.reset)
  const resetByChannel = asRecord(session.resetByChannel)
  const webchat = asRecord(resetByChannel.webchat)
  const agentContextIdleMinutes = asPositiveInteger(reset.idleMinutes)
  const webchatIdleMinutes = asPositiveInteger(webchat.idleMinutes)
  const expectedIdle = expectedSettings?.agentContextIdleMinutes

  const configured = session.dmScope === 'per-channel-peer'
    && reset.mode === 'idle'
    && agentContextIdleMinutes === expectedIdle
    && webchat.mode === 'idle'
    && webchatIdleMinutes === WEBCHAT_IDLE_MINUTES

  return {
    status: configured ? 'applied' : 'different',
    dmScope: session.dmScope === 'per-channel-peer' ? 'per-channel-peer' : null,
    resetMode: reset.mode === 'idle' ? 'idle' : null,
    agentContextIdleMinutes,
    webchatResetMode: webchat.mode === 'idle' ? 'idle' : null,
    webchatIdleMinutes,
  }
}

export async function readGatewaySessionState(gateway, expectedSettings) {
  if (!gateway?.isConnected) return { status: 'unavailable' }
  try {
    const payload = await gateway.call('config.get', {})
    return toPublicGatewaySessionState(payload, expectedSettings)
  } catch {
    return { status: 'unavailable' }
  }
}

export async function applyGatewaySessionSettings(gateway, settings) {
  if (!gateway?.isConnected) {
    const error = new Error('GAIOP 智能体服务暂未连接，未保存会话设置')
    error.code = 'GATEWAY_UNAVAILABLE'
    throw error
  }

  const patches = buildGatewaySessionPatches(settings)
  const snapshot = await gateway.call('config.get', {})
  const snapshotMeta = readConfigSnapshotMeta(snapshot)
  const params = { raw: buildGatewayPatchRaw(patches) }
  const baseHash = snapshotMeta.hash || (snapshotMeta.raw
    ? createHash('sha256').update(snapshotMeta.raw).digest('hex')
    : null)
  if (snapshotMeta.exists && baseHash) params.baseHash = baseHash

  try {
    await gateway.call('config.patch', params)
    return { mode: 'raw' }
  } catch (error) {
    if (!shouldUseLegacyPatch(error)) throw error
    await gateway.call('config.patch', { patches })
    return { mode: 'legacy' }
  }
}

export const __test__ = {
  WEBCHAT_IDLE_MINUTES,
  buildGatewaySessionPatches,
  buildGatewayPatchRaw,
  toPublicGatewaySessionState,
}
