'use strict'

const { Client } = require('ssh2')

const migrationId = String(process.env.GAIOP_TITLE_MIGRATION_ID || '')
const connection = {
  host: String(process.env.GAIOP_TITLE_MIGRATION_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_TITLE_MIGRATION_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_TITLE_MIGRATION_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!/^[0-9]{8}T[0-9]{6}Z$/.test(migrationId) || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled historical-title migration inputs are incomplete.')
}

// The remote command returns counters only. It never prints session keys,
// message content, database content, environment values, or credentials.
const migrationScript = String.raw`set -euo pipefail
migration_id='${migrationId}'
service_name='gaiop-admin.service'
main_pid=$(systemctl show "$service_name" -p MainPID --value 2>/dev/null || true)
data_dir=''
if [ -n "$main_pid" ] && [ "$main_pid" != 0 ]; then
  data_dir=$(tr '\0' '\n' < "/proc/$main_pid/environ" 2>/dev/null | sed -n 's/^GAIOP_ADMIN_DATA_DIR=//p' | head -n 1 || true)
fi
if [ -z "$data_dir" ]; then data_dir='/var/lib/gaiop/admin'; fi
test -f "$data_dir/wizard.db"
backup_dir="/var/backups/gaiop/admin-historical-title-$migration_id"
install -d -m 0700 -o gaiop -g gaiop "$backup_dir"
backup_path="$backup_dir/wizard.db.before-title-migration"
node_path=$(command -v node)
sudo -u gaiop env GAIOP_TITLE_BACKUP_PATH="$backup_path" GAIOP_ADMIN_DATA_DIR="$data_dir" "$node_path" --env-file=/etc/gaiop/admin.env --input-type=module - <<'NODE'
import db from '/opt/gaiop/admin/server/database.js'
import { OpenClawGateway } from '/opt/gaiop/admin/server/gateway.js'
import { __test__ } from '/opt/gaiop/admin/server/lib/session-ownership-service.js'

const { isWebChatSessionRecord, findDisplaySessionTitle, deriveFirstUserMessageTitle, setHistoricalWebChatTitleIfEmpty } = __test__
const result = { eligible: 0, updated: 0, alreadyTitled: 0, withoutUserMessage: 0, failed: 0, totalTitles: 0 }
const gateway = new OpenClawGateway(
  process.env.OPENCLAW_WS_URL,
  process.env.OPENCLAW_AUTH_TOKEN,
  process.env.OPENCLAW_AUTH_PASSWORD,
  process.env.LOG_LEVEL || 'INFO',
)

function rows(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  for (const name of ['sessions', 'items', 'data', 'results']) {
    if (Array.isArray(payload[name])) return payload[name]
  }
  return []
}

function keyOf(value) {
  if (!value || typeof value !== 'object') return ''
  return String(value.key || value.sessionKey || value.id || '').trim()
}

function connect(timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gateway-timeout')), timeoutMs)
    gateway.once('connected', () => { clearTimeout(timer); resolve() })
    gateway.once('error', () => { clearTimeout(timer); reject(new Error('gateway-connect-failed')) })
    gateway.connect()
  })
}

try {
  await db.backup(process.env.GAIOP_TITLE_BACKUP_PATH)
  await connect()
  const sessions = await gateway.call('sessions.list', {})
  const candidates = []
  for (const session of rows(sessions)) {
    if (!isWebChatSessionRecord(session)) continue
    const sessionKey = keyOf(session)
    if (!sessionKey) continue
    result.eligible += 1
    if (findDisplaySessionTitle(db, sessionKey)) {
      result.alreadyTitled += 1
      continue
    }
    try {
      const history = await gateway.call('chat.history', { sessionKey })
      const title = deriveFirstUserMessageTitle(history)
      if (!title) result.withoutUserMessage += 1
      else candidates.push({ sessionKey, title })
    } catch {
      result.failed += 1
    }
  }
  const writeTitles = db.transaction((items) => {
    for (const item of items) {
      if (setHistoricalWebChatTitleIfEmpty(db, item.sessionKey, item.title)) result.updated += 1
      else result.alreadyTitled += 1
    }
  })
  writeTitles(candidates)
  result.totalTitles = Number(db.prepare('SELECT COUNT(*) AS value FROM historical_webchat_titles').get().value || 0)
  process.stdout.write('TITLE_MIGRATION=' + JSON.stringify(result) + '\n')
} catch {
  process.stdout.write('TITLE_MIGRATION_FAILED\n')
  process.exitCode = 1
} finally {
  gateway.disconnect()
  db.close()
}
NODE
printf 'TITLE_BACKUP_CREATED=1\n'
printf 'ADMIN_SERVICE=%s\n' "$(systemctl is-active "$service_name" 2>/dev/null || true)"
printf 'ADMIN_LISTENER=%s\n' "$(ss -ltnH '( sport = :3000 )' | awk '$4 == "127.0.0.1:3000" { found=1 } END { print found ? "loopback-ipv4" : "other-or-none" }')"
`

function execute(client) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => resolve({ ok: code === 0, output }))
      stream.write(`${connection.password}\n${migrationScript}`)
      stream.end()
    })
  })
}

function parse(output, ok) {
  const match = String(output).match(/^TITLE_MIGRATION=(\{[^\r\n]+\})$/m)
  let counters = null
  try { counters = match ? JSON.parse(match[1]) : null } catch {}
  const value = (name) => String(output).match(new RegExp(`^${name}=([^\\r\\n]+)$`, 'm'))?.[1]?.trim() || 'unknown'
  return {
    completed: ok && !!counters,
    status: ok && counters ? 'historical-webchat-titles-migrated' : 'historical-webchat-title-migration-failed',
    migrationId,
    backupCreated: value('TITLE_BACKUP_CREATED') === '1',
    adminService: value('ADMIN_SERVICE'),
    listenerScope: value('ADMIN_LISTENER'),
    counters,
  }
}

const client = new Client()
let done = false
const timeout = setTimeout(() => {
  if (!done) process.stdout.write('{"completed":false,"status":"historical-webchat-title-migration-timeout"}\n')
  done = true
  client.end()
  process.exitCode = 1
}, 180_000)

client.on('ready', async () => {
  try {
    const result = await execute(client)
    done = true
    const summary = parse(result.output, result.ok)
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    if (!summary.completed) process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    client.end()
  }
})
client.on('error', () => {
  if (!done) {
    done = true
    process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n')
    clearTimeout(timeout)
    process.exitCode = 1
  }
})
client.connect(connection)
