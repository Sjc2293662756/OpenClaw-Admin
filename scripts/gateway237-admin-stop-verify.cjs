'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ADMIN_STOP_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_STOP_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_STOP_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!connection.host || !connection.username || !connection.password) throw new Error('The controlled Admin stop connection context is incomplete.')

const script = String.raw`set -euo pipefail
systemctl stop gaiop-admin.service
if systemctl is-active --quiet gaiop-admin.service; then exit 2; fi
if ss -ltn '( sport = :3000 )' | tail -n +2 | grep -q .; then exit 3; fi
printf 'ADMIN_STOP_VERIFIED\\n'
`

function execute(client) {
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

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    process.stdout.write(`${JSON.stringify({ completed: result.ok && /ADMIN_STOP_VERIFIED/.test(result.output), status: result.ok ? 'admin-stopped-no-listener' : 'admin-stop-verification-failed' })}\n`)
    if (!result.ok) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => { process.stdout.write(`${JSON.stringify({ completed: false, status: 'ssh-connection-failed' })}\n`); process.exitCode = 1 })
client.connect(connection)
