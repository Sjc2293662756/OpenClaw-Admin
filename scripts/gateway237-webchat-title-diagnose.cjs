'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_WEBCHAT_TITLE_DIAG_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_WEBCHAT_TITLE_DIAG_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_WEBCHAT_TITLE_DIAG_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}

if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled WebChat title diagnostic context is incomplete.')
}

const diagnostic = String.raw`set -eu
node - <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const cp = require('node:child_process')
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')

function text(value) {
  return String(value || '').trim()
}

function title(value, maxLength = 24) {
  const normalized = String(value || '').replace(/\s+/gu, ' ').trim()
  const characters = Array.from(normalized)
  return characters.length > maxLength
    ? characters.slice(0, maxLength).join('') + '…'
    : normalized
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function messageText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join(' ')
  const row = record(value)
  return text(row.text || row.content || row.message || row.value)
}

function firstUserTitle(sessionFile) {
  if (!sessionFile || !fs.existsSync(sessionFile)) return ''
  for (const line of fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    const message = record(event.message)
    const role = text(message.role || event.role || message.sender || message.author).toLowerCase()
    if (role !== 'user') continue
    const candidate = title(messageText(message.content || message.text || message.message))
    if (candidate) return candidate
  }
  return ''
}

const adminPid = cp.execFileSync('systemctl', [
  'show', 'gaiop-admin.service', '--property=MainPID', '--value'
], { encoding: 'utf8' }).trim()
const adminEnvironment = fs.readFileSync('/proc/' + adminPid + '/environ')
  .toString('utf8')
  .split('\0')
  .reduce((result, row) => {
    const separator = row.indexOf('=')
    if (separator > 0) result[row.slice(0, separator)] = row.slice(separator + 1)
    return result
  }, {})
const dataDirectory = text(adminEnvironment.GAIOP_ADMIN_DATA_DIR) || '/opt/gaiop/admin/data'
const databaseFile = path.join(dataDirectory, 'wizard.db')
const db = new Database(databaseFile, { readonly: true, fileMustExist: true })

const workspaceRows = db.prepare(
  'SELECT session_key, owner_user_id, session_title, status, created_at, updated_at FROM workspace_sessions ORDER BY updated_at DESC'
).all()
const historicalRows = db.prepare(
  'SELECT session_key, session_title, title_source, created_at, updated_at FROM historical_webchat_titles ORDER BY updated_at DESC'
).all()
db.close()

const sessionsRoot = '/home/netinside/.openclaw/agents/main/sessions'
const sessionIndex = JSON.parse(fs.readFileSync(path.join(sessionsRoot, 'sessions.json'), 'utf8'))
const gatewayRows = Object.entries(sessionIndex)
  .filter(([key, value]) => {
    const channel = text(value?.channel || value?.lastChannel).toLowerCase()
    return key === 'main' || key.includes('webchat-') || ['web', 'webchat', 'workspace'].includes(channel)
  })
  .map(([key, value]) => ({
    sessionKey: key,
    updatedAt: value?.updatedAt || null,
    channel: text(value?.channel || value?.lastChannel),
    transcriptPresent: Boolean(value?.sessionFile && fs.existsSync(value.sessionFile)),
    firstUserTitle: firstUserTitle(value?.sessionFile),
  }))
  .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))

const deployedIndex = fs.readFileSync('/opt/gaiop/admin/server/index.js', 'utf8')
const deployedOwnership = fs.readFileSync('/opt/gaiop/admin/server/lib/session-ownership-service.js', 'utf8')
process.stdout.write(JSON.stringify({
  adminActive: cp.execFileSync('systemctl', ['is-active', 'gaiop-admin.service'], { encoding: 'utf8' }).trim(),
  deployed: {
    writesTitleAfterChatSend: deployedIndex.includes("setWorkspaceSessionTitleIfEmpty(db, sessionKey, webSessionTitleCandidate)"),
    enrichesSessionLists: deployedIndex.includes('payload = enrichSessionPayload(db, payload)'),
    supportsHistoricalTitles: deployedOwnership.includes('historical_webchat_titles'),
    derivesFirstUserTitle: deployedOwnership.includes('deriveFirstUserMessageTitle'),
  },
  database: {
    workspaceCount: workspaceRows.length,
    activeWorkspaceCount: workspaceRows.filter((row) => row.status === 'active').length,
    workspaceWithTitleCount: workspaceRows.filter((row) => text(row.session_title)).length,
    historicalTitleCount: historicalRows.length,
    recentWorkspace: workspaceRows.slice(0, 30),
    recentHistorical: historicalRows.slice(0, 30),
  },
  gateway: {
    webSessionCount: gatewayRows.length,
    webSessionWithFirstUserTitleCount: gatewayRows.filter((row) => row.firstUserTitle).length,
    recentWebSessions: gatewayRows.slice(0, 30),
  },
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
      stream.on('close', (exitCode) => {
        if (exitCode === 0) resolve(JSON.parse(output))
        else reject(new Error(`remote exit ${exitCode}`))
      })
      stream.write(`${connection.password}\n${diagnostic}`)
      stream.end()
    })
  })
}

const client = new Client()
let finished = false
const timeout = setTimeout(() => {
  if (!finished) process.stdout.write('{"ok":false,"errorCode":"TIMEOUT"}\n')
  finished = true
  client.end()
  process.exitCode = 1
}, 120_000)

client.on('ready', async () => {
  try {
    const result = await execute(client)
    finished = true
    clearTimeout(timeout)
    process.stdout.write(`${JSON.stringify({ ok: true, diagnostic: result })}\n`)
    client.end()
  } catch {
    finished = true
    clearTimeout(timeout)
    process.stdout.write('{"ok":false,"errorCode":"REMOTE_DIAGNOSTIC_FAILED"}\n')
    client.end()
    process.exitCode = 1
  }
})

client.on('error', () => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  process.stdout.write('{"ok":false,"errorCode":"CONNECTION_FAILED"}\n')
  process.exitCode = 1
})

client.connect(connection)
