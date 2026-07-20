'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ADMIN_INSPECT_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_INSPECT_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_INSPECT_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) throw new Error('The controlled listener inspection inputs are incomplete.')

const script = String.raw`set -euo pipefail
printf 'BINDINGS_BEGIN\n'
ss -ltnH '( sport = :3000 )' | awk '{print $4}' | sort -u
printf 'BINDINGS_END\n'
if systemctl show gaiop-admin.service -p ExecStart --value | grep -q -- '--env-file=/etc/gaiop/admin.env'; then printf 'ENVFILE_MODE=enabled\n'; else printf 'ENVFILE_MODE=absent\n'; fi
if grep -q 'server.listen(envConfig.PORT, envConfig.GAIOP_BIND_HOST' /opt/gaiop/admin/server/index.js; then printf 'SOURCE_BIND_GUARD=present\n'; else printf 'SOURCE_BIND_GUARD=absent\n'; fi
printf 'SERVICE_ACTIVE='; systemctl is-active gaiop-admin.service || true
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

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    const bindings = result.output.match(/BINDINGS_BEGIN\r?\n([\s\S]*?)BINDINGS_END/)?.[1].trim().split(/\r?\n/).filter(Boolean) || []
    const value = (key) => result.output.match(new RegExp(`^${key}=([^\\r\\n]*)`, 'm'))?.[1]?.trim() || 'unknown'
    process.stdout.write(`${JSON.stringify({ completed: result.ok, bindings, envFileMode: value('ENVFILE_MODE'), sourceBindGuard: value('SOURCE_BIND_GUARD'), service: value('SERVICE_ACTIVE') })}\n`)
    if (!result.ok) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => { process.stdout.write('{"completed":false,"status":"ssh-connection-failed"}\n'); process.exitCode = 1 })
client.connect(connection)
