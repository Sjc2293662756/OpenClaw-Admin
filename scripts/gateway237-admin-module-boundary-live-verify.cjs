'use strict'

const { Client } = require('ssh2')

const connection = {
  host: String(process.env.GAIOP_ADMIN_ALERT_VERIFY_SSH_HOST || '').trim(),
  username: String(process.env.GAIOP_ADMIN_ALERT_VERIFY_SSH_USERNAME || '').trim(),
  password: String(process.env.GAIOP_ADMIN_ALERT_VERIFY_SSH_PASSWORD || ''),
  readyTimeout: 20_000,
}
if (!connection.host || !connection.username || !connection.password) {
  throw new Error('The controlled Admin live module-boundary verification inputs are incomplete.')
}

const script = String.raw`set -euo pipefail
node <<'NODE'
const { randomBytes, randomUUID, scryptSync } = require('node:crypto')
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')

const baseUrl = 'http://127.0.0.1:3000'
const db = new Database('/var/lib/gaiop/admin/wizard.db')
const marker = 'controlled-module-boundary-' + Date.now() + '-' + randomBytes(3).toString('hex')
const password = 'Probe9!' + randomBytes(18).toString('base64url')
const salt = randomBytes(16).toString('base64')
const passwordHash = 'scrypt$' + salt + '$' + scryptSync(password, salt, 64).toString('base64')
const definitions = [
  { key: 'basicAllow', role: 'basic', overrides: [['audit', 'allow'], ['users', 'allow']] },
  { key: 'standardAllow', role: 'standard', overrides: [['audit', 'allow'], ['users', 'allow']] },
  { key: 'auditorDefault', role: 'auditor', overrides: [] },
  { key: 'adminDefault', role: 'admin', overrides: [] },
  { key: 'auditorDeny', role: 'auditor', overrides: [['audit', 'deny']] },
  { key: 'standardDeny', role: 'standard', overrides: [['system', 'deny']] },
  { key: 'internalFlagTarget', role: 'basic', overrides: [], status: 'inactive', mustChangePassword: 1 },
].map((entry, index) => ({
  ...entry,
  id: randomUUID(),
  username: marker + '-' + index,
}))
const byKey = Object.fromEntries(definitions.map((entry) => [entry.key, entry]))
const tokens = new Map()
let cleanupCompleted = false

function insertFixtures() {
  const insertUser = db.prepare('INSERT INTO users ('
    + 'id, username, password_hash, role, description, status, is_initial_admin, '
    + 'must_change_password, permission_version, created_at, updated_at'
    + ") VALUES (?, ?, ?, ?, 'controlled release acceptance', ?, 0, ?, ?, ?, ?)")
  const insertOverride = db.prepare('INSERT INTO user_module_permission_overrides ('
    + 'user_id, module_key, effect, updated_by, created_at, updated_at'
    + ') VALUES (?, ?, ?, ?, ?, ?)')
  db.transaction(() => {
    const now = Date.now()
    for (const entry of definitions) {
      insertUser.run(
        entry.id,
        entry.username,
        passwordHash,
        entry.role,
        entry.status || 'active',
        Number(entry.mustChangePassword || 0),
        entry.overrides.length ? 1 : 0,
        now,
        now,
      )
      for (const [moduleKey, effect] of entry.overrides) {
        insertOverride.run(entry.id, moduleKey, effect, entry.id, now, now)
      }
    }
  })()
}

function removeFixtures() {
  db.transaction(() => {
    const removeOverrides = db.prepare('DELETE FROM user_module_permission_overrides WHERE user_id = ?')
    const removePreferences = db.prepare('DELETE FROM alert_notification_preferences WHERE user_id = ?')
    const removeUser = db.prepare('DELETE FROM users WHERE id = ?')
    for (const entry of definitions) {
      removeOverrides.run(entry.id)
      removePreferences.run(entry.id)
      removeUser.run(entry.id)
    }
  })()
  cleanupCompleted = definitions.every((entry) => !db.prepare('SELECT 1 FROM users WHERE id = ?').get(entry.id))
}

async function request(path, { token, method = 'GET', body } = {}) {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const contentType = response.headers.get('content-type') || ''
  const value = contentType.includes('application/json')
    ? await response.json()
    : await response.arrayBuffer()
  return { status: response.status, contentType, value }
}

async function login(entry) {
  const result = await request('/api/auth/login', {
    method: 'POST',
    body: { username: entry.username, password },
  })
  if (result.status !== 200 || !result.value.token) throw new Error('controlled login failed')
  tokens.set(entry.key, result.value.token)
  return result.value
}

async function main() {
  const summary = {
    completed: false,
    auditBasicAllow: false,
    auditStandardAllow: false,
    auditAuditorDefault: false,
    auditAdminDefault: false,
    auditDeny: false,
    systemBasicDefaultDeny: false,
    systemStandardDefault: false,
    systemStandardDeny: false,
    chatBoundaryUnchanged: false,
    usersProjectionSafe: false,
    authOwnPasswordChangeStatePreserved: false,
    cleanupCompleted: false,
  }
  try {
    insertFixtures()
    const sessions = {}
    for (const key of ['basicAllow', 'standardAllow', 'auditorDefault', 'adminDefault', 'auditorDeny', 'standardDeny']) {
      sessions[key] = await login(byKey[key])
    }

    summary.authOwnPasswordChangeStatePreserved = ['basicAllow', 'standardAllow', 'auditorDefault', 'adminDefault']
      .every((key) => Object.hasOwn(sessions[key].user, 'mustChangePassword'))

    for (const [key, summaryKey] of [
      ['basicAllow', 'auditBasicAllow'],
      ['standardAllow', 'auditStandardAllow'],
      ['auditorDefault', 'auditAuditorDefault'],
      ['adminDefault', 'auditAdminDefault'],
    ]) {
      const listed = await request('/api/audit-logs?maxResults=1&pageSize=1', { token: tokens.get(key) })
      const exported = await request('/api/audit-logs/export', {
        token: tokens.get(key), method: 'POST', body: { maxResults: 1, locale: 'zh-CN' },
      })
      summary[summaryKey] = listed.status === 200
        && exported.status === 200
        && /spreadsheetml/.test(exported.contentType)
    }
    const auditDenyList = await request('/api/audit-logs?maxResults=1&pageSize=1', { token: tokens.get('auditorDeny') })
    const auditDenyExport = await request('/api/audit-logs/export', {
      token: tokens.get('auditorDeny'), method: 'POST', body: { maxResults: 1, locale: 'zh-CN' },
    })
    summary.auditDeny = auditDenyList.status === 403
      && auditDenyList.value.code === 'MODULE_ACCESS_DENIED'
      && auditDenyExport.status === 403
      && auditDenyExport.value.code === 'MODULE_ACCESS_DENIED'

    const basicStatus = await request('/api/rpc', {
      token: tokens.get('basicAllow'), method: 'POST', body: { method: 'status', params: {} },
    })
    const basicHealth = await request('/api/rpc', {
      token: tokens.get('basicAllow'), method: 'POST', body: { method: 'health', params: {} },
    })
    summary.systemBasicDefaultDeny = [basicStatus, basicHealth]
      .every((result) => result.status === 403 && result.value.code === 'MODULE_ACCESS_DENIED')

    const standardStatus = await request('/api/rpc', {
      token: tokens.get('standardAllow'), method: 'POST', body: { method: 'status', params: {} },
    })
    const standardHealth = await request('/api/rpc', {
      token: tokens.get('standardAllow'), method: 'POST', body: { method: 'health', params: {} },
    })
    summary.systemStandardDefault = standardStatus.status === 200 && standardHealth.status === 200

    const deniedStatus = await request('/api/rpc', {
      token: tokens.get('standardDeny'), method: 'POST', body: { method: 'status', params: {} },
    })
    const deniedHealth = await request('/api/rpc', {
      token: tokens.get('standardDeny'), method: 'POST', body: { method: 'health', params: {} },
    })
    summary.systemStandardDeny = [deniedStatus, deniedHealth]
      .every((result) => result.status === 403 && result.value.code === 'MODULE_ACCESS_DENIED')

    const { getRpcPermissionDecision } = await import('file:///opt/gaiop/admin/server/lib/permissions.js')
    summary.chatBoundaryUnchanged = getRpcPermissionDecision(
      { role: 'basic', effectiveModules: { system: false } },
      'chat.send',
    ).allowed === true

    const userLists = []
    for (const key of ['basicAllow', 'standardAllow', 'auditorDefault', 'adminDefault']) {
      userLists.push(await request('/api/users', { token: tokens.get(key) }))
    }
    summary.usersProjectionSafe = userLists.every((result) => result.status === 200
      && Array.isArray(result.value.users)
      && result.value.users.every((user) => !Object.hasOwn(user, 'mustChangePassword')))

    summary.completed = Object.entries(summary)
      .filter(([key]) => !['completed', 'cleanupCompleted'].includes(key))
      .every(([, value]) => value === true)
  } finally {
    for (const token of tokens.values()) {
      try { await request('/api/auth/logout', { token, method: 'POST' }) } catch {}
    }
    removeFixtures()
    summary.cleanupCompleted = cleanupCompleted
    summary.completed = summary.completed && cleanupCompleted
    db.close()
    process.stdout.write(JSON.stringify(summary) + '\n')
    if (!summary.completed) process.exitCode = 1
  }
}

main().catch(() => {
  try { removeFixtures() } catch {}
  try { db.close() } catch {}
  process.stdout.write(JSON.stringify({ completed: false, cleanupCompleted }) + '\n')
  process.exitCode = 1
})
NODE
`

function execute(client) {
  return new Promise((resolve) => client.exec("sudo -S -p '' bash -s", (error, stream) => {
    if (error) return resolve({ ok: false, output: '' })
    let output = ''
    stream.on('data', (chunk) => { output += chunk.toString('utf8') })
    stream.stderr.on('data', () => {})
    stream.on('close', (code) => resolve({ ok: code === 0, output }))
    stream.write(connection.password + '\n' + script)
    stream.end()
  }))
}

const client = new Client()
client.on('ready', async () => {
  try {
    const result = await execute(client)
    let summary = { completed: false, cleanupCompleted: false }
    try { summary = JSON.parse(String(result.output || '').trim().split(/\r?\n/u).at(-1)) } catch {}
    process.stdout.write(JSON.stringify(summary) + '\n')
    if (!result.ok || !summary.completed || !summary.cleanupCompleted) process.exitCode = 1
  } finally {
    client.end()
  }
})
client.on('error', () => {
  process.stdout.write('{"completed":false,"cleanupCompleted":false,"status":"ssh-connection-failed"}\n')
  process.exitCode = 1
})
client.connect(connection)
