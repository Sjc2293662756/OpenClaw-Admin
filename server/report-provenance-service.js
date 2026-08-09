import { createHash, createHmac } from 'crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'

const PROVENANCE_VERSION = 'gaiop_report_provenance.v3'
const PROVENANCE_PHYSICAL_RETENTION_MS = 48 * 60 * 60 * 1000
const PROVENANCE_TEMP_RETENTION_MS = 48 * 60 * 60 * 1000
const PROVENANCE_FILE_PATTERN = /^([a-f0-9]{64})\.json$/
const PROVENANCE_TEMP_FILE_PATTERN = /^\.gaiop-report-provenance-([a-f0-9]{64})\.(\d{1,10})\.(\d{13})\.tmp$/
const MAX_PROVENANCE_FILE_BYTES = 64 * 1024
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

function cleanText(value, maxLength = 240) {
  const text = String(value || '').trim()
  return text ? text.slice(0, maxLength) : ''
}

function resolveSessionId(params = {}) {
  return cleanText(params.sessionKey || params.key || params.session)
}

function canonicalPayload({ userId, username, sessionId, dataSourceId, sourceChannel, sourceChannelUserId, sourceChannelUserName, messageId, messagePreview, issuedAt }) {
  return JSON.stringify([
    PROVENANCE_VERSION,
    userId,
    username || '',
    sessionId,
    dataSourceId || '',
    sourceChannel || '',
    sourceChannelUserId || '',
    sourceChannelUserName || '',
    messageId || '',
    messagePreview || '',
    Number(issuedAt),
  ])
}

function persistEnvelope(envelope, storeDirectory) {
  const directory = String(storeDirectory || '').trim()
  if (!directory || !envelope?.sessionId) return false
  mkdirSync(directory, { recursive: true, mode: 0o750 })
  const digest = createHash('sha256').update(envelope.sessionId, 'utf8').digest('hex')
  const target = join(directory, `${digest}.json`)
  const temporary = join(directory, `.gaiop-report-provenance-${digest}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o640 })
  renameSync(temporary, target)
  return true
}

function createCleanupResult(cutoffMs) {
  return {
    category: 'report_provenance_envelope',
    cutoffTime: new Date(cutoffMs).toISOString(),
    success: 0,
    skipped: 0,
    failed: 0,
    freedBytes: 0,
    reasons: {},
  }
}

function addReason(result, outcome, reason) {
  result[outcome] += 1
  result.reasons[reason] = (result.reasons[reason] || 0) + 1
}

function isValidEnvelopeForFile(envelope, digest, nowMs) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false
  if (envelope.version !== PROVENANCE_VERSION) return false
  if (typeof envelope.userId !== 'string' || !envelope.userId.trim()) return false
  if (typeof envelope.sessionId !== 'string' || !envelope.sessionId.trim()) return false
  if (typeof envelope.signature !== 'string' || !envelope.signature.trim()) return false
  if (!Number.isFinite(envelope.issuedAt) || envelope.issuedAt <= 0 || envelope.issuedAt > nowMs + MAX_CLOCK_SKEW_MS) return false
  const expected = createHash('sha256').update(envelope.sessionId, 'utf8').digest('hex')
  return expected === digest
}

/**
 * Delete only expired files owned by the dedicated report-provenance store.
 * The function is intentionally non-recursive and never follows symlinks.
 */
export function cleanupExpiredReportProvenance({
  storeDirectory,
  now = Date.now(),
  retentionMs = PROVENANCE_PHYSICAL_RETENTION_MS,
  tempRetentionMs = PROVENANCE_TEMP_RETENTION_MS,
  maxItems = 100,
  fs = {},
} = {}) {
  const nowMs = Number(now)
  const cutoffMs = nowMs - retentionMs
  const result = createCleanupResult(cutoffMs)
  const io = {
    existsSync: fs.existsSync || existsSync,
    lstatSync: fs.lstatSync || lstatSync,
    readFileSync: fs.readFileSync || readFileSync,
    readdirSync: fs.readdirSync || readdirSync,
    unlinkSync: fs.unlinkSync || unlinkSync,
  }
  if (!Number.isFinite(nowMs) || !Number.isFinite(retentionMs) || retentionMs < 0 || !Number.isFinite(tempRetentionMs) || tempRetentionMs < 0) {
    addReason(result, 'failed', 'invalid_policy')
    return result
  }

  const root = resolve(String(storeDirectory || ''))
  if (basename(root) !== 'report-provenance') {
    addReason(result, 'failed', 'unexpected_root_name')
    return result
  }
  if (!storeDirectory || !io.existsSync(root)) return result
  let rootStat
  try {
    rootStat = io.lstatSync(root)
  } catch {
    addReason(result, 'failed', 'root_stat_failed')
    return result
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    addReason(result, 'failed', 'unsafe_root')
    return result
  }

  let entries
  try {
    entries = io.readdirSync(root, { withFileTypes: true })
  } catch {
    addReason(result, 'failed', 'root_read_failed')
    return result
  }

  const candidates = []
  for (const entry of entries) {
    const target = resolve(root, entry.name)
    if (target === root || !target.startsWith(root + '\\') && !target.startsWith(root + '/')) {
      addReason(result, 'skipped', 'path_outside_root')
      continue
    }
    let stat
    try {
      stat = io.lstatSync(target)
    } catch {
      addReason(result, 'failed', 'entry_stat_failed')
      continue
    }
    if (stat.isSymbolicLink()) {
      addReason(result, 'skipped', 'symbolic_link')
      continue
    }
    if (!stat.isFile()) {
      addReason(result, 'skipped', entry.isDirectory() ? 'unknown_directory' : 'unknown_file_type')
      continue
    }
    if (!Number.isFinite(stat.mtimeMs) || stat.mtimeMs <= 0 || stat.mtimeMs > nowMs + MAX_CLOCK_SKEW_MS) {
      addReason(result, 'skipped', 'invalid_timestamp')
      continue
    }

    const envelopeMatch = PROVENANCE_FILE_PATTERN.exec(entry.name)
    const tempMatch = PROVENANCE_TEMP_FILE_PATTERN.exec(entry.name)
    if (!envelopeMatch && !tempMatch) {
      addReason(result, 'skipped', 'unknown_filename')
      continue
    }

    if (envelopeMatch) {
      if (!Number.isFinite(stat.size) || stat.size <= 0 || stat.size > MAX_PROVENANCE_FILE_BYTES) {
        addReason(result, 'skipped', 'invalid_file_size')
        continue
      }
      let envelope
      try {
        envelope = JSON.parse(io.readFileSync(target, 'utf8'))
      } catch {
        addReason(result, 'skipped', 'invalid_envelope')
        continue
      }
      if (!isValidEnvelopeForFile(envelope, envelopeMatch[1], nowMs)) {
        addReason(result, 'skipped', 'invalid_envelope')
        continue
      }
      if (envelope.issuedAt > cutoffMs || stat.mtimeMs > cutoffMs) {
        addReason(result, 'skipped', 'not_expired')
        continue
      }
      candidates.push({ target, stat, sortTime: Math.max(envelope.issuedAt, stat.mtimeMs) })
      continue
    }

    const createdAt = Number(tempMatch[3])
    const tempCutoffMs = nowMs - tempRetentionMs
    if (!Number.isFinite(createdAt) || createdAt <= 0 || createdAt > nowMs + MAX_CLOCK_SKEW_MS || Math.abs(stat.mtimeMs - createdAt) > MAX_CLOCK_SKEW_MS) {
      addReason(result, 'skipped', 'invalid_timestamp')
      continue
    }
    if (createdAt > tempCutoffMs || stat.mtimeMs > tempCutoffMs) {
      addReason(result, 'skipped', 'not_expired')
      continue
    }
    candidates.push({ target, stat, sortTime: Math.max(createdAt, stat.mtimeMs) })
  }

  candidates.sort((left, right) => left.sortTime - right.sortTime || left.target.localeCompare(right.target))
  const limit = Math.max(0, Math.floor(Number(maxItems) || 0))
  for (const candidate of candidates.slice(0, limit)) {
    try {
      const current = io.lstatSync(candidate.target)
      if (current.isSymbolicLink() || !current.isFile() || current.dev !== candidate.stat.dev || current.ino !== candidate.stat.ino) {
        addReason(result, 'skipped', 'entry_changed')
        continue
      }
      io.unlinkSync(candidate.target)
      result.success += 1
      result.freedBytes += Number.isFinite(candidate.stat.size) ? candidate.stat.size : 0
    } catch {
      addReason(result, 'failed', 'delete_failed')
    }
  }
  for (let index = limit; index < candidates.length; index += 1) addReason(result, 'skipped', 'batch_limit')
  return result
}

/**
 * Create and persist a server-signed provenance envelope. Legacy runtimes may
 * also transport it in chat.send metadata; production can disable that path
 * so control-plane identity never enters the Gateway/model request.
 */
export function attachReportProvenance(params = {}, user = null, options = {}) {
  const enabled = options.enabled === true
  const transportMetadata = options.transportMetadata !== false
  const signingKey = String(options.signingKey || '').trim()
  const userId = cleanText(user?.id)
  const username = cleanText(user?.username, 160)
  const sessionId = resolveSessionId(params)
  // The browser never supplies this value. It is read from the one active
  // Admin-side data source immediately before the Gateway RPC is made.
  const dataSourceId = cleanText(options.dataSourceId, 160)
  // The source message is supplied by the authenticated Web client and is
  // signed together with the server-owned identity. It is provenance only;
  // the report Skill never treats it as a tool instruction.
  const messageId = cleanText(params.idempotencyKey || params.messageId, 160)
  const messagePreview = cleanText(params.message || params.input, 500)
  if (!enabled || signingKey.length < 32 || !userId || !sessionId) {
    return { params, attached: false }
  }

  const issuedAt = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const signature = createHmac('sha256', signingKey)
    .update(canonicalPayload({ userId, username, sessionId, dataSourceId, sourceChannel: 'web', sourceChannelUserId: userId, sourceChannelUserName: username, messageId, messagePreview, issuedAt }), 'utf8')
    .digest('base64url')
  const metadata = params?.metadata && typeof params.metadata === 'object' && !Array.isArray(params.metadata)
    ? { ...params.metadata }
    : {}

  const envelope = {
    version: PROVENANCE_VERSION,
    userId,
    sourceChannel: 'web',
    sourceChannelUserId: userId,
    sourceChannelUserName: username || undefined,
    sessionId,
    dataSourceId: dataSourceId || undefined,
    sourceMessageId: messageId || undefined,
    sourceMessagePreview: messagePreview || undefined,
    issuedAt,
    signature,
  }
  let stored = false
  try {
    stored = persistEnvelope(envelope, options.storeDirectory)
  } catch {
    // Metadata remains the compatibility path. Persistence failures do not
    // turn an otherwise valid chat.send request into a user-visible failure.
  }

  return {
    attached: transportMetadata,
    stored,
    params: transportMetadata
      ? {
          ...params,
          metadata: {
            ...metadata,
            gaiopReportProvenance: envelope,
          },
        }
      : params,
  }
}

export const __test__ = {
  canonicalPayload,
  resolveSessionId,
  persistEnvelope,
  isValidEnvelopeForFile,
  PROVENANCE_VERSION,
  PROVENANCE_PHYSICAL_RETENTION_MS,
  PROVENANCE_TEMP_RETENTION_MS,
}
