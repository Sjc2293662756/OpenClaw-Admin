// GAIOP Personal WeChat loopback adapter (runs on 237 as the OpenClaw user).
//
// Exposes a minimal loopback HTTP API on 127.0.0.1:19091 for the GAIOP Admin
// BFF. It is the only component that touches the installed
// @tencent-weixin/openclaw-weixin plugin: QR login (via the plugin's own
// exported functions), per-account credential persistence, account enable/
// disable/delete. WeChat tokens and QR authorization payloads never leave
// this host.

import http from 'node:http'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HOST = '127.0.0.1'
const PORT = Number(process.env.GAIOP_WEIXIN_ADAPTER_PORT || 19091)
const TOKEN = String(process.env.GAIOP_WEIXIN_ADAPTER_TOKEN || '')
const HOME = String(process.env.GAIOP_HOME || '/home/netinside')
const NODE_BIN = process.env.GAIOP_NODE_BIN || 'node'
const PLUGIN_BASE = path.join(HOME, '.openclaw/npm/node_modules/@tencent-weixin/openclaw-weixin')
const PLUGIN_STATE = path.join(HOME, '.openclaw/openclaw-weixin')
const CONFIG_PATH = path.join(HOME, '.openclaw/openclaw.json')
const WORKER_PATH = path.join(__dirname, 'worker.mjs')
const SESSION_TTL_MS = 5 * 60 * 1000
const PROMPT_SCANNED = /正在验证/
const PROMPT_VERIFY = /输入手机微信显示的数字|重新输入/
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function pluginVersion() {
  const pkg = readJson(path.join(PLUGIN_BASE, 'package.json'))
  return typeof pkg?.version === 'string' ? pkg.version : null
}

function pluginAvailable() {
  return fs.existsSync(path.join(PLUGIN_BASE, 'dist/src/auth/login-qr.js'))
}

function listAccounts() {
  const index = readJson(path.join(PLUGIN_STATE, 'accounts.json'))
  const ids = Array.isArray(index)
    ? index.filter((id) => typeof id === 'string' && id.trim() && ACCOUNT_ID_PATTERN.test(id.trim()))
    : []
  const config = readJson(CONFIG_PATH) || {}
  const section = config.channels?.['openclaw-weixin'] || {}
  const channelEnabled = section.enabled !== false
  return ids.map((id) => {
    const data = readJson(path.join(PLUGIN_STATE, 'accounts', `${id}.json`))
    const accountConfig = section.accounts?.[id] || {}
    return {
      accountId: id,
      enabled: channelEnabled && accountConfig.enabled !== false,
      configured: Boolean(data?.token?.trim()),
      userId: typeof data?.userId === 'string' ? data.userId : undefined,
    }
  })
}

/**
 * Apply a small mutation to the openclaw.json channels.openclaw-weixin
 * section with an atomic write and a .bak snapshot. This deliberately avoids
 * the OpenClaw CLI/SDK config write path, whose full schema validation takes
 * multiple seconds per call on this host. The mutations here are structural
 * (delete an account key / toggle a boolean) and low risk.
 */
function updateOpenClawWeixinConfig(mutate) {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  const cfg = JSON.parse(raw)
  if (!cfg.channels || typeof cfg.channels !== 'object' || Array.isArray(cfg.channels)) cfg.channels = {}
  if (!cfg.channels['openclaw-weixin'] || typeof cfg.channels['openclaw-weixin'] !== 'object') {
    cfg.channels['openclaw-weixin'] = {}
  }
  const section = cfg.channels['openclaw-weixin']
  mutate(section)
  section.channelConfigUpdatedAt = new Date().toISOString()
  fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`)
  const temporary = `${CONFIG_PATH}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, CONFIG_PATH)
}

// ---------------------------------------------------------------------------
// QR login sessions
// ---------------------------------------------------------------------------

const sessions = new Map()

function publicSession(session) {
  return {
    sessionKey: session.sessionKey,
    status: session.status,
    qrcodeUrl: session.qrcodeUrl,
    expiresAt: session.expiresAt,
    accountId: session.accountId,
    userId: session.userId,
    message: session.message,
  }
}

function expireIfNeeded(session) {
  if (!session.terminal && session.status !== 'canceled' && Date.now() >= session.expiresAt) {
    session.terminal = true
    session.status = 'expired'
    session.message = '二维码已过期，请重新生成'
    killWorker(session)
  }
}

function killWorker(session) {
  if (session.worker && session.worker.exitCode === null && !session.worker.killed) {
    const worker = session.worker
    worker.activeSession = null
    try {
      worker.kill('SIGTERM')
    } catch {
      // best-effort
    }
    removeIdleWorker(worker)
  }
}

function emitEvent(session, snapshot) {
  Object.assign(session, snapshot)
  session.expiresAt = session.expiresAt || Date.now() + SESSION_TTL_MS
  const waiters = session.waiters
  session.waiters = []
  for (const resolve of waiters) resolve(publicSession(session))
}

function handleWorkerLine(worker, line) {
  const trimmed = String(line || '').trim()
  if (!trimmed) return
  let parsed = null
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    parsed = null
  }
  if (parsed && typeof parsed.event === 'string') {
    if (parsed.event === 'ready') {
      if (worker._readyResolve) {
        const resolve = worker._readyResolve
        worker._readyResolve = null
        resolve(worker)
      } else if (!worker.activeSession) {
        releaseWorker(worker)
      }
      return
    }
    const session = worker.activeSession
    if (!session) return
    if (parsed.event === 'qr_ready') {
      session.qrcodeUrl = typeof parsed.qrcodeUrl === 'string' ? parsed.qrcodeUrl : undefined
      emitEvent(session, { status: 'waiting_for_scan' })
    } else if (parsed.event === 'result') {
      session.terminal = true
      worker.activeSession = null
      if (parsed.connected === true && typeof parsed.accountId === 'string') {
        emitEvent(session, {
          status: 'connected',
          accountId: parsed.accountId,
          userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
        })
      } else if (parsed.status === 'already_connected') {
        emitEvent(session, {
          status: 'already_connected',
          message: typeof parsed.message === 'string' ? parsed.message : undefined,
        })
      } else {
        emitEvent(session, {
          status: 'failed',
          message: typeof parsed.message === 'string' ? parsed.message : undefined,
        })
      }
    }
    return
  }
  const session = worker.activeSession
  if (!session) return
  if (PROMPT_VERIFY.test(trimmed)) {
    if (session.status !== 'verification_required') emitEvent(session, { status: 'verification_required' })
  } else if (PROMPT_SCANNED.test(trimmed)) {
    if (session.status === 'waiting_for_scan' || session.status === 'starting') {
      emitEvent(session, { status: 'scanned' })
    }
  }
}

const idleWorkers = []
const MAX_IDLE_WORKERS = 2

function removeIdleWorker(worker) {
  const index = idleWorkers.indexOf(worker)
  if (index >= 0) idleWorkers.splice(index, 1)
}

function releaseWorker(worker) {
  if (!worker || worker.killed || worker.exitCode !== null) return
  if (worker.activeSession) return
  if (idleWorkers.includes(worker)) return
  if (idleWorkers.length >= MAX_IDLE_WORKERS) {
    try { worker.kill('SIGTERM') } catch { /* best-effort */ }
    return
  }
  idleWorkers.push(worker)
}

function spawnWorker() {
  const worker = spawn(NODE_BIN, [WORKER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME,
      PATH: `${HOME}/.npm-global/bin:/usr/local/bin:/usr/bin:/bin`,
      XDG_RUNTIME_DIR: '/run/user/1000',
    },
  })
  worker.activeSession = null
  worker._readyResolve = null

  let stdoutBuffer = ''
  worker.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8')
    let newlineIndex = stdoutBuffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex)
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      handleWorkerLine(worker, line)
      newlineIndex = stdoutBuffer.indexOf('\n')
    }
  })
  worker.stderr.on('data', (chunk) => {
    if (worker.activeSession) {
      worker.activeSession.stderrTail = `${worker.activeSession.stderrTail}${chunk.toString('utf8')}`.slice(-4000)
    }
  })
  worker.on('error', () => {
    const session = worker.activeSession
    removeIdleWorker(worker)
    if (worker._readyResolve) {
      const reject = worker._readyReject
      worker._readyResolve = null
      if (reject) reject(new Error('扫码进程无法启动'))
    }
    if (session && !session.terminal) {
      session.terminal = true
      emitEvent(session, { status: 'failed', message: '扫码进程无法启动' })
    }
  })
  worker.on('close', () => {
    const session = worker.activeSession
    worker.activeSession = null
    removeIdleWorker(worker)
    if (session && !session.terminal && session.status !== 'canceled') {
      session.terminal = true
      expireIfNeeded(session)
      if (!session.terminal) emitEvent(session, { status: 'failed', message: '扫码进程提前退出' })
    }
  })
  return worker
}

function getWorker() {
  const idle = idleWorkers.pop()
  if (idle) return Promise.resolve(idle)
  const worker = spawnWorker()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker._readyResolve = null
      reject(new Error('扫码进程启动超时'))
      try { worker.kill('SIGTERM') } catch { /* best-effort */ }
    }, 20_000)
    worker._readyResolve = (readyWorker) => {
      clearTimeout(timer)
      resolve(readyWorker)
    }
    worker._readyReject = (error) => {
      clearTimeout(timer)
      reject(error)
    }
  })
}

async function startQrSession() {
  const sessionKey = randomUUID()
  const session = {
    sessionKey,
    status: 'starting',
    qrcodeUrl: undefined,
    expiresAt: Date.now() + SESSION_TTL_MS,
    accountId: undefined,
    userId: undefined,
    message: undefined,
    terminal: false,
    worker: null,
    waiters: [],
    stderrTail: '',
  }
  sessions.set(sessionKey, session)

  const worker = await getWorker()
  worker.activeSession = session
  session.worker = worker
  try {
    worker.stdio[3].write(`${JSON.stringify({ cmd: 'start', sessionKey })}\n`)
  } catch {
    session.terminal = true
    emitEvent(session, { status: 'failed', message: '扫码进程无法写入指令' })
  }
  return session
}

function getSession(sessionKey) {
  const session = sessions.get(String(sessionKey || ''))
  if (!session) return null
  expireIfNeeded(session)
  return session
}

function waitForSessionEvent(session, timeoutMs) {
  if (session.terminal || session.status === 'canceled') return Promise.resolve(publicSession(session))
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(publicSession(session)), timeoutMs)
    session.waiters.push((snapshot) => {
      clearTimeout(timer)
      resolve(snapshot)
    })
  })
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, private',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function authorized(req) {
  if (!TOKEN) return true
  const provided = String(req.headers['x-gaiop-weixin-token'] || '')
  const left = Buffer.from(provided)
  const right = Buffer.from(TOKEN)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function errorPayload(code, message) {
  return { ok: false, error: { code, message } }
}

function normalizeAccountIdInput(raw) {
  const value = String(raw || '').trim()
  return ACCOUNT_ID_PATTERN.test(value) ? value : null
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) return json(res, 401, errorPayload('PERSONAL_WECHAT_ADAPTER_UNAUTHORIZED', '未授权的个人微信适配器请求'))

  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const pathname = url.pathname

  try {
    if (req.method === 'GET' && pathname === '/status') {
      return json(res, 200, {
        ok: true,
        available: pluginAvailable(),
        version: pluginVersion(),
        accounts: listAccounts(),
      })
    }

    if (req.method === 'POST' && pathname === '/qr/start') {
      const session = await startQrSession()
      return json(res, 200, { ok: true, ...publicSession(session) })
    }

    if (req.method === 'POST' && (pathname === '/qr/wait' || pathname === '/qr/status')) {
      const body = await readBody(req)
      const session = getSession(body.sessionKey)
      if (!session) {
        return json(res, 404, errorPayload('PERSONAL_WECHAT_ONBOARDING_NOT_FOUND', '扫码会话不存在或已过期'))
      }
      const timeoutMs = pathname === '/qr/wait'
        ? Math.min(25_000, Math.max(1_000, Math.floor(Number(body.timeoutMs) || 25_000)))
        : 0
      const snapshot = await waitForSessionEvent(session, timeoutMs)
      return json(res, 200, { ok: true, ...snapshot })
    }

    if (req.method === 'POST' && pathname === '/qr/verify') {
      const body = await readBody(req)
      const session = getSession(body.sessionKey)
      if (!session) {
        return json(res, 404, errorPayload('PERSONAL_WECHAT_ONBOARDING_NOT_FOUND', '扫码会话不存在或已过期'))
      }
      const code = String(body.code || '').trim()
      if (!/^[0-9A-Za-z]{4,12}$/.test(code)) {
        return json(res, 400, errorPayload('PERSONAL_WECHAT_VERIFICATION_CODE_INVALID', '微信验证码格式无效'))
      }
      if (session.status !== 'verification_required') {
        return json(res, 409, errorPayload('PERSONAL_WECHAT_VERIFICATION_NOT_REQUIRED', '当前扫码会话不需要验证码'))
      }
      session.status = 'waiting_for_scan'
      if (session.worker && session.worker.stdin.writable) {
        session.worker.stdin.write(`${code}\n`)
      }
      return json(res, 200, { ok: true, ...publicSession(session) })
    }

    if (req.method === 'POST' && pathname === '/qr/cancel') {
      const body = await readBody(req)
      const session = getSession(body.sessionKey)
      if (!session) {
        return json(res, 404, errorPayload('PERSONAL_WECHAT_ONBOARDING_NOT_FOUND', '扫码会话不存在或已过期'))
      }
      if (session.terminal || session.status === 'canceled') {
        return json(res, 409, errorPayload('PERSONAL_WECHAT_ONBOARDING_NOT_CANCELLABLE', '当前扫码会话无法取消'))
      }
      session.terminal = true
      session.status = 'canceled'
      killWorker(session)
      emitEvent(session, {})
      // Prewarm a replacement worker so the next scan is not cold.
      void getWorker().then(releaseWorker).catch(() => {})
      return json(res, 200, { ok: true, ...publicSession(session) })
    }

    const enabledMatch = pathname.match(/^\/accounts\/([^/]+)\/enabled$/)
    if (req.method === 'PUT' && enabledMatch) {
      const accountId = normalizeAccountIdInput(decodeURIComponent(enabledMatch[1]))
      if (!accountId) {
        return json(res, 400, errorPayload('PERSONAL_WECHAT_ACCOUNT_INPUT_INVALID', '个人微信账号标识无效'))
      }
      const body = await readBody(req)
      if (typeof body.enabled !== 'boolean') {
        return json(res, 400, errorPayload('PERSONAL_WECHAT_ACCOUNT_INPUT_INVALID', '个人微信账号状态参数无效'))
      }
      try {
        updateOpenClawWeixinConfig((section) => {
          if (!section.accounts || typeof section.accounts !== 'object' || Array.isArray(section.accounts)) {
            section.accounts = {}
          }
          section.accounts[accountId] = { enabled: body.enabled }
        })
      } catch {
        return json(res, 502, errorPayload(
          'PERSONAL_WECHAT_ACCOUNT_STATE_FAILED',
          '个人微信账号状态写入失败',
        ))
      }
      return json(res, 200, { ok: true, accountId, enabled: body.enabled })
    }

    if (req.method === 'PUT' && pathname === '/channel/enabled') {
      const body = await readBody(req)
      if (typeof body.enabled !== 'boolean') {
        return json(res, 400, errorPayload('PERSONAL_WECHAT_ACCOUNT_INPUT_INVALID', '个人微信渠道状态参数无效'))
      }
      try {
        updateOpenClawWeixinConfig((section) => {
          section.enabled = body.enabled
          // The channel-level flag alone is overridden by per-account
          // enabled entries in this plugin. Apply the same state to every
          // configured account so the switch really starts/stops the channel.
          const accountIds = new Set([
            ...(Array.isArray(section.accounts) ? [] : Object.keys(section.accounts || {})),
            ...listAccounts().map((account) => account.accountId),
          ])
          if (!section.accounts || typeof section.accounts !== 'object' || Array.isArray(section.accounts)) {
            section.accounts = {}
          }
          for (const accountId of accountIds) {
            if (accountId) section.accounts[accountId] = { enabled: body.enabled }
          }
        })
      } catch {
        return json(res, 502, errorPayload(
          'PERSONAL_WECHAT_CHANNEL_STATE_FAILED',
          '个人微信渠道状态写入失败',
        ))
      }
      return json(res, 200, { ok: true, enabled: body.enabled })
    }

    const deleteMatch = pathname.match(/^\/accounts\/([^/]+)$/)
    if (req.method === 'DELETE' && deleteMatch) {
      const accountId = normalizeAccountIdInput(decodeURIComponent(deleteMatch[1]))
      if (!accountId) {
        return json(res, 400, errorPayload('PERSONAL_WECHAT_ACCOUNT_INPUT_INVALID', '个人微信账号标识无效'))
      }
      const accountsModule = await import(
        pathToFileURL(path.join(PLUGIN_BASE, 'dist/src/auth/accounts.js')).href
      )
      accountsModule.clearWeixinAccount(accountId)
      accountsModule.unregisterWeixinAccountId(accountId)
      try {
        updateOpenClawWeixinConfig((section) => {
          if (section.accounts && typeof section.accounts === 'object') {
            delete section.accounts[accountId]
          }
        })
      } catch {
        return json(res, 502, errorPayload(
          'PERSONAL_WECHAT_ACCOUNT_DELETE_FAILED',
          '个人微信账号配置清理失败',
        ))
      }
      return json(res, 200, { ok: true, accountId, deleted: true })
    }

    return json(res, 404, errorPayload('PERSONAL_WECHAT_ADAPTER_NOT_FOUND', '接口不存在'))
  } catch (error) {
    return json(res, 400, errorPayload('PERSONAL_WECHAT_ADAPTER_BAD_REQUEST', String(error?.message || '请求无效')))
  }
})

server.listen(PORT, HOST, () => {
  process.stdout.write(`personal-wechat-adapter listening on ${HOST}:${PORT}\n`)
})

process.on('SIGTERM', () => {
  for (const session of sessions.values()) killWorker(session)
  for (const worker of idleWorkers.splice(0)) {
    try { worker.kill('SIGTERM') } catch { /* best-effort */ }
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
})
