// Personal WeChat login worker (persistent, runs on 237 as the OpenClaw user).
//
// Loads the installed @tencent-weixin/openclaw-weixin plugin modules once at
// startup and serves scan sessions over pipes:
//   - fd 0 (stdin):  raw verify-code lines (the plugin reads process.stdin)
//   - fd 1 (stdout): JSON events (ready / qr_ready / result)
//   - fd 2 (stderr): diagnostics
//   - fd 3:          JSON commands ({ cmd: "start", sessionKey })
//
// Keeping the worker alive removes the per-session cold module import that
// used to delay QR generation by several seconds. Credentials stay inside the
// plugin's own store; the only config mutation is the per-account enabled
// entry written atomically with a .bak snapshot.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const PLUGIN_BASE = String(process.env.GAIOP_WEIXIN_PLUGIN_BASE || '')
  || '/home/netinside/.openclaw/npm/node_modules/@tencent-weixin/openclaw-weixin'
const HOST_CORE = String(process.env.GAIOP_WEIXIN_HOST_CORE || '')
  || '/home/netinside/.npm-global/lib/node_modules/openclaw'
const API_BASE = String(process.env.GAIOP_WEIXIN_API_BASE || '')
  || 'https://ilinkai.weixin.qq.com'
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const CONFIG_PATH = path.join(process.env.HOME || '/home/netinside', '.openclaw/openclaw.json')

const { startWeixinLoginWithQr, waitForWeixinLogin, DEFAULT_ILINK_BOT_TYPE } = await import(
  `${PLUGIN_BASE}/dist/src/auth/login-qr.js`
)
const {
  saveWeixinAccount,
  registerWeixinAccountId,
  clearStaleAccountsForUserId,
  triggerWeixinChannelReload,
} = await import(`${PLUGIN_BASE}/dist/src/auth/accounts.js`)
const { clearContextTokensForAccount } = await import(
  `${PLUGIN_BASE}/dist/src/messaging/inbound.js`
)
const { normalizeAccountId } = await import(
  `${HOST_CORE}/dist/plugin-sdk/account-id.js`
)

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function ensureAccountConfigEnabled(accountId) {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
  const cfg = JSON.parse(raw)
  if (!cfg.channels || typeof cfg.channels !== 'object' || Array.isArray(cfg.channels)) cfg.channels = {}
  if (!cfg.channels['openclaw-weixin'] || typeof cfg.channels['openclaw-weixin'] !== 'object') {
    cfg.channels['openclaw-weixin'] = {}
  }
  const section = cfg.channels['openclaw-weixin']
  if (!section.accounts || typeof section.accounts !== 'object' || Array.isArray(section.accounts)) {
    section.accounts = {}
  }
  section.accounts[accountId] = { enabled: true }
  section.channelConfigUpdatedAt = new Date().toISOString()
  fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`)
  const temporary = `${CONFIG_PATH}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, CONFIG_PATH)
}

async function runSession(sessionKey) {
  const started = await startWeixinLoginWithQr({
    accountId: sessionKey,
    apiBaseUrl: API_BASE,
    botType: DEFAULT_ILINK_BOT_TYPE,
  })
  if (!started.qrcodeUrl) {
    emit({ event: 'result', connected: false, status: 'failed', message: started.message })
    return
  }
  emit({
    event: 'qr_ready',
    sessionKey: started.sessionKey,
    qrcodeUrl: started.qrcodeUrl,
  })

  const result = await waitForWeixinLogin({
    sessionKey: started.sessionKey,
    apiBaseUrl: API_BASE,
    botType: DEFAULT_ILINK_BOT_TYPE,
    timeoutMs: LOGIN_TIMEOUT_MS,
  })

  if (result.connected && result.botToken && result.accountId) {
    try {
      const normalizedId = normalizeAccountId(result.accountId)
      saveWeixinAccount(normalizedId, {
        token: result.botToken,
        baseUrl: result.baseUrl,
        userId: result.userId,
      })
      registerWeixinAccountId(normalizedId)
      if (result.userId) {
        clearStaleAccountsForUserId(normalizedId, result.userId, clearContextTokensForAccount)
      }
      ensureAccountConfigEnabled(normalizedId)
      void triggerWeixinChannelReload()
      emit({
        event: 'result',
        connected: true,
        status: 'connected',
        accountId: normalizedId,
        userId: typeof result.userId === 'string' && result.userId.trim() ? result.userId : undefined,
      })
    } catch (error) {
      emit({
        event: 'result',
        connected: false,
        status: 'failed',
        message: `账号凭据保存失败：${String(error?.message || error)}`,
      })
    }
  } else if (result.alreadyConnected) {
    emit({
      event: 'result',
      connected: false,
      status: 'already_connected',
      message: result.message,
    })
  } else {
    emit({
      event: 'result',
      connected: false,
      status: 'failed',
      message: result.message,
    })
  }
}

const commands = readline.createInterface({
  input: fs.createReadStream('', { fd: 3 }),
  crlfDelay: Infinity,
})

// Keep fd 0 open for the plugin's verify-code reads.
process.stdin.resume()

emit({ event: 'ready' })

commands.on('line', (line) => {
  let cmd
  try {
    cmd = JSON.parse(line)
  } catch {
    return
  }
  if (cmd?.cmd !== 'start') return
  const sessionKey = String(cmd.sessionKey || randomUUID())
  void runSession(sessionKey)
    .catch((error) => {
      emit({
        event: 'result',
        connected: false,
        status: 'failed',
        message: String(error?.message || error),
      })
    })
    .finally(() => {
      emit({ event: 'ready' })
    })
})
