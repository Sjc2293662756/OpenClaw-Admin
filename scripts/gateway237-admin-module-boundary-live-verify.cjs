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
const { chmodSync, existsSync, mkdirSync, rmSync, rmdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const Database = require('/opt/gaiop/admin/node_modules/better-sqlite3')

const baseUrl = 'http://127.0.0.1:3000'
const reportRoot = '/var/lib/gaiop/reports'
const db = new Database('/var/lib/gaiop/admin/wizard.db')
const marker = 'controlled-module-boundary-' + Date.now() + '-' + randomBytes(3).toString('hex')
const password = 'Probe9!' + randomBytes(18).toString('base64url')
const salt = randomBytes(16).toString('base64')
const passwordHash = 'scrypt$' + salt + '$' + scryptSync(password, salt, 64).toString('base64')
const definitions = [
  { key: 'basicDefault', role: 'basic', overrides: [], legacyOverrides: [['users', 'allow']] },
  { key: 'basicDashboardOnly', role: 'basic', overrides: [['dashboard', 'allow']] },
  {
    key: 'basicScoped', role: 'basic',
    overrides: [
      ['data.allUsers', 'allow'], ['dashboard', 'allow'],
      ['sessions', 'allow'], ['reports', 'allow'],
    ],
  },
  {
    key: 'basicDataOnly', role: 'basic',
    overrides: [['data.allUsers', 'allow'], ['reports', 'deny']],
  },
  {
    key: 'basicAlertDeny', role: 'basic',
    overrides: [['alerts.records', 'deny'], ['alerts.notifications', 'deny']],
  },
  { key: 'basicAuditAllow', role: 'basic', overrides: [['audit', 'allow']] },
  { key: 'auditorDefault', role: 'auditor', overrides: [] },
  { key: 'auditorDenyAudit', role: 'auditor', overrides: [['audit', 'deny']] },
  { key: 'standardOwner', role: 'standard', overrides: [] },
  { key: 'ordinaryAdmin', role: 'admin', overrides: [] },
  { key: 'versionTarget', role: 'standard', overrides: [] },
].map((entry, index) => ({
  ...entry,
  id: randomUUID(),
  username: marker + '-' + index,
}))
const byKey = Object.fromEntries(definitions.map((entry) => [entry.key, entry]))
const tokens = new Map()
const reportDirectory = join(reportRoot, '.controlled-verification', marker)
const ownedReport = {
  id: marker + '-owned-report',
  storedName: '.controlled-verification/' + marker + '/owned.txt',
  sourceUserId: byKey.basicDefault.id,
}
const otherReport = {
  id: marker + '-other-report',
  storedName: '.controlled-verification/' + marker + '/other.txt',
  sourceUserId: byKey.standardOwner.id,
}
const scopedSessionKey = 'agent:main:web:direct:' + marker + '-scoped'
const dashboardSessionKey = 'agent:main:web:direct:' + marker + '-dashboard'
const otherSessionKey = 'agent:main:web:direct:' + marker + '-other'

const summary = {
  completed: false,
  catalogIsCurrent: false,
  fixedAccountGovernance: false,
  initialAdminIdentityLock: false,
  permissionConfigurationRestricted: false,
  optimisticVersioning: false,
  safeDelegationBoundary: false,
  alertRecordsAndExport: false,
  alertNotificationsAndSse: false,
  alertDenyEffective: false,
  personalReportOwnership: false,
  allUserReportIntersection: false,
  dashboardModuleIntersection: false,
  sessionReadScopeIntersection: false,
  sessionWriteOwnershipPreserved: false,
  auditAllowAndDeny: false,
  cleanupCompleted: false,
}

function tableExists(name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function insertFixtures() {
  const insertUser = db.prepare('INSERT INTO users ('
    + 'id, username, password_hash, role, description, status, is_initial_admin, '
    + 'must_change_password, permission_version, created_at, updated_at'
    + ") VALUES (?, ?, ?, ?, 'controlled release acceptance', 'active', 0, 0, ?, ?, ?)")
  const insertOverride = db.prepare('INSERT INTO user_module_permission_overrides ('
    + 'user_id, module_key, effect, updated_by, created_at, updated_at'
    + ') VALUES (?, ?, ?, ?, ?, ?)')
  const insertSession = db.prepare('INSERT INTO workspace_sessions ('
    + 'session_key, owner_user_id, session_title, status, created_at, updated_at'
    + ") VALUES (?, ?, 'controlled verification', 'active', ?, ?)")
  const insertReport = db.prepare('INSERT INTO report_files ('
    + 'id, stored_name, original_name, report_type, source_user_id, mime_type, size, status, created_at, updated_at'
    + ") VALUES (?, ?, ?, 'controlled-verification', ?, 'text/plain; charset=utf-8', ?, 'ready', ?, ?)")

  db.transaction(() => {
    const now = Date.now()
    for (const entry of definitions) {
      const overrides = [...entry.overrides, ...(entry.legacyOverrides || [])]
      insertUser.run(entry.id, entry.username, passwordHash, entry.role, overrides.length ? 1 : 0, now, now)
      for (const [moduleKey, effect] of overrides) {
        insertOverride.run(entry.id, moduleKey, effect, entry.id, now, now)
      }
    }
    insertSession.run(scopedSessionKey, byKey.basicScoped.id, now, now)
    insertSession.run(dashboardSessionKey, byKey.basicDashboardOnly.id, now, now)
    insertSession.run(otherSessionKey, byKey.standardOwner.id, now, now)
    insertReport.run(ownedReport.id, ownedReport.storedName, 'owned.txt', ownedReport.sourceUserId, 5, now, now)
    insertReport.run(otherReport.id, otherReport.storedName, 'other.txt', otherReport.sourceUserId, 5, now, now)
  })()

  mkdirSync(reportDirectory, { recursive: true, mode: 0o755 })
  writeFileSync(join(reportDirectory, 'owned.txt'), 'owned', { mode: 0o644 })
  writeFileSync(join(reportDirectory, 'other.txt'), 'other', { mode: 0o644 })
  chmodSync(reportDirectory, 0o755)
}

function removeFixtures() {
  try {
    db.transaction(() => {
      if (tableExists('report_deliveries')) {
        db.prepare('DELETE FROM report_deliveries WHERE report_id IN (?, ?)').run(ownedReport.id, otherReport.id)
      }
      if (tableExists('report_retention_artifacts')) {
        db.prepare('DELETE FROM report_retention_artifacts WHERE report_id IN (?, ?)').run(ownedReport.id, otherReport.id)
      }
      db.prepare('DELETE FROM report_files WHERE id IN (?, ?)').run(ownedReport.id, otherReport.id)
      db.prepare('DELETE FROM workspace_sessions WHERE session_key IN (?, ?, ?)')
        .run(scopedSessionKey, dashboardSessionKey, otherSessionKey)
      const removeOverrides = db.prepare('DELETE FROM user_module_permission_overrides WHERE user_id = ?')
      const removePreferences = db.prepare('DELETE FROM alert_notification_preferences WHERE user_id = ?')
      const removeUser = db.prepare('DELETE FROM users WHERE id = ?')
      for (const entry of definitions) {
        removeOverrides.run(entry.id)
        removePreferences.run(entry.id)
        removeUser.run(entry.id)
      }
    })()
  } catch {}
  try { rmSync(reportDirectory, { recursive: true, force: true }) } catch {}
  try { rmdirSync(join(reportRoot, '.controlled-verification')) } catch {}

  try {
    const userCount = db.prepare('SELECT COUNT(*) AS count FROM users WHERE username LIKE ?').get(marker + '%').count
    const userIds = definitions.map((entry) => entry.id)
    const overrideCount = db.prepare('SELECT COUNT(*) AS count FROM user_module_permission_overrides WHERE user_id IN ('
      + userIds.map(() => '?').join(',') + ')').get(...userIds).count
    const reportCount = db.prepare('SELECT COUNT(*) AS count FROM report_files WHERE id IN (?, ?)')
      .get(ownedReport.id, otherReport.id).count
    const sessionCount = db.prepare('SELECT COUNT(*) AS count FROM workspace_sessions WHERE session_key IN (?, ?, ?)')
      .get(scopedSessionKey, dashboardSessionKey, otherSessionKey).count
    summary.cleanupCompleted = userCount === 0
      && overrideCount === 0
      && reportCount === 0
      && sessionCount === 0
      && !existsSync(reportDirectory)
  } catch {
    summary.cleanupCompleted = false
  }
}

async function request(path, { token, method = 'GET', body } = {}) {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const response = await fetch(baseUrl + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    return { status: response.status, contentType, value: await response.json() }
  }
  const value = Buffer.from(await response.arrayBuffer())
  return { status: response.status, contentType, byteLength: value.length }
}

async function login(entry) {
  const result = await request('/api/auth/login', {
    method: 'POST',
    body: { username: entry.username, password },
  })
  if (result.status !== 200 || !result.value.token || !result.value.user) throw new Error('controlled login failed')
  tokens.set(entry.key, result.value.token)
  return result.value.user
}

function reportIds(result) {
  return new Set(Array.isArray(result.value?.reports) ? result.value.reports.map((row) => row.id) : [])
}

async function main() {
  try {
    insertFixtures()
    const modulePermissions = await import('file:///opt/gaiop/admin/server/lib/module-permissions.js')
    const permissions = await import('file:///opt/gaiop/admin/server/lib/permissions.js')
    const sessionOwnership = await import('file:///opt/gaiop/admin/server/lib/session-ownership-service.js')
    const sseAccess = await import('file:///opt/gaiop/admin/server/lib/sse-access.js')

    const before = modulePermissions.getUserModulePermissionProjection(db, byKey.versionTarget.id)
    const first = modulePermissions.replaceUserModulePermissionOverrides(db, {
      actor: { id: byKey.ordinaryAdmin.id },
      userId: byKey.versionTarget.id,
      expectedVersion: before.permissionVersion,
      overrides: [{ moduleKey: 'cron', effect: 'allow' }],
      recordAudit: () => true,
    })
    let conflictRejected = false
    try {
      modulePermissions.replaceUserModulePermissionOverrides(db, {
        actor: { id: byKey.ordinaryAdmin.id },
        userId: byKey.versionTarget.id,
        expectedVersion: before.permissionVersion,
        overrides: [],
        recordAudit: () => true,
      })
    } catch (error) {
      conflictRejected = error?.code === 'PERMISSION_VERSION_CONFLICT'
    }
    const restored = modulePermissions.replaceUserModulePermissionOverrides(db, {
      actor: { id: byKey.ordinaryAdmin.id },
      userId: byKey.versionTarget.id,
      expectedVersion: first.permissionVersion,
      overrides: [],
      recordAudit: () => true,
    })
    summary.optimisticVersioning = conflictRejected
      && first.permissionVersion === before.permissionVersion + 1
      && restored.permissionVersion === first.permissionVersion + 1
      && Object.keys(restored.moduleOverrides).length === 0

    const users = {}
    for (const entry of definitions.filter((item) => item.key !== 'versionTarget')) {
      users[entry.key] = await login(entry)
    }

    const expectedCatalog = new Set([
      'data.allUsers', 'dashboard', 'alerts.records', 'alerts.notifications', 'sessions', 'reports',
      'cron', 'memory', 'models', 'channels', 'skills', 'system', 'agents', 'office', 'audit',
      'settings', 'systemConfiguration', 'systemUpgrade', 'platformBranding',
    ])
    const catalog = await request('/api/module-permissions/catalog', { token: tokens.get('basicDefault') })
    const catalogRows = Array.isArray(catalog.value?.modules) ? catalog.value.modules : []
    const catalogKeys = new Set(catalogRows.map((row) => row.moduleKey))
    const alertRecord = catalogRows.find((row) => row.moduleKey === 'alerts.records')
    summary.catalogIsCurrent = catalog.status === 200
      && catalogRows.length === 19
      && expectedCatalog.size === catalogKeys.size
      && [...expectedCatalog].every((key) => catalogKeys.has(key))
      && !catalogKeys.has('users')
      && !catalogKeys.has('userAdministration')
      && !catalogKeys.has('alerts.export')
      && alertRecord?.rest?.includes('POST /api/alerts/export') === true

    const basicUsers = await request('/api/users', { token: tokens.get('basicDefault') })
    const auditorUsers = await request('/api/users', { token: tokens.get('auditorDefault') })
    const adminUsers = await request('/api/users', { token: tokens.get('ordinaryAdmin') })
    summary.fixedAccountGovernance = basicUsers.status === 403
      && users.basicDefault.effectiveModules.users === false
      && users.basicDefault.effectiveModules.userAdministration === false
      && auditorUsers.status === 200
      && users.auditorDefault.effectiveModules.users === true
      && users.auditorDefault.effectiveModules.userAdministration === false
      && adminUsers.status === 200
      && users.ordinaryAdmin.effectiveModules.users === true
      && users.ordinaryAdmin.effectiveModules.userAdministration === true
      && adminUsers.value.users.every((user) => !Object.hasOwn(user, 'mustChangePassword'))

    const initial = modulePermissions.resolveEffectiveModulePermissions(db, {
      id: marker + '-synthetic-initial', role: 'admin', is_initial_admin: 1, permission_version: 0,
    })
    summary.initialAdminIdentityLock = initial.modules.length === 19
      && initial.modules.every((row) => row.locked && row.effectiveAllowed)
      && users.ordinaryAdmin.effectiveModules.platformBranding === false

    const targetPath = '/api/users/' + encodeURIComponent(byKey.basicDefault.id) + '/module-permissions'
    const ordinaryRead = await request(targetPath, { token: tokens.get('ordinaryAdmin') })
    const ordinaryWrite = await request(targetPath, {
      token: tokens.get('ordinaryAdmin'),
      method: 'PUT',
      body: { expectedVersion: 1, overrides: [] },
    })
    summary.permissionConfigurationRestricted = [ordinaryRead, ordinaryWrite]
      .every((result) => result.status === 403 && result.value.code === 'INITIAL_ADMIN_REQUIRED')

    const delegated = {
      role: 'basic',
      effectiveModules: { systemConfiguration: true },
      moduleOverrides: { systemConfiguration: 'allow' },
    }
    summary.safeDelegationBoundary = permissions.getRpcPermissionDecision(delegated, 'config.get').allowed === true
      && permissions.getRpcPermissionDecision(delegated, 'config.set').allowed === false
      && permissions.getRpcPermissionDecision(
        { role: 'basic', effectiveModules: { system: false } }, 'chat.send',
      ).allowed === true

    const alertList = await request('/api/alerts?page=1&pageSize=1', { token: tokens.get('basicDefault') })
    const alertExport = await request('/api/alerts/export', {
      token: tokens.get('basicDefault'),
      method: 'POST',
      body: {
        rows: [{
          occurredAt: '2026-08-31 00:00', severity: 'minor', name: 'controlled verification',
          category: 'appAlerts', sourceHost: '127.0.0.1', status: 'triggered',
        }],
      },
    })
    summary.alertRecordsAndExport = alertList.status === 200
      && alertExport.status === 200
      && /spreadsheetml/.test(alertExport.contentType)
      && alertExport.byteLength > 0

    const alertPreferences = await request('/api/alerts/preferences', { token: tokens.get('basicDefault') })
    summary.alertNotificationsAndSse = alertPreferences.status === 200
      && sseAccess.canReceiveSseData(users.basicDefault, { type: 'alert' }) === true
      && sseAccess.canReceiveSseData(users.basicDefault, { type: 'alertStreamState' }) === true
      && sseAccess.canReceiveSseData(users.basicAlertDeny, { type: 'alert' }) === false

    const deniedAlertList = await request('/api/alerts?page=1&pageSize=1', { token: tokens.get('basicAlertDeny') })
    const deniedAlertExport = await request('/api/alerts/export', {
      token: tokens.get('basicAlertDeny'), method: 'POST', body: { rows: [{ name: 'must not export' }] },
    })
    const deniedAlertPreferences = await request('/api/alerts/preferences', { token: tokens.get('basicAlertDeny') })
    summary.alertDenyEffective = [deniedAlertList, deniedAlertExport, deniedAlertPreferences]
      .every((result) => result.status === 403)

    const personalReports = await request('/api/reports', { token: tokens.get('basicDefault') })
    const personalIds = reportIds(personalReports)
    const ownDownload = await request('/api/reports/' + encodeURIComponent(ownedReport.id) + '/download', {
      token: tokens.get('basicDefault'),
    })
    const hiddenOther = await request('/api/reports/' + encodeURIComponent(otherReport.id) + '/download', {
      token: tokens.get('basicDefault'),
    })
    summary.personalReportOwnership = personalReports.status === 200
      && personalIds.has(ownedReport.id)
      && !personalIds.has(otherReport.id)
      && ownDownload.status === 200
      && hiddenOther.status === 404

    const allReports = await request('/api/reports', { token: tokens.get('basicScoped') })
    const allIds = reportIds(allReports)
    const allOther = await request('/api/reports/' + encodeURIComponent(otherReport.id) + '/download', {
      token: tokens.get('basicScoped'),
    })
    const reportsDenied = await request('/api/reports', { token: tokens.get('basicDataOnly') })
    summary.allUserReportIntersection = allReports.status === 200
      && allIds.has(ownedReport.id)
      && allIds.has(otherReport.id)
      && allOther.status === 200
      && reportsDenied.status === 403

    const dashboardDenied = await request('/api/dashboard/summary', { token: tokens.get('basicDataOnly') })
    const dashboardPersonal = await request('/api/dashboard/summary', { token: tokens.get('basicDashboardOnly') })
    const dashboardAll = await request('/api/dashboard/summary', { token: tokens.get('basicScoped') })
    const personalKeys = sessionOwnership.listOwnedWorkspaceSessionKeys(
      db, users.basicDashboardOnly, { scopeModuleKey: 'dashboard' },
    )
    const allKeys = sessionOwnership.listOwnedWorkspaceSessionKeys(
      db, users.basicScoped, { scopeModuleKey: 'dashboard' },
    )
    summary.dashboardModuleIntersection = dashboardDenied.status === 403
      && dashboardPersonal.status === 200
      && dashboardAll.status === 200
      && personalKeys instanceof Set
      && personalKeys.has(dashboardSessionKey)
      && !personalKeys.has(otherSessionKey)
      && allKeys === null

    const scopedRead = sessionOwnership.ensureWorkspaceSessionReadAccess(db, users.basicScoped, otherSessionKey)
    const dataOnlyRead = sessionOwnership.ensureWorkspaceSessionReadAccess(db, users.basicDataOnly, otherSessionKey)
    const scopedKeys = sessionOwnership.listOwnedWorkspaceSessionKeys(db, users.basicScoped)
    const dataOnlyKeys = sessionOwnership.listOwnedWorkspaceSessionKeys(db, users.basicDataOnly)
    summary.sessionReadScopeIntersection = scopedRead.ok === true
      && dataOnlyRead.ok === false
      && scopedKeys === null
      && dataOnlyKeys instanceof Set
      && !dataOnlyKeys.has(otherSessionKey)

    const ownWrite = sessionOwnership.ensureWorkspaceSessionAccess(db, users.basicScoped, scopedSessionKey)
    const otherWrite = sessionOwnership.ensureWorkspaceSessionAccess(db, users.basicScoped, otherSessionKey)
    summary.sessionWriteOwnershipPreserved = ownWrite.ok === true && otherWrite.ok === false

    const auditAllowed = await request('/api/audit-logs?maxResults=1&pageSize=1', {
      token: tokens.get('basicAuditAllow'),
    })
    const auditDenied = await request('/api/audit-logs?maxResults=1&pageSize=1', {
      token: tokens.get('auditorDenyAudit'),
    })
    summary.auditAllowAndDeny = auditAllowed.status === 200
      && auditDenied.status === 403
      && auditDenied.value.code === 'MODULE_ACCESS_DENIED'

    summary.completed = Object.entries(summary)
      .filter(([key]) => !['completed', 'cleanupCompleted'].includes(key))
      .every(([, value]) => value === true)
  } catch {
    summary.completed = false
  } finally {
    for (const token of tokens.values()) {
      try { await request('/api/auth/logout', { token, method: 'POST' }) } catch {}
    }
    removeFixtures()
    summary.completed = summary.completed && summary.cleanupCompleted
    try { db.close() } catch {}
    process.stdout.write(JSON.stringify(summary) + '\n')
    if (!summary.completed) process.exitCode = 1
  }
}

main().catch(() => {
  try { removeFixtures() } catch {}
  try { db.close() } catch {}
  process.stdout.write(JSON.stringify({ completed: false, cleanupCompleted: summary.cleanupCompleted }) + '\n')
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
