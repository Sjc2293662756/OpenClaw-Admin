'use strict'

const { Client } = require('ssh2')

const releaseId = String(process.env.GAIOP_REPORT_SOURCE_REPAIR_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_REPORT_SOURCE_REPAIR_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_SOURCE_REPAIR_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_SOURCE_REPAIR_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId) || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report-source repair inputs are incomplete.')
}

const repairs = [
  {
    auditSuffix: '20260727_104133.json',
    sourceChannel: 'wecom',
    sourceUserId: 'channel:wecom:yangs',
    sourceUserName: 'yangs',
    sourceSessionId: 'agent:main:wecom:direct:yangs',
  },
  {
    auditSuffix: '20260727_104455.json',
    sourceChannel: 'wecom',
    sourceUserId: 'channel:wecom:shijc',
    sourceUserName: 'shijc',
    sourceSessionId: 'agent:main:wecom:direct:shijc',
  },
]

function remoteScript() {
  const repairsJson = JSON.stringify(repairs)
  return String.raw`set -euo pipefail
release_id='${releaseId}'
admin_root='/opt/gaiop/admin'
reports_root='/var/lib/gaiop/reports'
backup_root="/var/backups/gaiop/report-source-repair-$release_id"
stage_root="/tmp/gaiop-report-source-repair-$release_id"
result_file="$stage_root/result.json"
database_file=''
admin_was_active=0
gateway_was_active=0
committed=0
phase='PRECHECK'

gatewayctl() { sudo -u netinside XDG_RUNTIME_DIR=/run/user/$(id -u netinside) systemctl --user "$@"; }
mark() { phase="$1"; printf 'PHASE_%s\n' "$phase"; }

rollback() {
  status=$?
  if [ "$committed" -eq 0 ] && [ -d "$backup_root" ]; then
    systemctl stop gaiop-admin.service >/dev/null 2>&1 || true
    gatewayctl stop openclaw-gateway.service >/dev/null 2>&1 || true
    if [ -f "$backup_root/wizard.db" ]; then
      install -o gaiop -g gaiop -m 0640 "$backup_root/wizard.db" "$database_file"
      rm -f -- "$database_file-wal" "$database_file-shm"
    fi
    if [ -d "$backup_root/reports" ]; then
      if [ -d "$reports_root" ]; then mv -- "$reports_root" "$stage_root.failed-reports" || true; fi
      cp -a -- "$backup_root/reports" "$reports_root"
    fi
  fi
  if [ "$gateway_was_active" -eq 1 ]; then gatewayctl start openclaw-gateway.service >/dev/null 2>&1 || true; fi
  if [ "$admin_was_active" -eq 1 ]; then systemctl start gaiop-admin.service >/dev/null 2>&1 || true; fi
  printf 'FAILED_PHASE=%s\n' "$phase"
  exit "$status"
}
trap rollback ERR

mark PRECHECK
admin_pid=$(systemctl show gaiop-admin.service --property=MainPID --value)
admin_data_dir=$(tr '\0' '\n' < "/proc/$admin_pid/environ" | sed -n 's/^GAIOP_ADMIN_DATA_DIR=//p' | head -n 1)
if [ -z "$admin_data_dir" ]; then admin_data_dir="$admin_root/data"; fi
database_file="$admin_data_dir/wizard.db"
if [ ! -f "$database_file" ]; then printf 'BLOCK_DATABASE_MISSING\n'; exit 45; fi
if [ ! -d "$reports_root" ]; then printf 'BLOCK_REPORT_ROOT_MISSING\n'; exit 46; fi
if [ -e "$backup_root" ] || [ -e "$stage_root" ]; then printf 'BLOCK_RELEASE_PATH_EXISTS\n'; exit 41; fi
if ! node -e "require('$admin_root/node_modules/better-sqlite3')"; then printf 'BLOCK_DATABASE_RUNTIME_MISSING\n'; exit 47; fi
if systemctl is-active --quiet gaiop-admin.service; then admin_was_active=1; else printf 'BLOCK_ADMIN_INACTIVE\n'; exit 42; fi
if gatewayctl is-active --quiet openclaw-gateway.service; then gateway_was_active=1; else printf 'BLOCK_GATEWAY_INACTIVE\n'; exit 43; fi
required_kb=$(( $(du -sk "$reports_root" "$database_file" | awk '{ total += $1 } END { print total }') + 16384 ))
available_kb=$(df -Pk /var/backups/gaiop | awk 'NR == 2 { print $4 }')
if [ -z "$available_kb" ] || [ "$available_kb" -lt "$required_kb" ]; then printf 'BLOCK_INSUFFICIENT_SPACE\n'; exit 44; fi
install -d -m 0700 "$backup_root" "$stage_root"

mark STOP
gatewayctl stop openclaw-gateway.service
systemctl stop gaiop-admin.service

mark BACKUP
cp -a -- "$database_file" "$backup_root/wizard.db"
cp -a -- "$reports_root" "$backup_root/reports"
printf 'BACKUP_CREATED\n'

mark REPAIR
env \
  GAIOP_REPORT_SOURCE_REPAIR_DB="$database_file" \
  GAIOP_REPORT_SOURCE_REPAIR_ROOT="$reports_root" \
  GAIOP_REPORT_SOURCE_REPAIR_RESULT="$result_file" \
  GAIOP_REPORT_SOURCE_REPAIR_TARGETS='${repairsJson}' \
  node - <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')

const databaseFile = path.resolve(process.env.GAIOP_REPORT_SOURCE_REPAIR_DB)
const reportsRoot = path.resolve(process.env.GAIOP_REPORT_SOURCE_REPAIR_ROOT)
const resultFile = path.resolve(process.env.GAIOP_REPORT_SOURCE_REPAIR_RESULT)
const targets = JSON.parse(process.env.GAIOP_REPORT_SOURCE_REPAIR_TARGETS || '[]')
const database = new Database(databaseFile)
database.pragma('foreign_keys = ON')
database.pragma('journal_mode = DELETE')

function text(value) {
  const normalized = String(value || '').trim()
  return normalized || null
}

function segment(value, fallback) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/\x00-\x1f]/.test(normalized)) return fallback
  return normalized.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 160) || fallback
}

function resolveStored(storedName) {
  const normalized = String(storedName || '').trim().replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/')) throw new Error('invalid stored report path')
  const target = path.resolve(reportsRoot, ...normalized.split('/'))
  if (!target.startsWith(reportsRoot + path.sep)) throw new Error('report path escapes root')
  return target
}

const activeSources = database.prepare(
  'SELECT id, ip, description FROM data_sources WHERE is_active = 1 ORDER BY created_at DESC'
).all()
if (activeSources.length !== 1) throw new Error('expected exactly one active data source')
const dataSource = activeSources[0]
const dataSourceName = text(dataSource.description) || text(dataSource.ip)
if (!dataSourceName) throw new Error('active data source has no display name')

const rows = database.prepare('SELECT * FROM report_files ORDER BY created_at').all()
const updates = []
for (const target of targets) {
  const matches = rows.filter((row) => String(row.audit_name || '').endsWith(target.auditSuffix))
  if (matches.length !== 1) throw new Error('target report is not unique: ' + target.auditSuffix)
  const row = matches[0]
  const oldAuditName = String(row.audit_name || '').replace(/\\/g, '/')
  const oldStoredName = String(row.stored_name || '').replace(/\\/g, '/')
  const oldAuditPath = resolveStored(oldAuditName)
  const oldReportPath = resolveStored(oldStoredName)
  if (!fs.existsSync(oldAuditPath) || !fs.existsSync(oldReportPath)) throw new Error('target report pair is missing')
  const audit = JSON.parse(fs.readFileSync(oldAuditPath, 'utf8'))
  if (text(row.source_channel) || text(row.source_user_id) || text(row.source_session_id)) {
    throw new Error('target report already has source provenance')
  }

  const reportType = text(row.report_type) || text(audit.reportType) || 'report'
  const targetDirectory = segment(target.sourceUserId, '_unattributed') + '/' + segment(reportType, 'report')
  const targetStoredName = targetDirectory + '/' + path.basename(oldStoredName)
  const targetAuditName = targetDirectory + '/' + path.basename(oldAuditName)
  const targetReportPath = resolveStored(targetStoredName)
  const targetAuditPath = resolveStored(targetAuditName)
  if (fs.existsSync(targetReportPath) || fs.existsSync(targetAuditPath)) throw new Error('repair destination collision')

  const oldDirectoryStat = fs.statSync(path.dirname(oldReportPath))
  fs.mkdirSync(path.dirname(targetReportPath), { recursive: true, mode: oldDirectoryStat.mode & 0o777 })
  try { fs.chownSync(path.dirname(targetReportPath), oldDirectoryStat.uid, oldDirectoryStat.gid) } catch {}
  fs.renameSync(oldReportPath, targetReportPath)

  Object.assign(audit, {
    sourceChannel: target.sourceChannel,
    sourceUserId: target.sourceUserId,
    sourceSessionId: target.sourceSessionId,
    sourceChannelUserId: target.sourceUserId.replace(/^channel:[^:]+:/, ''),
    sourceChannelUserName: target.sourceUserName,
    dataSourceId: dataSource.id,
    relativeFilePath: targetStoredName,
    relativeAuditPath: targetAuditName,
    provenanceBackfill: 'verified_session_match',
  })
  const temporaryAuditPath = targetAuditPath + '.tmp'
  const oldAuditStat = fs.statSync(oldAuditPath)
  fs.writeFileSync(temporaryAuditPath, JSON.stringify(audit, null, 2), { mode: 0o640 })
  try { fs.chownSync(temporaryAuditPath, oldAuditStat.uid, oldAuditStat.gid) } catch {}
  fs.renameSync(temporaryAuditPath, targetAuditPath)
  fs.rmSync(oldAuditPath, { force: true })

  updates.push({
    id: row.id,
    storedName: targetStoredName,
    auditName: targetAuditName,
    sourceChannel: target.sourceChannel,
    sourceUserId: target.sourceUserId,
    sourceSessionId: target.sourceSessionId,
    sourceChannelUserId: target.sourceUserId.replace(/^channel:[^:]+:/, ''),
    sourceChannelUserName: target.sourceUserName,
    dataSourceId: dataSource.id,
  })
}

const update = database.prepare(
  'UPDATE report_files SET stored_name = @storedName, audit_name = @auditName, source_channel = @sourceChannel, source_user_id = @sourceUserId, source_session_id = @sourceSessionId, source_channel_user_id = @sourceChannelUserId, source_channel_user_name = @sourceChannelUserName, data_source_id = @dataSourceId, updated_at = @updatedAt WHERE id = @id'
)
database.transaction((items) => {
  const updatedAt = Date.now()
  for (const item of items) {
    const result = update.run({ ...item, updatedAt })
    if (result.changes !== 1) throw new Error('report database update count mismatch')
  }
})(updates)

for (const item of updates) {
  const row = database.prepare('SELECT * FROM report_files WHERE id = ?').get(item.id)
  const audit = JSON.parse(fs.readFileSync(resolveStored(item.auditName), 'utf8'))
  if (row.source_channel !== item.sourceChannel
    || row.source_user_id !== item.sourceUserId
    || row.source_session_id !== item.sourceSessionId
    || row.data_source_id !== dataSource.id
    || audit.sourceSessionId !== item.sourceSessionId
    || audit.dataSourceId !== dataSource.id) {
    throw new Error('report source repair verification failed')
  }
}
database.close()
fs.writeFileSync(resultFile, JSON.stringify({
  updatedCount: updates.length,
  dataSourceId: dataSource.id,
  dataSourceName,
  reports: updates.map((item) => ({
    sourceChannel: item.sourceChannel,
    sourceUserId: item.sourceUserId,
    sourceSessionId: item.sourceSessionId,
  })),
}), { mode: 0o600 })
NODE

mark START
gatewayctl start openclaw-gateway.service
systemctl start gaiop-admin.service

mark VERIFY
for _ in $(seq 1 60); do
  if systemctl is-active --quiet gaiop-admin.service && gatewayctl is-active --quiet openclaw-gateway.service; then break; fi
  sleep 1
done
systemctl is-active --quiet gaiop-admin.service
gatewayctl is-active --quiet openclaw-gateway.service
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null; then break; fi
  sleep 1
done
curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null
node -e "const r=require(process.argv[1]); if(r.updatedCount!==2||r.dataSourceName!=='101.254.114.238NAPM')process.exit(1)" "$result_file"

mark COMPLETE
committed=1
printf 'SOURCE_REPAIR_COMPLETE\n'
printf 'BACKUP_PATH=%s\n' "$backup_root"
cat "$result_file"
rm -rf -- "$stage_root"
`
}

function execute(client, script) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, output }))
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

function summarize(result) {
  const output = String(result.output || '')
  const resultMatch = output.match(/(\{"updatedCount":[^\r\n]+\})/)
  let repair = null
  try { repair = resultMatch ? JSON.parse(resultMatch[1]) : null } catch {}
  return {
    completed: result.ok && /SOURCE_REPAIR_COMPLETE/.test(output),
    backupCreated: /BACKUP_CREATED/.test(output),
    backupPath: output.match(/^BACKUP_PATH=(.+)$/m)?.[1] || null,
    phase: output.match(/^FAILED_PHASE=([A-Z_]+)$/m)?.[1]
      || output.match(/PHASE_([A-Z_]+)/g)?.at(-1)?.replace('PHASE_', '')
      || 'UNKNOWN',
    repair,
    errorCode: result.ok ? null : (
      output.includes('BLOCK_RELEASE_PATH_EXISTS') ? 'REPORT_SOURCE_REPAIR_RELEASE_PATH_EXISTS'
        : output.includes('BLOCK_INSUFFICIENT_SPACE') ? 'REPORT_SOURCE_REPAIR_INSUFFICIENT_SPACE'
          : output.includes('BLOCK_DATABASE_MISSING') ? 'REPORT_SOURCE_REPAIR_DATABASE_MISSING'
            : output.includes('BLOCK_REPORT_ROOT_MISSING') ? 'REPORT_SOURCE_REPAIR_ROOT_MISSING'
              : output.includes('BLOCK_DATABASE_RUNTIME_MISSING') ? 'REPORT_SOURCE_REPAIR_DATABASE_RUNTIME_MISSING'
                : output.includes('BLOCK_ADMIN_INACTIVE') ? 'REPORT_SOURCE_REPAIR_ADMIN_INACTIVE'
                  : output.includes('BLOCK_GATEWAY_INACTIVE') ? 'REPORT_SOURCE_REPAIR_GATEWAY_INACTIVE'
                    : 'REPORT_SOURCE_REPAIR_FAILED'
    ),
  }
}

const client = new Client()
let complete = false
const timeout = setTimeout(() => {
  if (!complete) process.stdout.write(`${JSON.stringify({ completed: false, errorCode: 'REPORT_SOURCE_REPAIR_TIMEOUT' })}\n`)
  complete = true
  client.end()
  process.exitCode = 1
}, 180_000)

client.on('ready', async () => {
  try {
    const result = await execute(client, remoteScript())
    complete = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify(summarize(result))}\n`)
    if (!result.ok) process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  if (!complete) process.stdout.write(`${JSON.stringify({ completed: false, errorCode: 'REPORT_SOURCE_REPAIR_SSH_FAILED' })}\n`)
  complete = true
  clearTimeout(timeout)
  process.exitCode = 1
})
client.connect(connection)
