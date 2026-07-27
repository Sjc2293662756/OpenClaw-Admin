'use strict'

const { Client } = require('ssh2')

const releaseId = String(process.env.GAIOP_REPORT_DELIVERY_E2E_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_REPORT_DELIVERY_E2E_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_DELIVERY_E2E_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_DELIVERY_E2E_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId) || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report-delivery E2E context is incomplete.')
}

const script = String.raw`set -euo pipefail
release_id='${releaseId}'
report_id="delivery_audit_verifier_$release_id"
report_root='/var/lib/gaiop/reports'
report_relative="channel_wecom_system-delivery-verifier/quick_report/$report_id.docx"
audit_relative="channel_wecom_system-delivery-verifier/quick_report/$report_id.json"
report_path="$report_root/$report_relative"
audit_path="$report_root/$audit_relative"
outbound_path="/home/netinside/.openclaw/media/outbound/napm-reports/$report_id.docx"
plugin='/home/netinside/.openclaw/extensions/napm-openclaw-plugin/napm-openclaw-plugin.remote.js'
admin_root='/opt/gaiop/admin'
database_file='/var/lib/gaiop/admin/wizard.db'
result_file="/tmp/gaiop-report-delivery-e2e-$release_id.json"

cleanup() {
  node - "$database_file" "$admin_root/node_modules/better-sqlite3" "$report_root" "$report_id" <<'NODE' >/dev/null 2>&1 || true
const [databasePath, modulePath, reportRoot, reportId] = process.argv.slice(2)
const path = require('node:path')
const fs = require('node:fs')
const Database = require(modulePath)
const db = new Database(databasePath)
const events = db.prepare('SELECT event_name FROM report_deliveries WHERE report_id = ?').all(reportId)
db.prepare('DELETE FROM report_deliveries WHERE report_id = ?').run(reportId)
db.prepare('DELETE FROM report_files WHERE id = ?').run(reportId)
db.close()
for (const row of events) {
  const candidate = path.resolve(reportRoot, String(row.event_name || ''))
  if (candidate.startsWith(path.resolve(reportRoot, '.delivery-events') + path.sep)) fs.rmSync(candidate, { force: true })
}
NODE
  rm -f -- "$report_path" "$audit_path" "$outbound_path" "$result_file"
}
trap cleanup EXIT

install -d -o netinside -g gaiop -m 2750 "$(dirname "$report_path")"
sudo -u netinside env \
  GAIOP_REPORTS_DIR="$report_root" \
  GAIOP_REPORT_DELIVERY_DIR='/home/netinside/.openclaw/media/outbound/napm-reports' \
  node - "$plugin" "$report_id" "$report_path" "$audit_path" "$report_relative" "$audit_relative" "$result_file" <<'NODE'
const [pluginPath, reportId, reportPath, auditPath, relativeFilePath, relativeAuditPath, resultFile] = process.argv.slice(2)
const fs = require('node:fs')
const path = require('node:path')
const plugin = require(pluginPath)
const generatedAt = new Date().toISOString()
const toolContext = {
  sessionKey: 'agent:main:wecom:dm:system-delivery-verifier',
  sessionId: 'e2e:wecom:report-delivery',
  messageChannel: 'wecom',
  requesterSenderId: 'system-delivery-verifier',
  deliveryContext: { channel: 'wecom', to: 'system-delivery-verifier' }
}
const provenance = plugin.__test__.resolveReportExportContextProvenance(null, null, toolContext)
if (!provenance) process.exit(1)
fs.writeFileSync(reportPath, Buffer.from('GAIOP controlled report delivery verification'))
fs.writeFileSync(auditPath, JSON.stringify({
  reportId,
  title: '频道交付审计验证报告',
  reportType: 'quick_report',
  ...provenance,
  generatedAt,
  relativeFilePath,
  relativeAuditPath
}, null, 2) + '\n')
let result = plugin.__test__.prepareReportForChannelDelivery({
  ok: true,
  reportId,
  fileName: path.basename(reportPath),
  filePath: reportPath,
  generatedAt
}, { sourceChannel: 'wecom' })
result = plugin.__test__.recordReportDeliveryEvent(result, { sourceChannel: 'wecom' }, 'prepared')
result = plugin.__test__.recordReportDeliveryEvent(result, { sourceChannel: 'wecom' }, 'handed_off')
if (!result.deliveryFilePath || !result.deliveryEventRecorded || result.deliveryAuditErrorCode) process.exit(1)
fs.writeFileSync(resultFile, JSON.stringify({
  attemptId: result.deliveryAttemptId,
  mediaReply: plugin.__test__.buildReportExportReply(result).includes('MEDIA:'),
  deliveryFileName: path.basename(result.deliveryFilePath)
}))
NODE

chown root:gaiop "$result_file"
chmod 0640 "$result_file"
sudo -u gaiop node --env-file=/etc/gaiop/admin.env --input-type=module \
  - "$report_id" "$result_file" <<'NODE'
import fs from 'node:fs'
import db from 'file:///opt/gaiop/admin/server/database.js'
import { __test__ } from 'file:///opt/gaiop/admin/server/routes/reports.js'
const [reportId, resultFile] = process.argv.slice(2)
__test__.syncGeneratedReports(db)
__test__.syncReportDeliveries(db)
const report = db.prepare('SELECT * FROM report_files WHERE id = ?').get(reportId)
const delivery = db.prepare('SELECT * FROM report_deliveries WHERE report_id = ? ORDER BY updated_at DESC LIMIT 1').get(reportId)
const pluginResult = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
if (!report || !delivery) process.exit(1)
if (report.source_channel !== 'wecom' || report.source_user_id !== 'channel:wecom:system-delivery-verifier') process.exit(1)
if (delivery.channel !== 'wecom' || delivery.status !== 'handed_off') process.exit(1)
if (delivery.id !== pluginResult.attemptId || !pluginResult.mediaReply) process.exit(1)
process.stdout.write(JSON.stringify({
  completed: true,
  formalReportRows: 1,
  sourceChannel: report.source_channel,
  sourceRecorded: Boolean(report.source_user_id && report.source_session_id && report.data_source_id),
  deliveryRows: 1,
  deliveryStatus: delivery.status,
  mediaReply: pluginResult.mediaReply
}) + '\n')
NODE
`

function execute(client) {
  return new Promise((resolve, reject) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return reject(error)
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => {
        if (exitCode !== 0) return reject(new Error(`remote exit ${exitCode}`))
        const line = output.split(/\r?\n/).find((value) => value.startsWith('{"completed":true'))
        if (!line) return reject(new Error('controlled result missing'))
        resolve(JSON.parse(line))
      })
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write('{"completed":false,"errorCode":"REPORT_DELIVERY_E2E_TIMEOUT"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 90_000)

client.on('ready', async () => {
  try {
    const result = await execute(client)
    finished = true
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    finished = true
    process.stdout.write('{"completed":false,"errorCode":"REPORT_DELIVERY_E2E_FAILED"}\n')
    process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    client.end()
  }
})

client.on('error', () => {
  if (!finished) {
    finished = true
    process.stdout.write('{"completed":false,"errorCode":"REPORT_DELIVERY_E2E_CONNECTION_FAILED"}\n')
    clearTimeout(timeout)
    process.exitCode = 1
  }
})

client.connect(connection)
