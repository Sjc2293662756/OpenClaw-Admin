'use strict'

const { Client } = require('ssh2')

const prompt = String(process.env.GAIOP_REPORT_DISCOVERY_PROMPT || '').trim()
const from = String(process.env.GAIOP_REPORT_DISCOVERY_FROM || '').trim()
const to = String(process.env.GAIOP_REPORT_DISCOVERY_TO || '').trim()
const connection = {
  host: String(process.env.GAIOP_REPORT_DISCOVERY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_REPORT_DISCOVERY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_REPORT_DISCOVERY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!prompt || prompt.length > 300 || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))
  || Date.parse(from) >= Date.parse(to) || !connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled report turn discovery inputs are incomplete.')
}

const encoded = (value) => Buffer.from(value, 'utf8').toString('base64')
const remoteScript = String.raw`set -euo pipefail
sudo -u netinside env \
GAIOP_DISCOVERY_PROMPT_B64='${encoded(prompt)}' \
GAIOP_DISCOVERY_FROM_B64='${encoded(from)}' \
GAIOP_DISCOVERY_TO_B64='${encoded(to)}' \
node - /home/netinside/.openclaw/logs/audit.log <<'NODE'
const fs = require('node:fs')
const crypto = require('node:crypto')

const decode = (name) => Buffer.from(String(process.env[name] || ''), 'base64').toString('utf8')
const prompt = decode('GAIOP_DISCOVERY_PROMPT_B64').replace(/\s+/gu, ' ').trim()
const from = Date.parse(decode('GAIOP_DISCOVERY_FROM_B64'))
const to = Date.parse(decode('GAIOP_DISCOVERY_TO_B64'))
const entries = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/u).filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
})
const started = entries.filter((entry) => {
  const timestamp = Date.parse(String(entry.timestamp || ''))
  const value = String(entry.prompt || entry.userPrompt || '').replace(/\s+/gu, ' ').trim()
  return entry.event === 'napm_automatic_inspection_started'
    && Number.isFinite(timestamp) && timestamp >= from && timestamp <= to && value === prompt
})
if (started.length !== 1) {
  process.stdout.write(JSON.stringify({ matchCount: started.length, matches: started.map((entry) => ({
    timestamp: String(entry.timestamp || ''),
    turnId: String(entry.turnId || ''),
    conversationKeySha256: crypto.createHash('sha256').update(String(entry.conversationKey || '')).digest('hex'),
  })) }))
  process.exit(started.length ? 3 : 2)
}
const match = started[0]
const turnId = String(match.turnId || '')
const conversationKey = String(match.conversationKey || '')
const sessionKey = conversationKey.startsWith('session:') ? conversationKey.slice('session:'.length) : ''
if (!turnId || !/^agent:main:main:dm:webchat-[a-f0-9]{32}$/u.test(sessionKey)) process.exit(4)
const turnEvents = entries.filter((entry) => String(entry.turnId || '') === turnId).map((entry) => ({
  timestamp: String(entry.timestamp || ''),
  event: String(entry.event || ''),
  turnId: String(entry.turnId || ''),
  conversationKey: String(entry.conversationKey || ''),
  sessionKey: String(entry.sessionKey || ''),
  channelId: String(entry.channelId || entry.channel || ''),
  provider: String(entry.provider || ''),
  surface: String(entry.surface || ''),
  reportId: String(entry.reportId || ''),
  runId: String(entry.runId || ''),
  messageId: String(entry.messageId || ''),
  sourceMessageId: String(entry.sourceMessageId || ''),
  keys: Object.keys(entry).sort(),
}))
process.stdout.write(JSON.stringify({ matchCount: 1, sessionKey, conversationKey, turnId, startedKeys: Object.keys(match).sort(), turnEvents }))
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
    const discovery = await execute(client)
    process.stdout.write(`${JSON.stringify({ ok: true, discovery })}\n`)
  } catch {
    process.stdout.write('{"ok":false,"errorCode":"REMOTE_DISCOVERY_FAILED"}\n')
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
