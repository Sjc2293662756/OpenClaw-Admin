import { createHmac } from 'crypto'

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

/**
 * Attach a server-signed provenance envelope to a chat.send request. The
 * browser cannot choose the user id or signature; GAIOP verifies this envelope
 * only after Gateway places it in its execution context.
 */
export function attachReportProvenance(params = {}, user = null, options = {}) {
  const enabled = options.enabled === true
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
  const messagePreview = cleanText(params.message, 500)
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

  return {
    attached: true,
    params: {
      ...params,
      metadata: {
        ...metadata,
        gaiopReportProvenance: {
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
        },
      },
    },
  }
}

export const __test__ = { canonicalPayload, resolveSessionId, PROVENANCE_VERSION }
