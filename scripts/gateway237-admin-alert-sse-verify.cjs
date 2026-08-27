'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ADMIN_ALERT_VERIFY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_ALERT_VERIFY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_ALERT_VERIFY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) throw new Error('The controlled Admin alert verification inputs are incomplete.')

const script = String.raw`set -euo pipefail
env_file='/etc/gaiop/admin.env'
test -f "$env_file"
set -a; . "$env_file"; set +a
data_dir="$GAIOP_ADMIN_DATA_DIR"
db_file="$data_dir/wizard.db"
test -f "$db_file"
health_code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health || true)
unauth_events_code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/events || true)
test -f /opt/gaiop/admin/dist/index.html
stream_state=$(node - "$db_file" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true })
const row = db.prepare('SELECT connection_state, gap_state FROM alert_stream_runtime WHERE singleton_id = 1').get()
db.close()
const states = new Set(['idle', 'connecting', 'connected', 'unavailable', 'authentication_error', 'gap', 'receiver_reset', 'protocol_error'])
if (!row || !states.has(row.connection_state)) process.exit(2)
process.stdout.write(row.connection_state + '|' + (row.gap_state || 'none'))
NODE
)
printf 'HEALTH=%s\n' "$health_code"
printf 'EVENTS_UNAUTH=%s\n' "$unauth_events_code"
printf 'STREAM_STATE=%s\n' "$stream_state"
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

const value = (output, key) => String(output).match(new RegExp('^' + key + '=([^\\r\\n]*)', 'm'))?.[1]?.trim() || 'unknown'
const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    const stream = value(result.output, 'STREAM_STATE').split('|')
    const summary = {
      completed: result.ok,
      health: value(result.output, 'HEALTH') === '200',
      browserSseRejectsUnauthenticated: value(result.output, 'EVENTS_UNAUTH') === '401',
      receiverUpstreamState: stream[0],
      gapState: stream[1] || 'none',
    }
    process.stdout.write(JSON.stringify(summary) + '\n')
    if (!result.ok) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => { process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n'); process.exitCode = 1 })
client.connect(connection)
