import { createHash, createHmac } from 'crypto'
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

const PROVENANCE_VERSION = 'gaiop_report_provenance.v3'

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
  const temporary = join(directory, `.${digest}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o640 })
  renameSync(temporary, target)
  return true
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

export const __test__ = { canonicalPayload, resolveSessionId, persistEnvelope, PROVENANCE_VERSION }
