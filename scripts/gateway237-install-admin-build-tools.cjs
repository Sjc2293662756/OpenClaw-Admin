'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_BUILD_TOOLS_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_BUILD_TOOLS_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_BUILD_TOOLS_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled build-tool installation connection context is incomplete.')
}

const script = String.raw`set -euo pipefail
rollback_command='apt-get remove build-essential'
installed_before=0
if dpkg -s build-essential 2>/dev/null | grep -q '^Status: install ok installed$'; then installed_before=1; fi
DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential python3 >/dev/null
command -v make >/dev/null
command -v g++ >/dev/null
command -v python3 >/dev/null
printf 'BUILD_TOOLS_READY\\n'
printf 'BUILD_TOOLS_PREEXISTED_%s\\n' "$installed_before"
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
let done = false
const timeout = setTimeout(() => {
  if (!done) process.stdout.write(`${JSON.stringify({ completed: false, status: 'build-tools-timeout' })}\n`)
  done = true
  client.end()
  process.exitCode = 1
}, 10 * 60_000)

client.on('ready', async () => {
  try {
    const result = await execute(client)
    done = true
    const output = String(result.output || '')
    process.stdout.write(`${JSON.stringify({
      completed: result.ok && /BUILD_TOOLS_READY/.test(output),
      status: result.ok ? 'build-tools-ready' : 'build-tools-install-failed',
      alreadyPresent: /BUILD_TOOLS_PREEXISTED_1/.test(output),
    })}\n`)
    if (!result.ok) process.exitCode = 1
  } finally {
    clearTimeout(timeout)
    client.end()
  }
})
client.on('error', () => {
  if (!done) {
    done = true
    process.stdout.write(`${JSON.stringify({ completed: false, status: 'ssh-connection-failed' })}\n`)
    clearTimeout(timeout)
    process.exitCode = 1
  }
})
client.connect(connection)
