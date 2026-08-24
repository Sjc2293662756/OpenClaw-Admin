'use strict'

const { join } = require('node:path')
const { Client } = require('ssh2')

const mode = String(process.env.GAIOP_REPORT_REGISTRY_RECONCILE_MODE || '').trim()
const releaseId = String(process.env.GAIOP_REPORT_REGISTRY_RECONCILE_RELEASE_ID || '').trim()
const connection = {
  host: String(process.env.GAIOP_REPORT_REGISTRY_RECONCILE_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_REGISTRY_RECONCILE_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_REGISTRY_RECONCILE_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!['inspect', 'repair'].includes(mode)) throw new Error('The report registry reconcile mode is unavailable.')
if (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId)) throw new Error('The report registry reconcile release ID is invalid.')
if (!connection.host || !connection.username || !connection.password) throw new Error('The controlled 237 connection is incomplete.')

function execute(client, script) {
  return new Promise((resolve) => client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) return resolve({ ok: false, output: '', errorOutput: error.message })
    let output = ''
    let errorOutput = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', (chunk) => { errorOutput += chunk.toString('utf8') })
    stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, output, errorOutput, exitCode }))
    stream.write(`${connection.password}\n${script}`)
    stream.end()
  }))
}

function remoteScript() {
  return String.raw`set -euo pipefail
admin_root='/opt/gaiop/admin'
admin_db='/var/lib/gaiop/admin/wizard.db'
reports_root='/var/lib/gaiop/reports'
mode='${mode}'
work_root="/var/tmp/gaiop-report-registry-reconcile-${releaseId}"
backup_root="/var/backups/gaiop/report-registry-reconcile-${releaseId}"
result_file="$work_root/result.json"
candidates_file="$work_root/candidates.json"
admin_was_active=0
committed=0
phase='PRECHECK'

mark() { phase="$1"; printf 'PHASE_%s\n' "$phase"; }
cleanup() { rm -rf -- "$work_root"; }
rollback() {
  status=$?
  set +e
  if [ "$admin_was_active" -eq 1 ] && ! systemctl is-active --quiet gaiop-admin.service; then
    systemctl start gaiop-admin.service >/dev/null 2>&1 || true
  fi
  cleanup
  printf 'FAILED_PHASE=%s\n' "$phase"
  exit "$status"
}
trap rollback ERR

mark PRECHECK
test -f "$admin_db"
test -d "$reports_root"
test ! -L "$reports_root"
if systemctl is-active --quiet gaiop-admin.service; then admin_was_active=1; else printf 'BLOCK_ADMIN_INACTIVE\n'; exit 41; fi
if [ "$mode" = 'repair' ] && [ -e "$backup_root" ]; then printf 'BLOCK_RELEASE_PATH_EXISTS\n'; exit 42; fi
install -d -m 0700 "$work_root"

mark SNAPSHOT
/usr/local/bin/node - "$admin_db" "$work_root/snapshot.db" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const [sourcePath, destinationPath] = process.argv.slice(2)
const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
;(async () => {
  try {
    if (source.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('live_integrity_failed')
    await source.backup(destinationPath)
    const backup = new Database(destinationPath, { readonly: true, fileMustExist: true })
    try { if (backup.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('snapshot_integrity_failed') } finally { backup.close() }
  } finally { source.close() }
})().catch((error) => { console.error(error.message); process.exit(1) })
NODE

mark CANDIDATE_SCAN
GAIOP_REPORTS_DIR="$reports_root" SNAPSHOT_DB="$work_root/snapshot.db" RESULT_FILE="$result_file" CANDIDATES_FILE="$candidates_file" /usr/local/bin/node --input-type=module - <<'NODE'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { syncGeneratedReports } from '/opt/gaiop/admin/server/routes/reports.js'
const require = createRequire(import.meta.url)
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')

const reportsRoot = path.resolve(process.env.GAIOP_REPORTS_DIR)
const snapshotDb = process.env.SNAPSHOT_DB
const resultFile = process.env.RESULT_FILE
const candidatesFile = process.env.CANDIDATES_FILE
const database = new Database(snapshotDb)

function insideRoot(relativeName) {
  const normalized = String(relativeName || '').trim().replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null
  const candidate = path.resolve(reportsRoot, ...normalized.split('/'))
  const relative = path.relative(reportsRoot, candidate)
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
    ? candidate
    : null
}

function regularNonLink(filePath) {
  try {
    const value = fs.lstatSync(filePath)
    return value.isFile() && !value.isSymbolicLink() ? value : null
  } catch { return null }
}

function rowMetadata(row, reason = null) {
  return {
    id: String(row.id || ''),
    storedName: String(row.stored_name || ''),
    auditName: String(row.audit_name || ''),
    reportType: String(row.report_type || ''),
    status: String(row.status || ''),
    size: Number(row.size || 0),
    createdAt: Number(row.created_at || 0),
    sourceChannel: row.source_channel || null,
    sourceUserId: row.source_user_id || null,
    reason,
  }
}

const beforeRows = database.prepare('SELECT * FROM report_files').all()
const beforeById = new Map(beforeRows.map((row) => [String(row.id), row]))
const beforeByStored = new Map(beforeRows.map((row) => [String(row.stored_name), row]))
syncGeneratedReports(database)
const afterRows = database.prepare('SELECT * FROM report_files').all()
const candidates = []
const rejected = []

for (const row of afterRows) {
  if (beforeById.has(String(row.id)) || beforeByStored.has(String(row.stored_name))) continue
  const reportPath = insideRoot(row.stored_name)
  const auditPath = insideRoot(row.audit_name)
  const reportStat = reportPath ? regularNonLink(reportPath) : null
  const auditStat = auditPath ? regularNonLink(auditPath) : null
  let reason = null
  if (String(row.status) !== 'ready') reason = 'sync_status_not_ready'
  else if (!reportPath || !auditPath) reason = 'path_outside_report_root'
  else if (path.dirname(reportPath) !== path.dirname(auditPath)) reason = 'pair_directory_mismatch'
  else if (!reportStat || !auditStat) reason = 'report_or_audit_not_regular'
  else if (Number(row.size) !== reportStat.size) reason = 'report_size_mismatch'
  if (reason) rejected.push(rowMetadata(row, reason))
  else candidates.push(rowMetadata(row))
}

function walkFiles(directory) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) result.push(...walkFiles(filePath))
    else if (entry.isFile()) result.push(filePath)
  }
  return result
}

const artifactFiles = walkFiles(reportsRoot)
const reportNames = new Set()
const auditNames = new Set()
const pairedReportNames = new Set()
const unregisteredPairs = []
const malformedAudits = []
let pairedAuditCount = 0
for (const auditPath of artifactFiles) {
  const auditName = path.relative(reportsRoot, auditPath).split(path.sep).join('/')
  if (auditName.split('/').includes('.delivery-events') || !auditName.toLowerCase().endsWith('.json')) continue
  auditNames.add(auditName)
  let audit
  try { audit = JSON.parse(fs.readFileSync(auditPath, 'utf8')) } catch { malformedAudits.push({ auditName, reason: 'audit_json_invalid' }); continue }
  const auditDirectory = path.posix.dirname(auditName)
  const reportId = String(audit.reportId || '').trim()
  let declared = String(audit.relativeFilePath || audit.fileName || path.basename(String(audit.filePath || '')) || '').trim().replace(/\\/g, '/')
  if (declared && !declared.includes('/') && auditDirectory !== '.') declared = auditDirectory + '/' + declared
  const reportPath = insideRoot(declared)
  const reportStat = reportPath ? regularNonLink(reportPath) : null
  if (!reportPath || !reportStat || path.posix.dirname(declared) !== auditDirectory) {
    malformedAudits.push({ auditName, reportId, reason: !reportPath ? 'audit_report_path_invalid' : 'audit_report_pair_missing' })
    continue
  }
  pairedAuditCount += 1
  pairedReportNames.add(declared)
  const row = beforeByStored.get(declared) || (reportId ? beforeById.get(reportId) : null)
  if (!row || String(row.stored_name) !== declared) {
    unregisteredPairs.push({
      reportId,
      storedName: declared,
      auditName,
      reportSize: reportStat.size,
      generatedAt: String(audit.generatedAt || ''),
      reportType: String(audit.reportType || ''),
      reason: 'pair_not_registered',
    })
  }
}
for (const filePath of artifactFiles) {
  const relativeName = path.relative(reportsRoot, filePath).split(path.sep).join('/')
  if (relativeName.split('/').includes('.delivery-events') || relativeName.toLowerCase().endsWith('.json')) continue
  reportNames.add(relativeName)
}

fs.writeFileSync(candidatesFile, JSON.stringify(candidates), { encoding: 'utf8', mode: 0o600 })
fs.writeFileSync(resultFile, JSON.stringify({
  beforeCount: beforeRows.length,
  afterCount: afterRows.length,
  candidateCount: candidates.length,
  rejectedCount: rejected.length,
  candidates,
  rejected: rejected.slice(0, 100),
  artifacts: {
    reportFileCount: reportNames.size,
    auditFileCount: auditNames.size,
    pairedAuditCount,
    registeredPairCount: pairedAuditCount - unregisteredPairs.length,
    unregisteredPairCount: unregisteredPairs.length,
    unregisteredPairs: unregisteredPairs.slice(0, 100),
    unpairedReportFileCount: [...reportNames].filter((name) => !pairedReportNames.has(name)).length,
    unpairedReportFiles: [...reportNames].filter((name) => !pairedReportNames.has(name)).slice(0, 100),
    malformedAuditCount: malformedAudits.length,
    malformedAudits: malformedAudits.slice(0, 100),
  },
}), { encoding: 'utf8', mode: 0o600 })
database.close()
NODE

result_b64=$(base64 -w 0 "$result_file")
printf 'RESULT_B64=%s\n' "$result_b64"
if [ "$mode" = 'inspect' ]; then
  mark COMPLETE
  committed=1
  cleanup
  printf 'INTEGRATION_COMPLETE\n'
  exit 0
fi
candidate_count=$(/usr/local/bin/node - "$result_file" <<'NODE'
const fs = require('node:fs')
const file = process.argv.at(-1)
process.stdout.write(String(JSON.parse(fs.readFileSync(file, 'utf8')).candidateCount))
NODE
)
if [ "$candidate_count" -eq 0 ]; then
  mark COMPLETE
  committed=1
  cleanup
  printf 'NO_SAFE_CANDIDATES\n'
  printf 'INTEGRATION_COMPLETE\n'
  exit 0
fi

mark DATABASE_BACKUP
install -d -m 0700 "$backup_root"
/usr/local/bin/node - "$admin_db" "$backup_root/wizard.db" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const [sourcePath, destinationPath] = process.argv.slice(2)
const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
;(async () => {
  try { await source.backup(destinationPath) } finally { source.close() }
  const backup = new Database(destinationPath, { readonly: true, fileMustExist: true })
  try { if (backup.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('backup_integrity_failed') } finally { backup.close() }
})().catch((error) => { console.error(error.message); process.exit(1) })
NODE
printf 'DATABASE_BACKUP_CREATED\n'

mark STOP
systemctl stop gaiop-admin.service

mark APPLY
SNAPSHOT_DB="$work_root/snapshot.db" LIVE_DB="$admin_db" CANDIDATES_FILE="$candidates_file" /usr/local/bin/node - <<'NODE'
const fs = require('node:fs')
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const snapshot = new Database(process.env.SNAPSHOT_DB, { readonly: true, fileMustExist: true })
const live = new Database(process.env.LIVE_DB, { fileMustExist: true })
try {
  const candidates = JSON.parse(fs.readFileSync(process.env.CANDIDATES_FILE, 'utf8'))
  const countBefore = Number(live.prepare('SELECT COUNT(*) AS count FROM report_files').get().count)
  const sourceRows = new Map(snapshot.prepare('SELECT * FROM report_files').all().map((row) => [String(row.id), row]))
  const existingById = live.prepare('SELECT id, stored_name FROM report_files WHERE id = ?')
  const existingByStored = live.prepare('SELECT id, stored_name FROM report_files WHERE stored_name = ?')
  const insert = live.prepare('INSERT INTO report_files ('
    + 'id, stored_name, audit_name, original_name, report_type, '
    + 'source_session_id, source_user_id, source_channel, source_channel_user_id, '
    + 'source_channel_user_name, source_message_id, source_message_preview, '
    + 'data_source_id, mime_type, size, status, created_at, updated_at '
    + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const apply = live.transaction(() => {
    for (const candidate of candidates) {
      const row = sourceRows.get(String(candidate.id))
      if (!row) throw new Error('candidate_snapshot_row_missing:' + candidate.id)
      if (existingById.get(row.id) || existingByStored.get(row.stored_name)) throw new Error('candidate_live_conflict:' + row.id)
      insert.run(
        row.id, row.stored_name, row.audit_name, row.original_name, row.report_type,
        row.source_session_id, row.source_user_id, row.source_channel, row.source_channel_user_id,
        row.source_channel_user_name, row.source_message_id, row.source_message_preview,
        row.data_source_id, row.mime_type, row.size, row.status, row.created_at, row.updated_at,
      )
    }
  })
  apply()
  const countAfter = Number(live.prepare('SELECT COUNT(*) AS count FROM report_files').get().count)
  if (countAfter - countBefore !== candidates.length) throw new Error('insert_count_mismatch')
  process.stdout.write(JSON.stringify({ inserted: candidates.length, beforeCount: countBefore, afterCount: countAfter }))
} finally { snapshot.close(); live.close() }
NODE

mark START
systemctl start gaiop-admin.service
for _ in $(seq 1 60); do systemctl is-active --quiet gaiop-admin.service && break; sleep 1; done
systemctl is-active --quiet gaiop-admin.service
committed=1
mark VERIFY
/usr/local/bin/node - "$admin_db" <<'NODE'
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true })
try { if (db.pragma('integrity_check', { simple: true }) !== 'ok') process.exit(1); process.stdout.write(String(db.prepare('SELECT COUNT(*) AS count FROM report_files').get().count)) } finally { db.close() }
NODE
printf '\nINTEGRATION_COMPLETE\n'
printf 'BACKUP_PATH=%s\n' "$backup_root"
cleanup
`
}

function parseResult(result) {
  const output = String(result.output || '')
  const encoded = output.match(/^RESULT_B64=(.+)$/m)?.[1]
  let inspection = null
  if (encoded) {
    try { inspection = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) } catch {}
  }
  return {
    completed: result.ok && /INTEGRATION_COMPLETE/.test(output),
    phase: output.match(/^FAILED_PHASE=([A-Z_]+)$/m)?.[1] || output.match(/PHASE_([A-Z_]+)/g)?.at(-1)?.replace('PHASE_', '') || 'UNKNOWN',
    backupPath: output.match(/^BACKUP_PATH=(.+)$/m)?.[1] || null,
    inspection,
    failureDiagnostic: String(result.errorOutput || '').trim().split(/\r?\n/).slice(-8).join(' | ') || null,
  }
}

async function main() {
  const client = new Client()
  const timeout = setTimeout(() => { process.stdout.write(JSON.stringify({ completed: false, errorCode: 'REPORT_REGISTRY_RECONCILE_TIMEOUT' }) + '\n'); client.end(); process.exitCode = 1 }, 180_000)
  const result = await new Promise((resolve, reject) => {
    client.once('error', reject)
    client.on('ready', async () => {
      try { resolve(parseResult(await execute(client, remoteScript()))) } catch (error) { reject(error) }
    })
    client.connect(connection)
  })
  clearTimeout(timeout)
  client.end()
  process.stdout.write(JSON.stringify(result) + '\n')
  if (!result.completed) process.exitCode = 1
}
main().catch((error) => { process.stdout.write(JSON.stringify({ completed: false, errorCode: 'REPORT_REGISTRY_RECONCILE_FAILED', message: error.message }) + '\n'); process.exitCode = 1 })
