'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ADMIN_ALERT_VERIFY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_ALERT_VERIFY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_ALERT_VERIFY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled Admin module-permission verification inputs are incomplete.')
}

const script = String.raw`set -euo pipefail
db_file='/var/lib/gaiop/admin/wizard.db'
test -f "$db_file"
http_code() {
  method="$1"
  url="$2"
  shift 2
  curl -sS --max-time 5 -X "$method" -o /dev/null -w '%{http_code}' "$@" "http://127.0.0.1:3000$url" || true
}
health_code=$(http_code GET /api/health)
catalog_unauth=$(http_code GET /api/module-permissions/catalog)
target_unauth=$(http_code GET /api/users/nonexistent/module-permissions)
write_unauth=$(http_code PUT /api/users/nonexistent/module-permissions -H 'Content-Type: application/json' --data '{"expectedVersion":0,"overrides":[]}')
alerts_unauth=$(http_code GET /api/alerts)
reports_unauth=$(http_code GET /api/reports)
migration_state=$(node - "$db_file" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true })
try {
  const users = db.prepare('PRAGMA table_info(users)').all()
  const version = users.find((column) => column.name === 'permission_version')
  if (!version || Number(version.notnull) !== 1 || String(version.dflt_value) !== '0') process.exit(2)
  const overrides = db.prepare('PRAGMA table_info(user_module_permission_overrides)').all()
  const fields = overrides.map((column) => column.name)
  const expected = ['user_id', 'module_key', 'effect', 'updated_by', 'created_at', 'updated_at']
  if (JSON.stringify(fields) !== JSON.stringify(expected)) process.exit(3)
  const primaryKey = overrides.filter((column) => Number(column.pk) > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name)
  if (JSON.stringify(primaryKey) !== JSON.stringify(['user_id', 'module_key'])) process.exit(4)
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_module_permission_overrides'").get()
  if (!table || !/effect\s+TEXT\s+NOT NULL\s+CHECK\s*\(effect\s+IN\s*\('allow',\s*'deny'\)\)/i.test(table.sql)) process.exit(5)
  process.stdout.write('ok')
} finally {
  db.close()
}
NODE
)
printf 'HEALTH=%s\n' "$health_code"
printf 'CATALOG_UNAUTH=%s\n' "$catalog_unauth"
printf 'TARGET_UNAUTH=%s\n' "$target_unauth"
printf 'WRITE_UNAUTH=%s\n' "$write_unauth"
printf 'ALERTS_UNAUTH=%s\n' "$alerts_unauth"
printf 'REPORTS_UNAUTH=%s\n' "$reports_unauth"
printf 'MIGRATION=%s\n' "$migration_state"
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
    const summary = {
      completed: result.ok,
      health: value(result.output, 'HEALTH') === '200',
      catalogRejectsUnauthenticated: value(result.output, 'CATALOG_UNAUTH') === '401',
      targetProjectionRejectsUnauthenticated: value(result.output, 'TARGET_UNAUTH') === '401',
      permissionWriteRejectsUnauthenticated: value(result.output, 'WRITE_UNAUTH') === '401',
      alertsRejectUnauthenticated: value(result.output, 'ALERTS_UNAUTH') === '401',
      reportsRejectUnauthenticated: value(result.output, 'REPORTS_UNAUTH') === '401',
      migrationReady: value(result.output, 'MIGRATION') === 'ok',
    }
    process.stdout.write(JSON.stringify(summary) + '\n')
    if (!result.ok || Object.values(summary).some((item) => item !== true)) process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
