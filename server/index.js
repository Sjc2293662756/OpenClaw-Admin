import express from 'express'
import cors from 'cors'
import compression from 'compression'
import { createServer } from 'http'
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join, resolve, basename, extname, sep } from 'path'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, unlinkSync, stat, promises as fsPromises, createReadStream, createWriteStream, copyFileSync, readlinkSync, symlinkSync, renameSync } from 'fs'
import { OpenClawGateway } from './gateway.js'
import { parse } from 'dotenv'
import os from 'os'
import multer from 'multer'
import checkDiskSpace from 'check-disk-space'
import { execSync } from 'child_process'
import pty from 'node-pty'
import db, { createBackupRecord, updateBackupRecord, getBackupRecord, getBackupRecords, getBackupRecordsCount, deleteBackupRecord } from './database.js'
import { USER_ROLES, USER_STATUSES, getRpcPermissionDecision, isReadOnlyRpcMethod, createRoleMiddleware } from './lib/permissions.js'
import { sendError } from './lib/api-response.js'
import { sanitizeGatewayConfigPayload } from './lib/sensitive-data.js'
import { createAuditRouter } from './routes/audit.js'
import { createAuthRouter } from './routes/auth.js'
import { createUsersRouter } from './routes/users.js'
import { createDataSourcesRouter } from './routes/data-sources.js'
import { createSensitiveConfigRouter } from './routes/sensitive-config.js'
import { createReportsRouter } from './routes/reports.js'
import { createAlertsRouter } from './routes/alerts.js'
import { createReportStorageRouter } from './routes/report-storage.js'
import { createSessionSettingsRouter } from './routes/session-settings.js'
import { createWorkspaceSessionsRouter } from './routes/workspace-sessions.js'
import { createGAIOPServiceRouter } from './routes/gaiop-service.js'
import { createAlertIngestionRouter } from './routes/alert-ingestion.js'
import { createChannelsRouter } from './routes/channels.js'
import { createSystemUpgradeRouter } from './routes/system-upgrade.js'
import { readSessionSettings } from './lib/session-settings.js'
import {
  SESSION_LIST_METHODS,
  SESSION_SCOPED_READ_METHODS,
  SESSION_SCOPED_WRITE_METHODS,
  canAccessWorkspaceSession,
  enrichSessionPayload,
  ensureWorkspaceSessionAccess,
  extractSessionKeyFromEvent,
  filterHiddenLegacySessions,
  filterSessionListPayload,
  getConversationTitleCandidate,
  getSessionKeyFromParams,
  hideLegacySharedSession,
  isLegacySessionHidden,
  isLegacySharedWebSessionKey,
  isConversationSessionSend,
  listOwnedWorkspaceSessionKeys,
  markWorkspaceSessionDeleted,
  setWorkspaceSessionTitleIfEmpty,
} from './lib/session-ownership-service.js'
import { attachReportProvenance } from './report-provenance-service.js'
import { decryptDataSourcePassword, encryptDataSourcePassword, isDataSourceEncryptionReady, testNapmDataSource, toPublicDataSource, validateDataSourceInput } from './data-source-service.js'
import { getDataSourceRuntimeStatus, writeActiveDataSourceRuntime } from './data-source-runtime-service.js'
import { encryptSensitiveConfigValue, isSensitiveConfigEncryptionReady, toPublicSystemSensitiveConfig, validateSystemSensitiveConfigInput } from './sensitive-config-service.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const envPath = join(__dirname, '../.env')

function loadEnvConfig() {
  const parsed = existsSync(envPath) ? parse(readFileSync(envPath, 'utf-8')) : {}
  const value = (name, fallback = '') => process.env[name] || parsed[name] || fallback
  return {
    PORT: value('PORT', '3001'),
    GAIOP_BIND_HOST: value('GAIOP_BIND_HOST', '127.0.0.1'),
    OPENCLAW_WS_URL: value('OPENCLAW_WS_URL', 'ws://localhost:18789'),
    OPENCLAW_AUTH_TOKEN: value('OPENCLAW_AUTH_TOKEN'),
    OPENCLAW_AUTH_PASSWORD: value('OPENCLAW_AUTH_PASSWORD'),
    DEV_FRONTEND_URL: value('DEV_FRONTEND_URL', 'http://localhost:3000'),
    AUTH_USERNAME: value('AUTH_USERNAME'),
    AUTH_PASSWORD: value('AUTH_PASSWORD'),
    MEDIA_DIR: value('MEDIA_DIR'),
    LOG_LEVEL: value('LOG_LEVEL', 'INFO'),
    HERMES_WEB_URL: value('HERMES_WEB_URL'),
    HERMES_API_URL: value('HERMES_API_URL'),
    HERMES_API_KEY: value('HERMES_API_KEY'),
    HERMES_CLI_PATH: value('HERMES_CLI_PATH'),
    HERMES_HOME: value('HERMES_HOME'),
    GAIOP_REPORT_PROVENANCE_ENABLED: value('GAIOP_REPORT_PROVENANCE_ENABLED', 'false'),
    GAIOP_REPORT_PROVENANCE_SIGNING_KEY: value('GAIOP_REPORT_PROVENANCE_SIGNING_KEY'),
    GAIOP_REPORT_PROVENANCE_STORE_DIR: value('GAIOP_REPORT_PROVENANCE_STORE_DIR', '/var/lib/gaiop/runtime/report-provenance'),
    GAIOP_UPGRADE_SERVICE_URL: value('GAIOP_UPGRADE_SERVICE_URL'),
    GAIOP_UPGRADE_INTERNAL_TOKEN: value('GAIOP_UPGRADE_INTERNAL_TOKEN'),
  }
}

let envConfig = loadEnvConfig()

const allowedBindHosts = new Set(['127.0.0.1', '::1'])
if (!allowedBindHosts.has(envConfig.GAIOP_BIND_HOST)) {
  throw new Error('GAIOP_BIND_HOST must be a loopback address.')
}

const isDebug = envConfig.LOG_LEVEL === 'DEBUG'

function debug(...args) {
  if (isDebug) {
    console.log('[DEBUG]', ...args)
  }
}

const app = express()
const server = createServer(app)

const distPath = join(__dirname, '../dist')
const hasDist = existsSync(join(distPath, 'index.html'))

const sessions = new Map()

app.use(cors())
app.use(compression({
  threshold: 1024,
  filter: (req, res) => req.path !== '/api/events' && compression.filter(req, res),
}))
app.use(express.json())

// Hermes 相关源码按产品迁移需要保留，但当前 GAIOP 正式运行态不启用该模式。
// 这里在路由入口直接拦截，避免通过旧地址绕过前端菜单进入已停用能力。
function disabledHermesApi(_req, res) {
  return sendError(res, {
    status: 404,
    code: 'FEATURE_DISABLED',
    message: '该功能当前未启用',
  })
}
app.use('/api/hermes', disabledHermesApi)
app.use('/api/hermes-cli', disabledHermesApi)

let gateway = new OpenClawGateway(envConfig.OPENCLAW_WS_URL, envConfig.OPENCLAW_AUTH_TOKEN, envConfig.OPENCLAW_AUTH_PASSWORD, envConfig.LOG_LEVEL)

const sseClients = new Map()

const terminalSessions = new Map()
const hermesCliSessions = new Map()
const desktopSessions = new Map()

function cleanupTerminalSession(sessionId) {
  const session = terminalSessions.get(sessionId)
  if (!session) return false
  
  try {
    if (session.ptyProcess) {
      session.ptyProcess.kill()
    }
  } catch (e) {
    debug('[Terminal] Error killing PTY process:', e.message)
  }
  
  terminalSessions.delete(sessionId)
  console.log(`[Terminal] Session ${sessionId} cleaned up`)
  return true
}

function cleanupAllTerminalSessions() {
  const sessionIds = [...terminalSessions.keys()]
  console.log(`[Terminal] Cleaning up ${sessionIds.length} terminal sessions...`)
  for (const sessionId of sessionIds) {
    cleanupTerminalSession(sessionId)
  }
}

function cleanupOrphanedSessions() {
  const now = Date.now()
  const STALE_THRESHOLD = 30 * 60 * 1000
  
  for (const [sessionId, session] of terminalSessions) {
    const isStale = session.lastHeartbeat && (now - session.lastHeartbeat) > STALE_THRESHOLD
    const hasDeadResponse = !session.res || session.res.writableEnded || session.res.destroyed
    
    if (isStale || hasDeadResponse) {
      console.log(`[Terminal] Cleaning up orphaned session ${sessionId} (stale: ${isStale}, dead response: ${hasDeadResponse})`)
      cleanupTerminalSession(sessionId)
    }
  }
}

setInterval(cleanupOrphanedSessions, 5 * 60 * 1000)

// ============ Hermes CLI Session Management ============

const HERMES_CLI_OUTPUT_BUFFER_MAX = 64 * 1024 // 64KB ring buffer
let hermesCliSessionCounter = 0

function cleanupHermesCliSession(sessionId) {
  const session = hermesCliSessions.get(sessionId)
  if (!session) return false

  try {
    if (session.ptyProcess) {
      session.ptyProcess.kill()
    }
  } catch (e) {
    debug('[HermesCLI] Error killing PTY process:', e.message)
  }

  // Close response if still connected
  if (session.res) {
    try {
      session.res.end()
    } catch (e) {
      // Ignore
    }
  }

  hermesCliSessions.delete(sessionId)
  console.log(`[HermesCLI] Session ${sessionId} (${session.name || 'unnamed'}) destroyed`)
  return true
}

function detachHermesCliSession(sessionId) {
  const session = hermesCliSessions.get(sessionId)
  if (!session) return false

  // Only remove the HTTP response reference, keep the PTY process running
  if (session.res) {
    try {
      session.res.end()
    } catch (e) {
      // Ignore
    }
    session.res = null
  }

  console.log(`[HermesCLI] Session ${sessionId} (${session.name || 'unnamed'}) detached (process still running)`)
  return true
}

function addOutputToBuffer(session, data) {
  if (!session.outputBuffer) {
    session.outputBuffer = []
    session.outputBufferSize = 0
  }
  session.outputBuffer.push(data)
  session.outputBufferSize += Buffer.byteLength(data, 'utf-8')

  // Trim from the front if we exceed the buffer limit
  while (session.outputBufferSize > HERMES_CLI_OUTPUT_BUFFER_MAX && session.outputBuffer.length > 1) {
    const removed = session.outputBuffer.shift()
    session.outputBufferSize -= Buffer.byteLength(removed, 'utf-8')
  }
}

function cleanupAllHermesCliSessions() {
  const sessionIds = [...hermesCliSessions.keys()]
  console.log(`[HermesCLI] Cleaning up ${sessionIds.length} sessions...`)
  for (const sessionId of sessionIds) {
    cleanupHermesCliSession(sessionId)
  }
}

function cleanupOrphanedHermesCliSessions() {
  const now = Date.now()
  const STALE_THRESHOLD = 2 * 60 * 60 * 1000 // 2 hours for Hermes CLI sessions

  for (const [sessionId, session] of hermesCliSessions) {
    const isStale = session.lastHeartbeat && (now - session.lastHeartbeat) > STALE_THRESHOLD
    // Only consider orphaned if process has actually exited
    const hasDeadProcess = !session.ptyProcess || session.ptyProcess.killed

    if (isStale || hasDeadProcess) {
      console.log(`[HermesCLI] Cleaning up orphaned session ${sessionId} (stale: ${isStale}, dead process: ${hasDeadProcess})`)
      cleanupHermesCliSession(sessionId)
    }
  }
}

setInterval(cleanupOrphanedHermesCliSessions, 5 * 60 * 1000)

let gatewayVersion = null
let updateInfo = null

function bindGAIOPServiceEvents(targetGateway) {
  targetGateway.on('connected', () => {
    console.log('[Gateway] Connected to GAIOP service')
  })

  targetGateway.on('version', (info) => {
    debug('Gateway version info:', info)
    updateInfo = info
    gatewayVersion = info.currentVersion
    broadcastSSE({ type: 'gatewayState', state: 'connected', version: info.currentVersion, updateAvailable: info })
  })

  targetGateway.on('disconnected', () => {
    console.log('[Gateway] Disconnected from GAIOP service')
    gatewayVersion = null
    broadcastSSE({ type: 'gatewayState', state: 'disconnected' })
  })

  targetGateway.on('error', (err) => {
    console.error('[Gateway] Error:', err.message)
    debug('Error stack:', err.stack)
  })

  targetGateway.on('event', (event, payload) => {
    debug('Gateway event:', event, 'payload keys:', payload ? Object.keys(payload) : null)
    broadcastSSE({ type: 'event', event, payload })
  })

  targetGateway.on('stateChange', (state) => {
    debug('Gateway state changed to:', state)
    broadcastSSE({ type: 'gatewayState', state })
  })
}

bindGAIOPServiceEvents(gateway)

debug('Connecting to Gateway at:', envConfig.OPENCLAW_WS_URL)
gateway.connect()

function broadcastSSE(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`
  for (const [id, client] of sseClients) {
    if (!canReceiveSseData(client.user, data)) continue
    try {
      client.res.write(message)
    } catch (e) {
      sseClients.delete(id)
    }
  }
}

function isAuthEnabled() {
  return !!db.prepare('SELECT 1 FROM users LIMIT 1').get() || !!(envConfig.AUTH_USERNAME && envConfig.AUTH_PASSWORD)
}

function getGAIOPServiceConfig() {
  return {
    endpoint: envConfig.OPENCLAW_WS_URL,
    accessTokenConfigured: Boolean(envConfig.OPENCLAW_AUTH_TOKEN),
    state: gateway.isConnected ? 'connected' : 'disconnected',
  }
}

function saveGAIOPServiceConfig({ endpoint, accessToken }) {
  const existingContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : ''
  const existing = parseEnvFile(existingContent)
  existing.OPENCLAW_WS_URL = endpoint
  if (accessToken) existing.OPENCLAW_AUTH_TOKEN = accessToken
  writeFileSync(envPath, stringifyEnvFile(existing), 'utf-8')

  gateway.disconnect()
  envConfig = loadEnvConfig()
  gateway = new OpenClawGateway(envConfig.OPENCLAW_WS_URL, envConfig.OPENCLAW_AUTH_TOKEN, envConfig.OPENCLAW_AUTH_PASSWORD, envConfig.LOG_LEVEL)
  bindGAIOPServiceEvents(gateway)
  gateway.connect()
  return getGAIOPServiceConfig()
}

function canReceiveSseData(user, data) {
  if (data?.type !== 'event' || user?.role === 'admin') return true
  const sessionKey = extractSessionKeyFromEvent(data.payload)
  return !!sessionKey && canAccessWorkspaceSession(db, user, sessionKey)
}

const RESET_PASSWORD = 'admin123'

function hashPassword(password) {
  const salt = randomBytes(16).toString('base64')
  const hash = scryptSync(password, salt, 64).toString('base64')
  return `scrypt$${salt}$${hash}`
}

function verifyPassword(password, storedHash) {
  const [algorithm, salt, encodedHash] = String(storedHash || '').split('$')
  if (algorithm !== 'scrypt' || !salt || !encodedHash) return false
  const expected = Buffer.from(encodedHash, 'base64')
  const actual = scryptSync(password, salt, expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    description: user.description || '',
    status: user.status,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
  }
}

function ensureInitialAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count
  if (count || !envConfig.AUTH_USERNAME || !envConfig.AUTH_PASSWORD) return
  const now = Date.now()
  db.prepare(`INSERT INTO users (id, username, password_hash, role, description, status, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', ?, 'active', ?, ?)`)
    .run(randomUUID(), envConfig.AUTH_USERNAME.trim(), hashPassword(envConfig.AUTH_PASSWORD), '初始管理员账户', now, now)
  console.log('[Auth] Initial administrator account created')
}

ensureInitialAdmin()

function checkAuth(req) {
  if (!isAuthEnabled()) return { username: 'anonymous', role: 'admin' }
  let token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.session
  if (!token && req.query && req.query.token) {
    token = req.query.token
  }
  if (!token) return null
  const session = sessions.get(token)
  if (!session) return null
  const now = Date.now()
  if (session.expires < now) {
    sessions.delete(token)
    return null
  }
  const policy = readSessionSettings(db)
  const idleTimeoutMs = policy.idleTimeoutMinutes * 60 * 1000
  const lastActiveAt = session.lastActiveAt || session.createdAt || now
  if (idleTimeoutMs > 0 && lastActiveAt + idleTimeoutMs < now) {
    sessions.delete(token)
    return null
  }
  session.lastActiveAt = now
  return session
}

function authMiddleware(req, res, next) {
  if (!isAuthEnabled()) return next()
  const session = checkAuth(req)
  if (!session) {
    return sendError(res, { status: 401, code: 'UNAUTHORIZED', message: '登录状态已失效，请重新登录' })
  }
  req.user = session
  next()
}

const adminMiddleware = createRoleMiddleware(authMiddleware, ['admin'], '仅管理员可以执行此操作')
const operatorMiddleware = createRoleMiddleware(authMiddleware, ['standard', 'admin'], '当前用户仅有查看权限，不能执行此操作')
const auditViewerMiddleware = createRoleMiddleware(authMiddleware, ['auditor', 'admin'], '审计信息仅审计用户和管理员可查看')

function recordAudit(user, action, target = '', detail = '') {
  try {
    db.prepare(`INSERT INTO audit_logs (id, actor_user_id, actor_username, actor_role, action, target, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), user?.id || null, user?.username || 'system', user?.role || 'system', action,
      String(target || '').slice(0, 200), String(detail || '').slice(0, 500), Date.now()
    )
  } catch (error) {
    console.error('[Audit] Failed to record event:', error.message)
  }
}

// 设置 Hermes 代理的认证中间件

// 迁移保留：认证路由已由下方独立模块接管，不再注册以下旧实现。
function registerLegacyAuthRoutes() {
app.get('/api/auth/config', (req, res) => {
  res.json({
    enabled: isAuthEnabled(),
  })
})

app.post('/api/auth/login', (req, res) => {
  if (!isAuthEnabled()) {
    return res.json({ ok: true, message: 'Auth disabled' })
  }

  const { username, password } = req.body

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Username and password required' })
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username).trim())
  const validUser = user && user.status === 'active' && verifyPassword(password, user.password_hash)
  const validLegacyUser = !user && username === envConfig.AUTH_USERNAME && password === envConfig.AUTH_PASSWORD
  if (!validUser && !validLegacyUser) {
    return res.status(401).json({ ok: false, error: 'Invalid credentials' })
  }

  const token = randomUUID()
  const expires = Date.now() + 24 * 60 * 60 * 1000

  const sessionUser = validUser
    ? { id: user.id, username: user.username, role: user.role }
    : { username: envConfig.AUTH_USERNAME, role: 'admin' }
  sessions.set(token, { ...sessionUser, expires })
  recordAudit(sessionUser, '登录', '管理平台', '登录成功')

  res.json({ ok: true, token, user: sessionUser })
})

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (token) {
    recordAudit(sessions.get(token), '退出登录', '管理平台', '用户主动退出')
    sessions.delete(token)
  }
  res.json({ ok: true })
})

app.get('/api/auth/check', authMiddleware, (req, res) => {
  res.json({ ok: true, authenticated: true, user: { id: req.user.id, username: req.user.username, role: req.user.role } })
})
}

app.use('/api/auth', createAuthRouter({
  db,
  sessions,
  authMiddleware,
  isAuthEnabled,
  getLegacyCredentials: () => ({ username: envConfig.AUTH_USERNAME, password: envConfig.AUTH_PASSWORD }),
  verifyPassword,
  recordAudit,
  createId: randomUUID,
  getSessionSettings: () => readSessionSettings(db),
}))
app.use('/api/system-settings/report-storage', createReportStorageRouter({ adminMiddleware, recordAudit }))
app.use('/api/system-settings/sessions', createSessionSettingsRouter({
  db,
  authMiddleware,
  adminMiddleware,
  recordAudit,
  gateway,
  getGateway: () => gateway,
}))
app.use('/api/system-config/gaiop-service', createGAIOPServiceRouter({
  adminMiddleware,
  recordAudit,
  getServiceConfig: getGAIOPServiceConfig,
  saveServiceConfig: saveGAIOPServiceConfig,
}))
app.use('/api/system-config/alert-ingestion', createAlertIngestionRouter({ db, adminMiddleware, recordAudit }))
app.use('/api/system-upgrade', createSystemUpgradeRouter({
  adminMiddleware,
  recordAudit,
  getUpgradeConfig: () => ({
    serviceUrl: envConfig.GAIOP_UPGRADE_SERVICE_URL,
    internalToken: envConfig.GAIOP_UPGRADE_INTERNAL_TOKEN,
  }),
}))
app.use('/api/channels', createChannelsRouter({
  authMiddleware,
  adminMiddleware,
  recordAudit,
  gateway,
  getGateway: () => gateway,
}))
app.use('/api/workspace/sessions', createWorkspaceSessionsRouter({
  db,
  authMiddleware,
  operatorMiddleware,
  recordAudit,
}))
app.use('/api/alerts', createAlertsRouter({ authMiddleware, recordAudit }))

// 迁移保留：阶段 B 已由下方独立路由接管这些 API。保留旧实现仅用于短期回归比对，
// 不再注册，确认线上稳定后会在后续清理。
function registerLegacyAccountAndConfigurationRoutes() {
app.get('/api/users', authMiddleware, (_req, res) => {
  const users = db.prepare('SELECT id, username, role, description, status, created_at, updated_at FROM users ORDER BY updated_at DESC').all()
  res.json({ ok: true, users: users.map(publicUser) })
})

app.get('/api/audit-logs', auditViewerMiddleware, (req, res) => {
  const requestedLimit = Number.parseInt(String(req.query.limit || '100'), 10)
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 100
  const logs = db.prepare(`SELECT id, actor_username, actor_role, action, target, detail, created_at
    FROM audit_logs ORDER BY created_at DESC LIMIT ?`).all(limit)
  res.json({ ok: true, logs: logs.map((log) => ({
    id: log.id, username: log.actor_username, role: log.actor_role, action: log.action,
    target: log.target || '', detail: log.detail || '', createdAt: log.created_at,
  })) })
})

app.post('/api/users', adminMiddleware, (req, res) => {
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const role = String(req.body?.role || '')
  const description = String(req.body?.description || '').trim()
  const status = String(req.body?.status || 'active')

  if (!username || username.length > 64 || !password || password.length < 6 || !USER_ROLES.has(role) || !USER_STATUSES.has(status) || description.length > 500) {
    return res.status(400).json({ ok: false, error: '用户信息不完整或格式不正确' })
  }
  try {
    const now = Date.now()
    const user = { id: randomUUID(), username, password_hash: hashPassword(password), role, description, status, created_at: now, updated_at: now }
    db.prepare(`INSERT INTO users (id, username, password_hash, role, description, status, created_at, updated_at)
      VALUES (@id, @username, @password_hash, @role, @description, @status, @created_at, @updated_at)`).run(user)
    recordAudit(req.user, '创建用户', username, `角色：${role}；状态：${status}`)
    res.status(201).json({ ok: true, user: publicUser(user) })
  } catch (error) {
    const duplicate = String(error.message).includes('UNIQUE')
    res.status(duplicate ? 409 : 500).json({ ok: false, error: duplicate ? '用户名已存在' : '创建用户失败' })
  }
})

app.post('/api/users/:id/reset-password', adminMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' })
  const updatedAt = Date.now()
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(RESET_PASSWORD), updatedAt, user.id)
  for (const [token, session] of sessions) if (session.id === user.id) sessions.delete(token)
  recordAudit(req.user, '重置用户密码', user.username, '已重置为默认密码')
  res.json({ ok: true, updatedAt })
})

app.put('/api/users/:id/password', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' })
  const newPassword = String(req.body?.newPassword || '')
  const isSelf = req.user.id === user.id
  if (!isSelf && req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '无权修改该用户密码' })
  if (newPassword.length < 6) return res.status(400).json({ ok: false, error: '密码至少 6 位' })
  if (isSelf && !verifyPassword(String(req.body?.currentPassword || ''), user.password_hash)) {
    return res.status(400).json({ ok: false, error: '当前密码不正确' })
  }
  const updatedAt = Date.now()
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(newPassword), updatedAt, user.id)
  for (const [token, session] of sessions) if (session.id === user.id && token !== req.headers.authorization?.replace('Bearer ', '')) sessions.delete(token)
  recordAudit(req.user, isSelf ? '修改本人密码' : '修改用户密码', user.username)
  res.json({ ok: true, updatedAt })
})

app.delete('/api/users/:id', adminMiddleware, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' })
  if (req.user.id === user.id) return res.status(400).json({ ok: false, error: '不能删除当前登录账户' })
  if (user.role === 'admin') {
    const adminCount = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'").get().count
    if (adminCount <= 1) return res.status(400).json({ ok: false, error: '至少需要保留一个已激活的管理员账户' })
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id)
  for (const [token, session] of sessions) if (session.id === user.id) sessions.delete(token)
  recordAudit(req.user, '删除用户', user.username, `角色：${user.role}`)
  res.json({ ok: true })
})

function dataSourceEncryptionMiddleware(_req, res, next) {
  if (!isDataSourceEncryptionReady()) {
    return res.status(503).json({ ok: false, error: '数据源加密密钥未配置，请在服务端环境变量中设置 DATA_SOURCE_ENCRYPTION_KEY' })
  }
  next()
}

app.get('/api/data-sources', authMiddleware, dataSourceEncryptionMiddleware, (_req, res) => {
  const rows = db.prepare(`SELECT id, ip, description, type, username, password_encrypted, status,
    last_tested_at, last_test_message, created_at, updated_at FROM data_sources ORDER BY updated_at DESC`).all()
  res.json({ ok: true, dataSources: rows.map(toPublicDataSource) })
})

app.post('/api/data-sources', adminMiddleware, dataSourceEncryptionMiddleware, (req, res) => {
  const validated = validateDataSourceInput(req.body, { passwordRequired: true })
  if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error })
  try {
    const now = Date.now()
    const source = {
      id: randomUUID(), ...validated.value,
      passwordEncrypted: encryptDataSourcePassword(validated.value.password),
      createdAt: now, updatedAt: now,
    }
    db.prepare(`INSERT INTO data_sources (id, ip, description, type, username, password_encrypted, status, created_at, updated_at)
      VALUES (@id, @ip, @description, @type, @username, @passwordEncrypted, @status, @createdAt, @updatedAt)`).run(source)
    const row = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(source.id)
    recordAudit(req.user, '添加数据源', source.ip, `类型：${source.type}`)
    res.status(201).json({ ok: true, dataSource: toPublicDataSource(row) })
  } catch (error) {
    res.status(500).json({ ok: false, error: '添加数据源失败' })
  }
})

app.put('/api/data-sources/:id', adminMiddleware, dataSourceEncryptionMiddleware, (req, res) => {
  const existing = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ ok: false, error: '数据源不存在' })
  const validated = validateDataSourceInput(req.body, { passwordRequired: false })
  if (!validated.ok) return res.status(400).json({ ok: false, error: validated.error })
  try {
    const value = validated.value
    const passwordEncrypted = value.password ? encryptDataSourcePassword(value.password) : existing.password_encrypted
    const now = Date.now()
    db.prepare(`UPDATE data_sources SET ip = ?, description = ?, type = ?, username = ?, password_encrypted = ?, status = ?, updated_at = ? WHERE id = ?`)
      .run(value.ip, value.description, value.type, value.username, passwordEncrypted, value.status, now, existing.id)
    const row = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(existing.id)
    recordAudit(req.user, '编辑数据源', value.ip, `类型：${value.type}`)
    res.json({ ok: true, dataSource: toPublicDataSource(row) })
  } catch (error) {
    res.status(500).json({ ok: false, error: '更新数据源失败' })
  }
})

app.delete('/api/data-sources/:id', adminMiddleware, dataSourceEncryptionMiddleware, (req, res) => {
  const source = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(req.params.id)
  if (!source) return res.status(404).json({ ok: false, error: '数据源不存在' })
  db.prepare('DELETE FROM data_sources WHERE id = ?').run(source.id)
  recordAudit(req.user, '删除数据源', source.ip, `类型：${source.type}`)
  res.json({ ok: true })
})

app.post('/api/data-sources/:id/test', adminMiddleware, dataSourceEncryptionMiddleware, async (req, res) => {
  const source = db.prepare('SELECT * FROM data_sources WHERE id = ?').get(req.params.id)
  if (!source) return res.status(404).json({ ok: false, error: '数据源不存在' })
  if (source.status === 'disabled') return res.status(400).json({ ok: false, error: '已停用的数据源不能执行连接测试' })
  try {
    const result = await testNapmDataSource({ ip: source.ip, username: source.username, password: decryptDataSourcePassword(source.password_encrypted) })
    const now = Date.now()
    db.prepare('UPDATE data_sources SET status = ?, last_tested_at = ?, last_test_message = ?, updated_at = ? WHERE id = ?')
      .run(result.ok ? 'success' : 'failed', now, result.message, now, source.id)
    recordAudit(req.user, '测试数据源连接', source.ip, result.ok ? '连接成功' : '连接失败')
    res.json({ ok: true, result: { ...result, testedAt: now } })
  } catch (_error) {
    res.status(500).json({ ok: false, error: '数据源测试失败，请检查加密密钥和 NAPM 配置' })
  }
})

}

// 阶段 B：稳定管理接口从服务入口拆出。访问地址保持不变，避免影响已完成的前端页面。
app.use('/api/users', createUsersRouter({
  db,
  sessions,
  authMiddleware,
  adminMiddleware,
  recordAudit,
  hashPassword,
  verifyPassword,
  publicUser,
  userRoles: USER_ROLES,
  userStatuses: USER_STATUSES,
  resetPassword: RESET_PASSWORD,
  createId: randomUUID,
}))
app.use('/api/audit-logs', createAuditRouter({ db, auditViewerMiddleware }))
app.use('/api/data-sources', createDataSourcesRouter({
  db,
  authMiddleware,
  adminMiddleware,
  recordAudit,
  createId: randomUUID,
  decryptDataSourcePassword,
  encryptDataSourcePassword,
  isDataSourceEncryptionReady,
  testNapmDataSource,
  toPublicDataSource,
  validateDataSourceInput,
  getDataSourceRuntimeStatus,
  writeActiveDataSourceRuntime,
}))
app.use('/api/system-config/environment', createSensitiveConfigRouter({
  db,
  adminMiddleware,
  recordAudit,
  encryptSensitiveConfigValue,
  isSensitiveConfigEncryptionReady,
  toPublicSystemSensitiveConfig,
  validateSystemSensitiveConfigInput,
}))
app.use('/api/reports', createReportsRouter({ db, authMiddleware, adminMiddleware, recordAudit }))

// 报告文件管理已替代旧的通用工作区文件浏览器。保留旧实现代码便于回归，
// 但所有 /api/files/* 外部访问统一停用，防止绕过报告目录边界。
app.use('/api/files', authMiddleware, (_req, res) => sendError(res, {
  status: 410,
  code: 'LEGACY_FILE_BROWSER_DISABLED',
  message: '通用文件浏览器已停用，请使用报告文件管理',
}))

// 旧接口会直接读取和写入服务端 .env，无法满足“敏感值不回显”的产品边界。
// 保留下方迁移期实现以便回归对照，但禁止任何正式页面继续调用。
app.use('/api/config', adminMiddleware, (_req, res) => sendError(res, {
  status: 410,
  code: 'LEGACY_CONFIG_API_DISABLED',
  message: '旧环境配置接口已停用，请使用系统配置中的环境与敏感配置模块',
}))

function parseEnvFile(content) {
  const result = {}
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    let value = trimmed.slice(eqIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function stringifyEnvFile(data) {
  const lines = []
  for (const [key, value] of Object.entries(data)) {
    const escaped = value.includes('\n') || value.includes('"') || value.includes("'")
      ? `"${value.replace(/"/g, '\\"')}"`
      : value
    lines.push(`${key}=${escaped}`)
  }
  return lines.join('\n') + '\n'
}

app.get('/api/config', adminMiddleware, (req, res) => {
  try {
    if (!existsSync(envPath)) {
      return res.json({ ok: true, config: {} })
    }
    const content = readFileSync(envPath, 'utf-8')
    const config = parseEnvFile(content)
    res.json({ ok: true, config })
  } catch (err) {
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/config', adminMiddleware, (req, res) => {
  try {
    const { AUTH_USERNAME, AUTH_PASSWORD, OPENCLAW_WS_URL, OPENCLAW_AUTH_TOKEN, OPENCLAW_AUTH_PASSWORD } = req.body
    
    const existingContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : ''
    const existing = parseEnvFile(existingContent)
    
    if (AUTH_USERNAME !== undefined) existing.AUTH_USERNAME = AUTH_USERNAME
    if (AUTH_PASSWORD !== undefined) existing.AUTH_PASSWORD = AUTH_PASSWORD
    if (OPENCLAW_WS_URL !== undefined) existing.OPENCLAW_WS_URL = OPENCLAW_WS_URL
    if (OPENCLAW_AUTH_TOKEN !== undefined) existing.OPENCLAW_AUTH_TOKEN = OPENCLAW_AUTH_TOKEN
    if (OPENCLAW_AUTH_PASSWORD !== undefined) existing.OPENCLAW_AUTH_PASSWORD = OPENCLAW_AUTH_PASSWORD
    
    const newContent = stringifyEnvFile(existing)
    writeFileSync(envPath, newContent, 'utf-8')
    
    const oldConfig = { ...envConfig }
    envConfig = loadEnvConfig()
    
    const wsUrlChanged = oldConfig.OPENCLAW_WS_URL !== envConfig.OPENCLAW_WS_URL
    const tokenChanged = oldConfig.OPENCLAW_AUTH_TOKEN !== envConfig.OPENCLAW_AUTH_TOKEN
    const passwordChanged = oldConfig.OPENCLAW_AUTH_PASSWORD !== envConfig.OPENCLAW_AUTH_PASSWORD
    
    if (wsUrlChanged || tokenChanged || passwordChanged) {
      console.log('[Config] Gateway config changed, reconnecting...')
      gateway.disconnect()
      gateway = new OpenClawGateway(envConfig.OPENCLAW_WS_URL, envConfig.OPENCLAW_AUTH_TOKEN, envConfig.OPENCLAW_AUTH_PASSWORD)
      
      gateway.on('connected', (info) => {
        console.log('[Gateway] Connected to OpenClaw:', info?.server?.version)
        broadcastSSE({ type: 'gatewayState', state: 'connected' })
      })
      gateway.on('disconnected', () => {
        console.log('[Gateway] Disconnected from OpenClaw')
        broadcastSSE({ type: 'gatewayState', state: 'disconnected' })
      })
      gateway.on('error', (err) => {
        console.error('[Gateway] Error:', err.message)
      })
      gateway.on('event', (event, payload) => {
        broadcastSSE({ type: 'event', event, payload })
      })
      gateway.on('stateChange', (state) => {
        broadcastSSE({ type: 'gatewayState', state })
      })
      gateway.connect()
    }
    
    console.log('[Config] Configuration reloaded')
    recordAudit(req.user, '修改环境配置', '系统设置', '已保存环境变量与网关连接配置')
    res.json({ ok: true, message: 'Configuration saved and reloaded.' })
  } catch (err) {
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    gateway: gateway.isConnected ? 'connected' : 'disconnected',
    clients: sseClients.size,
  })
})

app.get('/api/npm/versions', async (req, res) => {
  try {
    const response = await fetch('https://registry.npmjs.org/openclaw')
    if (!response.ok) {
      throw new Error('Failed to fetch versions from npm')
    }
    const data = await response.json()
    const versions = Object.keys(data.versions || {})
    
    // 过滤并排序版本号
    const validVersions = versions.filter(version => /^\d+\.\d+\.\d+/.test(version))
    validVersions.sort((a, b) => {
      const aParts = a.split('.').map(Number)
      const bParts = b.split('.').map(Number)
      
      for (let i = 0; i < 3; i++) {
        const aVal = aParts[i] || 0
        const bVal = bParts[i] || 0
        if (aVal !== bVal) {
          return bVal - aVal
        }
      }
      return 0
    })
    
    res.json({ versions: validVersions })
  } catch (error) {
    console.error('[Server] Failed to fetch npm versions:', error.message)
    res.status(500).json({ error: 'Failed to fetch versions from npm' })
  }
})

app.post('/api/npm/update', adminMiddleware, async (req, res) => {
  try {
    const { version } = req.body
    const packageSpec = version ? `openclaw@${version}` : 'openclaw@latest'
    
    console.log(`[Server] Updating OpenClaw via npm: ${packageSpec}`)
    
    // 执行npm更新命令
    const { execSync } = await import('child_process')
    const output = execSync(`npm install -g ${packageSpec}`, {
      encoding: 'utf8',
      timeout: 120000 // 2分钟超时
    })
    
    console.log('[Server] npm update output:', output)
    
    res.json({ 
      ok: true, 
      message: `Successfully updated to ${packageSpec}`,
      output: output
    })
  } catch (error) {
    console.error('[Server] Failed to update OpenClaw via npm:', error.message)
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      stdout: error.stdout,
      stderr: error.stderr
    })
  }
})

let lastNetworkStats = null
let lastNetworkTime = null

function getNetworkStats() {
  const platform = os.platform()
  let bytesReceived = 0
  let bytesSent = 0

  try {
    if (platform === 'win32') {
      const output = execSync(
        'powershell -NoProfile -Command "Get-NetAdapterStatistics | ConvertTo-Json"',
        { encoding: 'utf8', timeout: 5000 }
      )
      const stats = JSON.parse(output || '[]')
      const adapters = Array.isArray(stats) ? stats : [stats]
      for (const adapter of adapters) {
        if (adapter) {
          bytesReceived += Number(adapter.ReceivedBytes) || 0
          bytesSent += Number(adapter.SentBytes) || 0
        }
      }
    } else {
      const netDev = readFileSync('/proc/net/dev', 'utf8')
      const lines = netDev.trim().split('\n').slice(2)
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 10) {
          const iface = parts[0].replace(':', '')
          if (iface === 'lo') continue
          bytesReceived += parseInt(parts[1], 10) || 0
          bytesSent += parseInt(parts[9], 10) || 0
        }
      }
    }
  } catch {
    bytesReceived = 0
    bytesSent = 0
  }

  return { bytesReceived, bytesSent }
}

async function getDiskSpace() {
  try {
    const platform = os.platform()
    let checkPath = '/'
    if (platform === 'win32') {
      checkPath = process.env.SystemDrive || 'C:\\'
    }
    const diskSpace = await checkDiskSpace(checkPath)
    return {
      total: diskSpace.size,
      free: diskSpace.free,
      used: diskSpace.size - diskSpace.free,
    }
  } catch {
    return { total: 0, free: 0, used: 0 }
  }
}

app.get('/api/system/metrics', authMiddleware, async (req, res) => {
  try {
    const cpus = os.cpus()
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem

    const diskInfo = await getDiskSpace()
    const diskTotal = diskInfo.total
    const diskFree = diskInfo.free

    let cpuUsage = 0
    for (const cpu of cpus) {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0)
      const idle = cpu.times.idle
      cpuUsage += ((total - idle) / total) * 100
    }
    cpuUsage = cpuUsage / cpus.length

    let presence = []
    try {
      if (gateway.isConnected) {
        presence = await gateway.call('system-presence')
        if (!Array.isArray(presence)) {
          presence = presence?.presence || presence?.items || presence?.list || []
        }
      }
    } catch {
      presence = []
    }

    let uptime = os.uptime()
    try {
      if (gateway.isConnected) {
        const health = await gateway.call('health')
        uptime = health?.uptime || uptime
      }
    } catch {
      // use os uptime
    }

    const networkStats = getNetworkStats()

    res.json({
      ok: true,
      metrics: {
        cpu: {
          usage: Math.round(cpuUsage * 10) / 10,
          cores: cpus.length,
          model: cpus[0]?.model || 'Unknown',
        },
        memory: {
          total: totalMem,
          used: usedMem,
          free: freeMem,
          usagePercent: Math.round((usedMem / totalMem) * 1000) / 10,
        },
        disk: {
          total: diskTotal,
          used: diskTotal - diskFree,
          free: diskFree,
          usagePercent: diskTotal > 0 ? Math.round(((diskTotal - diskFree) / diskTotal) * 1000) / 10 : 0,
        },
        network: {
          bytesReceived: networkStats.bytesReceived,
          bytesSent: networkStats.bytesSent,
        },
        uptime,
        loadAverage: os.loadavg(),
        platform: os.platform(),
        hostname: os.hostname(),
      },
      presence,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

const WORKSPACE_BASE = join(__dirname, '..')

const agentWorkspaceCache = new Map()

function expandHomePath(path) {
  if (!path) return path
  if (path.startsWith('~')) {
    return join(os.homedir(), path.slice(1))
  }
  return path
}

function safePath(userPath, workspaceBase) {
  if (!workspaceBase) return null
  
  const expandedBase = resolve(expandHomePath(workspaceBase))
  const targetPath = resolve(expandedBase, userPath || '')
  
  const normalizedBase = expandedBase.toLowerCase()
  const normalizedTarget = targetPath.toLowerCase()
  
  if (!normalizedTarget.startsWith(normalizedBase)) {
    console.log('[Files] Path escape detected:', { 
      base: expandedBase, 
      target: targetPath,
      userPath 
    })
    return null
  }
  
  return targetPath
}

async function getAgentWorkspace(agentId) {
  if (agentWorkspaceCache.has(agentId)) {
    const cached = agentWorkspaceCache.get(agentId)
    if (Date.now() - cached.timestamp < 60000) {
      return cached.workspace
    }
  }
  
  if (!gateway.isConnected) {
    return null
  }
  
  try {
    const result = await gateway.call('agents.files.list', { agentId })
    const workspace = result?.workspace || result?.dir || result?.path
    if (workspace) {
      agentWorkspaceCache.set(agentId, { workspace, timestamp: Date.now() })
    }
    return workspace
  } catch (e) {
    console.error('[Files] Failed to get agent workspace:', e.message)
    return null
  }
}

app.get('/api/agents/workspace', authMiddleware, async (req, res) => {
  try {
    const agentId = req.query.agentId || 'main'
    
    if (!gateway.isConnected) {
      return res.status(503).json({ ok: false, error: { message: 'Gateway not connected' } })
    }
    
    const workspace = await getAgentWorkspace(agentId)
    
    if (!workspace) {
      return res.status(404).json({ ok: false, error: { message: 'Could not determine agent workspace' } })
    }
    
    res.json({
      ok: true,
      agentId,
      workspace,
      expandedPath: expandHomePath(workspace)
    })
  } catch (err) {
    console.error('[Agents] Workspace error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

app.get('/api/files/list', authMiddleware, async (req, res) => {
  try {
    const relPath = req.query.path || ''
    const workspaceParam = req.query.workspace || ''
    
    if (!workspaceParam) {
      return res.status(400).json({ ok: false, error: { message: 'Workspace parameter is required' } })
    }
    
    const workspaceBase = expandHomePath(workspaceParam)
    const absPath = safePath(relPath, workspaceBase)
    
    console.log('[Files] List:', { relPath, workspaceParam, workspaceBase, absPath })
    
    if (!absPath) {
      return res.status(400).json({ ok: false, error: { message: 'Invalid path' } })
    }
    
    if (!existsSync(absPath)) {
      return res.json({ ok: true, files: [], path: relPath, workspaceRoot: workspaceBase })
    }
    
    const stats = statSync(absPath)
    if (!stats.isDirectory()) {
      return res.json({ ok: true, files: [], path: relPath, workspaceRoot: workspaceBase })
    }
    
    const entries = readdirSync(absPath, { withFileTypes: true })
    const files = entries.map(entry => {
      const fullPath = join(absPath, entry.name)
      let size = 0
      let mtime = 0
      
      try {
        const s = statSync(fullPath)
        size = s.size
        mtime = s.mtimeMs
      } catch {}
      
      const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name
      
      return {
        name: entry.name,
        path: entryRelPath.replace(/\\/g, '/'),
        type: entry.isDirectory() ? 'directory' : 'file',
        isDirectory: entry.isDirectory(),
        size: entry.isFile() ? size : undefined,
        updatedAtMs: mtime,
        extension: entry.isFile() ? extname(entry.name).slice(1).toLowerCase() : undefined,
      }
    })
    
    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    
    res.json({ 
      ok: true, 
      files,
      path: relPath,
      workspaceRoot: workspaceBase
    })
  } catch (err) {
    console.error('[Files] List error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.get('/api/files/get', authMiddleware, async (req, res) => {
  try {
    let relPath = req.query.path || req.query.name
    const workspaceParam = req.query.workspace || ''
    const binary = req.query.binary === 'true'
    
    if (!relPath) {
      return res.status(400).json({ ok: false, error: { message: 'Path is required' } })
    }
    
    if (!workspaceParam) {
      return res.status(400).json({ ok: false, error: { message: 'Workspace parameter is required' } })
    }
    
    // Handle double URL encoding from img src
    try {
      let decoded = decodeURIComponent(relPath)
      // Check if it was double-encoded
      if (decoded.includes('%')) {
        decoded = decodeURIComponent(decoded)
      }
      relPath = decoded
    } catch (e) {
      // If decode fails, use original
    }
    
    const workspaceBase = expandHomePath(workspaceParam)
    const absPath = safePath(relPath, workspaceBase)
    
    console.log('[Files] Get:', { relPath, workspaceParam, absPath, binary })
    
    if (!absPath) {
      return res.status(400).json({ ok: false, error: { message: 'Invalid path' } })
    }
    
    if (!existsSync(absPath)) {
      return res.status(404).json({ ok: false, error: { message: 'File not found' } })
    }
    
    const stats = statSync(absPath)
    if (stats.isDirectory()) {
      return res.status(400).json({ ok: false, error: { message: 'Cannot read directory' } })
    }
    
    const ext = extname(absPath).slice(1).toLowerCase()
    const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']
    const pdfExts = ['pdf']
    
    if (binary && imgExts.includes(ext)) {
      const contentTypeMap = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        webp: 'image/webp',
        ico: 'image/x-icon',
        bmp: 'image/bmp',
      }
      
      const contentType = contentTypeMap[ext] || 'application/octet-stream'
      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Length', stats.size)
      
      const stream = createReadStream(absPath)
      stream.pipe(res)
      
      stream.on('error', (err) => {
        console.error('[Files] Stream error:', err.message)
        if (!res.headersSent) {
          res.status(500).json({ ok: false, error: { message: err.message } })
        }
      })
      return
    }
    
    if (binary && pdfExts.includes(ext)) {
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Length', stats.size)
      
      const stream = createReadStream(absPath)
      stream.pipe(res)
      
      stream.on('error', (err) => {
        console.error('[Files] PDF stream error:', err.message)
        if (!res.headersSent) {
          res.status(500).json({ ok: false, error: { message: err.message } })
        }
      })
      return
    }
    
    if (imgExts.includes(ext)) {
      const buffer = readFileSync(absPath)
      const base64 = buffer.toString('base64')
      res.json({
        ok: true,
        file: {
          name: basename(absPath),
          path: relPath,
          content: base64,
          isBase64: true,
          size: stats.size,
          updatedAtMs: stats.mtimeMs,
          extension: ext,
        }
      })
    } else {
      const content = readFileSync(absPath, 'utf-8')
      res.json({
        ok: true,
        file: {
          name: basename(absPath),
          path: relPath,
          content,
          size: stats.size,
          updatedAtMs: stats.mtimeMs,
          extension: ext,
        }
      })
    }
  } catch (err) {
    console.error('[Files] Get error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/files/set', adminMiddleware, async (req, res) => {
  try {
    const { path: relPath, name, content, workspace: workspaceParam } = req.body
    const filePath = relPath || name
    
    if (!filePath) {
      return res.status(400).json({ ok: false, error: { message: 'Path is required' } })
    }
    
    if (!workspaceParam) {
      return res.status(400).json({ ok: false, error: { message: 'Workspace parameter is required' } })
    }
    
    const workspaceBase = expandHomePath(workspaceParam)
    const absPath = safePath(filePath, workspaceBase)
    
    console.log('[Files] Set:', { filePath, workspaceParam, absPath })
    
    if (!absPath) {
      return res.status(400).json({ ok: false, error: { message: 'Invalid path' } })
    }
    
    const parentDir = dirname(absPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }
    
    if (content === null || content === undefined) {
      if (existsSync(absPath)) {
        unlinkSync(absPath)
      }
      res.json({ ok: true, deleted: true })
    } else {
      writeFileSync(absPath, content, 'utf-8')
      const stats = statSync(absPath)
      res.json({
        ok: true,
        file: {
          name: basename(absPath),
          path: filePath,
          size: stats.size,
          updatedAtMs: stats.mtimeMs,
        }
      })
    }
  } catch (err) {
    console.error('[Files] Set error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/files/mkdir', adminMiddleware, async (req, res) => {
  try {
    const { path: relPath, name, workspace: workspaceParam } = req.body
    const dirPath = relPath || name
    
    if (!dirPath) {
      return res.status(400).json({ ok: false, error: { message: 'Path is required' } })
    }
    
    if (!workspaceParam) {
      return res.status(400).json({ ok: false, error: { message: 'Workspace parameter is required' } })
    }
    
    const workspaceBase = expandHomePath(workspaceParam)
    const absPath = safePath(dirPath, workspaceBase)
    
    console.log('[Files] Mkdir:', { dirPath, workspaceParam, absPath })
    
    if (!absPath) {
      return res.status(400).json({ ok: false, error: { message: 'Invalid path' } })
    }
    
    if (existsSync(absPath)) {
      return res.status(400).json({ ok: false, error: { message: 'Already exists' } })
    }
    
    mkdirSync(absPath, { recursive: true })
    
    res.json({
      ok: true,
      directory: {
        name: basename(absPath),
        path: dirPath,
      }
    })
  } catch (err) {
    console.error('[Files] Mkdir error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/files/delete', adminMiddleware, async (req, res) => {
  try {
    const { path: relPath, name, workspace: workspaceParam } = req.body
    const filePath = relPath || name
    
    if (!filePath) {
      return res.status(400).json({ ok: false, error: { message: 'Path is required' } })
    }
    
    if (!workspaceParam) {
      return res.status(400).json({ ok: false, error: { message: 'Workspace parameter is required' } })
    }
    
    const workspaceBase = expandHomePath(workspaceParam)
    const absPath = safePath(filePath, workspaceBase)
    
    console.log('[Files] Delete:', { filePath, workspaceParam, absPath })
    
    if (!absPath) {
      return res.status(400).json({ ok: false, error: { message: 'Invalid path' } })
    }
    
    if (!existsSync(absPath)) {
      return res.status(404).json({ ok: false, error: { message: 'Not found' } })
    }
    
    rmSync(absPath, { recursive: true, force: true })
    
    res.json({ ok: true, deleted: true })
  } catch (err) {
    console.error('[Files] Delete error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/files/rename', adminMiddleware, async (req, res) => {
  try {
    const { oldPath, newPath, workspace: workspaceParam } = req.body
    
    if (!oldPath || !newPath) {
      return res.status(400).json({ ok: false, error: { message: 'Old path and new path are required' } })
    }
    
    if (!workspaceParam) {
      return res.status(400).json({ ok: false, error: { message: 'Workspace parameter is required' } })
    }
    
    const workspaceBase = expandHomePath(workspaceParam)
    const absOldPath = safePath(oldPath, workspaceBase)
    const absNewPath = safePath(newPath, workspaceBase)
    
    console.log('[Files] Rename:', { oldPath, newPath, absOldPath, absNewPath })
    
    if (!absOldPath || !absNewPath) {
      return res.status(400).json({ ok: false, error: { message: 'Invalid path' } })
    }
    
    if (!existsSync(absOldPath)) {
      return res.status(404).json({ ok: false, error: { message: 'Source not found' } })
    }
    
    if (existsSync(absNewPath)) {
      return res.status(400).json({ ok: false, error: { message: 'Target already exists' } })
    }
    
    const { renameSync } = await import('fs')
    renameSync(absOldPath, absNewPath)
    
    res.json({ 
      ok: true, 
      renamed: true,
      oldPath,
      newPath 
    })
  } catch (err) {
    console.error('[Files] Rename error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
})

app.post('/api/files/upload', adminMiddleware, upload.single('file'), async (req, res) => {
  try {
    const file = req.file
    const relPath = req.body.path
    const workspaceParam = req.body.workspace
    
    if (!file) {
      return res.status(400).json({ ok: false, error: { message: 'No file uploaded' } })
    }
    
    if (!relPath) {
      return res.status(400).json({ ok: false, error: { message: 'Path is required' } })
    }
    
    if (!workspaceParam) {
      return res.status(400).json({ ok: false, error: { message: 'Workspace parameter is required' } })
    }
    
    const workspaceBase = expandHomePath(workspaceParam)
    const absPath = safePath(relPath, workspaceBase)
    
    console.log('[Files] Upload:', { relPath, workspaceParam, absPath, size: file.size })
    
    if (!absPath) {
      return res.status(400).json({ ok: false, error: { message: 'Invalid path' } })
    }
    
    const parentDir = dirname(absPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }
    
    await fsPromises.writeFile(absPath, file.buffer)
    
    const stats = statSync(absPath)
    res.json({
      ok: true,
      file: {
        name: basename(absPath),
        path: relPath,
        size: stats.size,
        updatedAtMs: stats.mtimeMs,
      }
    })
  } catch (err) {
    console.error('[Files] Upload error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.get('/api/status', authMiddleware, async (req, res) => {
  try {
    if (!gateway.isConnected) {
      return res.status(503).json({ error: 'Gateway not connected' })
    }
    const status = await gateway.call('status')
    res.json({ ok: true, payload: status })
  } catch (err) {
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/rpc', authMiddleware, async (req, res) => {
  const method = typeof req.body?.method === 'string' ? req.body.method.trim() : ''
  const params = req.body?.params

  if (!method) {
    return sendError(res, { status: 400, code: 'RPC_METHOD_REQUIRED', message: '必须提供 RPC 方法' })
  }

  const permission = getRpcPermissionDecision(req.user, method)
  if (!permission.allowed) {
    return sendError(res, { status: 403, code: permission.code, message: permission.message })
  }

  if (!gateway.isConnected) {
    return sendError(res, { status: 503, code: 'GATEWAY_UNAVAILABLE', message: 'GAIOP 智能体服务暂未连接' })
  }

  const isSessionList = SESSION_LIST_METHODS.has(method)
  const isConversationSend = isConversationSessionSend(method, params)
  const isSessionScoped = SESSION_SCOPED_READ_METHODS.has(method)
    || SESSION_SCOPED_WRITE_METHODS.has(method)
    || (method === 'agent' && isConversationSend)
  const sessionKey = isSessionScoped ? getSessionKeyFromParams(params) : ''
  if (isSessionScoped) {
    if (isLegacySessionHidden(db, sessionKey)) {
      return sendError(res, { status: 404, code: 'SESSION_NOT_FOUND', message: '会话不存在或无权访问' })
    }
    const access = ensureWorkspaceSessionAccess(db, req.user, sessionKey)
    if (!access.ok) {
      return sendError(res, { status: 404, code: access.code, message: access.message })
    }
  }

  try {
    // OpenClaw protects its default `main` session from physical deletion.
    // Retire that old shared WebChat record from GAIOP instead of bypassing
    // Gateway safeguards or mutating its private storage.
    if ((method === 'sessions.delete' || method === 'session.delete') && isLegacySharedWebSessionKey(sessionKey)) {
      if (!hideLegacySharedSession(db, req.user, sessionKey)) {
        throw new Error('历史共享会话无法移出列表')
      }
      recordAudit(req.user, '移出历史共享会话', sessionKey, '已从 GAIOP 会话列表隐藏；未修改 Gateway 历史')
      return res.json({ ok: true, payload: { key: sessionKey, retired: true } })
    }
    const activeDataSource = method === 'chat.send'
      ? db.prepare('SELECT id FROM data_sources WHERE is_active = 1 LIMIT 1').get()
      : null
    const webSessionTitleCandidate = isConversationSend
      ? getConversationTitleCandidate(method, params)
      : ''
    const reportProvenance = method === 'chat.send'
      ? attachReportProvenance(params, req.user, {
        enabled: envConfig.GAIOP_REPORT_PROVENANCE_ENABLED === 'true',
        signingKey: envConfig.GAIOP_REPORT_PROVENANCE_SIGNING_KEY,
        storeDirectory: envConfig.GAIOP_REPORT_PROVENANCE_STORE_DIR,
        dataSourceId: activeDataSource?.id,
      })
      : { params, attached: false }
    const result = await gateway.call(method, reportProvenance.params)
    // Save the first successful WebChat request as its fixed, local title.
    // The title is never model-generated and is not sent to the Gateway.
    if (isConversationSend) setWorkspaceSessionTitleIfEmpty(db, sessionKey, webSessionTitleCandidate)
    let payload = method === 'config.get' && req.user?.role !== 'admin'
      ? sanitizeGatewayConfigPayload(result)
      : result
    if (isSessionList) {
      payload = filterSessionListPayload(payload, listOwnedWorkspaceSessionKeys(db, req.user))
      payload = filterHiddenLegacySessions(db, payload)
      payload = enrichSessionPayload(db, payload)
    } else if (method === 'sessions.get' || method === 'session.get') {
      payload = enrichSessionPayload(db, payload)
    }
    if (method === 'sessions.delete' || method === 'session.delete') {
      markWorkspaceSessionDeleted(db, sessionKey)
    }
    if (!isReadOnlyRpcMethod(method)) recordAudit(req.user, '执行业务操作', method)
    res.json({ ok: true, payload })
  } catch (err) {
    res.status(500).json({ ok: false, error: { message: err.message }, code: 'RPC_CALL_FAILED' })
  }
})

app.get('/api/events', authMiddleware, (req, res) => {
  debug('[SSE] New client connecting, auth check passed')
  
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const clientId = randomUUID()
  sseClients.set(clientId, { res, user: req.user, subscriptions: new Set(['*']) })
  debug('[SSE] Client connected:', clientId, 'total clients:', sseClients.size)

  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`)

  const initialState = gateway.isConnected ? 'connected' : 'disconnected'
  debug('[SSE] Sending initial state to client:', clientId, 'state:', initialState, 'gatewayVersion:', gatewayVersion)
  res.write(`data: ${JSON.stringify({ 
    type: 'gatewayState', 
    state: initialState,
    version: initialState === 'connected' ? gatewayVersion : null,
    updateAvailable: initialState === 'connected' ? updateInfo : null
  })}\n\n`)

  req.on('close', () => {
    sseClients.delete(clientId)
    debug('[SSE] Client disconnected:', clientId, 'remaining clients:', sseClients.size)
  })
})

app.get('/api/terminal/stream', adminMiddleware, (req, res) => {
  const cols = parseInt(req.query.cols) || 120
  const rows = parseInt(req.query.rows) || 36
  const nodeId = req.query.nodeId || 'local'

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const sessionId = randomUUID()
  const now = Date.now()
  
  const sendEvent = (type, data = {}) => {
    try {
      const event = { type, sessionId, ...data }
      res.write(`data: ${JSON.stringify(event)}\n\n`)
      return true
    } catch (e) {
      console.error('[Terminal] Error sending event:', e.message)
      return false
    }
  }

  try {
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash'
    
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME || process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' }
    })

    terminalSessions.set(sessionId, { 
      ptyProcess, 
      nodeId, 
      res, 
      createdAt: now,
      lastHeartbeat: now 
    })

    ptyProcess.onData((data) => {
      try {
        const sent = sendEvent('output', { data })
        if (!sent) {
          console.log(`[Terminal] Failed to send output for session ${sessionId}, cleaning up`)
          cleanupTerminalSession(sessionId)
        }
      } catch (e) {
        console.error('[Terminal] Error sending output:', e.message)
        cleanupTerminalSession(sessionId)
      }
    })

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[Terminal] Session ${sessionId} exited with code ${exitCode}`)
      sendEvent('disconnected', { message: `Process exited with code ${exitCode}` })
      cleanupTerminalSession(sessionId)
    })

    console.log(`[Terminal] Session ${sessionId} created (shell: ${shell}, size: ${cols}x${rows})`)
    sendEvent('connected', { cols, rows })

    req.on('close', () => {
      console.log(`[Terminal] Client disconnected, cleaning up session ${sessionId}`)
      cleanupTerminalSession(sessionId)
    })

    req.on('error', (err) => {
      console.error(`[Terminal] Request error for session ${sessionId}:`, err.message)
      cleanupTerminalSession(sessionId)
    })

  } catch (err) {
    console.error('[Terminal] Failed to create PTY:', err.message)
    sendEvent('error', { message: `Failed to create terminal: ${err.message}` })
    res.end()
  }
})

app.post('/api/terminal/input', adminMiddleware, (req, res) => {
  const { sessionId, data } = req.body

  if (!sessionId || !data) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId and data are required' } })
  }

  const session = terminalSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }

  try {
    session.ptyProcess.write(data)
    res.json({ ok: true })
  } catch (err) {
    console.error('[Terminal] Error writing to PTY:', err.message)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/terminal/resize', adminMiddleware, (req, res) => {
  const { sessionId, cols, rows } = req.body

  if (!sessionId || cols === undefined || rows === undefined) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId, cols, and rows are required' } })
  }

  const session = terminalSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }

  try {
    session.ptyProcess.resize(cols, rows)
    res.json({ ok: true, cols, rows })
  } catch (err) {
    console.error('[Terminal] Error resizing PTY:', err.message)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/terminal/destroy', adminMiddleware, (req, res) => {
  const { sessionId } = req.body

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId is required' } })
  }

  const cleaned = cleanupTerminalSession(sessionId)
  if (cleaned) {
    console.log(`[Terminal] Session ${sessionId} destroyed via API`)
  }
  res.json({ ok: true, message: cleaned ? 'Session destroyed' : 'Session already destroyed' })
})

app.post('/api/terminal/heartbeat', adminMiddleware, (req, res) => {
  const { sessionId } = req.body

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId is required' } })
  }

  const session = terminalSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }

  session.lastHeartbeat = Date.now()
  res.json({ ok: true })
})

// ============ Hermes CLI API ============

function findHermesCliPath() {
  if (envConfig.HERMES_CLI_PATH && existsSync(envConfig.HERMES_CLI_PATH)) {
    return envConfig.HERMES_CLI_PATH
  }

  const homeDir = os.homedir()
  const possiblePaths = []

  if (process.platform === 'win32') {
    possiblePaths.push(
      join(homeDir, 'hermes-agent', '.venv', 'Scripts', 'hermes.exe'),
      join(homeDir, '.local', 'bin', 'hermes.exe'),
      'C:\\hermes-agent\\.venv\\Scripts\\hermes.exe'
    )
  } else {
    possiblePaths.push(
      join(homeDir, '.local', 'bin', 'hermes'),
      join(homeDir, 'hermes-agent', '.venv', 'bin', 'hermes'),
      '/usr/local/bin/hermes',
      '/usr/bin/hermes',
      '/data/user/work/hermes-agent/.venv/bin/hermes'
    )
  }

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      try {
        const stat = statSync(p)
        if (stat.isFile() || stat.isSymbolicLink()) {
          return p
        }
      } catch {}
    }
  }

  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which'
    const result = execSync(`${whichCmd} hermes`, { encoding: 'utf8', timeout: 5000 }).trim()
    if (result && existsSync(result.split('\n')[0])) {
      return result.split('\n')[0]
    }
  } catch {}

  if (process.platform !== 'win32') {
    const searchDirs = [
      homeDir,
      '/usr/local',
      '/usr',
      '/opt',
      '/data'
    ]
    
    for (const searchDir of searchDirs) {
      if (!existsSync(searchDir)) continue
      try {
        const findCmd = `find "${searchDir}" -type f -name "hermes" 2>/dev/null | head -5`
        const result = execSync(findCmd, { encoding: 'utf8', timeout: 30000 }).trim()
        if (result) {
          const lines = result.split('\n').filter(Boolean)
          for (const line of lines) {
            const path = line.trim()
            if (path && existsSync(path)) {
              try {
                const stat = statSync(path)
                if (stat.isFile() || stat.isSymbolicLink()) {
                  console.log(`[HermesCLI] Found hermes at: ${path}`)
                  return path
                }
              } catch {}
            }
          }
        }
      } catch {}
    }
  }

  return null
}

function findHermesHome(hermesCliPath) {
  if (envConfig.HERMES_HOME && existsSync(envConfig.HERMES_HOME)) {
    return envConfig.HERMES_HOME
  }

  const homeDir = os.homedir()
  const hermesDataDir = join(homeDir, '.hermes')
  if (existsSync(hermesDataDir)) {
    return homeDir
  }

  if (hermesCliPath) {
    const venvBin = dirname(hermesCliPath)
    const venvDir = dirname(venvBin)
    const possibleHome = dirname(venvDir)
    if (existsSync(possibleHome)) {
      return possibleHome
    }
  }

  const possibleHomes = [
    join(homeDir, 'hermes-agent'),
    '/data/user/work/hermes-agent'
  ]

  for (const h of possibleHomes) {
    if (existsSync(h)) {
      return h
    }
  }

  return homeDir
}

const HERMES_CLI_PATH = findHermesCliPath()
const HERMES_HOME = findHermesHome(HERMES_CLI_PATH)
const HERMES_VENV_BIN = HERMES_CLI_PATH ? dirname(HERMES_CLI_PATH) : null

console.log('[HermesCLI] HERMES_CLI_PATH:', HERMES_CLI_PATH)
console.log('[HermesCLI] HERMES_HOME:', HERMES_HOME)
console.log('[HermesCLI] HERMES_VENV_BIN:', HERMES_VENV_BIN)

// GET /api/hermes-cli/sessions — List all sessions
app.get('/api/hermes-cli/sessions', authMiddleware, (req, res) => {
  const sessions = []
  for (const [id, session] of hermesCliSessions) {
    const isProcessAlive = session.ptyProcess && !session.ptyProcess.killed
    sessions.push({
      id,
      name: session.name || null,
      args: session.args || [],
      createdAt: session.createdAt,
      lastHeartbeat: session.lastHeartbeat,
      status: isProcessAlive ? (session.res ? 'connected' : 'running') : 'exited',
    })
  }
  res.json({ ok: true, sessions })
})

// POST /api/hermes-cli/sessions/rename — Rename a session
app.post('/api/hermes-cli/sessions/rename', adminMiddleware, (req, res) => {
  const { sessionId, name } = req.body

  if (!sessionId || !name) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId and name are required' } })
  }

  const session = hermesCliSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }

  session.name = name
  console.log(`[HermesCLI] Session ${sessionId} renamed to "${name}"`)
  res.json({ ok: true })
})

// GET /api/hermes-cli/stream — Create new or reconnect to existing session
app.get('/api/hermes-cli/stream', adminMiddleware, (req, res) => {
  const cols = parseInt(req.query.cols) || 120
  const rows = parseInt(req.query.rows) || 36
  const existingSessionId = req.query.sessionId || null

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // --- Reconnect to existing session ---
  if (existingSessionId) {
    const session = hermesCliSessions.get(existingSessionId)
    if (!session) {
      res.write(`data: ${JSON.stringify({ type: 'error', sessionId: existingSessionId, message: 'Session not found' })}\n\n`)
      res.end()
      return
    }

    if (!session.ptyProcess || session.ptyProcess.killed) {
      res.write(`data: ${JSON.stringify({ type: 'error', sessionId: existingSessionId, message: 'Session process has exited' })}\n\n`)
      res.end()
      hermesCliSessions.delete(existingSessionId)
      return
    }

    const sessionId = existingSessionId
    const sendEvent = (type, data = {}) => {
      try {
        const event = { type, sessionId, ...data }
        res.write(`data: ${JSON.stringify(event)}\n\n`)
        if (typeof res.flush === 'function') {
          res.flush()
        }
        return true
      } catch (e) {
        console.error('[HermesCLI] Error sending event:', e.message)
        return false
      }
    }

    // Attach new response to existing session
    session.res = res
    session.lastHeartbeat = Date.now()

    // Send connected event FIRST (before buffer replay)
    console.log(`[HermesCLI] Session ${sessionId} (${session.name || 'unnamed'}) reconnected (size: ${cols}x${rows})`)
    sendEvent('connected', { cols, rows, reconnect: true })

    // Resize PTY to match new client dimensions
    try {
      session.ptyProcess.resize(cols, rows)
    } catch (e) {
      // Ignore resize errors on reconnect
    }

    // Replay output buffer AFTER connected event
    if (session.outputBuffer && session.outputBuffer.length > 0) {
      for (const chunk of session.outputBuffer) {
        sendEvent('output', { data: chunk })
      }
    }

    req.on('close', () => {
      console.log(`[HermesCLI] Client disconnected from session ${sessionId}, detaching (process stays alive)`)
      detachHermesCliSession(sessionId)
    })

    req.on('error', (err) => {
      console.error(`[HermesCLI] Request error for session ${sessionId}:`, err.message)
      detachHermesCliSession(sessionId)
    })

    return
  }

  // --- Create new session ---
  if (!HERMES_CLI_PATH) {
    res.status(503).json({ error: 'Hermes CLI not found. Please install hermes-agent or configure HERMES_CLI_PATH in .env' })
    return
  }

  const sessionId = randomUUID()
  const now = Date.now()
  hermesCliSessionCounter++
  const sessionName = `Session #${hermesCliSessionCounter}`

  // Parse CLI args from query
  const cliArgs = []
  const queryArgs = req.query.args
  if (queryArgs) {
    if (Array.isArray(queryArgs)) {
      cliArgs.push(...queryArgs)
    } else {
      cliArgs.push(...queryArgs.split(' '))
    }
  }

  const sendEvent = (type, data = {}) => {
    try {
      const event = { type, sessionId, ...data }
      res.write(`data: ${JSON.stringify(event)}\n\n`)
      if (typeof res.flush === 'function') {
        res.flush()
      }
      return true
    } catch (e) {
      console.error('[HermesCLI] Error sending event:', e.message)
      return false
    }
  }

  try {
    const hermesEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      HERMES_HOME: HERMES_HOME,
      HOME: os.homedir(),
      PATH: `${HERMES_VENV_BIN}:${process.env.PATH || ''}`,
    }

    console.log('[HermesCLI] Spawning:', HERMES_CLI_PATH, cliArgs)
    console.log('[HermesCLI] CWD:', HERMES_HOME)
    console.log('[HermesCLI] ENV HOME:', hermesEnv.HOME, 'HERMES_HOME:', hermesEnv.HERMES_HOME)

    const ptyProcess = pty.spawn(HERMES_CLI_PATH, cliArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: HERMES_HOME,
      env: hermesEnv,
    })

    hermesCliSessions.set(sessionId, {
      ptyProcess,
      res,
      createdAt: now,
      lastHeartbeat: now,
      name: sessionName,
      args: cliArgs,
      outputBuffer: [],
      outputBufferSize: 0,
    })

    ptyProcess.onData((data) => {
      try {
        const session = hermesCliSessions.get(sessionId)
        if (session) {
          addOutputToBuffer(session, data)
        }
        const sent = sendEvent('output', { data })
        if (!sent) {
          console.log(`[HermesCLI] Failed to send output for session ${sessionId}, detaching`)
          detachHermesCliSession(sessionId)
        }
      } catch (e) {
        console.error('[HermesCLI] Error sending output:', e.message)
        detachHermesCliSession(sessionId)
      }
    })

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[HermesCLI] Session ${sessionId} (${sessionName}) exited with code ${exitCode}`)
      sendEvent('disconnected', { message: `Process exited with code ${exitCode}` })
      hermesCliSessions.delete(sessionId)
    })

    console.log(`[HermesCLI] Session ${sessionId} (${sessionName}) created (args: ${cliArgs.join(' ') || 'none'}, size: ${cols}x${rows})`)
    sendEvent('connected', { cols, rows, name: sessionName })

    req.on('close', () => {
      console.log(`[HermesCLI] Client disconnected from session ${sessionId}, detaching (process stays alive)`)
      detachHermesCliSession(sessionId)
    })

    req.on('error', (err) => {
      console.error(`[HermesCLI] Request error for session ${sessionId}:`, err.message)
      detachHermesCliSession(sessionId)
    })

  } catch (err) {
    console.error('[HermesCLI] Failed to create PTY:', err.message)
    sendEvent('error', { message: `Failed to create Hermes CLI terminal: ${err.message}` })
    res.end()
  }
})

app.post('/api/hermes-cli/input', adminMiddleware, (req, res) => {
  const { sessionId, data } = req.body

  if (!sessionId || !data) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId and data are required' } })
  }

  const session = hermesCliSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }

  try {
    session.ptyProcess.write(data)
    res.json({ ok: true })
  } catch (err) {
    console.error('[HermesCLI] Error writing to PTY:', err.message)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/hermes-cli/resize', adminMiddleware, (req, res) => {
  const { sessionId, cols, rows } = req.body

  if (!sessionId || cols === undefined || rows === undefined) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId, cols, and rows are required' } })
  }

  const session = hermesCliSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }

  try {
    session.ptyProcess.resize(cols, rows)
    res.json({ ok: true, cols, rows })
  } catch (err) {
    console.error('[HermesCLI] Error resizing PTY:', err.message)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/hermes-cli/destroy', adminMiddleware, (req, res) => {
  const { sessionId } = req.body

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId is required' } })
  }

  const cleaned = cleanupHermesCliSession(sessionId)
  if (cleaned) {
    console.log(`[HermesCLI] Session ${sessionId} destroyed via API`)
  }
  res.json({ ok: true, message: cleaned ? 'Session destroyed' : 'Session already destroyed' })
})

app.post('/api/hermes-cli/heartbeat', adminMiddleware, (req, res) => {
  const { sessionId } = req.body

  if (!sessionId) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId is required' } })
  }

  const session = hermesCliSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }

  session.lastHeartbeat = Date.now()
  res.json({ ok: true })
})

// ============ Remote Desktop API ============

const { spawn } = await import('child_process')

async function findFreeDisplay() {
  for (let i = 99; i >= 1; i--) {
    const lockFile = `/tmp/.X${i}-lock`
    if (!existsSync(lockFile)) {
      return i
    }
  }
  return 99
}

async function startXvfbDisplay(width, height, depth = 24) {
  const displayNum = await findFreeDisplay()
  const display = `:${displayNum}`
  
  const xvfb = spawn('Xvfb', [
    display,
    '-screen', '0', `${width}x${height}x${depth}`,
    '-ac',
    '-nolisten', 'tcp',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Xvfb startup timeout'))
    }, 5000)
    
    xvfb.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    
    setTimeout(() => {
      clearTimeout(timeout)
      resolve(true)
    }, 500)
  })
  
  return { display, process: xvfb }
}

async function startX11vnc(display, password) {
  const args = [
    '-display', display,
    '-forever',
    '-shared',
    '-rfbport', '0',
    '-nopw',
  ]
  
  if (password) {
    args.push('-passwd', password)
  }
  
  const vnc = spawn('x11vnc', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  
  let port = null
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('x11vnc startup timeout'))
    }, 10000)
    
    vnc.stderr.on('data', (data) => {
      const str = data.toString()
      const portMatch = str.match(/PORT=(\d+)/)
      if (portMatch) {
        port = parseInt(portMatch[1], 10)
        clearTimeout(timeout)
        resolve(true)
      }
    })
    
    vnc.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
  
  return { process: vnc, port }
}

function startFFmpegCapture(display, width, height, fps = 15, quality = 5) {
  const args = [
    '-f', 'x11grab',
    '-draw_mouse', '1',
    '-video_size', `${width}x${height}`,
    '-framerate', String(fps),
    '-i', display,
    '-vf', `scale=${width}:${height}`,
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', String(quality),
    '-',
  ]
  
  const ffmpeg = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  
  return ffmpeg
}

function parseMJPEGFrames(ffmpeg, onFrame) {
  let buffer = Buffer.alloc(0)
  const SOI = Buffer.from([0xFF, 0xD8])
  const EOI = Buffer.from([0xFF, 0xD9])
  
  ffmpeg.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    
    let start = 0
    while (true) {
      const soiIndex = buffer.indexOf(SOI, start)
      if (soiIndex === -1) break
      
      const eoiIndex = buffer.indexOf(EOI, soiIndex)
      if (eoiIndex === -1) break
      
      const frame = buffer.slice(soiIndex, eoiIndex + 2)
      onFrame(frame)
      start = eoiIndex + 2
    }
    
    if (start > 0) {
      buffer = buffer.slice(start)
    }
  })
  
  return ffmpeg
}

async function captureLinuxDesktopFast(display, width, height, quality = 30) {
  return new Promise((resolve) => {
    const args = [
      '-f', 'x11grab',
      '-draw_mouse', '1',
      '-video_size', `${width}x${height}`,
      '-i', display,
      '-vframes', '1',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', String(quality),
      '-',
    ]
    
    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    
    const chunks = []
    proc.stdout.on('data', (chunk) => chunks.push(chunk))
    proc.on('close', () => {
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks))
      } else {
        resolve(null)
      }
    })
    proc.on('error', () => resolve(null))
  })
}

async function captureLinuxDesktop(display, width, height) {
  return captureLinuxDesktopFast(display, width, height, 30)
}

async function captureWindowsDesktop() {
  return new Promise((resolve) => {
    const script = `
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
      $bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
      $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
      $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 50L)
      $stream = New-Object System.IO.MemoryStream
      $bitmap.Save($stream, $encoder, $params)
      [Convert]::ToBase64String($stream.ToArray())
    `
    
    const proc = spawn('powershell', ['-NoProfile', '-Command', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    
    let output = ''
    proc.stdout.on('data', (data) => output += data.toString())
    proc.on('close', () => {
      if (output) {
        try {
          resolve(Buffer.from(output.trim(), 'base64'))
        } catch {
          resolve(null)
        }
      } else {
        resolve(null)
      }
    })
    proc.on('error', () => resolve(null))
  })
}

app.get('/api/desktop/displays', adminMiddleware, (req, res) => {
  if (process.platform === 'win32') {
    return res.json({ ok: true, displays: [], platform: 'windows' })
  }
  
  const displays = []
  const tmpDir = '/tmp'
  
  try {
    const files = readdirSync(tmpDir)
    const lockPattern = /^\.X(\d+)-lock$/
    
    for (const file of files) {
      const match = file.match(lockPattern)
      if (match) {
        const displayNum = match[1]
        displays.push({
          display: `:${displayNum}`,
          number: parseInt(displayNum, 10),
        })
      }
    }
    
    displays.sort((a, b) => b.number - a.number)
  } catch (e) {
    console.error('[Desktop] Failed to list displays:', e.message)
  }
  
  res.json({ ok: true, displays, platform: 'linux' })
})

app.get('/api/desktop/list', adminMiddleware, (req, res) => {
  const sessions = []
  for (const [id, session] of desktopSessions) {
    sessions.push({
      id,
      nodeId: session.nodeId,
      nodeName: session.nodeName,
      platform: session.platform,
      status: session.status,
      width: session.width,
      height: session.height,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
    })
  }
  res.json({ ok: true, sessions })
})

app.post('/api/desktop/create', adminMiddleware, async (req, res) => {
  const { nodeId, width, height, host, port, password, display: inputDisplay } = req.body
  
  const sessionId = randomUUID()
  const platform = process.platform === 'win32' ? 'windows' : 'linux'
  
  const session = {
    id: sessionId,
    nodeId: nodeId || 'local',
    nodeName: nodeId || 'local',
    platform,
    status: 'creating',
    width: width || 1024,
    height: height || 768,
    host: host || 'localhost',
    port: port || 5900,
    password: password || '',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    clients: new Set(),
    xvfbProcess: null,
    vncProcess: null,
    ffmpegProcess: null,
    display: null,
    frameBuffer: null,
    isExternalDisplay: false,
  }
  
  desktopSessions.set(sessionId, session)
  
  try {
    if (platform === 'linux') {
      if (inputDisplay) {
        console.log(`[Desktop] Using existing display ${inputDisplay} for session ${sessionId}...`)
        session.display = inputDisplay
        session.isExternalDisplay = true
      } else {
        console.log(`[Desktop] Starting Xvfb for session ${sessionId}...`)
        const { display, process: xvfb } = await startXvfbDisplay(session.width, session.height)
        session.display = display
        session.xvfbProcess = xvfb
        console.log(`[Desktop] Xvfb started on display ${display}`)
        
        try {
          console.log(`[Desktop] Starting x11vnc for session ${sessionId}...`)
          const { process: vnc, port: vncPort } = await startX11vnc(display, session.password)
          session.vncProcess = vnc
          session.port = vncPort
          console.log(`[Desktop] x11vnc started on port ${vncPort}`)
        } catch (vncErr) {
          console.log(`[Desktop] x11vnc not available, using screen capture: ${vncErr.message}`)
        }
        
        xvfb.on('exit', (code) => {
          console.log(`[Desktop] Xvfb exited for session ${sessionId} with code ${code}`)
          session.status = 'error'
        })
      }
    }
    
    session.status = 'ready'
    res.json({
      ok: true,
      sessionId,
      message: 'Desktop session created. Connect via SSE stream.',
      width: session.width,
      height: session.height,
      platform: session.platform,
      display: session.display,
      vncPort: session.port,
      isExternalDisplay: session.isExternalDisplay,
    })
  } catch (err) {
    console.error(`[Desktop] Failed to create session ${sessionId}:`, err.message)
    session.status = 'error'
    res.status(500).json({
      ok: false,
      error: { message: `Failed to create desktop session: ${err.message}` },
    })
  }
})

app.get('/api/desktop/stream', adminMiddleware, (req, res) => {
  const sessionId = req.query.sessionId
  
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId is required' } })
  }
  
  const session = desktopSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }
  
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  
  const sendEvent = (type, data = {}) => {
    const event = { type, sessionId, ...data }
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  
  session.clients.add(res)
  session.status = 'connected'
  session.lastActivityAt = Date.now()
  
  console.log(`[Desktop] Client connected to session ${sessionId}`)
  sendEvent('connected', { width: session.width, height: session.height })
  
  let ffmpegProcess = null
  let frameCount = 0
  let lastFrameTime = Date.now()
  
  if (session.platform === 'linux' && session.display) {
    ffmpegProcess = startFFmpegCapture(session.display, session.width, session.height, 15, 5)
    
    parseMJPEGFrames(ffmpegProcess, (frame) => {
      frameCount++
      const now = Date.now()
      if (now - lastFrameTime >= 100) {
        session.frameBuffer = frame
        sendEvent('frame', { 
          data: frame.toString('base64'),
          width: session.width,
          height: session.height,
          fps: Math.round(frameCount * 1000 / (now - lastFrameTime)),
        })
        frameCount = 0
        lastFrameTime = now
      }
    })
    
    ffmpegProcess.on('error', (err) => {
      console.error(`[Desktop] FFmpeg error for session ${sessionId}:`, err.message)
    })
    
    ffmpegProcess.on('exit', (code) => {
      console.log(`[Desktop] FFmpeg exited for session ${sessionId} with code ${code}`)
    })
  } else if (session.platform === 'windows') {
    const captureFrame = async () => {
      try {
        const frameBuffer = await captureWindowsDesktop()
        if (frameBuffer) {
          session.frameBuffer = frameBuffer
          sendEvent('frame', { 
            data: frameBuffer.toString('base64'),
            width: session.width,
            height: session.height,
          })
        }
      } catch (err) {
        console.error(`[Desktop] Frame capture error for session ${sessionId}:`, err.message)
      }
    }
    
    const frameInterval = setInterval(captureFrame, 100)
    
    req.on('close', () => {
      clearInterval(frameInterval)
      session.clients.delete(res)
      console.log(`[Desktop] Client disconnected from session ${sessionId}`)
      if (session.clients.size === 0) {
        session.status = 'disconnected'
      }
    })
    
    return
  }
  
  req.on('close', () => {
    if (ffmpegProcess) {
      ffmpegProcess.kill()
    }
    session.clients.delete(res)
    console.log(`[Desktop] Client disconnected from session ${sessionId}`)
    if (session.clients.size === 0) {
      session.status = 'disconnected'
    }
  })
})

app.post('/api/desktop/input/mouse', adminMiddleware, (req, res) => {
  const { sessionId, x, y, button, buttons, type, wheelDeltaX, wheelDeltaY } = req.body
  
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId is required' } })
  }
  
  const session = desktopSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }
  
  session.lastActivityAt = Date.now()
  
  if (session.platform === 'linux' && session.display) {
    try {
      let cmd = ''
      if (type === 'mousemove') {
        cmd = `DISPLAY=${session.display} xdotool mousemove ${x} ${y}`
      } else if (type === 'click') {
        const btn = button === 2 ? 3 : button === 3 ? 2 : button
        cmd = `DISPLAY=${session.display} xdotool mousemove ${x} ${y} click ${btn + 1}`
      } else if (type === 'wheel') {
        const deltaY = wheelDeltaY || 0
        const btn = deltaY > 0 ? 5 : 4
        const clicks = Math.abs(deltaY) > 50 ? 3 : 1
        cmd = `DISPLAY=${session.display} xdotool click --repeat ${clicks} ${btn}`
      }
      
      if (cmd) {
        spawn('sh', ['-c', cmd])
      }
    } catch (e) {
      console.error('[Desktop] Mouse input error:', e.message)
    }
  }
  
  res.json({ ok: true })
})

app.post('/api/desktop/input/keyboard', adminMiddleware, (req, res) => {
  const { sessionId, key, code, keyCode, shiftKey, ctrlKey, altKey, metaKey, type } = req.body
  
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId is required' } })
  }
  
  const session = desktopSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }
  
  session.lastActivityAt = Date.now()
  
  if (session.platform === 'linux' && session.display) {
    try {
      let keyName = key
      const specialKeys = {
        'Enter': 'Return',
        'Escape': 'Escape',
        'Backspace': 'BackSpace',
        'Tab': 'Tab',
        'ArrowUp': 'Up',
        'ArrowDown': 'Down',
        'ArrowLeft': 'Left',
        'ArrowRight': 'Right',
        'Control': 'Control_L',
        'Shift': 'Shift_L',
        'Alt': 'Alt_L',
        'Meta': 'Super_L',
        ' ': 'space',
      }
      
      if (specialKeys[key]) {
        keyName = specialKeys[key]
      }
      
      const modifiers = []
      if (ctrlKey) modifiers.push('ctrl')
      if (shiftKey) modifiers.push('shift')
      if (altKey) modifiers.push('alt')
      if (metaKey) modifiers.push('super')
      
      let cmd = ''
      if (type === 'keydown') {
        if (modifiers.length > 0) {
          cmd = `DISPLAY=${session.display} xdotool keydown ${modifiers.map(m => m).join(' ')} ${keyName}`
        } else {
          cmd = `DISPLAY=${session.display} xdotool keydown ${keyName}`
        }
      } else if (type === 'keyup') {
        cmd = `DISPLAY=${session.display} xdotool keyup ${keyName}`
      }
      
      if (cmd) {
        spawn('sh', ['-c', cmd])
      }
    } catch (e) {
      console.error('[Desktop] Keyboard input error:', e.message)
    }
  }
  
  res.json({ ok: true })
})

app.post('/api/desktop/input/clipboard', adminMiddleware, (req, res) => {
  const { sessionId, text } = req.body
  
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId is required' } })
  }
  
  const session = desktopSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }
  
  session.lastActivityAt = Date.now()
  
  res.json({ ok: true })
})

app.post('/api/desktop/resize', adminMiddleware, (req, res) => {
  const { sessionId, width, height } = req.body
  
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId is required' } })
  }
  
  const session = desktopSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }
  
  session.width = width || session.width
  session.height = height || session.height
  session.lastActivityAt = Date.now()
  
  for (const client of session.clients) {
    try {
      client.write(`data: ${JSON.stringify({ type: 'resized', sessionId, width: session.width, height: session.height })}\n\n`)
    } catch (e) {}
  }
  
  res.json({ ok: true, width: session.width, height: session.height })
})

app.post('/api/desktop/destroy', adminMiddleware, (req, res) => {
  const { sessionId } = req.body
  
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId is required' } })
  }
  
  const session = desktopSessions.get(sessionId)
  if (!session) {
    return res.json({ ok: true, message: 'Session already destroyed' })
  }
  
  for (const client of session.clients) {
    try {
      client.write(`data: ${JSON.stringify({ type: 'disconnected', sessionId, message: 'Session destroyed' })}\n\n`)
      client.end()
    } catch (e) {}
  }
  
  if (session.ffmpegProcess) {
    try {
      session.ffmpegProcess.kill()
      console.log(`[Desktop] FFmpeg killed for session ${sessionId}`)
    } catch (e) {}
  }
  
  if (session.vncProcess) {
    try {
      session.vncProcess.kill()
      console.log(`[Desktop] x11vnc killed for session ${sessionId}`)
    } catch (e) {}
  }
  
  if (session.xvfbProcess) {
    try {
      session.xvfbProcess.kill()
      console.log(`[Desktop] Xvfb killed for session ${sessionId}`)
    } catch (e) {}
  }
  
  desktopSessions.delete(sessionId)
  console.log(`[Desktop] Session ${sessionId} destroyed`)
  res.json({ ok: true })
})

app.post('/api/desktop/heartbeat', adminMiddleware, (req, res) => {
  const { sessionId } = req.body
  
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: { message: 'sessionId is required' } })
  }
  
  const session = desktopSessions.get(sessionId)
  if (!session) {
    return res.status(404).json({ ok: false, error: { message: 'Session not found' } })
  }
  
  session.lastHeartbeat = Date.now()
  res.json({ ok: true })
})

function keyCodeToX11KeySym(keyCode, key) {
  const keyMap = {
    8: 0xFF08,
    9: 0xFF09,
    13: 0xFF0D,
    16: 0xFFE1,
    17: 0xFFE3,
    18: 0xFFE9,
    19: 0xFF13,
    20: 0xFFE5,
    27: 0xFF1B,
    32: 0x0020,
    33: 0xFF55,
    34: 0xFF56,
    35: 0xFF57,
    36: 0xFF50,
    37: 0xFF51,
    38: 0xFF52,
    39: 0xFF53,
    40: 0xFF54,
    45: 0xFF63,
    46: 0xFFFF,
    91: 0xFFEB,
    92: 0xFF67,
    93: 0xFF67,
    112: 0xFFBE,
    113: 0xFFBF,
    114: 0xFFC0,
    115: 0xFFC1,
    116: 0xFFC2,
    117: 0xFFC3,
    118: 0xFFC4,
    119: 0xFFC5,
    120: 0xFFC6,
    121: 0xFFC7,
    122: 0xFFC8,
    123: 0xFFC9,
    144: 0xFF7F,
    145: 0xFF14,
    186: 0x003B,
    187: 0x003D,
    188: 0x002C,
    189: 0x002D,
    190: 0x002E,
    191: 0x002F,
    192: 0x0060,
    219: 0x005B,
    220: 0x005C,
    221: 0x005D,
    222: 0x0027,
  }
  
  if (keyMap[keyCode]) {
    return keyMap[keyCode]
  }
  
  if (key && key.length === 1) {
    return key.charCodeAt(0)
  }
  
  return keyCode
}

// ============ Wizard API (Scenarios & Tasks) ============

// Scenarios API
app.get('/api/wizard/scenarios', authMiddleware, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM scenarios ORDER BY updated_at DESC').all()
    const scenarios = rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      agentSelectionMode: row.agent_selection_mode,
      selectedAgents: JSON.parse(row.selected_agents || '[]'),
      generatedAgents: JSON.parse(row.generated_agents || '[]'),
      bindings: JSON.parse(row.bindings || '[]'),
      tasks: JSON.parse(row.tasks || '[]'),
      executionLog: JSON.parse(row.execution_log || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
    res.json({ ok: true, scenarios })
  } catch (err) {
    console.error('[Wizard] Get scenarios error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.get('/api/wizard/scenarios/:id', authMiddleware, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(req.params.id)
    if (!row) {
      return res.status(404).json({ ok: false, error: { message: 'Scenario not found' } })
    }
    const scenario = {
      id: row.id,
      name: row.name,
      description: row.description,
      status: row.status,
      agentSelectionMode: row.agent_selection_mode,
      selectedAgents: JSON.parse(row.selected_agents || '[]'),
      generatedAgents: JSON.parse(row.generated_agents || '[]'),
      bindings: JSON.parse(row.bindings || '[]'),
      tasks: JSON.parse(row.tasks || '[]'),
      executionLog: JSON.parse(row.execution_log || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    res.json({ ok: true, scenario })
  } catch (err) {
    console.error('[Wizard] Get scenario error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/wizard/scenarios', operatorMiddleware, (req, res) => {
  try {
    const id = randomUUID()
    const now = Date.now()
    const { name, description, agentSelectionMode, selectedAgents, generatedAgents, bindings, tasks, status, executionLog } = req.body
    
    db.prepare(`
      INSERT INTO scenarios (id, name, description, status, agent_selection_mode, selected_agents, generated_agents, bindings, tasks, execution_log, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name || '',
      description || '',
      status || 'draft',
      agentSelectionMode || 'existing',
      JSON.stringify(selectedAgents || []),
      JSON.stringify(generatedAgents || []),
      JSON.stringify(bindings || []),
      JSON.stringify(tasks || []),
      JSON.stringify(executionLog || []),
      now,
      now
    )
    
    const scenario = {
      id,
      name: name || '',
      description: description || '',
      status: status || 'draft',
      agentSelectionMode: agentSelectionMode || 'existing',
      selectedAgents: selectedAgents || [],
      generatedAgents: generatedAgents || [],
      bindings: bindings || [],
      tasks: tasks || [],
      executionLog: executionLog || [],
      createdAt: now,
      updatedAt: now,
    }
    
    console.log('[Wizard] Created scenario:', id, name)
    res.json({ ok: true, scenario })
  } catch (err) {
    console.error('[Wizard] Create scenario error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.put('/api/wizard/scenarios/:id', operatorMiddleware, (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM scenarios WHERE id = ?').get(req.params.id)
    if (!existing) {
      return res.status(404).json({ ok: false, error: { message: 'Scenario not found' } })
    }
    
    const now = Date.now()
    const { name, description, status, agentSelectionMode, selectedAgents, generatedAgents, bindings, tasks, executionLog } = req.body
    
    db.prepare(`
      UPDATE scenarios 
      SET name = ?, description = ?, status = ?, agent_selection_mode = ?, selected_agents = ?, generated_agents = ?, bindings = ?, tasks = ?, execution_log = ?, updated_at = ?
      WHERE id = ?
    `).run(
      name,
      description,
      status,
      agentSelectionMode,
      JSON.stringify(selectedAgents || []),
      JSON.stringify(generatedAgents || []),
      JSON.stringify(bindings || []),
      JSON.stringify(tasks || []),
      JSON.stringify(executionLog || []),
      now,
      req.params.id
    )
    
    console.log('[Wizard] Updated scenario:', req.params.id)
    res.json({ ok: true, updatedAt: now })
  } catch (err) {
    console.error('[Wizard] Update scenario error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.delete('/api/wizard/scenarios/:id', operatorMiddleware, (req, res) => {
  try {
    db.prepare('DELETE FROM tasks WHERE scenario_id = ?').run(req.params.id)
    db.prepare('DELETE FROM scenarios WHERE id = ?').run(req.params.id)
    
    console.log('[Wizard] Deleted scenario:', req.params.id)
    res.json({ ok: true })
  } catch (err) {
    console.error('[Wizard] Delete scenario error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

// Tasks API
app.get('/api/wizard/tasks', authMiddleware, (req, res) => {
  try {
    const scenarioId = req.query.scenarioId
    let rows
    if (scenarioId) {
      rows = db.prepare('SELECT * FROM tasks WHERE scenario_id = ? ORDER BY updated_at DESC').all(scenarioId)
    } else {
      rows = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all()
    }
    
    const tasks = rows.map(row => ({
      id: row.id,
      scenarioId: row.scenario_id,
      title: row.title,
      description: row.description,
      status: row.status,
      assignedAgents: JSON.parse(row.assigned_agents || '[]'),
      priority: row.priority,
      mode: row.mode,
      conversationHistory: JSON.parse(row.conversation_history || '[]'),
      executionHistory: JSON.parse(row.execution_history || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
    res.json({ ok: true, tasks })
  } catch (err) {
    console.error('[Wizard] Get tasks error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.get('/api/wizard/tasks/:id', authMiddleware, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id)
    if (!row) {
      return res.status(404).json({ ok: false, error: { message: 'Task not found' } })
    }
    const task = {
      id: row.id,
      scenarioId: row.scenario_id,
      title: row.title,
      description: row.description,
      status: row.status,
      assignedAgents: JSON.parse(row.assigned_agents || '[]'),
      priority: row.priority,
      mode: row.mode,
      conversationHistory: JSON.parse(row.conversation_history || '[]'),
      executionHistory: JSON.parse(row.execution_history || '[]'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    res.json({ ok: true, task })
  } catch (err) {
    console.error('[Wizard] Get task error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/wizard/tasks', operatorMiddleware, (req, res) => {
  try {
    const id = randomUUID()
    const now = Date.now()
    const { scenarioId, title, description, status, assignedAgents, priority, mode, conversationHistory, executionHistory } = req.body
    
    db.prepare(`
      INSERT INTO tasks (id, scenario_id, title, description, status, assigned_agents, priority, mode, conversation_history, execution_history, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      scenarioId || null,
      title || '',
      description || '',
      status || 'pending',
      JSON.stringify(assignedAgents || []),
      priority || 'medium',
      mode || 'default',
      JSON.stringify(conversationHistory || []),
      JSON.stringify(executionHistory || []),
      now,
      now
    )
    
    const task = {
      id,
      scenarioId: scenarioId || null,
      title: title || '',
      description: description || '',
      status: status || 'pending',
      assignedAgents: assignedAgents || [],
      priority: priority || 'medium',
      mode: mode || 'default',
      conversationHistory: conversationHistory || [],
      executionHistory: executionHistory || [],
      createdAt: now,
      updatedAt: now,
    }
    
    console.log('[Wizard] Created task:', id, title)
    res.json({ ok: true, task })
  } catch (err) {
    console.error('[Wizard] Create task error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.put('/api/wizard/tasks/:id', operatorMiddleware, (req, res) => {
  try {
    const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id)
    if (!existing) {
      return res.status(404).json({ ok: false, error: { message: 'Task not found' } })
    }
    
    const now = Date.now()
    const { scenarioId, title, description, status, assignedAgents, priority, mode, conversationHistory, executionHistory } = req.body
    
    db.prepare(`
      UPDATE tasks 
      SET scenario_id = ?, title = ?, description = ?, status = ?, assigned_agents = ?, priority = ?, mode = ?, conversation_history = ?, execution_history = ?, updated_at = ?
      WHERE id = ?
    `).run(
      scenarioId,
      title,
      description,
      status,
      JSON.stringify(assignedAgents || []),
      priority,
      mode,
      JSON.stringify(conversationHistory || []),
      JSON.stringify(executionHistory || []),
      now,
      req.params.id
    )
    
    console.log('[Wizard] Updated task:', req.params.id)
    res.json({ ok: true, updatedAt: now })
  } catch (err) {
    console.error('[Wizard] Update task error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.delete('/api/wizard/tasks/:id', operatorMiddleware, (req, res) => {
  try {
    db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id)
    
    console.log('[Wizard] Deleted task:', req.params.id)
    res.json({ ok: true })
  } catch (err) {
    console.error('[Wizard] Delete task error:', err)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

// Media API endpoint
app.get('/api/media', (req, res) => {
  try {
    const path = req.query.path
    if (!path) {
      return res.status(400).json({ ok: false, error: { message: 'Path parameter is required' } })
    }
    
    console.log('[Media] Request path:', path)
    
    // Prevent directory traversal
    const safePath = path.replace(/\.\./g, '').replace(/\//g, sep)
    console.log('[Media] Safe path:', safePath)
    
    // 支持多个可能的媒体目录，按优先级搜索
    const possibleMediaDirs = []
    
    // 1. .env 文件中的 MEDIA_DIR（最高优先级）
    if (envConfig.MEDIA_DIR) {
      possibleMediaDirs.push(envConfig.MEDIA_DIR)
    }
    
    // 2. 系统环境变量 MEDIA_DIR
    if (process.env.MEDIA_DIR) {
      possibleMediaDirs.push(process.env.MEDIA_DIR)
    }
    
    // 3. OPENCLAW_HOME 推导的媒体目录
    const openclawHome = process.env.OPENCLAW_HOME
    if (openclawHome) {
      possibleMediaDirs.push(join(openclawHome, '.openclaw', 'media'))
    }
    
    // 4. 当前用户主目录
    possibleMediaDirs.push(join(os.homedir(), '.openclaw', 'media'))
    
    // 5. 常见的其他用户目录（适用于 root 运行但文件在 ubuntu 用户目录的情况）
    if (process.platform !== 'win32') {
      possibleMediaDirs.push('/home/ubuntu/.openclaw/media')
      possibleMediaDirs.push('/home/user/.openclaw/media')
    }
    
    // 去重
    const uniqueMediaDirs = [...new Set(possibleMediaDirs)]
    console.log('[Media] Searching in dirs:', uniqueMediaDirs)
    
    let foundFile = null
    let usedMediaDir = null
    
    for (const mediaDir of uniqueMediaDirs) {
      const fullPath = resolve(mediaDir, safePath)
      
      // 安全检查：确保路径在媒体目录内
      if (!fullPath.startsWith(mediaDir)) {
        continue
      }
      
      if (existsSync(fullPath)) {
        const stats = statSync(fullPath)
        if (stats.isFile()) {
          foundFile = fullPath
          usedMediaDir = mediaDir
          break
        }
      }
    }
    
    if (!foundFile) {
      console.log('[Media] File not found in any media dir:', safePath)
      return res.status(404).json({ ok: false, error: { message: 'File not found' } })
    }
    
    console.log('[Media] File found:', foundFile, '| Media dir:', usedMediaDir)
    
    const stats = statSync(foundFile)
    if (!stats.isFile()) {
      return res.status(400).json({ ok: false, error: { message: 'Not a file' } })
    }
    
    // Set appropriate content type based on file extension
    const ext = extname(foundFile).toLowerCase()
    const contentTypeMap = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml'
    }
    
    const contentType = contentTypeMap[ext] || 'application/octet-stream'
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', stats.size)
    
    // Stream the file
    const stream = createReadStream(foundFile)
    stream.pipe(res)
    
    stream.on('error', (err) => {
      console.error('[Media] Error streaming file:', err.message)
      res.status(500).json({ ok: false, error: { message: 'Internal server error' } })
    })
  } catch (err) {
    console.error('[Media] Error:', err.message)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

// ============================================================
// Backup & Restore API
// ============================================================

import { createGzip, createGunzip } from 'zlib'
import { pipeline, Readable } from 'stream'
import { pipeline as pipelinePromises } from 'stream/promises'
import { createHash } from 'crypto'
import archiver from 'archiver'
import unzipper from 'unzipper'
import AdmZip from 'adm-zip'

const PROJECT_ROOT = join(__dirname, '..')
const DATA_DIR = process.env.GAIOP_ADMIN_DATA_DIR || join(PROJECT_ROOT, 'data')
const BACKUP_DIR = process.env.GAIOP_ADMIN_BACKUP_DIR || join(PROJECT_ROOT, 'backups')
const WIZARD_DB_PATH = join(DATA_DIR, 'wizard.db')
const ENV_PATH = join(PROJECT_ROOT, '.env')

const backupTasks = new Map()

function ensureBackupDir() {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true })
  }
}

function generateTaskId() {
  return `backup-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function broadcastBackupProgress(taskId, progress) {
  broadcastSSE({
    type: 'backupProgress',
    taskId,
    ...progress
  })
}

async function executeOpenClawBackup(outputPath) {
  return new Promise((resolve, reject) => {
    const openclawHome = process.env.OPENCLAW_HOME
    
    let command, args, spawnOptions
    
    if (openclawHome && process.platform !== 'win32') {
      const username = openclawHome.split('/').pop()
      console.log(`[Backup] Running as user '${username}' with full environment`)
      
      command = 'su'
      args = ['-', username, '-c', `openclaw backup create --output ${outputPath}`]
      spawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] }
    } else {
      command = 'openclaw'
      args = ['backup', 'create', '--output', outputPath]
      spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: openclawHome 
          ? { ...process.env, HOME: openclawHome }
          : process.env
      }
      if (openclawHome) {
        console.log(`[Backup] Using OPENCLAW_HOME: ${openclawHome}`)
      }
    }
    
    const proc = spawn(command, args, spawnOptions)

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, stdout, stderr })
      } else {
        reject(new Error(`OpenClaw backup failed with code ${code}: ${stderr || stdout}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to execute openclaw backup: ${err.message}`))
    })
  })
}

async function extractOpenClawBackup(backupPath, tempDir) {
  return new Promise((resolve, reject) => {
    const homeDir = process.env.OPENCLAW_HOME || os.homedir()
    const openclawDir = join(homeDir, '.openclaw')
    console.log('[Restore] Target OpenClaw directory:', openclawDir)

    if (!existsSync(backupPath)) {
      return reject(new Error(`OpenClaw backup file not found: ${backupPath}`))
    }

    const stat = statSync(backupPath)
    if (stat.size === 0) {
      return reject(new Error('OpenClaw backup file is empty'))
    }

    console.log('[Restore] Extracting OpenClaw backup:', backupPath, 'size:', stat.size)

    const proc = spawn('tar', ['-xzf', backupPath, '-C', tempDir, '--ignore-zeros'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let timeout = null

    const timeoutMs = Math.max(300000, Math.ceil(stat.size / 1024 / 1024) * 1000)
    console.log('[Restore] Setting timeout to', timeoutMs / 1000, 'seconds for', Math.ceil(stat.size / 1024 / 1024), 'MB file')

    timeout = setTimeout(() => {
      proc.kill()
      reject(new Error('OpenClaw backup extraction timed out'))
    }, timeoutMs)

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', async (code) => {
      clearTimeout(timeout)
      try {
        if (code !== 0 && stderr.includes('unexpected end of file')) {
          return reject(new Error('OpenClaw backup file is corrupted or incomplete'))
        }

        const items = readdirSync(tempDir, { withFileTypes: true })
        const backupRoot = items.find(item => item.isDirectory() && item.name.includes('openclaw-backup'))

        if (!backupRoot) {
          if (code !== 0 && stderr) {
            console.warn('[Restore] tar warnings:', stderr)
          }
          return reject(new Error('Invalid OpenClaw backup: no backup root directory found'))
        }

        const payloadPath = join(tempDir, backupRoot.name, 'payload')
        if (!existsSync(payloadPath)) {
          return reject(new Error('Invalid OpenClaw backup: no payload directory found'))
        }

        function findOpenClawDir(dir) {
          try {
            const items = readdirSync(dir, { withFileTypes: true })
            for (const item of items) {
              if (item.isDirectory()) {
                if (item.name === '.openclaw') {
                  return join(dir, item.name)
                }
                const found = findOpenClawDir(join(dir, item.name))
                if (found) return found
              }
            }
          } catch (e) {
            console.warn('[Restore] Error reading directory:', dir, e.message)
          }
          return null
        }

        const extractedOpenClawDir = findOpenClawDir(payloadPath)
        if (!extractedOpenClawDir) {
          return reject(new Error('Invalid OpenClaw backup: .openclaw directory not found in payload'))
        }

        function copyDirSync(src, dest, overwrite = false) {
          if (!existsSync(dest)) {
            mkdirSync(dest, { recursive: true })
          }
          const entries = readdirSync(src, { withFileTypes: true })
          for (const entry of entries) {
            const srcPath = join(src, entry.name)
            const destPath = join(dest, entry.name)
            try {
              if (entry.isDirectory()) {
                copyDirSync(srcPath, destPath, overwrite)
              } else if (entry.isSymbolicLink()) {
                if (overwrite) {
                  try { unlinkSync(destPath) } catch (e) { }
                } else if (existsSync(destPath)) {
                  continue
                }
                const linkTarget = readlinkSync(srcPath)
                symlinkSync(linkTarget, destPath)
              } else {
                if (existsSync(destPath)) {
                  if (overwrite) {
                    try {
                      unlinkSync(destPath)
                      copyFileSync(srcPath, destPath)
                    } catch (e) {
                      console.warn('[Restore] Could not overwrite (file may be locked):', destPath)
                    }
                  }
                } else {
                  copyFileSync(srcPath, destPath)
                }
              }
            } catch (e) {
              console.warn('[Restore] Error copying:', srcPath, e.message)
            }
          }
        }

        copyDirSync(extractedOpenClawDir, openclawDir, true)

        console.log('[Restore] OpenClaw backup restored to:', openclawDir)
        resolve({ success: true, stdout, stderr, warnings: code !== 0 ? stderr : null })
      } catch (err) {
        reject(new Error(`Failed to move extracted files: ${err.message}`))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`Failed to extract OpenClaw backup: ${err.message}`))
    })
  })
}

async function createZipArchive(outputPath, files) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath)
    const archive = archiver('zip', { zlib: { level: 9 } })

    output.on('close', () => {
      const size = archive.pointer()
      console.log('[Backup] ZIP archive created:', outputPath, 'size:', size)
      resolve({ size })
    })

    output.on('error', (err) => {
      console.error('[Backup] ZIP output error:', err.message)
      reject(err)
    })

    archive.on('error', (err) => {
      console.error('[Backup] ZIP archive error:', err.message)
      reject(err)
    })

    archive.on('warning', (err) => {
      console.warn('[Backup] ZIP archive warning:', err.message)
    })

    archive.pipe(output)

    let addedFiles = 0
    let totalSize = 0
    for (const file of files) {
      if (existsSync(file.path)) {
        const stat = statSync(file.path)
        console.log('[Backup] Adding to ZIP:', file.name, 'size:', stat.size)
        archive.file(file.path, { name: file.name })
        addedFiles++
        totalSize += stat.size
      } else {
        console.warn('[Backup] File not found, skipping:', file.path)
      }
    }

    console.log('[Backup] ZIP contains', addedFiles, 'files, total size:', totalSize)
    archive.finalize()
  })
}

async function extractZipArchive(zipPath, targetDir) {
  return new Promise((resolve, reject) => {
    try {
      if (!existsSync(zipPath)) {
        return reject(new Error(`ZIP file not found: ${zipPath}`))
      }

      const stat = statSync(zipPath)
      if (stat.size === 0) {
        return reject(new Error('ZIP file is empty'))
      }

      console.log('[Restore] Extracting ZIP:', zipPath, 'size:', stat.size)

      const zip = new AdmZip(zipPath)
      const zipEntries = zip.getEntries()

      console.log('[Restore] ZIP contains', zipEntries.length, 'entries')

      zip.extractAllTo(targetDir, true)

      console.log('[Restore] ZIP extraction completed to:', targetDir)
      resolve()
    } catch (err) {
      console.error('[Restore] ZIP extraction failed:', err.message)
      reject(new Error(`Failed to extract ZIP: ${err.message}`))
    }
  })
}

async function executeBackupTask(taskId, params = {}) {
  const task = backupTasks.get(taskId)
  if (!task) return

  createBackupRecord(taskId, 'create')
  const tempDir = join(os.tmpdir(), `.openclaw_backup_${taskId}`)

  try {
    task.status = 'running'
    task.progress = 0
    task.message = 'Starting backup...'
    broadcastBackupProgress(taskId, { status: 'running', progress: 0, message: task.message })
    updateBackupRecord(taskId, { status: 'running', progress: 0, message: task.message })

    ensureBackupDir()

    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true })
    }

    const timestamp = new Date().toISOString()
      .replace(/T/, '_')
      .replace(/:/g, '-')
      .replace(/\..+/, '')

    const backupFilename = `backup_${timestamp}.zip`
    const backupPath = join(BACKUP_DIR, backupFilename)

    task.message = 'Creating OpenClaw backup...'
    task.progress = 10
    broadcastBackupProgress(taskId, { status: 'running', progress: 10, message: task.message, stage: 'openclaw_backup' })
    updateBackupRecord(taskId, { status: 'running', progress: 10, message: task.message, stage: 'openclaw_backup' })

    const openclawBackupPath = join(os.tmpdir(), `openclaw_backup_${taskId}.tar.gz`)
    const openclawFinalPath = join(tempDir, 'openclaw_backup.tar.gz')
    try {
      await executeOpenClawBackup(openclawBackupPath)
      console.log('[Backup] OpenClaw backup created')
      
      if (existsSync(openclawBackupPath)) {
        copyFileSync(openclawBackupPath, openclawFinalPath)
        unlinkSync(openclawBackupPath)
      }
    } catch (err) {
      console.warn('[Backup] OpenClaw backup skipped:', err.message)
      if (existsSync(openclawBackupPath)) {
        try { unlinkSync(openclawBackupPath) } catch (e) {}
      }
    }

    task.message = 'Backing up project database...'
    task.progress = 30
    broadcastBackupProgress(taskId, { status: 'running', progress: 30, message: task.message, stage: 'project_database' })
    updateBackupRecord(taskId, { status: 'running', progress: 30, message: task.message, stage: 'project_database' })

    const filesToArchive = []

    if (existsSync(openclawFinalPath)) {
      filesToArchive.push({ path: openclawFinalPath, name: 'openclaw_backup.tar.gz' })
      console.log('[Backup] OpenClaw backup added')
    }

    if (existsSync(WIZARD_DB_PATH)) {
      filesToArchive.push({ path: WIZARD_DB_PATH, name: 'data/wizard.db' })
      console.log('[Backup] Wizard database added')
    }

    task.message = 'Backing up environment config...'
    task.progress = 50
    broadcastBackupProgress(taskId, { status: 'running', progress: 50, message: task.message, stage: 'env_config' })
    updateBackupRecord(taskId, { status: 'running', progress: 50, message: task.message, stage: 'env_config' })

    if (existsSync(ENV_PATH)) {
      const tempEnvPath = join(tempDir, '.env')
      copyFileSync(ENV_PATH, tempEnvPath)
      filesToArchive.push({ path: tempEnvPath, name: '.env' })
      console.log('[Backup] Environment config added')
    }

    const manifest = {
      version: '3.0',
      createdAt: new Date().toISOString(),
      platform: process.platform,
      nodeVersion: process.version,
      source: 'openclaw-admin',
      components: {
        openclaw: existsSync(openclawBackupPath),
        wizardDb: existsSync(WIZARD_DB_PATH),
        env: existsSync(ENV_PATH)
      }
    }
    const manifestPath = join(tempDir, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    filesToArchive.push({ path: manifestPath, name: 'manifest.json' })

    task.message = 'Creating archive...'
    task.progress = 70
    broadcastBackupProgress(taskId, { status: 'running', progress: 70, message: task.message, stage: 'archiving' })
    updateBackupRecord(taskId, { status: 'running', progress: 70, message: task.message, stage: 'archiving' })

    const archiveResult = await createZipArchive(backupPath, filesToArchive)

    task.message = 'Cleaning up...'
    task.progress = 90
    broadcastBackupProgress(taskId, { status: 'running', progress: 90, message: task.message, stage: 'cleanup' })
    updateBackupRecord(taskId, { status: 'running', progress: 90, message: task.message, stage: 'cleanup' })

    rmSync(tempDir, { recursive: true, force: true })

    task.status = 'completed'
    task.progress = 100
    task.message = 'Backup completed successfully'
    task.completedAt = Date.now()
    task.result = {
      filename: backupFilename,
      size: archiveResult.size
    }

    updateBackupRecord(taskId, {
      status: 'completed',
      progress: 100,
      message: task.message,
      filename: backupFilename,
      size: archiveResult.size,
      completedAt: task.completedAt,
      result: task.result
    })

    broadcastBackupProgress(taskId, {
      status: 'completed',
      progress: 100,
      message: task.message,
      result: task.result
    })

    console.log(`[Backup] Created: ${backupFilename}`)
  } catch (err) {
    console.error('[Backup] Create error:', err.message)
    task.status = 'failed'
    task.error = err.message
    task.message = `Backup failed: ${err.message}`
    task.completedAt = Date.now()

    updateBackupRecord(taskId, {
      status: 'failed',
      error: err.message,
      message: task.message,
      completedAt: task.completedAt
    })

    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }

    broadcastBackupProgress(taskId, {
      status: 'failed',
      progress: task.progress,
      message: task.message,
      error: err.message
    })
  }
}

async function executeRestoreTask(taskId, filename) {
  const task = backupTasks.get(taskId)
  if (!task) return

  const tempDir = join(os.tmpdir(), `.openclaw_restore_${taskId}`)

  try {
    task.status = 'running'
    task.progress = 0
    task.message = 'Starting restore...'
    broadcastBackupProgress(taskId, { status: 'running', progress: 0, message: task.message })
    updateBackupRecord(taskId, { status: 'running', progress: 0, message: task.message })

    const safeName = basename(filename)
    if (safeName !== filename || (!filename.endsWith('.zip') && !filename.endsWith('.json.gz'))) {
      throw new Error('Invalid filename. Expected .zip or .json.gz file.')
    }

    const backupPath = join(BACKUP_DIR, safeName)
    if (!existsSync(backupPath)) {
      throw new Error('Backup not found')
    }

    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true })
    }

    let manifest = { version: '1.0' }
    let backupData = null

    if (filename.endsWith('.zip')) {
      task.message = 'Extracting backup archive...'
      task.progress = 10
      broadcastBackupProgress(taskId, { status: 'running', progress: 10, message: task.message, stage: 'extracting' })

      await extractZipArchive(backupPath, tempDir)

      const manifestPath = join(tempDir, 'manifest.json')
      if (existsSync(manifestPath)) {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      }
      console.log('[Restore] Manifest:', manifest)
    } else if (filename.endsWith('.json.gz')) {
      task.message = 'Reading legacy backup file...'
      task.progress = 10
      broadcastBackupProgress(taskId, { status: 'running', progress: 10, message: task.message, stage: 'reading' })

      const gzip = createGunzip()
      const readStream = createReadStream(backupPath)
      const chunks = []

      await pipelinePromises(
        readStream,
        gzip,
        async function* (source) {
          for await (const chunk of source) {
            chunks.push(chunk)
            yield chunk
          }
        }
      )

      const jsonContent = Buffer.concat(chunks).toString('utf-8')
      backupData = JSON.parse(jsonContent)
      manifest = { version: backupData.version || '1.0', legacy: true }
      console.log('[Restore] Legacy backup version:', manifest.version)

      if (backupData.data) {
        if (backupData.data.wizardDatabase) {
          const wizardDbDir = join(tempDir, 'data')
          mkdirSync(wizardDbDir, { recursive: true })
          const wizardDbContent = Buffer.from(backupData.data.wizardDatabase.content, 'base64')
          writeFileSync(join(wizardDbDir, 'wizard.db'), wizardDbContent)
        }
        if (backupData.data.envConfig) {
          writeFileSync(join(tempDir, '.env'), backupData.data.envConfig)
        }
      }
    }

    const results = {
      wizardDb: false,
      env: false,
      openclaw: false,
      errors: []
    }

    task.message = 'Restoring OpenClaw data...'
    task.progress = 30
    broadcastBackupProgress(taskId, { status: 'running', progress: 30, message: task.message, stage: 'openclaw_restore' })
    updateBackupRecord(taskId, { status: 'running', progress: 30, message: task.message, stage: 'openclaw_restore' })

    const extractedOpenClawBackup = join(tempDir, 'openclaw_backup.tar.gz')
    if (existsSync(extractedOpenClawBackup)) {
      try {
        const openclawTempDir = join(os.tmpdir(), `.openclaw_extract_${taskId}`)
        mkdirSync(openclawTempDir, { recursive: true })
        await extractOpenClawBackup(extractedOpenClawBackup, openclawTempDir)
        rmSync(openclawTempDir, { recursive: true, force: true })
        results.openclaw = true
        console.log('[Restore] OpenClaw data restored')
      } catch (e) {
        results.errors.push(`OpenClaw restore failed: ${e.message}`)
        console.warn('[Restore] OpenClaw restore error:', e.message)
      }
    }

    task.message = 'Restoring project database...'
    task.progress = 50
    broadcastBackupProgress(taskId, { status: 'running', progress: 50, message: task.message, stage: 'project_database' })
    updateBackupRecord(taskId, { status: 'running', progress: 50, message: task.message, stage: 'project_database' })

    let backupDbPath = null
    const extractedWizardDb = join(tempDir, 'data', 'wizard.db')
    if (existsSync(extractedWizardDb)) {
      try {
        if (existsSync(WIZARD_DB_PATH)) {
          backupDbPath = `${WIZARD_DB_PATH}.bak-${Date.now()}`
          writeFileSync(backupDbPath, readFileSync(WIZARD_DB_PATH))
        }
        writeFileSync(WIZARD_DB_PATH, readFileSync(extractedWizardDb))
        results.wizardDb = true
        console.log('[Restore] Wizard database restored')
      } catch (e) {
        results.errors.push(`Wizard DB restore failed: ${e.message}`)
      }
    }

    let backupEnvPath = null
    task.message = 'Restoring environment config...'
    task.progress = 70
    broadcastBackupProgress(taskId, { status: 'running', progress: 70, message: task.message, stage: 'env_config' })
    updateBackupRecord(taskId, { status: 'running', progress: 70, message: task.message, stage: 'env_config' })

    const extractedEnv = join(tempDir, '.env')
    if (existsSync(extractedEnv)) {
      try {
        if (existsSync(ENV_PATH)) {
          backupEnvPath = `${ENV_PATH}.bak-${Date.now()}`
          copyFileSync(ENV_PATH, backupEnvPath)
        }
        copyFileSync(extractedEnv, ENV_PATH)
        results.env = true
        console.log('[Restore] Environment config restored')
      } catch (e) {
        results.errors.push(`Env restore failed: ${e.message}`)
      }
    }

    task.message = 'Cleaning up...'
    task.progress = 90
    broadcastBackupProgress(taskId, { status: 'running', progress: 90, message: task.message, stage: 'cleanup' })

    rmSync(tempDir, { recursive: true, force: true })

    if (backupDbPath && existsSync(backupDbPath)) {
      try {
        unlinkSync(backupDbPath)
        console.log('[Restore] Cleaned up database backup file')
      } catch (e) {
        console.warn('[Restore] Failed to cleanup database backup file:', e.message)
      }
    }
    if (backupEnvPath && existsSync(backupEnvPath)) {
      try {
        unlinkSync(backupEnvPath)
        console.log('[Restore] Cleaned up env backup file')
      } catch (e) {
        console.warn('[Restore] Failed to cleanup env backup file:', e.message)
      }
    }

    task.status = 'completed'
    task.progress = 100
    task.message = 'Restore completed successfully'
    task.completedAt = Date.now()
    task.result = results

    broadcastBackupProgress(taskId, {
      status: 'completed',
      progress: 100,
      message: task.message,
      result: results
    })

    console.log(`[Restore] Completed: ${safeName}`)
  } catch (err) {
    console.error('[Restore] Error:', err.message)
    task.status = 'failed'
    task.error = err.message
    task.message = `Restore failed: ${err.message}`
    task.completedAt = Date.now()

    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true })
    }

    broadcastBackupProgress(taskId, {
      status: 'failed',
      progress: task.progress,
      message: task.message,
      error: err.message
    })
  }
}

app.get('/api/backup/list', authMiddleware, (req, res) => {
  try {
    ensureBackupDir()
    const files = readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.zip') || f.endsWith('.json.gz'))
      .map(f => {
        const filePath = join(BACKUP_DIR, f)
        const stats = statSync(filePath)
        const zipMatch = f.match(/backup_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.zip/)
        const gzMatch = f.match(/backup_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.json\.gz/)
        const uploadedZipMatch = f.match(/uploaded_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.zip/)
        const uploadedGzMatch = f.match(/uploaded_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.json\.gz/)
        const match = zipMatch || gzMatch || uploadedZipMatch || uploadedGzMatch
        return {
          filename: f,
          createdAt: stats.birthtime,
          size: stats.size,
          date: match ? `${match[1]} ${match[2].replace(/-/g, ':')}` : f,
          format: f.endsWith('.zip') ? 'zip' : 'json.gz'
        }
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

    res.json({ ok: true, backups: files })
  } catch (err) {
    console.error('[Backup] List error:', err.message)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.get('/api/backup/tasks', authMiddleware, (req, res) => {
  try {
    const dbTasks = getBackupRecords(20)
    const tasks = dbTasks.map(t => ({
      id: t.id,
      type: t.type,
      status: t.status,
      progress: t.progress,
      message: t.message,
      filename: t.filename,
      error: t.error,
      startedAt: t.created_at,
      completedAt: t.completed_at,
      result: t.filename ? { filename: t.filename } : null
    }))
    res.json({ ok: true, tasks })
  } catch (err) {
    console.error('[Backup] Failed to get tasks:', err.message)
    res.json({ ok: true, tasks: [] })
  }
})

app.get('/api/backup/tasks/:taskId', authMiddleware, (req, res) => {
  const task = backupTasks.get(req.params.taskId)
  if (!task) {
    return res.status(404).json({ ok: false, error: { message: 'Task not found' } })
  }
  res.json({
    ok: true,
    task: {
      id: task.id,
      type: task.type,
      status: task.status,
      progress: task.progress,
      message: task.message,
      filename: task.filename,
      error: task.error,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      result: task.result
    }
  })
})

app.delete('/api/backup/tasks/completed', adminMiddleware, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM backup_records WHERE status IN (?, ?)').run('completed', 'failed')
    console.log(`[Backup] Cleared ${result.changes} completed/failed tasks`)
    res.json({ ok: true, deleted: result.changes })
  } catch (err) {
    console.error('[Backup] Failed to clear completed tasks:', err.message)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

app.post('/api/backup/create', adminMiddleware, async (req, res) => {
  try {
    const taskId = generateTaskId()
    const task = {
      id: taskId,
      type: 'create',
      status: 'pending',
      progress: 0,
      message: 'Backup task created',
      startedAt: Date.now(),
      params: req.body || {}
    }
    backupTasks.set(taskId, task)

    res.json({
      ok: true,
      taskId,
      message: 'Backup task created'
    })

    setImmediate(() => executeBackupTask(taskId, req.body))
  } catch (err) {
    console.error('[Backup] Create error:', err.message)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

// 下载备份
app.get('/api/backup/download', authMiddleware, (req, res) => {
  try {
    const filename = req.query.filename
    if (!filename) {
      return res.status(400).json({ ok: false, error: { message: 'Filename is required' } })
    }
    
    // 安全检查：防止路径遍历
    const safeName = basename(filename)
    if (safeName !== filename || (!filename.endsWith('.zip') && !filename.endsWith('.json.gz'))) {
      return res.status(400).json({ ok: false, error: { message: 'Invalid filename. Expected .zip or .json.gz file.' } })
    }
    
    const backupPath = join(BACKUP_DIR, safeName)
    if (!existsSync(backupPath)) {
      return res.status(404).json({ ok: false, error: { message: 'Backup not found' } })
    }
    
    const contentType = filename.endsWith('.zip') ? 'application/zip' : 'application/gzip'
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
    
    const stream = createReadStream(backupPath)
    stream.pipe(res)
  } catch (err) {
    console.error('[Backup] Download error:', err.message)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

// 恢复备份
app.post('/api/backup/restore', adminMiddleware, async (req, res) => {
  try {
    const { filename } = req.body
    if (!filename) {
      return res.status(400).json({ ok: false, error: { message: 'Filename is required' } })
    }

    const safeName = basename(filename)
    if (safeName !== filename || (!filename.endsWith('.zip') && !filename.endsWith('.json.gz'))) {
      return res.status(400).json({ ok: false, error: { message: 'Invalid filename. Expected .zip or .json.gz file.' } })
    }

    const backupPath = join(BACKUP_DIR, safeName)
    if (!existsSync(backupPath)) {
      return res.status(404).json({ ok: false, error: { message: 'Backup not found' } })
    }

    const taskId = generateTaskId()
    const task = {
      id: taskId,
      type: 'restore',
      status: 'pending',
      progress: 0,
      message: 'Restore task created',
      filename: safeName,
      startedAt: Date.now()
    }
    backupTasks.set(taskId, task)

    res.json({
      ok: true,
      taskId,
      message: 'Restore task created'
    })

    setImmediate(() => executeRestoreTask(taskId, filename))
  } catch (err) {
    console.error('[Restore] Error:', err.message)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

// 删除备份
app.delete('/api/backup/delete', adminMiddleware, (req, res) => {
  try {
    const filename = req.query.filename
    if (!filename) {
      return res.status(400).json({ ok: false, error: { message: 'Filename is required' } })
    }

    const safeName = basename(filename)
    if (safeName !== filename || (!filename.endsWith('.zip') && !filename.endsWith('.json.gz'))) {
      return res.status(400).json({ ok: false, error: { message: 'Invalid filename. Expected .zip or .json.gz file.' } })
    }

    const backupPath = join(BACKUP_DIR, safeName)
    if (!existsSync(backupPath)) {
      return res.status(404).json({ ok: false, error: { message: 'Backup not found' } })
    }

    unlinkSync(backupPath)
    res.json({ ok: true, message: 'Backup deleted' })
    console.log(`[Backup] Deleted: ${safeName}`)
  } catch (err) {
    console.error('[Backup] Delete error:', err.message)
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

// 上传并恢复备份
const backupUpload = multer({ 
  dest: join(os.tmpdir(), 'openclaw-backup-uploads'),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB 限制
})

app.post('/api/backup/upload', adminMiddleware, backupUpload.single('backup'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: { message: 'No backup file uploaded' } })
    }

    const tempPath = req.file.path

    const taskId = generateTaskId()
    const task = {
      id: taskId,
      type: 'upload',
      status: 'pending',
      progress: 0,
      message: 'Upload task created',
      filename: req.file.originalname,
      startedAt: Date.now(),
      tempPath
    }
    backupTasks.set(taskId, task)

    res.json({
      ok: true,
      taskId,
      message: 'Upload task created'
    })

    setImmediate(async () => {
      try {
        task.status = 'running'
        task.message = 'Validating uploaded file...'
        task.progress = 10
        broadcastBackupProgress(taskId, { status: 'running', progress: 10, message: task.message })

        const isZip = req.file.originalname.endsWith('.zip')
        const isGz = req.file.originalname.endsWith('.json.gz')

        if (!isZip && !isGz) {
          throw new Error('Invalid backup file format. Expected .zip or .json.gz file.')
        }

        ensureBackupDir()
        const timestamp = new Date().toISOString()
          .replace(/T/, '_')
          .replace(/:/g, '-')
          .replace(/\..+/, '')

        if (isZip) {
          const tempExtractDir = join(os.tmpdir(), `backup_extract_${taskId}`)
          mkdirSync(tempExtractDir, { recursive: true })

          await extractZipArchive(tempPath, tempExtractDir)

          const manifestPath = join(tempExtractDir, 'manifest.json')
          if (!existsSync(manifestPath)) {
            rmSync(tempExtractDir, { recursive: true, force: true })
            throw new Error('Invalid backup file: missing manifest.json')
          }

          task.message = 'Saving backup...'
          task.progress = 50
          broadcastBackupProgress(taskId, { status: 'running', progress: 50, message: task.message })

          const newFilename = `uploaded_${timestamp}.zip`
          const newPath = join(BACKUP_DIR, newFilename)

          const filesToArchive = []
          const items = readdirSync(tempExtractDir, { recursive: true, withFileTypes: true })
          for (const item of items) {
            if (item.isFile()) {
              const relativePath = item.path.replace(tempExtractDir, '').replace(/^[/\\]/, '')
              const itemName = relativePath ? `${relativePath}/${item.name}` : item.name
              filesToArchive.push({ path: join(item.path, item.name), name: itemName })
            }
          }

          const archiveResult = await createZipArchive(newPath, filesToArchive)

          rmSync(tempExtractDir, { recursive: true, force: true })
          unlinkSync(tempPath)

          task.status = 'completed'
          task.progress = 100
          task.message = 'Backup uploaded successfully'
          task.completedAt = Date.now()
          task.result = {
            filename: newFilename,
            size: archiveResult.size
          }

          broadcastBackupProgress(taskId, {
            status: 'completed',
            progress: 100,
            message: task.message,
            result: task.result
          })

          console.log(`[Backup] Uploaded and saved: ${newFilename}`)
        } else if (isGz) {
          task.message = 'Validating legacy backup...'
          task.progress = 30
          broadcastBackupProgress(taskId, { status: 'running', progress: 30, message: task.message })

          const gzip = createGunzip()
          const readStream = createReadStream(tempPath)
          const chunks = []

          await pipelinePromises(
            readStream,
            gzip,
            async function* (source) {
              for await (const chunk of source) {
                chunks.push(chunk)
                yield chunk
              }
            }
          )

          const jsonContent = Buffer.concat(chunks).toString('utf-8')
          const backupData = JSON.parse(jsonContent)

          if (!backupData.version || !backupData.data) {
            unlinkSync(tempPath)
            throw new Error('Invalid legacy backup file format')
          }

          task.message = 'Saving backup...'
          task.progress = 50
          broadcastBackupProgress(taskId, { status: 'running', progress: 50, message: task.message })

          const newFilename = `uploaded_${timestamp}.json.gz`
          const newPath = join(BACKUP_DIR, newFilename)

          const newGzip = createGzip()
          const writeStream = createWriteStream(newPath)
          await pipelinePromises(
            Readable.from([jsonContent]),
            newGzip,
            writeStream
          )

          unlinkSync(tempPath)

          task.status = 'completed'
          task.progress = 100
          task.message = 'Backup uploaded successfully'
          task.completedAt = Date.now()
          task.result = {
            filename: newFilename,
            size: statSync(newPath).size
          }

          broadcastBackupProgress(taskId, {
            status: 'completed',
            progress: 100,
            message: task.message,
            result: task.result
          })

          console.log(`[Backup] Uploaded and saved: ${newFilename}`)
        }
      } catch (err) {
        console.error('[Backup] Upload error:', err.message)
        if (existsSync(tempPath)) {
          unlinkSync(tempPath)
        }
        task.status = 'failed'
        task.error = err.message
        task.message = `Upload failed: ${err.message}`
        task.completedAt = Date.now()

        broadcastBackupProgress(taskId, {
          status: 'failed',
          progress: task.progress,
          message: task.message,
          error: err.message
        })
      }
    })
  } catch (err) {
    console.error('[Backup] Upload error:', err.message)
    if (req.file && existsSync(req.file.path)) {
      unlinkSync(req.file.path)
    }
    res.status(500).json({ ok: false, error: { message: err.message } })
  }
})

if (hasDist) {
  app.use(express.static(distPath, {
    immutable: true,
    index: false,
    maxAge: '1y',
  }))

  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) {
      res.set('Cache-Control', 'no-cache')
      res.sendFile(join(distPath, 'index.html'))
    } else {
      next()
    }
  })
} else {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next()
    }
    res.status(404).json({
      error: 'Frontend not built',
      message: `This is the backend API server. Please visit ${envConfig.DEV_FRONTEND_URL} for the frontend during development, or run 'npm run build' first.`,
      frontendUrl: envConfig.DEV_FRONTEND_URL,
    })
  })
}

server.listen(envConfig.PORT, envConfig.GAIOP_BIND_HOST, () => {
  console.log(`Server running on http://${envConfig.GAIOP_BIND_HOST}:${envConfig.PORT}`)
  console.log(`OpenClaw Gateway: ${envConfig.OPENCLAW_WS_URL}`)
  if (isAuthEnabled()) {
    console.log(`Auth enabled: user "${envConfig.AUTH_USERNAME}"`)
  } else {
    console.log('Auth disabled (no AUTH_USERNAME/AUTH_PASSWORD configured)')
  }
  if (!hasDist) {
    console.log(`Development mode: Frontend at ${envConfig.DEV_FRONTEND_URL}`)
  }
  console.log(`Hermes CLI: ${HERMES_CLI_PATH || 'NOT FOUND'}`)
  console.log(`Hermes Home: ${HERMES_HOME || 'NOT FOUND'}`)
  if (!HERMES_CLI_PATH) {
    console.log('WARNING: Hermes CLI not found. Install hermes-agent or set HERMES_CLI_PATH in .env')
  }

  try {
    const runningTasks = db.prepare('SELECT id FROM backup_records WHERE status = ?').all('running')
    if (runningTasks.length > 0) {
      console.log(`[Backup] Marking ${runningTasks.length} interrupted tasks as failed`)
      db.prepare('UPDATE backup_records SET status = ?, error = ?, message = ? WHERE status = ?').run(
        'failed',
        'Server restarted during task execution',
        'Task interrupted by server restart',
        'running'
      )
    }
  } catch (err) {
    console.error('[Backup] Failed to cleanup interrupted tasks:', err.message)
  }
})

process.on('SIGINT', () => {
  console.log('\nShutting down...')
  cleanupAllTerminalSessions()
  gateway.disconnect()
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})

process.on('SIGTERM', () => {
  console.log('\nShutting down (SIGTERM)...')
  cleanupAllTerminalSessions()
  gateway.disconnect()
  server.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})
