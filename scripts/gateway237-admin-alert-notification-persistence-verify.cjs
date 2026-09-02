'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ADMIN_ALERT_VERIFY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_ALERT_VERIFY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_ALERT_VERIFY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled Admin alert notification verification inputs are incomplete.')
}

const script = String.raw`set -euo pipefail
env_file='/etc/gaiop/admin.env'
test -f "$env_file"
set -a; . "$env_file"; set +a
db_file="$GAIOP_ADMIN_DATA_DIR/wizard.db"
test -f "$db_file"
health_code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health || true)
list_unauth_code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:3000/api/alerts/notifications?limit=1' || true)
claim_unauth_code=$(curl -sS --max-time 5 -X POST -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/alerts/notifications/offline-summary/claim || true)
store_hash=$(sha256sum /opt/gaiop/admin/server/lib/alert-notification-store.js | awk '{print $1}')
index_hash=$(sha256sum /opt/gaiop/admin/server/index.js | awk '{print $1}')
node - "$db_file" "$health_code" "$list_unauth_code" "$claim_unauth_code" "$store_hash" "$index_hash" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')

const [dbFile, healthCode, listUnauthCode, claimUnauthCode, storeHash, indexHash] = process.argv.slice(2)
const db = new Database(dbFile, { readonly: true, fileMustExist: true })
db.pragma('query_only = ON')

const expectedTables = [
  'alert_notification_events',
  'account_alert_notifications',
  'account_alert_notification_state',
]
const expectedIndexes = [
  'idx_alert_notification_events_occurred',
  'idx_alert_notification_events_severity',
  'idx_alert_notification_events_alert_id',
  'idx_account_alert_notifications_visible',
  'idx_account_alert_notifications_unread',
  'idx_account_alert_notifications_offline',
]
const existingTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
const existingIndexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((row) => row.name))
const runtimeColumns = new Set(db.pragma('table_info(alert_stream_runtime)').map((row) => row.name))
const integrityRows = db.pragma('integrity_check')
const foreignKeyRows = db.pragma('foreign_key_check')
const runtime = db.prepare(
  "SELECT receiver_generation, connection_state, COALESCE(gap_state, 'none') AS gap_state "
  + 'FROM alert_stream_runtime WHERE singleton_id = 1',
).get()
const count = (table) => Number(db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count)

const summary = {
  completed: healthCode === '200'
    && listUnauthCode === '401'
    && claimUnauthCode === '401'
    && expectedTables.every((name) => existingTables.has(name))
    && expectedIndexes.every((name) => existingIndexes.has(name))
    && runtimeColumns.has('receiver_generation')
    && integrityRows.length === 1
    && integrityRows[0].integrity_check === 'ok'
    && foreignKeyRows.length === 0
    && Number(runtime?.receiver_generation) >= 1,
  health: healthCode === '200',
  unauthenticatedListRejected: listUnauthCode === '401',
  unauthenticatedSummaryClaimRejected: claimUnauthCode === '401',
  tablesPresent: expectedTables.every((name) => existingTables.has(name)),
  indexesPresent: expectedIndexes.every((name) => existingIndexes.has(name)),
  receiverGenerationColumnPresent: runtimeColumns.has('receiver_generation'),
  receiverGeneration: Number(runtime?.receiver_generation || 0),
  receiverUpstreamState: String(runtime?.connection_state || 'unknown'),
  gapState: String(runtime?.gap_state || 'none'),
  integrityCheck: integrityRows.length === 1 ? String(integrityRows[0].integrity_check) : 'failed',
  foreignKeyViolationCount: foreignKeyRows.length,
  aggregateCounts: {
    sharedEvents: count('alert_notification_events'),
    accountNotifications: count('account_alert_notifications'),
    accountStates: count('account_alert_notification_state'),
  },
  deployedHashes: { alertNotificationStore: storeHash, serverIndex: indexHash },
}
db.close()
process.stdout.write(JSON.stringify(summary) + '\n')
if (!summary.completed) process.exitCode = 1
NODE
`

function execute(client) {
  return new Promise((resolve) => client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) return resolve({ ok: false, output: '' })
    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', () => {})
    stream.on('close', (code) => resolve({ ok: code === 0, output }))
    stream.write(connection.password + '\n' + script)
    stream.end()
  }))
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    let summary = { completed: false, status: 'remote-verification-failed' }
    if (result.ok) {
      try { summary = JSON.parse(result.output.trim()) } catch {}
    }
    process.stdout.write(JSON.stringify(summary) + '\n')
    if (!result.ok || !summary.completed) process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
