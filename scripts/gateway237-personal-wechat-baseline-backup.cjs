'use strict'

const { Client } = require('ssh2')

const backupId = String(process.env.GAIOP_WEIXIN_BACKUP_ID || '').trim()
const connection = {
  host: String(process.env.GAIOP_WEIXIN_BACKUP_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_WEIXIN_BACKUP_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_WEIXIN_BACKUP_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!/^personal-wechat-(?:before|after)-[0-9]{8}T[0-9]{6}Z$/.test(backupId)) {
  throw new Error('The controlled baseline backup id is invalid.')
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled baseline backup connection context is incomplete.')
}

function execSudoScript(client, script) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, exitCode: null, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (exitCode) => resolve({ ok: exitCode === 0, exitCode, output }))
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

function backupScript() {
  return `set -euo pipefail
backup_id='${backupId}'
backup_root="/var/backups/gaiop/deployments/$backup_id"
archive="$backup_root/filesystem.tar.gz"
openclaw_home='/home/netinside'
openclaw_user=$(stat -c '%U' "$openclaw_home/.openclaw")
openclaw_uid=$(id -u "$openclaw_user")
gateway_was_active=0
admin_was_active=0
gateway_stopped=0
admin_stopped=0
completed=0

gateway_systemctl() {
  runuser -u "$openclaw_user" -- env \
    HOME="$openclaw_home" \
    PATH="$openclaw_home/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    XDG_RUNTIME_DIR="/run/user/$openclaw_uid" \
    systemctl --user "$@"
}

restore_services() {
  status=$?
  if [ "$gateway_was_active" -eq 1 ] && [ "$gateway_stopped" -eq 1 ]; then
    gateway_systemctl start openclaw-gateway.service >/dev/null 2>&1 || true
  fi
  if [ "$admin_was_active" -eq 1 ] && [ "$admin_stopped" -eq 1 ]; then
    systemctl start gaiop-admin.service >/dev/null 2>&1 || true
  fi
  if [ "$completed" -eq 0 ] && [ -d "$backup_root" ]; then
    printf '%s\n' "INCOMPLETE: command exited with status $status" > "$backup_root/INCOMPLETE"
  fi
  exit "$status"
}
trap restore_services EXIT

test ! -e "$backup_root"
install -d -o root -g root -m 0700 /var/backups/gaiop/deployments
install -d -o root -g root -m 0700 "$backup_root"
printf 'creating\n' > "$backup_root/INCOMPLETE"

paths=(
  'home/netinside/.openclaw'
  'home/netinside/.npm-global/lib/node_modules/openclaw'
  'home/netinside/.npm-global/bin/openclaw'
  'home/netinside/.local/lib/gaiop-report-attribution'
  'home/netinside/gaiop-personal-wechat'
  'home/netinside/.config/systemd/user/openclaw-gateway.service'
  'home/netinside/.config/systemd/user/openclaw-gateway.service.d'
  'home/netinside/.config/systemd/user/gaiop-personal-wechat.service'
  'home/netinside/.config/systemd/user/gaiop-report-attribution.service'
  'opt/gaiop/admin'
  'var/lib/gaiop/admin'
  'var/lib/gaiop/reports'
  'var/lib/gaiop/report-attribution'
  'var/lib/gaiop/runtime/report-provenance'
  'etc/gaiop'
  'etc/systemd/system/gaiop-admin.service'
  'etc/systemd/system/gaiop-admin.service.d'
)
existing=()
source_bytes=0
for relative in "\${paths[@]}"; do
  absolute="/$relative"
  if [ -e "$absolute" ] || [ -L "$absolute" ]; then
    existing+=("$relative")
    bytes=$(du -sb -- "$absolute" | awk '{print $1}')
    source_bytes=$((source_bytes + bytes))
  fi
done
test "\${#existing[@]}" -ge 7
available_bytes=$(df -PB1 /var/backups/gaiop | awk 'NR==2 {print $4}')
required_bytes=$((source_bytes + source_bytes / 5 + 536870912))
if [ "$available_bytes" -lt "$required_bytes" ]; then
  printf 'BLOCK_INSUFFICIENT_SPACE\n'
  exit 71
fi

if gateway_systemctl is-active --quiet openclaw-gateway.service; then gateway_was_active=1; fi
if systemctl is-active --quiet gaiop-admin.service; then admin_was_active=1; fi

printf 'backup_id=%s\ncreated_utc=%s\nsource_bytes=%s\navailable_bytes_before=%s\n' \
  "$backup_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$source_bytes" "$available_bytes" > "$backup_root/manifest.txt"
printf 'openclaw_version=' >> "$backup_root/manifest.txt"
runuser -u "$openclaw_user" -- env HOME="$openclaw_home" PATH="$openclaw_home/.npm-global/bin:/usr/local/bin:/usr/bin:/bin" openclaw --version 2>/dev/null | head -n 1 >> "$backup_root/manifest.txt"
printf 'node_version=' >> "$backup_root/manifest.txt"
node --version >> "$backup_root/manifest.txt"
printf 'gateway_was_active=%s\nadmin_was_active=%s\n' "$gateway_was_active" "$admin_was_active" >> "$backup_root/manifest.txt"

for relative in "\${existing[@]}"; do
  absolute="/$relative"
  kind='file'
  [ -d "$absolute" ] && kind='directory'
  [ -L "$absolute" ] && kind='symlink'
  printf '%s\t%s\t%s\t%s\n' "$relative" "$kind" "$(stat -c '%U:%G %a' "$absolute")" "$(du -sb -- "$absolute" | awk '{print $1}')" >> "$backup_root/paths.tsv"
done

if [ "$admin_was_active" -eq 1 ]; then
  systemctl stop gaiop-admin.service
  admin_stopped=1
  ! systemctl is-active --quiet gaiop-admin.service
fi
if [ "$gateway_was_active" -eq 1 ]; then
  gateway_systemctl stop openclaw-gateway.service
  gateway_stopped=1
  ! gateway_systemctl is-active --quiet openclaw-gateway.service
fi

tar --numeric-owner --acls --xattrs -C / -czpf "$archive" -- "\${existing[@]}"
sha256sum "$archive" > "$backup_root/SHA256SUMS"

cat > "$backup_root/RESTORE.md" <<'RESTORE'
# Personal WeChat pre-change full rollback baseline

This archive restores the GAIOP Admin code/data/configuration and the complete
OpenClaw state, installed core, channel plugins, credentials, and service units
captured before the personal WeChat implementation changed production.

Restore only during a controlled rollback window. Stop \`gaiop-admin.service\`
and the \`openclaw-gateway.service\` user unit, verify \`SHA256SUMS\`, extract
\`filesystem.tar.gz\` from \`/\`, run \`systemctl daemon-reload\`, then start the
OpenClaw Gateway user unit and GAIOP Admin. Validate Gateway deep health, all
channel plugin inspections, channel status, Admin health, and public HTTPS.
RESTORE

if [ "$gateway_was_active" -eq 1 ]; then
  gateway_systemctl start openclaw-gateway.service
  gateway_stopped=0
fi
if [ "$admin_was_active" -eq 1 ]; then
  systemctl start gaiop-admin.service
  admin_stopped=0
fi

for _ in $(seq 1 90); do
  gateway_ok=1
  admin_ok=1
  if [ "$gateway_was_active" -eq 1 ]; then gateway_systemctl is-active --quiet openclaw-gateway.service || gateway_ok=0; fi
  if [ "$admin_was_active" -eq 1 ]; then
    systemctl is-active --quiet gaiop-admin.service || admin_ok=0
    curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null || admin_ok=0
  fi
  if [ "$gateway_ok" -eq 1 ] && [ "$admin_ok" -eq 1 ]; then break; fi
  sleep 1
done

[ "$gateway_was_active" -eq 0 ] || gateway_systemctl is-active --quiet openclaw-gateway.service
[ "$admin_was_active" -eq 0 ] || { systemctl is-active --quiet gaiop-admin.service && curl -fsS --max-time 5 http://127.0.0.1:3000/api/health >/dev/null; }
rm -f "$backup_root/INCOMPLETE"
completed=1
archive_bytes=$(stat -c '%s' "$archive")
printf 'BASELINE_BACKUP_COMPLETE id=%s archive_bytes=%s\n' "$backup_id" "$archive_bytes"
trap - EXIT
`
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execSudoScript(client, backupScript())
    const match = result.output.match(/BASELINE_BACKUP_COMPLETE id=([^ ]+) archive_bytes=([0-9]+)/)
    const completed = result.ok && Boolean(match)
    process.stdout.write(`${JSON.stringify({
      completed,
      status: completed ? 'baseline-backup-created' : 'baseline-backup-failed',
      backupId: completed ? match[1] : backupId,
      backupPath: completed ? `/var/backups/gaiop/deployments/${match[1]}` : null,
      archiveBytes: completed ? Number(match[2]) : null,
      remoteExitCode: result.exitCode,
    })}\n`)
    if (!completed) process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  process.stdout.write(`${JSON.stringify({ completed: false, status: 'ssh-connection-failed' })}\n`)
  process.exitCode = 1
})
client.connect(connection)
