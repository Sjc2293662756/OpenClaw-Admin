'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ADMIN_DIAG_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_DIAG_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_DIAG_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled Admin diagnostic connection context is incomplete.')
}

const script = String.raw`set -euo pipefail
log=$(mktemp)
trap 'rm -f -- "$log"' EXIT
journalctl -u gaiop-admin.service -n 240 --no-pager > "$log" 2>/dev/null || true
printf 'SERVICE_ACTIVE='; systemctl is-active gaiop-admin.service || true
printf 'SERVICE_RESULT='; systemctl show gaiop-admin.service -p Result --value || true
printf 'SERVICE_EXIT='; systemctl show gaiop-admin.service -p ExecMainStatus --value || true
if grep -Eqi 'Cannot find module|MODULE_NOT_FOUND' "$log"; then printf 'DIAGNOSTIC=missing-module\n'
elif grep -Eqi 'SyntaxError|Unexpected token|Invalid or unexpected token' "$log"; then printf 'DIAGNOSTIC=syntax-error\n'
elif grep -Eqi 'EACCES|EPERM|permission denied|read-only file system' "$log"; then printf 'DIAGNOSTIC=permission-or-filesystem\n'
elif grep -Eqi 'EADDRINUSE|address already in use' "$log"; then printf 'DIAGNOSTIC=port-conflict\n'
elif grep -Eqi 'ERR_REQUIRE_ESM|require\(\).*ES Module' "$log"; then printf 'DIAGNOSTIC=module-format\n'
elif grep -Eqi 'ReferenceError|TypeError|RangeError|Unhandled.*Error' "$log"; then printf 'DIAGNOSTIC=application-runtime-error\n'
elif grep -Eqi 'failed to start|status=[0-9]+/' "$log"; then printf 'DIAGNOSTIC=process-start-failure\n'
else printf 'DIAGNOSTIC=unclassified\n'; fi
`

function execute(client) {
  return new Promise((resolve) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return resolve({ ok: false, output: '' })
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => resolve({ ok: code === 0, output }))
      stream.write(`${connection.password}\n${script}`)
      stream.end()
    })
  })
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    const item = (key) => result.output.match(new RegExp(`^${key}=([^\\r\\n]*)`, 'm'))?.[1]?.trim() || 'unknown'
    process.stdout.write(`${JSON.stringify({ completed: result.ok, service: item('SERVICE_ACTIVE'), result: item('SERVICE_RESULT'), exitStatus: item('SERVICE_EXIT'), diagnostic: item('DIAGNOSTIC') })}\n`)
    if (!result.ok) process.exitCode = 1
  } finally { client.end() }
})
client.on('error', () => { process.stdout.write('{"completed":false,"diagnostic":"ssh-connection-failed"}\n'); process.exitCode = 1 })
client.connect(connection)
