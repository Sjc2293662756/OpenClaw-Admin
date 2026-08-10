import db from './database.js'
import { OpenClawGateway } from './gateway.js'
import { createAuditRecorder } from './lib/audit-service.js'
import { enrichSessionPayload } from './lib/session-ownership-service.js'
import { runSessionRetentionCycle } from './lib/session-retention-service.js'

function isEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true'
}

function waitForGateway(gateway, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('gateway_connection_timeout')), timeoutMs)
    const finish = (error) => {
      clearTimeout(timer)
      gateway.off('connected', onConnected)
      gateway.off('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onConnected = () => finish()
    const onError = () => finish(new Error('gateway_connection_failed'))
    gateway.once('connected', onConnected)
    gateway.once('error', onError)
    void gateway.connect()
  })
}

const autoMark = isEnabled(process.env.GAIOP_SESSION_RETENTION_AUTO_MARK)
const autoDelete = isEnabled(process.env.GAIOP_SESSION_RETENTION_AUTO_DELETE)
let gateway = null

try {
  if (autoMark || autoDelete) {
    gateway = new OpenClawGateway(
      process.env.OPENCLAW_WS_URL || 'ws://127.0.0.1:18789',
      process.env.OPENCLAW_AUTH_TOKEN || '',
      process.env.OPENCLAW_AUTH_PASSWORD || '',
      process.env.LOG_LEVEL || 'INFO',
    )
    await waitForGateway(gateway)
  }

  const { recordAuditEvent } = createAuditRecorder(db)
  const result = await runSessionRetentionCycle({
    db,
    autoMark,
    autoDelete,
    retentionDays: process.env.GAIOP_SESSION_RETENTION_DAYS,
    graceDays: process.env.GAIOP_SESSION_RETENTION_GRACE_DAYS,
    maxItems: process.env.GAIOP_SESSION_RETENTION_MAX_ITEMS,
    recordAuditEvent,
    listGatewaySessions: gateway
      ? async () => enrichSessionPayload(db, await gateway.call('sessions.list', {}))
      : undefined,
    deleteGatewaySession: gateway
      ? (sessionKey) => gateway.call('sessions.delete', { key: sessionKey, deleteTranscript: true })
      : undefined,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    policyVersion: 'gaiop_session_retention.v1',
    completed: false,
    errorCode: /^[a-z0-9_]+$/i.test(String(error?.message || ''))
      ? String(error.message).toUpperCase()
      : 'SESSION_RETENTION_RUN_FAILED',
  })}\n`)
  process.exitCode = 1
} finally {
  gateway?.disconnect()
  try { db.close() } catch {}
}
