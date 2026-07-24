'use strict'

const { Client } = require('ssh2')

const releaseId = String(process.env.GAIOP_REPORT_HISTORY_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_REPORT_HISTORY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_HISTORY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_HISTORY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId) || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report-history backfill inputs are incomplete.')
}

const exactMatches = [
  ['_unattributed/diagnostic_report/分析今日业务系统运行情况，排查报错和慢访问_故障分析报告_20260722_133409.json', 'agent:main:main:dm:webchat-f09dce431f724259a6bb711b4a41a148'],
  ['_unattributed/diagnostic_report/分析今日业务系统运行情况，排查报错和慢访问_故障分析报告_20260723_102153.json', 'agent:main:main:dm:webchat-e934c4047da044ffa3570da73279801a'],
  ['_unattributed/summary_report/napm_全局综述报告_20260722_133323.json', 'agent:main:main:dm:webchat-c2827cdb6fc44aca80d11335b302d12b'],
  ['_unattributed/summary_report/napm_全局综述报告_20260723_144737.json', 'agent:main:main:dm:webchat-94b54791405c4fb88dba6f0f472a58d2'],
  ['_unattributed/summary_report/napm_全局综述报告_20260724_140508.json', 'agent:main:main:dm:webchat-b77418b834564ed7bbea0906a9e6e559'],
  ['_unattributed/summary_report/napm_全局综述报告_20260724_143849.json', 'agent:main:main:dm:webchat-9570f700dcf44a3a9c7399f59fe81fc9'],
  ['_unattributed/summary_report/napm_全局综述报告_20260724_151123.json', 'agent:main:main:dm:webchat-d2ad1f0fd87343ae879a21b57926ec7b'],
  ['_unattributed/summary_report/基于AI的全流量性能分析平台_全局综述报告_20260723_140355.json', 'agent:main:main:dm:webchat-5a39597fc33545008634f245d42e3a80'],
]

function remoteScript() {
  const exactJson = JSON.stringify(exactMatches)
  return String.raw`set -euo pipefail
release_id='${releaseId}'
admin_root='/opt/gaiop/admin'
database_file=''
reports_root='/var/lib/gaiop/reports'
backup_root="/var/backups/gaiop/report-history-backfill-$release_id"
stage_root="/tmp/gaiop-report-history-backfill-$release_id"
result_file="$stage_root/result.json"
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
if ! node -e "require('$admin_root/node_modules/better-sqlite3')"; then printf 'BLOCK_DATABASE_RUNTIME_MISSING\n'; exit 47; fi
if [ -e "$backup_root" ] || [ -e "$stage_root" ]; then printf 'BLOCK_RELEASE_PATH_EXISTS\n'; exit 41; fi
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

mark MIGRATE
env \
  GAIOP_REPORT_HISTORY_DB="$database_file" \
  GAIOP_REPORT_HISTORY_ROOT="$reports_root" \
  GAIOP_REPORT_HISTORY_RESULT="$result_file" \
  GAIOP_REPORT_HISTORY_EXACT='${exactJson}' \
  node - <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')

const databaseFile = path.resolve(process.env.GAIOP_REPORT_HISTORY_DB)
const reportsRoot = path.resolve(process.env.GAIOP_REPORT_HISTORY_ROOT)
const resultFile = path.resolve(process.env.GAIOP_REPORT_HISTORY_RESULT)
const exactMatches = new Map(JSON.parse(process.env.GAIOP_REPORT_HISTORY_EXACT || '[]'))
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

const dataSources = database.prepare(
  "SELECT id, ip, description FROM data_sources WHERE is_active = 1 ORDER BY created_at DESC"
).all()
if (dataSources.length !== 1) throw new Error('expected exactly one active data source')
const dataSource = dataSources[0]
const dataSourceName = text(dataSource.description) || text(dataSource.ip)
if (!dataSourceName) throw new Error('active data source has no display name')

const users = new Map(database.prepare('SELECT id, username FROM users').all().map((row) => [row.id, row.username]))
const sessions = new Map(database.prepare(
  'SELECT session_key, owner_user_id FROM workspace_sessions'
).all().map((row) => [row.session_key, row]))
const rows = database.prepare(
  "SELECT * FROM report_files WHERE source_channel IS NULL OR source_channel = '' OR source_user_id IS NULL OR source_user_id = '' OR source_session_id IS NULL OR source_session_id = '' OR data_source_id IS NULL OR data_source_id = '' ORDER BY created_at"
).all()
if (rows.length === 0) throw new Error('no incomplete report history remains')

const updates = []
let exactCount = 0
let historicalCount = 0
let movedCount = 0

for (const row of rows) {
  const oldAuditName = String(row.audit_name || '').replace(/\\/g, '/')
  const oldStoredName = String(row.stored_name || '').replace(/\\/g, '/')
  const oldAuditPath = resolveStored(oldAuditName)
  const oldReportPath = resolveStored(oldStoredName)
  if (!fs.existsSync(oldAuditPath) || !fs.existsSync(oldReportPath)) throw new Error('report pair is missing')
  const audit = JSON.parse(fs.readFileSync(oldAuditPath, 'utf8'))
  const exactSessionKey = exactMatches.get(oldAuditName)
  let sourceUserId
  let sourceChannel
  let sourceSessionId
  let sourceChannelUserId
  let sourceChannelUserName

  if (exactSessionKey) {
    const session = sessions.get(exactSessionKey)
    if (!session || !text(session.owner_user_id)) throw new Error('verified historical session is unavailable')
    sourceUserId = session.owner_user_id
    sourceChannel = 'web'
    sourceSessionId = exactSessionKey
    sourceChannelUserId = sourceUserId
    sourceChannelUserName = text(users.get(sourceUserId)) || sourceUserId
    exactCount += 1
  } else {
    sourceUserId = text(row.source_user_id) || text(audit.sourceUserId)
    if (!sourceUserId) {
      const generatedAt = Date.parse(audit.generatedAt || '')
      sourceUserId = generatedAt >= Date.parse('2026-07-24T07:20:00Z')
        ? 'system-release-verifier'
        : '_historical_admin'
    }
    sourceChannel = 'historical_import'
    sourceSessionId = 'historical-import:' + row.id
    sourceChannelUserId = sourceUserId
    sourceChannelUserName = text(users.get(sourceUserId))
      || (sourceUserId === 'system-release-verifier' ? '237发布验收'
        : sourceUserId === '_historical_admin' ? '历史归档' : sourceUserId)
    historicalCount += 1
  }

  const reportType = text(row.report_type) || text(audit.reportType) || 'report'
  const extension = path.extname(oldStoredName)
  const targetDirectory = segment(sourceUserId, '_unattributed') + '/' + segment(reportType, 'report')
  const targetStoredName = targetDirectory + '/' + path.basename(oldStoredName)
  const targetAuditName = targetDirectory + '/' + path.basename(oldAuditName)
  const targetReportPath = resolveStored(targetStoredName)
  const targetAuditPath = resolveStored(targetAuditName)

  if (targetStoredName !== oldStoredName || targetAuditName !== oldAuditName) {
    if ((fs.existsSync(targetReportPath) && targetReportPath !== oldReportPath)
      || (fs.existsSync(targetAuditPath) && targetAuditPath !== oldAuditPath)) {
      throw new Error('report migration destination collision')
    }
    const oldDirectoryStat = fs.statSync(path.dirname(oldReportPath))
    fs.mkdirSync(path.dirname(targetReportPath), { recursive: true, mode: oldDirectoryStat.mode & 0o777 })
    try { fs.chownSync(path.dirname(targetReportPath), oldDirectoryStat.uid, oldDirectoryStat.gid) } catch {}
    fs.renameSync(oldReportPath, targetReportPath)
    movedCount += 1
  }

  Object.assign(audit, {
    sourceUserId,
    sourceSessionId,
    sourceChannel,
    sourceChannelUserId,
    sourceChannelUserName,
    dataSourceId: dataSource.id,
    relativeFilePath: targetStoredName,
    relativeAuditPath: targetAuditName,
    provenanceBackfill: exactSessionKey ? 'verified_session_match' : 'historical_archive',
  })
  const temporaryAuditPath = targetAuditPath + '.tmp'
  fs.writeFileSync(temporaryAuditPath, JSON.stringify(audit, null, 2), { mode: 0o640 })
  const oldAuditStat = fs.statSync(oldAuditPath)
  try { fs.chownSync(temporaryAuditPath, oldAuditStat.uid, oldAuditStat.gid) } catch {}
  fs.renameSync(temporaryAuditPath, targetAuditPath)
  if (targetAuditPath !== oldAuditPath) fs.rmSync(oldAuditPath, { force: true })

  updates.push({
    id: row.id,
    storedName: targetStoredName,
    auditName: targetAuditName,
    sourceUserId,
    sourceSessionId,
    sourceChannel,
    sourceChannelUserId,
    sourceChannelUserName,
    dataSourceId: dataSource.id,
  })
}

const update = database.prepare(
  'UPDATE report_files SET stored_name = @storedName, audit_name = @auditName, source_user_id = @sourceUserId, source_session_id = @sourceSessionId, source_channel = @sourceChannel, source_channel_user_id = @sourceChannelUserId, source_channel_user_name = @sourceChannelUserName, data_source_id = @dataSourceId, updated_at = @updatedAt WHERE id = @id'
)
database.transaction((items) => {
  const updatedAt = Date.now()
  for (const item of items) {
    const result = update.run({ ...item, updatedAt })
    if (result.changes !== 1) throw new Error('report database update count mismatch')
  }
})(updates)

const missing = database.prepare(
  "SELECT COUNT(*) AS count FROM report_files WHERE source_channel IS NULL OR source_channel = '' OR source_user_id IS NULL OR source_user_id = '' OR source_session_id IS NULL OR source_session_id = '' OR data_source_id IS NULL OR data_source_id = ''"
).get().count
if (missing !== 0) throw new Error('incomplete report provenance remains')
for (const item of updates) {
  const audit = JSON.parse(fs.readFileSync(resolveStored(item.auditName), 'utf8'))
  if (!text(audit.sourceChannel) || !text(audit.sourceUserId) || !text(audit.sourceSessionId) || audit.dataSourceId !== dataSource.id) {
    throw new Error('audit verification failed')
  }
}
database.close()
fs.writeFileSync(resultFile, JSON.stringify({
  updatedCount: updates.length,
  exactCount,
  historicalCount,
  movedCount,
  dataSourceId: dataSource.id,
  dataSourceName,
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
node -e "const r=require(process.argv[1]); if(r.updatedCount!==180||r.exactCount!==8||r.historicalCount!==172||r.dataSourceName!=='101.254.114.238NAPM')process.exit(1)" "$result_file"

mark COMPLETE
committed=1
printf 'BACKFILL_COMPLETE\n'
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
  let migration = null
  try { migration = resultMatch ? JSON.parse(resultMatch[1]) : null } catch {}
  return {
    completed: result.ok && /BACKFILL_COMPLETE/.test(output),
    backupCreated: /BACKUP_CREATED/.test(output),
    backupPath: output.match(/^BACKUP_PATH=(.+)$/m)?.[1] || null,
    phase: output.match(/^FAILED_PHASE=([A-Z_]+)$/m)?.[1]
      || output.match(/PHASE_([A-Z_]+)/g)?.at(-1)?.replace('PHASE_', '')
      || 'UNKNOWN',
    migration,
    errorCode: result.ok ? null : (
      output.includes('BLOCK_RELEASE_PATH_EXISTS') ? 'REPORT_HISTORY_RELEASE_PATH_EXISTS'
        : output.includes('BLOCK_INSUFFICIENT_SPACE') ? 'REPORT_HISTORY_INSUFFICIENT_SPACE'
          : output.includes('BLOCK_DATABASE_MISSING') ? 'REPORT_HISTORY_DATABASE_MISSING'
            : output.includes('BLOCK_REPORT_ROOT_MISSING') ? 'REPORT_HISTORY_ROOT_MISSING'
              : output.includes('BLOCK_DATABASE_RUNTIME_MISSING') ? 'REPORT_HISTORY_DATABASE_RUNTIME_MISSING'
                : output.includes('BLOCK_ADMIN_INACTIVE') ? 'REPORT_HISTORY_ADMIN_INACTIVE'
                  : output.includes('BLOCK_GATEWAY_INACTIVE') ? 'REPORT_HISTORY_GATEWAY_INACTIVE'
          : 'REPORT_HISTORY_BACKFILL_FAILED'
    ),
  }
}

const client = new Client()
let complete = false
const timeout = setTimeout(() => {
  if (!complete) process.stdout.write(`${JSON.stringify({ completed: false, errorCode: 'REPORT_HISTORY_BACKFILL_TIMEOUT' })}\n`)
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
  if (!complete) process.stdout.write(`${JSON.stringify({ completed: false, errorCode: 'REPORT_HISTORY_SSH_FAILED' })}\n`)
  complete = true
  clearTimeout(timeout)
  process.exitCode = 1
})
client.connect(connection)
