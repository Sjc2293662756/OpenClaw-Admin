'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_REPORT_ATTRIBUTION_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_ATTRIBUTION_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_ATTRIBUTION_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report-attribution verification context is incomplete.')
}

const script = String.raw`set -euo pipefail
uid=$(id -u netinside)
runtime="/run/user/$uid"
userctl() {
  sudo -u netinside env XDG_RUNTIME_DIR="$runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" systemctl --user "$@"
}

sudo -u gaiop env GAIOP_REPORTS_DIR=/var/lib/gaiop/reports GAIOP_REPORT_ATTRIBUTION_INDEX_PATH=/var/lib/gaiop/report-attribution/index.json /usr/local/bin/node --input-type=module - <<'NODE'
import Database from '/opt/gaiop/admin/node_modules/better-sqlite3/lib/index.js'
const { __test__ } = await import('/opt/gaiop/admin/server/routes/reports.js')
const db = new Database('/var/lib/gaiop/admin/wizard.db')
try {
  __test__.syncGeneratedReports(db)
  const summary = db.prepare([
    'SELECT',
    'COUNT(*) AS total,',
    'SUM(CASE WHEN source_session_id IS NOT NULL THEN 1 ELSE 0 END) AS sessions,',
    'SUM(CASE WHEN source_user_id IS NOT NULL THEN 1 ELSE 0 END) AS users,',
    'SUM(CASE WHEN source_channel IS NOT NULL THEN 1 ELSE 0 END) AS channels,',
    "SUM(CASE WHEN source_channel = 'webchat' THEN 1 ELSE 0 END) AS webchat,",
    "SUM(CASE WHEN source_channel = 'wecom' THEN 1 ELSE 0 END) AS wecom",
    "FROM report_files WHERE stored_name LIKE '_sidecar/%'",
  ].join(' ')).get()
  for (const [key, value] of Object.entries(summary)) process.stdout.write('DB_' + key.toUpperCase() + '=' + Number(value || 0) + '\n')
} finally { db.close() }
NODE

/usr/local/bin/node - /var/lib/gaiop/report-attribution/index.json <<'NODE'
const fs = require('fs')
const value = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const age = Date.now() - Date.parse(value.updatedAt)
process.stdout.write('INDEX_SCHEMA=' + String(value.schemaVersion === 'gaiop.report-attribution.v1') + '\n')
process.stdout.write('INDEX_ENTRIES=' + Number(value.entries?.length || 0) + '\n')
process.stdout.write('INDEX_FRESH=' + String(Number.isFinite(age) && age >= -60000 && age <= 120000) + '\n')
NODE

printf 'ADMIN_ACTIVE='; systemctl is-active gaiop-admin.service
printf 'SIDECAR_ACTIVE='; userctl is-active gaiop-report-attribution.service
printf 'SIDECAR_ENABLED='; userctl is-enabled gaiop-report-attribution.service
printf 'SIDECAR_LISTENERS='; ss -lntup 2>/dev/null | grep -c 'report-attribution' || true
printf 'AUTO_REFRESH='; grep -Fq '5000' /opt/gaiop/admin/dist/assets/FilesPage-*.js && echo present || echo missing
`

function execute(client) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => resolve({ ok: code === 0, output }))
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    const values = Object.create(null)
    for (const line of result.output.split(/\r?\n/)) {
      const match = line.match(/^([A-Z_]+)=([a-z0-9-]+)$/i)
      if (match) values[match[1]] = match[2]
    }
    const payload = {
      completed: result.ok,
      adminActive: values.ADMIN_ACTIVE,
      sidecarActive: values.SIDECAR_ACTIVE,
      sidecarEnabled: values.SIDECAR_ENABLED,
      sidecarListeners: Number(values.SIDECAR_LISTENERS || 0),
      indexSchema: values.INDEX_SCHEMA === 'true',
      indexFresh: values.INDEX_FRESH === 'true',
      indexEntries: Number(values.INDEX_ENTRIES || 0),
      registered: Number(values.DB_TOTAL || 0),
      withSession: Number(values.DB_SESSIONS || 0),
      withUser: Number(values.DB_USERS || 0),
      withChannel: Number(values.DB_CHANNELS || 0),
      webchat: Number(values.DB_WEBCHAT || 0),
      wecom: Number(values.DB_WECOM || 0),
      autoRefresh: values.AUTO_REFRESH === 'present',
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    if (!result.ok) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
