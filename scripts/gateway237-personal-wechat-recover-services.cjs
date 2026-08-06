'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_WEIXIN_RECOVERY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_WEIXIN_RECOVERY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_WEIXIN_RECOVERY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) throw new Error('Recovery context is incomplete.')

const script = `set -euo pipefail
openclaw_user=$(stat -c '%U' /home/netinside/.openclaw)
openclaw_uid=$(id -u "$openclaw_user")
gateway_systemctl() {
  runuser -u "$openclaw_user" -- env HOME=/home/netinside PATH=/home/netinside/.npm-global/bin:/usr/local/bin:/usr/bin:/bin XDG_RUNTIME_DIR="/run/user/$openclaw_uid" systemctl --user "$@"
}
gateway_systemctl start openclaw-gateway.service
systemctl reset-failed gaiop-admin.service || true
systemctl start gaiop-admin.service
for _ in $(seq 1 120); do
  if gateway_systemctl is-active --quiet openclaw-gateway.service && systemctl is-active --quiet gaiop-admin.service && curl -fsS --max-time 3 http://127.0.0.1:3000/api/health >/dev/null; then
    printf 'SERVICES_RECOVERED\n'
    exit 0
  fi
  sleep 1
done
exit 72
`

const client = new Client()
client.on('ready', () => {
  client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) {
      process.stdout.write('{"completed":false,"status":"remote-start-failed"}\n')
      process.exitCode = 1
      client.end()
      return
    }
    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', () => {})
    stream.on('close', (exitCode) => {
      const completed = exitCode === 0 && output.includes('SERVICES_RECOVERED')
      process.stdout.write(`${JSON.stringify({ completed, status: completed ? 'services-recovered' : 'service-recovery-failed', remoteExitCode: exitCode })}\n`)
      if (!completed) process.exitCode = 1
      client.end()
    })
    stream.write(`${connection.password}\n${script}`)
    stream.end()
  })
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
