'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_REPORT_INSPECT_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_INSPECT_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_INSPECT_SSH_PASSWORD || ''),
  readyTimeout: 15_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report-storage inspection connection context is incomplete.')
}

// This command deliberately reports only status flags and counts. It never
// prints environment-file values, report names, report content, or credentials.
const reportStorageInspection = String.raw`set -eu
reports_dir=/var/lib/gaiop/reports
expected_dir=/var/lib/gaiop/reports
legacy_reports_dir=/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/output
report_storage_service=/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/services/ReportStorageService.js
report_generation_service=/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/services/ReportGenerationService.js

env_state() {
  env_file=$1
  if [ ! -r "$env_file" ]; then printf 'unreadable'; return; fi
  node --env-file="$env_file" -e '
    const expected = process.argv[1]
    const value = process.env.GAIOP_REPORTS_DIR
    process.stdout.write(!value ? "missing" : value === expected ? "expected" : "custom")
  ' "$expected_dir" 2>/dev/null || printf 'unreadable'
}

directory_state=missing
gaiop_access=unavailable
gateway_service_access=unavailable
file_count=0
audit_count=0
paired_count=0
legacy_directory_state=missing
legacy_file_count=0
legacy_audit_count=0
legacy_paired_count=0
runtime_report_contract=missing
runtime_audit_contract=missing
acl_support=unavailable
report_runtime_dependencies=unavailable
gateway_reports_override=missing
admin_reports_route=missing
admin_reports_endpoint=unavailable
admin_reports_error=none
admin_report_schema=unavailable
admin_report_migration=missing
admin_report_list_failure=none
admin_report_sync_probe=unavailable

if [ -d "$reports_dir" ]; then
  directory_state=present
  if sudo -u gaiop test -r "$reports_dir" && sudo -u gaiop test -x "$reports_dir"; then
    if sudo -u gaiop test -w "$reports_dir"; then gaiop_access=read-write; else gaiop_access=read-only; fi
  else
    gaiop_access=unreadable
  fi
  if sudo -u netinside test -r "$reports_dir" && sudo -u netinside test -x "$reports_dir"; then
    if sudo -u netinside test -w "$reports_dir"; then gateway_service_access=read-write; else gateway_service_access=read-only; fi
  else
    gateway_service_access=unreadable
  fi
  file_count=$(find "$reports_dir" -type f 2>/dev/null | wc -l | tr -d '[:space:]')
  audit_count=$(find "$reports_dir" -type f -name '*.json' 2>/dev/null | wc -l | tr -d '[:space:]')
  while IFS= read -r -d '' audit; do
    stem=$(printf '%s' "$audit" | sed 's/\.json$//')
    if [ -f "$stem.docx" ] || [ -f "$stem.pdf" ] || [ -f "$stem.xlsx" ] || [ -f "$stem.csv" ] || [ -f "$stem.md" ] || [ -f "$stem.txt" ]; then
      paired_count=$((paired_count + 1))
    fi
  done < <(find "$reports_dir" -type f -name '*.json' -print0 2>/dev/null)
fi

if [ -d "$legacy_reports_dir" ]; then
  legacy_directory_state=present
  legacy_file_count=$(find "$legacy_reports_dir" -type f 2>/dev/null | wc -l | tr -d '[:space:]')
  legacy_audit_count=$(find "$legacy_reports_dir" -type f -name '*.json' 2>/dev/null | wc -l | tr -d '[:space:]')
  while IFS= read -r -d '' audit; do
    stem=$(printf '%s' "$audit" | sed 's/\.json$//')
    if [ -f "$stem.docx" ] || [ -f "$stem.pdf" ] || [ -f "$stem.xlsx" ] || [ -f "$stem.csv" ] || [ -f "$stem.md" ] || [ -f "$stem.txt" ]; then
      legacy_paired_count=$((legacy_paired_count + 1))
    fi
  done < <(find "$legacy_reports_dir" -type f -name '*.json' -print0 2>/dev/null)
fi

if [ -f "$report_storage_service" ]; then
  if grep -Fq 'GAIOP_REPORTS_DIR' "$report_storage_service"; then runtime_report_contract=contract-aware; else runtime_report_contract=legacy-only; fi
fi
if [ -f "$report_generation_service" ]; then
  if grep -Fq 'relativeFilePath' "$report_generation_service" && grep -Fq 'relativeAuditPath' "$report_generation_service"; then runtime_audit_contract=contract-aware; else runtime_audit_contract=legacy-only; fi
fi
if command -v setfacl >/dev/null 2>&1 && command -v getfacl >/dev/null 2>&1; then acl_support=available; else acl_support=unavailable; fi
if sudo -u netinside node -e "require('/home/netinside/.openclaw/workspace/skills/openclaw-napm-report/services/ReportGenerationService.js')" >/dev/null 2>&1; then report_runtime_dependencies=available; fi
if [ -f /home/netinside/.config/systemd/user/openclaw-gateway.service.d/90-gaiop-reports.conf ] && grep -Fxq 'Environment=GAIOP_REPORTS_DIR=/var/lib/gaiop/reports' /home/netinside/.config/systemd/user/openclaw-gateway.service.d/90-gaiop-reports.conf; then gateway_reports_override=expected; fi
if grep -Fq "app.use('/api/reports'" /opt/gaiop/admin/server/index.js 2>/dev/null; then admin_reports_route=present; fi
if grep -Fq 'ALTER TABLE report_files ADD COLUMN audit_name' /opt/gaiop/admin/server/database.js 2>/dev/null; then admin_report_migration=present; fi
admin_reports_endpoint=$(node - <<'NODE'
const http = require('node:http');
const request = http.get('http://127.0.0.1:3000/api/reports', { timeout: 5000 }, (response) => {
  response.resume();
  response.on('end', () => {
    const type = String(response.headers['content-type'] || '').toLowerCase();
    process.stdout.write(type.includes('application/json') ? 'json' : 'non-json');
  });
});
request.on('timeout', () => { request.destroy(); process.stdout.write('timeout'); });
request.on('error', () => process.stdout.write('unavailable'));
NODE
)
if journalctl -u gaiop-admin.service -n 300 --no-pager 2>/dev/null | grep -Eqi 'report_files.*(no such|has no column)|SQLITE.*report|REPORT_.*(FAILED|ERROR)|/api/reports.*(error|fail)'; then admin_reports_error=reported; fi
if journalctl -u gaiop-admin.service -n 300 --no-pager 2>/dev/null | grep -Fq '[Reports] Failed to load report list:'; then
  report_log=$(journalctl -u gaiop-admin.service -n 300 --no-pager 2>/dev/null | grep -F '[Reports] Failed to load report list:' | tail -n 1)
  if printf '%s' "$report_log" | grep -Eqi 'SQLITE|database|no such table|no such column|constraint'; then admin_report_list_failure=sqlite
  elif printf '%s' "$report_log" | grep -Eqi 'EACCES|EPERM|permission|access denied'; then admin_report_list_failure=permission
  elif printf '%s' "$report_log" | grep -Eqi 'ENOENT|not found|no such file'; then admin_report_list_failure=file
  else admin_report_list_failure=runtime
  fi
fi
admin_pid=$(systemctl show gaiop-admin.service --property=MainPID --value 2>/dev/null || true)
admin_data_dir=
if [ -n "$admin_pid" ] && [ "$admin_pid" != 0 ]; then
  admin_data_dir=$(sudo sh -c "tr '\\0' '\\n' < /proc/$admin_pid/environ" 2>/dev/null | sed -n 's/^GAIOP_ADMIN_DATA_DIR=//p' | head -n 1)
fi
if [ -z "$admin_data_dir" ]; then
  admin_data_dir=$(find /var/lib/gaiop -maxdepth 3 -type f -name wizard.db -printf '%h\n' 2>/dev/null | head -n 1)
fi
if [ -z "$admin_data_dir" ]; then admin_data_dir=/opt/gaiop/admin/data; fi
admin_db="$admin_data_dir/wizard.db"
if [ -r "$admin_db" ] && sudo -u gaiop node - "$admin_db" <<'NODE' >/tmp/gaiop-report-schema-state 2>/dev/null
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3');
const db = new Database(process.argv[2], { readonly: true });
const columns = new Set(db.prepare('PRAGMA table_info(report_files)').all().map((row) => row.name));
const expected = ['id', 'stored_name', 'audit_name', 'original_name', 'report_type', 'source_session_id', 'source_user_id', 'data_source_id', 'mime_type', 'size', 'status', 'created_at', 'updated_at'];
process.stdout.write(expected.every((name) => columns.has(name)) ? 'complete' : 'incomplete');
NODE
then
  admin_report_schema=$(cat /tmp/gaiop-report-schema-state 2>/dev/null || printf 'unavailable')
  rm -f /tmp/gaiop-report-schema-state
fi
if sudo -u gaiop env GAIOP_REPORTS_DIR="$reports_dir" node --input-type=module - <<'NODE' >/dev/null 2>&1
const { __test__ } = await import('/opt/gaiop/admin/server/routes/reports.js');
const db = { prepare(sql) {
  if (!String(sql).includes('INSERT INTO report_files')) throw new Error('unexpected probe query');
  return { run() {} };
} };
__test__.syncGeneratedReports(db);
NODE
then
  admin_report_sync_probe=passed
else
  admin_report_sync_probe=failed
fi

printf 'ADMIN_REPORTS_DIR=%s\n' "$(env_state /etc/gaiop/admin.env)"
printf 'GATEWAY_REPORTS_DIR=%s\n' "$(env_state /etc/gaiop/gateway.env)"
printf 'REPORTS_DIRECTORY=%s\n' "$directory_state"
printf 'GAIOP_SERVICE_ACCESS=%s\n' "$gaiop_access"
printf 'GATEWAY_SERVICE_ACCESS=%s\n' "$gateway_service_access"
printf 'REPORT_FILE_COUNT=%s\n' "$file_count"
printf 'AUDIT_JSON_COUNT=%s\n' "$audit_count"
printf 'PAIRED_REPORT_COUNT=%s\n' "$paired_count"
printf 'LEGACY_REPORTS_DIRECTORY=%s\n' "$legacy_directory_state"
printf 'LEGACY_REPORT_FILE_COUNT=%s\n' "$legacy_file_count"
printf 'LEGACY_AUDIT_JSON_COUNT=%s\n' "$legacy_audit_count"
printf 'LEGACY_PAIRED_REPORT_COUNT=%s\n' "$legacy_paired_count"
printf 'RUNTIME_REPORT_CONTRACT=%s\n' "$runtime_report_contract"
printf 'RUNTIME_AUDIT_CONTRACT=%s\n' "$runtime_audit_contract"
printf 'ACL_SUPPORT=%s\n' "$acl_support"
printf 'REPORT_RUNTIME_DEPENDENCIES=%s\n' "$report_runtime_dependencies"
printf 'GATEWAY_REPORTS_OVERRIDE=%s\n' "$gateway_reports_override"
printf 'ADMIN_REPORTS_ROUTE=%s\n' "$admin_reports_route"
printf 'ADMIN_REPORTS_ENDPOINT=%s\n' "$admin_reports_endpoint"
printf 'ADMIN_REPORTS_ERROR=%s\n' "$admin_reports_error"
printf 'ADMIN_REPORT_SCHEMA=%s\n' "$admin_report_schema"
printf 'ADMIN_REPORT_MIGRATION=%s\n' "$admin_report_migration"
printf 'ADMIN_REPORT_LIST_FAILURE=%s\n' "$admin_report_list_failure"
printf 'ADMIN_REPORT_SYNC_PROBE=%s\n' "$admin_report_sync_probe"
printf 'ADMIN_SERVICE=%s\n' "$(systemctl is-active gaiop-admin.service 2>/dev/null || true)"
printf 'ISO_GATEWAY_SERVICE=%s\n' "$(systemctl is-active gaiop-gateway.service 2>/dev/null || true)"
printf 'OPENCLAW_GATEWAY_SERVICE=%s\n' "$(sudo -u netinside XDG_RUNTIME_DIR=/run/user/$(id -u netinside) systemctl --user is-active openclaw-gateway.service 2>/dev/null || true)"
`

function parseInspection(output) {
  const values = Object.create(null)
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=([a-z0-9-]+)$/i)
    if (match) values[match[1]] = match[2]
  }
  return {
    adminReportsDirectory: values.ADMIN_REPORTS_DIR || 'unavailable',
    gatewayReportsDirectory: values.GATEWAY_REPORTS_DIR || 'unavailable',
    reportsDirectory: values.REPORTS_DIRECTORY || 'unavailable',
    gaiopServiceAccess: values.GAIOP_SERVICE_ACCESS || 'unavailable',
    gatewayServiceAccess: values.GATEWAY_SERVICE_ACCESS || 'unavailable',
    reportFileCount: Number(values.REPORT_FILE_COUNT || 0),
    auditJsonCount: Number(values.AUDIT_JSON_COUNT || 0),
    pairedReportCount: Number(values.PAIRED_REPORT_COUNT || 0),
    legacyReportsDirectory: values.LEGACY_REPORTS_DIRECTORY || 'unavailable',
    legacyReportFileCount: Number(values.LEGACY_REPORT_FILE_COUNT || 0),
    legacyAuditJsonCount: Number(values.LEGACY_AUDIT_JSON_COUNT || 0),
    legacyPairedReportCount: Number(values.LEGACY_PAIRED_REPORT_COUNT || 0),
    runtimeReportContract: values.RUNTIME_REPORT_CONTRACT || 'unavailable',
    runtimeAuditContract: values.RUNTIME_AUDIT_CONTRACT || 'unavailable',
    aclSupport: values.ACL_SUPPORT || 'unavailable',
    reportRuntimeDependencies: values.REPORT_RUNTIME_DEPENDENCIES || 'unavailable',
    gatewayReportsOverride: values.GATEWAY_REPORTS_OVERRIDE || 'unavailable',
    adminReportsRoute: values.ADMIN_REPORTS_ROUTE || 'unavailable',
    adminReportsEndpoint: values.ADMIN_REPORTS_ENDPOINT || 'unavailable',
    adminReportsError: values.ADMIN_REPORTS_ERROR || 'unavailable',
    adminReportSchema: values.ADMIN_REPORT_SCHEMA || 'unavailable',
    adminReportMigration: values.ADMIN_REPORT_MIGRATION || 'unavailable',
    adminReportListFailure: values.ADMIN_REPORT_LIST_FAILURE || 'unavailable',
    adminReportSyncProbe: values.ADMIN_REPORT_SYNC_PROBE || 'unavailable',
    adminService: values.ADMIN_SERVICE || 'unavailable',
    isoGatewayService: values.ISO_GATEWAY_SERVICE || 'unavailable',
    openclawGatewayService: values.OPENCLAW_GATEWAY_SERVICE || 'unavailable',
  }
}

function executeInspection(client) {
  return new Promise((resolve, reject) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) {
        reject(error)
        return
      }
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => {
        if (exitCode !== 0) {
          reject(new Error(`Remote report-storage inspection exited with code ${exitCode}.`))
          return
        }
        resolve(parseInspection(output))
      })
      stream.write(`${connection.password}\n`)
      stream.write(reportStorageInspection)
      stream.end()
    })
  })
}

const client = new Client()
let complete = false
const timeout = setTimeout(() => {
  if (!complete) process.stdout.write(`${JSON.stringify({ ok: false, errorCode: 'REPORT_STORAGE_INSPECTION_TIMEOUT' })}\n`)
  complete = true
  client.end()
  process.exitCode = 1
}, 30_000)

client.on('ready', async () => {
  try {
    const inspection = await executeInspection(client)
    complete = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify({ ok: true, inspection })}\n`)
    client.end()
  } catch (error) {
    complete = true
    clearTimeout(timeout)
    const message = String(error?.message || '')
    const exitCode = message.match(/code (\d+)/)?.[1] || null
    process.stdout.write(`${JSON.stringify({ ok: false, errorCode: exitCode ? `REPORT_STORAGE_REMOTE_EXIT_${exitCode}` : 'REPORT_STORAGE_INSPECTION_FAILED' })}\n`)
    client.end()
    process.exitCode = 1
  }
})

client.on('error', () => {
  if (complete) return
  complete = true
  clearTimeout(timeout)
  process.stdout.write(`${JSON.stringify({ ok: false, errorCode: 'REPORT_STORAGE_CONNECTION_FAILED' })}\n`)
  process.exitCode = 1
})

client.connect(connection)
