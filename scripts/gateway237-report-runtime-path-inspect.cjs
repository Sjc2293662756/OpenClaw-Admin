'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_REPORT_PATH_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_PATH_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_PATH_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) throw new Error('Missing controlled connection inputs.')

const remoteScript = String.raw`set -euo pipefail
sudo -u netinside node <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const targets = [
  '/home/netinside/.openclaw/workspace/napm-openclaw-plugin.remote.js',
  '/home/netinside/.openclaw/extensions/napm-openclaw-plugin/napm-openclaw-plugin.remote.js',
  '/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs',
]
function excerpt(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u)
  const hits = lines.flatMap((line, index) => /reply_dispatch|buildReplyDispatchMessageContext|shouldOwnAutomaticReportReplyDispatch|napm-openclaw-plugin\.remote/u.test(line) ? [index] : [])
  const indexes = [...new Set(hits.flatMap((index) => [index - 2, index - 1, index, index + 1, index + 2]).filter((index) => index >= 0 && index < lines.length))]
  const focused = file.includes('/workspace/')
    ? Array.from({ length: 34 }, (_, offset) => 3590 + offset)
    : file.endsWith('.remote.js')
      ? Array.from({ length: 38 }, (_, offset) => 4516 + offset)
      : []
  return [...new Set([...indexes, ...focused])].filter((index) => index >= 0 && index < lines.length)
    .sort((left, right) => left - right)
    .map((index) => ({ line: index + 1, text: lines[index].slice(0, 500) }))
}
const referenceCandidates = [
  '/home/netinside/.openclaw/extensions/napm-openclaw-plugin/index.mjs',
  '/home/netinside/.openclaw/extensions/napm-openclaw-plugin/package.json',
  '/home/netinside/.openclaw/workspace/package.json',
]
const references = referenceCandidates.filter((file) => {
  try { return fs.readFileSync(file, 'utf8').includes('napm-openclaw-plugin.remote.js') } catch { return false }
})
process.stdout.write(JSON.stringify({
  targets: targets.map((file) => ({ file, excerpt: excerpt(file) })),
  references: [...new Set(references)].sort(),
}))
NODE
`

function execute(client) {
  return new Promise((resolve, reject) => {
    client.exec("sudo -S -p '' bash -s", (error, stream) => {
      if (error) return reject(error)
      let output = ''
      stream.on('data', (chunk) => { output += chunk.toString('utf8') })
      stream.stderr.on('data', () => {})
      stream.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`remote exit ${code}`)))
      stream.write(`${connection.password}\n${remoteScript}`)
      stream.end()
    })
  })
}

const client = new Client()
client.on('ready', async () => {
  try {
    process.stdout.write(`${JSON.stringify({ ok: true, inspection: await execute(client) })}\n`)
  } catch {
    process.stdout.write('{"ok":false,"errorCode":"REMOTE_INSPECTION_FAILED"}\n')
    process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  process.stdout.write('{"ok":false,"errorCode":"CONNECTION_FAILED"}\n')
  process.exitCode = 1
})
client.connect(connection)
