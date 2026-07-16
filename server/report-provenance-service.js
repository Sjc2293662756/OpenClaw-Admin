import { createHmac } from 'crypto'

const PROVENANCE_VERSION = 'gaiop_report_provenance.v2'

function cleanText(value, maxLength = 240) {
  const text = String(value || '').trim()
  return text ? text.slice(0, maxLength) : ''
}

function resolveSessionId(params = {}) {
  return cleanText(params.sessionKey || params.key || params.session)
}

function canonicalPayload({ userId, sessionId, dataSourceId, issuedAt }) {
  return [PROVENANCE_VERSION, userId, sessionId, dataSourceId || '', String(issuedAt)].join('|')
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
  const sessionId = resolveSessionId(params)
  // The browser never supplies this value. It is read from the one active
  // Admin-side data source immediately before the Gateway RPC is made.
  const dataSourceId = cleanText(options.dataSourceId, 160)
  if (!enabled || signingKey.length < 32 || !userId || !sessionId) {
    return { params, attached: false }
  }

  const issuedAt = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now()
  const signature = createHmac('sha256', signingKey)
    .update(canonicalPayload({ userId, sessionId, dataSourceId, issuedAt }), 'utf8')
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
          sessionId,
          dataSourceId: dataSourceId || undefined,
          issuedAt,
          signature,
        },
      },
    },
  }
}

export const __test__ = { canonicalPayload, resolveSessionId, PROVENANCE_VERSION }
