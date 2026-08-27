'use strict'

const { Client } = require('ssh2')
const shellDollar = '$'

const connection = {
  host: String(process.env.GAIOP_RECEIVER_INSPECT_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_RECEIVER_INSPECT_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_RECEIVER_INSPECT_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) throw new Error('The controlled Receiver inspection inputs are incomplete.')

const script = String.raw`set -euo pipefail
service='gaiop-syslog-receiver.service'
service_user='${connection.username.replace(/'/g, "'\\''")}'
userctl() { uid=$(id -u "$service_user"); runuser -u "$service_user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user "$@"; }
phase=UNIT; printf 'PHASE_%s\n' "$phase"
exec_start=$(userctl show "$service" -p ExecStart --value)
workdir=$(userctl show "$service" -p WorkingDirectory --value)
state=$(userctl is-active "$service" || true)
service_pid=$(userctl show "$service" -p MainPID --value)
exec_is_receiver=$(printf '%s\n' "$exec_start" | grep -q 'openclaw-napm-syslog-receiver/scripts/run_syslog_receiver\.js' && printf yes || printf no)
target_root="$workdir/skills/openclaw-napm-syslog-receiver"
script_path="$target_root/scripts/run_syslog_receiver.js"
script_layout=$(case "$script_path" in
  */skills/openclaw-napm-syslog-receiver/scripts/run_syslog_receiver.js) printf skill-layout ;;
  */scripts/run_syslog_receiver.js) printf scripts-layout ;;
  */run_syslog_receiver.js) printf root-layout ;;
  *) printf unknown ;;
esac)
source_layout=$(test -f "$target_root/scripts/run_syslog_receiver.js" && test -f "$target_root/services/SyslogReceiverService.js" && printf yes || printf no)
http_server_present=$(test -f "$target_root/services/ReceiverHttpServer.js" && printf yes || printf no)
script_present=$(test -f "$target_root/scripts/run_syslog_receiver.js" && printf yes || printf no)
owner_matches=$(test -n "$target_root" && test "$(stat -c '%U' "$target_root" 2>/dev/null || true)" = "$service_user" && printf yes || printf no)
phase=ENVIRONMENT; printf 'PHASE_%s\n' "$phase"
env_file=$(userctl show "$service" -p EnvironmentFiles --value 2>/dev/null | grep -oE '/[^ "[:space:]]+' | head -n 1 | tr -d '"' || true)
env_source=file
if test -n "$env_file" && test -f "$env_file"; then
  set -a; . "$env_file"; set +a
else
  env_source=process
  test "$service_pid" -gt 1
  receiver_env=$(tr '\0' '\n' < "/proc/$service_pid/environ" | grep -E '^(GAIOP_ALERT_RECEIVER_PORT|GAIOP_ALERT_RECEIVER_TOKEN|GAIOP_ALERTS_DATA_DIR)=' || true)
  test -n "$receiver_env"
  while IFS= read -r assignment; do export "$assignment"; done <<< "$receiver_env"
fi
listener_port=$(ss -ltnp 2>/dev/null | awk -v pid="$service_pid" '$0 ~ ("pid=" pid ",") { address=$4; sub(/^.*:/, "", address); if (address ~ /^[0-9]+$/) { print address; exit } }' || true)
port=${shellDollar}{GAIOP_ALERT_RECEIVER_PORT:-${shellDollar}{listener_port:-19090}}
header="x-gaiop-alert-token: ${shellDollar}{GAIOP_ALERT_RECEIVER_TOKEN:-}"
data_dir=${shellDollar}{GAIOP_ALERTS_DATA_DIR:-"$target_root/data"}
history_present=$(test -f "$data_dir/alerts.jsonl" && printf yes || printf no)
phase=HEALTH; printf 'PHASE_%s\n' "$phase"
health_ok=0; alerts_ok=0
curl -fsS --max-time 5 -H "$header" "http://127.0.0.1:$port/health" | node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>process.exit(JSON.parse(b).ok?0:1))" && health_ok=1 || true
curl -fsS --max-time 5 -H "$header" "http://127.0.0.1:$port/alerts?page=1&pageSize=1" | node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>process.exit(JSON.parse(b).ok?0:1))" && alerts_ok=1 || true
listener=$( (ss -ltnH "( sport = :$port )" 2>/dev/null || true) | awk '$4 ~ /^127\.0\.0\.1:|^\[::1\]:/ { ok=1 } END { print ok ? "loopback" : "other-or-none" }')
release_artifacts=$(find "$(dirname "$target_root")" -maxdepth 1 \( -name "$(basename "$target_root").stage-*" -o -name "$(basename "$target_root").incoming-*" -o -name "$(basename "$target_root").previous-*" \) -print -quit | grep -q . && printf present || printf clean)
managed_backup=$(find /var/backups/gaiop -maxdepth 1 -type d -name 'syslog-receiver-sse-*' -print -quit 2>/dev/null | grep -q . && printf present || printf absent)
phase=RESULT; printf 'PHASE_%s\n' "$phase"
printf 'ACTIVE=%s\n' "$state"
printf 'EXEC_RECEIVER=%s\n' "$exec_is_receiver"
printf 'WORKDIR_MATCH=%s\n' "$(test "$workdir" = "$target_root" && printf yes || printf no)"
printf 'SOURCE_LAYOUT=%s\n' "$source_layout"
printf 'SCRIPT_LAYOUT=%s\n' "$script_layout"
printf 'HTTP_SERVER_PRESENT=%s\n' "$http_server_present"
printf 'SCRIPT_PRESENT=%s\n' "$script_present"
printf 'OWNER_MATCH=%s\n' "$owner_matches"
printf 'RUN_USER=%s\n' "$service_user"
printf 'SCRIPT_PATH=%s\n' "$script_path"
printf 'WORKDIR=%s\n' "$workdir"
printf 'LISTENER=%s\n' "$listener"
printf 'HEALTH=%s\n' "$health_ok"
printf 'ALERTS=%s\n' "$alerts_ok"
printf 'ENV_SOURCE=%s\n' "$env_source"
printf 'HISTORY_PRESENT=%s\n' "$history_present"
printf 'RELEASE_ARTIFACTS=%s\n' "$release_artifacts"
printf 'MANAGED_BACKUP=%s\n' "$managed_backup"
`

function execute(client) {
  return new Promise((resolve) => client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) return resolve({ ok: false, output: '' })
    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', () => {})
    stream.on('close', (code) => resolve({ ok: code === 0, output }))
    stream.write(`${connection.password}\n${script}`); stream.end()
  }))
}

const value = (output, key) => String(output).match(new RegExp(`^${key}=([^\\r\\n]*)`, 'm'))?.[1]?.trim() || 'unknown'
const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    const output = result.output || ''
    const summary = {
      completed: result.ok,
      status: result.ok ? 'receiver-inspection-complete' : 'receiver-inspection-remote-check-failed',
      failurePhase: result.ok ? null : (Array.from(String(output).matchAll(/PHASE_([A-Z_]+)/g), (match) => match[1]).at(-1) || 'UNKNOWN'),
      active: value(output, 'ACTIVE'),
      execStartIsReceiver: value(output, 'EXEC_RECEIVER') === 'yes',
      workingDirectoryMatches: value(output, 'WORKDIR_MATCH') === 'yes',
      sourceLayoutPresent: value(output, 'SOURCE_LAYOUT') === 'yes',
      scriptLayout: value(output, 'SCRIPT_LAYOUT'),
      httpServerPresent: value(output, 'HTTP_SERVER_PRESENT') === 'yes',
      scriptPresent: value(output, 'SCRIPT_PRESENT') === 'yes',
      targetOwnerMatches: value(output, 'OWNER_MATCH') === 'yes',
      runningUser: value(output, 'RUN_USER'),
      scriptPath: value(output, 'SCRIPT_PATH'),
      workingDirectory: value(output, 'WORKDIR'),
      listener: value(output, 'LISTENER'),
      health: value(output, 'HEALTH') === '1',
      alerts: value(output, 'ALERTS') === '1',
      environmentSource: value(output, 'ENV_SOURCE'),
      historyPresent: value(output, 'HISTORY_PRESENT') === 'yes',
      releaseArtifacts: value(output, 'RELEASE_ARTIFACTS'),
      managedBackupMarker: value(output, 'MANAGED_BACKUP'),
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`)
    if (!result.ok) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => { process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n'); process.exitCode = 1 })
client.connect(connection)
