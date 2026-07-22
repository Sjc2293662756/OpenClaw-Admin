import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'
import db from '../server/database.js'
import { OpenClawGateway } from '../server/gateway.js'
import { backfillHistoricalWebChatTitles } from '../server/lib/session-ownership-service.js'

const envPath = new URL('../.env', import.meta.url)
const values = parse(readFileSync(envPath, 'utf8'))
const value = (name, fallback = '') => process.env[name] || values[name] || fallback

const gateway = new OpenClawGateway(
  value('OPENCLAW_WS_URL'),
  value('OPENCLAW_AUTH_TOKEN'),
  value('OPENCLAW_AUTH_PASSWORD'),
  value('LOG_LEVEL', 'INFO'),
)

function waitForGatewayConnection(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gateway connection timed out')), timeoutMs)
    gateway.once('connected', () => {
      clearTimeout(timer)
      resolve()
    })
    gateway.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    gateway.connect()
  })
}

try {
  await waitForGatewayConnection()
  const sessions = await gateway.call('sessions.list', {})
  const result = await backfillHistoricalWebChatTitles(db, sessions, (sessionKey) =>
    gateway.call('chat.history', { sessionKey })
  )
  // Deliberately print only migration counters: never session text, keys, or credentials.
  console.log(JSON.stringify({ ok: true, ...result }))
} catch {
  console.log(JSON.stringify({ ok: false, code: 'HISTORICAL_SESSION_TITLE_BACKFILL_FAILED' }))
  process.exitCode = 1
} finally {
  gateway.disconnect()
  db.close()
}
