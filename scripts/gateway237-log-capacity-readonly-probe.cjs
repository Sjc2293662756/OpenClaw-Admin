'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_LOG_CAPACITY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_LOG_CAPACITY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_LOG_CAPACITY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

const TARGET_LABELS = Object.freeze([
  'caddy_gaiop_candidate', 'caddy_legacy_candidate', 'raw_syslog', 'journal_store',
  'gateway_application_logs', 'admin_state', 'formal_reports', 'report_recovery',
  'packet_artifacts', 'upgrade_state', 'upgrade_rollback',
])
const TARGET_STATES = new Set(['present', 'missing', 'symlink', 'not_directory', 'path_redirected', 'permission_denied', 'unavailable'])
const SERVICE_STATES = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating', 'unavailable'])
const TEMPLATE_STATES = new Set(['missing', 'permission_denied', 'expected_marker_present', 'marker_absent', 'unavailable'])
const TIMER_STATES = new Set(['active', 'inactive', 'failed', 'activating', 'deactivating', 'enabled', 'disabled', 'static', 'indirect', 'masked', 'unavailable'])

const FORBIDDEN_REMOTE_CAPABILITIES = Object.freeze([
  'rm -', 'unlink', 'journalctl --vacuum', 'logrotate --force',
  'systemctl restart', 'systemctl reload', 'systemctl enable', 'systemctl start',
  'systemctl stop', 'systemctl kill',
])

// Fixed paths are intentionally private to the remote script. Its output uses
// only the stable labels above, never paths, names, content, or env values.
const remoteScript = String.raw`set -eu

hash_id() { printf '%s' "$1" | sha256sum | awk '{print "fs-" substr($1, 1, 20)}'; }
safe_int() { case "$1" in ''|*[!0-9]*) printf '0';; *) printf '%s' "$1";; esac; }
path_state() {
  target=$1
  if [ -L "$target" ]; then printf 'symlink'; return; fi
  if [ ! -e "$target" ]; then printf 'missing'; return; fi
  if [ ! -d "$target" ]; then printf 'not_directory'; return; fi
  real=$(readlink -f -- "$target" 2>/dev/null || true)
  if [ "$real" != "$target" ]; then printf 'path_redirected'; return; fi
  if [ ! -r "$target" ] || [ ! -x "$target" ]; then printf 'permission_denied'; return; fi
  printf 'present'
}
directory_summary() {
  label=$1
  target=$2
  state=$(path_state "$target")
  if [ "$state" != present ]; then printf '%s=%s|0|0|0|0|0|0|unavailable|0|0\n' "$label" "$state"; return; fi
  summary=$(find "$target" -xdev -type f -printf '%s|%T@|%f\n' 2>/dev/null | awk -F'|' '
    BEGIN { files=bytes=gzip=rotated=0; earliest=0; latest=0 }
    { files++; bytes += $1; if ($3 ~ /\.gz$/) gzip++; if ($3 ~ /\.rotated(\.gz)?$/) rotated++;
      t=int($2); if (earliest == 0 || t < earliest) earliest=t; if (t > latest) latest=t }
    END { printf "%d|%.0f|%d|%d|%d|%d", files, bytes, gzip, rotated, earliest, latest }
  ')
  set -- $(df -Pk "$target" 2>/dev/null | awk 'NR==2 {print $2, $3, $4, $5}')
  total=$(safe_int "\${1:-0}"); used=$(safe_int "\${2:-0}"); available=$(safe_int "\${3:-0}")
  use=\${4:-unknown}; use=\${use%%%}
  device=$(stat -c '%d' "$target" 2>/dev/null || printf unresolved)
  fsid=$(hash_id "$device")
  printf '%s=present|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' "$label" "$summary" "$fsid" "$total" "$used" "$available" "$use"
}
service_state() { systemctl is-active "$1" 2>/dev/null || printf unavailable; }
timer_state() {
  active=$(systemctl is-active "$1" 2>/dev/null || printf unavailable)
  enabled=$(systemctl is-enabled "$1" 2>/dev/null || printf unavailable)
  printf '%s|%s' "$active" "$enabled"
}
file_policy_state() {
  target=$1
  expected=$2
  if [ ! -f "$target" ]; then printf missing; return; fi
  if [ ! -r "$target" ]; then printf permission_denied; return; fi
  if grep -Fq "$expected" "$target" 2>/dev/null; then printf expected_marker_present; else printf marker_absent; fi
}
journal_summary() {
  unit=$1
  limit=$2
  rows=$(journalctl -u "$unit" -n "$limit" --no-pager -o short-iso 2>/dev/null || true)
  entries=$(printf '%s\n' "$rows" | sed '/^$/d' | wc -l | tr -d '[:space:]')
  errors=$(printf '%s\n' "$rows" | grep -Eic '(^|[^a-z])(error|failed|fatal)([^a-z]|$)' || true)
  latest=$(printf '%s\n' "$rows" | tail -n 1 | sed -n 's/^\([0-9][0-9T:+.-]*\).*/\1/p')
  if [ -z "$latest" ]; then latest=unavailable; fi
  printf '%s|%s|%s' "$(safe_int "$entries")" "$(safe_int "$errors")" "$latest"
}

directory_summary caddy_gaiop_candidate /var/log/gaiop/caddy
directory_summary caddy_legacy_candidate /var/log/caddy
directory_summary raw_syslog /var/log/netinside
directory_summary journal_store /var/log/journal
directory_summary gateway_application_logs /home/netinside/.openclaw/logs
directory_summary admin_state /var/lib/gaiop/admin
directory_summary formal_reports /var/lib/gaiop/reports
directory_summary report_recovery /var/lib/gaiop/report-recovery
directory_summary packet_artifacts /home/netinside/.openclaw/artifacts/openclaw-napm-packet-analysis
directory_summary upgrade_state /var/lib/gaiop-upgrade
directory_summary upgrade_rollback /var/backups/gaiop/upgrade

printf 'CADDY_SERVICE=%s\n' "$(service_state caddy)"
printf 'RSYSLOG_SERVICE=%s\n' "$(service_state rsyslog)"
printf 'JOURNALD_SERVICE=%s\n' "$(service_state systemd-journald)"
printf 'CADDY_TEMPLATE=%s\n' "$(file_policy_state /etc/caddy/gaiop-access-log.caddy 'roll_keep_for 8760h')"
printf 'SYSLOG_TEMPLATE=%s\n' "$(file_policy_state /etc/logrotate.d/gaiop-netinside-syslog 'maxage 365')"
printf 'JOURNAL_TEMPLATE=%s\n' "$(file_policy_state /etc/systemd/journald.conf.d/60-gaiop-retention.conf 'MaxRetentionSec=180day')"
printf 'BACKEND_APPLICATION_LOG_TIMER=%s\n' "$(timer_state gaiop-backend-application-log-retention.timer)"
printf 'BACKEND_PACKET_TIMER=%s\n' "$(timer_state gaiop-backend-packet-retention.timer)"
printf 'REPORT_RETENTION_TIMER=%s\n' "$(timer_state gaiop-report-retention-cleanup.timer)"
printf 'WATERMARK_TIMER=%s\n' "$(timer_state gaiop-storage-watermark-monitor.timer)"
printf 'UPGRADE_RETENTION_TIMER=%s\n' "$(timer_state gaiop-upgrade-retention-cleanup.timer)"
printf 'CADDY_JOURNAL=%s\n' "$(journal_summary caddy 120)"
printf 'RSYSLOG_JOURNAL=%s\n' "$(journal_summary rsyslog 120)"
printf 'JOURNALD_JOURNAL=%s\n' "$(journal_summary systemd-journald 120)"
`

function integer(value) {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

function enumeration(value, allowed) {
  return allowed.has(String(value || '')) ? String(value) : 'unavailable'
}

function parseDirectory(value = '') {
  const [state, fileCount, totalBytes, gzipCount, rotatedCount, earliestEpoch, latestEpoch, filesystemId, totalKb, usedKb, availableKb, usagePercent] = String(value).split('|')
  return {
    state: enumeration(state, TARGET_STATES),
    fileCount: integer(fileCount), totalBytes: integer(totalBytes), gzipCount: integer(gzipCount),
    rotatedCount: integer(rotatedCount), earliestEpoch: integer(earliestEpoch), latestEpoch: integer(latestEpoch),
    filesystemId: /^fs-[a-f0-9]{20}$/.test(filesystemId || '') ? filesystemId : 'unavailable',
    totalKb: integer(totalKb), usedKb: integer(usedKb), availableKb: integer(availableKb), usagePercent: integer(usagePercent),
  }
}

function parseTimer(value = '') {
  const [active, enabled] = String(value).split('|')
  return { active: enumeration(active, TIMER_STATES), enabled: enumeration(enabled, TIMER_STATES) }
}

function parseJournal(value = '') {
  const [entryCount, errorCount, latestTimestamp] = String(value).split('|')
  return {
    entryCount: integer(entryCount), errorCount: integer(errorCount),
    latestTimestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.test(latestTimestamp || '') ? latestTimestamp : 'unavailable',
  }
}

function parseProbe(output) {
  const values = Object.create(null)
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=([^\r\n]*)$/)
    if (match) values[match[1]] = match[2]
  }
  const targets = Object.fromEntries(TARGET_LABELS.map((label) => [label, parseDirectory(values[label.toUpperCase()])]))
  return {
    completed: true,
    policyVersion: 'gaiop_log_capacity_readonly.v1',
    targets,
    services: {
      caddy: enumeration(values.CADDY_SERVICE, SERVICE_STATES), rsyslog: enumeration(values.RSYSLOG_SERVICE, SERVICE_STATES),
      journald: enumeration(values.JOURNALD_SERVICE, SERVICE_STATES),
    },
    templateMarkers: {
      caddy: enumeration(values.CADDY_TEMPLATE, TEMPLATE_STATES), syslog: enumeration(values.SYSLOG_TEMPLATE, TEMPLATE_STATES),
      journald: enumeration(values.JOURNAL_TEMPLATE, TEMPLATE_STATES),
    },
    timers: {
      backendApplicationLog: parseTimer(values.BACKEND_APPLICATION_LOG_TIMER),
      backendPacket: parseTimer(values.BACKEND_PACKET_TIMER), reportRetention: parseTimer(values.REPORT_RETENTION_TIMER),
      watermark: parseTimer(values.WATERMARK_TIMER), upgradeRetention: parseTimer(values.UPGRADE_RETENTION_TIMER),
    },
    journalSummary: {
      caddy: parseJournal(values.CADDY_JOURNAL), rsyslog: parseJournal(values.RSYSLOG_JOURNAL),
      journald: parseJournal(values.JOURNALD_JOURNAL),
    },
  }
}

function remoteScriptIsReadOnly(script = remoteScript) {
  const normalized = String(script).toLowerCase()
  return FORBIDDEN_REMOTE_CAPABILITIES.every((token) => !normalized.includes(token))
}

function executeProbe(client) {
  return new Promise((resolve, reject) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return reject(error)
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => code === 0 ? resolve(parseProbe(output)) : reject(new Error(`exit ${code}`)))
      stream.write(`${connection.password}\n${remoteScript}`)
      stream.end()
    })
  })
}

async function main() {
  if (!connection.host || !connection.username || !connection.password) throw new Error('LOG_CAPACITY_CONNECTION_CONTEXT_INCOMPLETE')
  if (!remoteScriptIsReadOnly()) throw new Error('LOG_CAPACITY_READONLY_CONTRACT_FAILED')
  const client = new Client()
  let completed = false
  const timeout = setTimeout(() => {
    if (!completed) process.stdout.write(`${JSON.stringify({ completed: false, errorCode: 'LOG_CAPACITY_TIMEOUT' })}\n`)
    completed = true; client.end(); process.exitCode = 1
  }, 30_000)
  client.on('ready', async () => {
    try {
      const inspection = await executeProbe(client)
      completed = true; clearTimeout(timeout)
      process.stdout.write(`${JSON.stringify({ completed: true, inspection })}\n`)
    } catch {
      completed = true; clearTimeout(timeout)
      process.stdout.write('{"completed":false,"errorCode":"LOG_CAPACITY_REMOTE_FAILED"}\n')
      process.exitCode = 1
    } finally { client.end() }
  })
  client.on('error', () => {
    if (!completed) { completed = true; clearTimeout(timeout); process.stdout.write('{"completed":false,"errorCode":"LOG_CAPACITY_CONNECTION_FAILED"}\n'); process.exitCode = 1 }
  })
  client.connect(connection)
}

if (require.main === module) main().catch(() => { process.stdout.write('{"completed":false,"errorCode":"LOG_CAPACITY_STARTUP_FAILED"}\n'); process.exitCode = 1 })

module.exports = { TARGET_LABELS, FORBIDDEN_REMOTE_CAPABILITIES, remoteScript, parseProbe, remoteScriptIsReadOnly }
