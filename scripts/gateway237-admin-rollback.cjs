'use strict'

const { Client } = require('ssh2')

const releaseId = String(process.env.GAIOP_ADMIN_ROLLBACK_RELEASE_ID || '')
const connection = {
  host: String(process.env.GAIOP_ADMIN_ROLLBACK_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_ROLLBACK_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_ROLLBACK_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!/^[0-9]{8}T[0-9]{6}Z$/.test(releaseId) || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled Admin rollback inputs are incomplete.')
}

function execSudoScript(client, script) {
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

function rollbackScript() {
  return `set -euo pipefail
release_id='${releaseId}'
backup_root="/var/backups/gaiop/admin-prestage-$release_id"
previous_root="$backup_root/preexisting-admin"
current_root='/opt/gaiop/admin'
database_file='/var/lib/gaiop/admin/wizard.db'
database_backup="$backup_root/wizard.db-pre-migration"
failed_root="$backup_root/failed-release-$(date -u +%Y%m%dT%H%M%SZ)"

test -d "$previous_root"
systemctl stop gaiop-admin.service || true
if systemctl is-active --quiet gaiop-admin.service; then exit 61; fi
if [ -e "$current_root" ]; then mv -- "$current_root" "$failed_root"; fi
mv -- "$previous_root" "$current_root"
if [ -f "$database_backup" ]; then
  install -o gaiop -g gaiop -m 0640 "$database_backup" "$database_file"
fi
systemctl daemon-reload
systemctl start gaiop-admin.service
for _ in $(seq 1 120); do
  systemctl is-active --quiet gaiop-admin.service && ss -ltnH '( sport = :3000 )' | grep -q '127.0.0.1:3000' && { printf 'ROLLBACK_COMPLETE\\n'; exit 0; }
  sleep 1
done
exit 62
`
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execSudoScript(client, rollbackScript())
    const completed = result.ok && /ROLLBACK_COMPLETE/.test(result.output)
    process.stdout.write(`${JSON.stringify({ completed, status: completed ? 'admin-rollback-restored' : 'admin-rollback-failed' })}\n`)
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
