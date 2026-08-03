'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ADMIN_SECURITY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_SECURITY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_SECURITY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled Admin security probe inputs are incomplete.')
}

const probes = [
  ['health', 'GET', '/api/health', 200],
  ['events-unauthenticated', 'GET', '/api/events', 401],
  ['media-unauthenticated', 'GET', '/api/media?path=browser%2Fprobe.png', 401],
  ['rpc-unauthenticated', 'POST', '/api/rpc', 401],
  ['upgrade-unauthenticated', 'GET', '/api/system-upgrade/overview', 401],
  ['npm-retired', 'GET', '/api/npm/versions', 410],
  ['backup-retired', 'GET', '/api/backup/list', 410],
  ['terminal-retired', 'GET', '/api/terminal/stream', 410],
  ['desktop-retired', 'GET', '/api/desktop/list', 410],
  ['files-retired', 'GET', '/api/files/list', 410],
  ['config-retired', 'GET', '/api/config', 410],
  ['workspace-retired', 'GET', '/api/agents/workspace', 410],
  ['hermes-retired', 'GET', '/api/hermes/status', 410],
]

const remoteScript = `set -euo pipefail
${probes.map(([name, method, path]) => (
  `code=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X '${method}' -H 'Content-Type: application/json' --data '{}' 'http://127.0.0.1:3000${path}' || true); printf '${name}=%s\\n' "$code"`
)).join('\n')}
`

function execute(client) {
  return new Promise((resolve) => client.exec('bash -s', (error, stream) => {
    if (error) return resolve({ ok: false, output: '' })
    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', () => {})
    stream.on('close', (code) => resolve({ ok: code === 0, output }))
    stream.end(remoteScript)
  }))
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    const codes = Object.fromEntries(
      result.output.split(/\r?\n/).filter(Boolean).map((line) => line.split('='))
    )
    const failures = probes
      .filter(([name, _method, _path, expected]) => Number(codes[name]) !== expected)
      .map(([name, _method, _path, expected]) => ({ name, expected, actual: Number(codes[name] || 0) }))
    process.stdout.write(`${JSON.stringify({ completed: result.ok && failures.length === 0, codes, failures })}\n`)
    if (!result.ok || failures.length) process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"codes":{},"failures":[{"name":"ssh","expected":0,"actual":1}]}\n')
  process.exitCode = 1
})
client.connect(connection)
