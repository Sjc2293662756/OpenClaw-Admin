// Personal WeChat login worker (runs on 237 as the OpenClaw user).
//
// Drives the installed @tencent-weixin/openclaw-weixin plugin's own QR login
// and per-account credential persistence. The worker is spawned per scan
// session by the loopback adapter and communicates with JSON lines on stdout.
// WeChat tokens and QR authorization payloads never leave this process.

import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const PLUGIN_BASE = String(process.env.GAIOP_WEIXIN_PLUGIN_BASE || '')
  || '/home/netinside/.openclaw/npm/node_modules/@tencent-weixin/openclaw-weixin'
const HOST_CORE = String(process.env.GAIOP_WEIXIN_HOST_CORE || '')
  || '/home/netinside/.npm-global/lib/node_modules/openclaw'
const API_BASE = String(process.env.GAIOP_WEIXIN_API_BASE || '')
  || 'https://ilinkai.weixin.qq.com'
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

// OpenClaw 2026.5.x only treats a channel as "configured" for gateway startup
// when it has a meaningful config entry (e.g. per-account enabled flags). Write
// the account config entry so the gateway loads and starts this channel.
function ensureAccountConfigEnabled(accountId) {
  const result = spawnSync(
    String(process.env.GAIOP_WEIXIN_OPENCLAW_BIN || 'openclaw'),
    [
      'config', 'set',
      `channels.openclaw-weixin.accounts.${accountId}.enabled`,
      'true',
    ],
    {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: process.env.HOME || '/home/netinside',
      },
    },
  )
  if (result.status !== 0) {
    throw new Error(
      `账号配置写入失败：${String(result.stderr || result.stdout || result.error || '').slice(0, 300)}`,
    )
  }
}

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

const sessionKey = String(process.env.GAIOP_WEIXIN_SESSION_KEY || '').trim() || randomUUID()

const started = await startWeixinLoginWithQr({
  accountId: sessionKey,
  apiBaseUrl: API_BASE,
  botType: DEFAULT_ILINK_BOT_TYPE,
})

if (!started.qrcodeUrl) {
  emit({ event: 'result', connected: false, status: 'failed', message: started.message })
  process.exit(0)
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

process.exit(0)
