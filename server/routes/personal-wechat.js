import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import { createPersonalWechatMetadataStore } from '../lib/personal-wechat-metadata.js'
import { createPersonalWechatOnboarding } from '../lib/personal-wechat-onboarding.js'
import { createPersonalWechatRuntime } from '../lib/personal-wechat-runtime.js'

function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store, private')
  res.set('Pragma', 'no-cache')
  next()
}

function errorStatus(code) {
  if (code === 'PERSONAL_WECHAT_REGISTRATION_INVALID' ||
      code === 'PERSONAL_WECHAT_VERIFICATION_CODE_INVALID' ||
      code === 'PERSONAL_WECHAT_ACCOUNT_INPUT_INVALID') return 400
  if (code === 'PERSONAL_WECHAT_ACCOUNT_NOT_FOUND' ||
      code === 'PERSONAL_WECHAT_ONBOARDING_NOT_FOUND') return 404
  if (code === 'PERSONAL_WECHAT_VERIFICATION_NOT_REQUIRED' ||
      code === 'PERSONAL_WECHAT_ONBOARDING_NOT_CANCELLABLE') return 409
  if (code === 'GATEWAY_UNAVAILABLE' || code === 'PERSONAL_WECHAT_PLUGIN_NOT_INSTALLED') return 503
  return 502
}

function safeErrorCode(error, fallback) {
  const code = String(error?.code || '').trim().toUpperCase()
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : fallback
}

function sendSafeRuntimeError(res, error, fallbackCode, fallbackMessage) {
  const code = safeErrorCode(error, fallbackCode)
  return sendError(res, { status: errorStatus(code), code, message: fallbackMessage })
}

function runtimeAccountStatus(runtimeAccount, metadata, runtimeAvailable) {
  const enabled = runtimeAccount ? runtimeAccount.enabled : metadata?.enabled !== false
  if (!enabled) return { status: 'disabled' }
  if (!runtimeAvailable) {
    return { status: 'error', lastErrorCode: 'PERSONAL_WECHAT_RUNTIME_UNAVAILABLE' }
  }
  if (!runtimeAccount) {
    return { status: 'error', lastErrorCode: 'PERSONAL_WECHAT_ACCOUNT_NOT_FOUND_IN_RUNTIME' }
  }
  if (runtimeAccount.lastErrorCode) {
    return { status: 'error', lastErrorCode: runtimeAccount.lastErrorCode }
  }
  if (!runtimeAccount.configured) {
    return { status: 'error', lastErrorCode: 'PERSONAL_WECHAT_ACCOUNT_NOT_CONFIGURED' }
  }
  // The adapter snapshot alone does not carry a running flag. "unknown" (not
  // "offline") is returned when the Gateway runtime state is unavailable so a
  // working account is not shown as deliberately stopped during Gateway
  // reconnects or when the runtime merge failed.
  if (typeof runtimeAccount.running !== 'boolean') {
    return { status: 'unknown' }
  }
  return { status: runtimeAccount.running ? 'online' : 'offline' }
}

function mergeAccounts(metadataAccounts, runtimeAccounts, runtimeAvailable) {
  const metadataMap = new Map(metadataAccounts.map((item) => [item.accountId, item]))
  const runtimeMap = new Map(runtimeAccounts.map((item) => [item.accountId, item]))
  const accountIds = Array.from(new Set([...metadataMap.keys(), ...runtimeMap.keys()])).sort()

  return accountIds.map((accountId) => {
    const metadata = metadataMap.get(accountId)
    const runtimeAccount = runtimeMap.get(accountId)
    const state = runtimeAccountStatus(runtimeAccount, metadata, runtimeAvailable)
    return {
      accountId,
      displayName: metadata?.displayName || runtimeAccount?.nickname || accountId,
      note: metadata?.note || undefined,
      wechatId: runtimeAccount?.wechatId || metadata?.wechatId,
      nickname: runtimeAccount?.nickname || metadata?.nickname,
      enabled: runtimeAccount ? runtimeAccount.enabled : metadata?.enabled !== false,
      status: state.status,
      lastErrorCode: state.lastErrorCode,
      errorCode: state.lastErrorCode,
    }
  })
}

export function createPersonalWechatRouter({
  db,
  adminMiddleware,
  recordAudit,
  gateway,
  getGateway,
  adapterBaseUrl,
  adapterToken,
  runtime: injectedRuntime,
  metadataStore: injectedMetadataStore,
  onboarding: injectedOnboarding,
} = {}) {
  const router = Router()
  const metadataStore = injectedMetadataStore || createPersonalWechatMetadataStore(db)
  const runtime = injectedRuntime || createPersonalWechatRuntime({ adapterBaseUrl, adapterToken })

  async function loadAccountSnapshot() {
    const snapshot = await runtime.getStatus()
    const runtimeMap = new Map(snapshot.accounts.map((item) => [item.accountId, item]))
    const gateway = typeof getGateway === 'function' ? getGateway() : undefined
    if (gateway?.isConnected) {
      try {
        const gatewayStatus = await gateway.call('channels.status', {}, 8_000)
        const liveAccounts = gatewayStatus?.channelAccounts?.['openclaw-weixin']
        if (Array.isArray(liveAccounts)) {
          for (const item of liveAccounts) {
            const accountId = String(item?.accountId || '').trim()
            if (!accountId) continue
            const existing = runtimeMap.get(accountId)
            runtimeMap.set(accountId, {
              ...existing,
              accountId,
              wechatId: existing?.wechatId || String(item?.userId || '').trim() || undefined,
              enabled: item?.enabled !== false,
              configured: item?.configured === true,
              // Only adopt the Gateway's boolean running flag. Absence of the
              // field (different RPC shapes) must not be coerced to "offline".
              running: typeof item?.running === 'boolean' ? item.running : existing?.running,
              lastErrorCode: safeErrorCode(item?.lastError) || undefined,
              lastInboundAt: item?.lastInboundAt,
              lastOutboundAt: item?.lastOutboundAt,
            })
          }
        }
      } catch {
        // Gateway status is advisory; the adapter snapshot remains
        // authoritative for account existence and configuration.
      }
    }
    return {
      accounts: Array.from(runtimeMap.values()),
      available: snapshot.available,
      version: snapshot.version,
    }
  }
  const onboarding = injectedOnboarding || createPersonalWechatOnboarding({
    runtime,
    metadataStore,
    onConnected: ({ actor, account }) => {
      recordAudit?.(
        actor,
        '完成个人微信扫码接入',
        account.accountId,
        `账户名称：${account.displayName}`,
      )
    },
  })

  router.use(noStore)

  router.get('/', adminMiddleware, async (_req, res) => {
    const metadataAccounts = metadataStore.list()
    try {
      const { accounts: runtimeAccounts, available, version } = await loadAccountSnapshot()
      return sendOk(res, {
        plugin: {
          installed: true,
          available,
          version,
          reason: available ? undefined : 'PERSONAL_WECHAT_PLUGIN_UNAVAILABLE',
          reasonCode: available ? undefined : 'PERSONAL_WECHAT_PLUGIN_UNAVAILABLE',
        },
        accounts: mergeAccounts(metadataAccounts, runtimeAccounts, available),
      })
    } catch (error) {
      const code = safeErrorCode(error, 'PERSONAL_WECHAT_RUNTIME_FAILED')
      return sendOk(res, {
        plugin: {
          installed: code !== 'PERSONAL_WECHAT_PLUGIN_NOT_INSTALLED',
          available: false,
          reason: code,
          reasonCode: code,
        },
        accounts: mergeAccounts(metadataAccounts, [], false),
      })
    }
  })

  router.post('/onboarding', adminMiddleware, async (req, res) => {
    try {
      const session = await onboarding.start({
        ownerId: req.user.id,
        actor: req.user,
        displayName: req.body?.displayName,
        note: req.body?.note,
      })
      recordAudit?.(
        req.user,
        '启动个人微信扫码接入',
        '频道管理',
        `账户名称：${session.displayName}`,
      )
      return sendOk(res, { session })
    } catch (error) {
      return sendSafeRuntimeError(
        res,
        error,
        'PERSONAL_WECHAT_ONBOARDING_START_FAILED',
        '个人微信扫码接入暂时无法启动',
      )
    }
  })

  router.get('/onboarding/:id', adminMiddleware, (req, res) => {
    const session = onboarding.getForOwner(req.params.id, req.user.id)
    if (!session) {
      return sendError(res, {
        status: 404,
        code: 'PERSONAL_WECHAT_ONBOARDING_NOT_FOUND',
        message: '个人微信扫码会话不存在或已过期',
      })
    }
    return sendOk(res, { session })
  })

  router.post('/onboarding/:id/verify', adminMiddleware, async (req, res) => {
    try {
      const session = await onboarding.verify({
        id: req.params.id,
        ownerId: req.user.id,
        code: req.body?.code,
      })
      if (!session) {
        return sendError(res, {
          status: 404,
          code: 'PERSONAL_WECHAT_ONBOARDING_NOT_FOUND',
          message: '个人微信扫码会话不存在或已过期',
        })
      }
      recordAudit?.(req.user, '提交个人微信扫码验证', '频道管理', '未记录验证码内容')
      return sendOk(res, { session })
    } catch (error) {
      return sendSafeRuntimeError(
        res,
        error,
        'PERSONAL_WECHAT_VERIFICATION_FAILED',
        '个人微信扫码验证失败',
      )
    }
  })

  router.delete('/onboarding/:id', adminMiddleware, async (req, res) => {
    try {
      const session = await onboarding.cancel({ id: req.params.id, ownerId: req.user.id })
      if (!session) {
        return sendError(res, {
          status: 404,
          code: 'PERSONAL_WECHAT_ONBOARDING_NOT_FOUND',
          message: '个人微信扫码会话不存在或已过期',
        })
      }
      recordAudit?.(req.user, '取消个人微信扫码接入', '频道管理', '未保存二维码授权数据')
      return sendOk(res, { session })
    } catch (error) {
      return sendSafeRuntimeError(
        res,
        error,
        'PERSONAL_WECHAT_ONBOARDING_CANCEL_FAILED',
        '个人微信扫码会话无法取消',
      )
    }
  })

  router.put('/accounts/:accountId/enabled', adminMiddleware, async (req, res) => {
    const existing = metadataStore.get(req.params.accountId)
    if (!existing) {
      return sendError(res, {
        status: 404,
        code: 'PERSONAL_WECHAT_ACCOUNT_NOT_FOUND',
        message: '个人微信账号不存在',
      })
    }
    if (typeof req.body?.enabled !== 'boolean') {
      return sendError(res, {
        status: 400,
        code: 'PERSONAL_WECHAT_ACCOUNT_INPUT_INVALID',
        message: '个人微信账号状态参数无效',
      })
    }
    try {
      await runtime.setAccountEnabled(existing.accountId, req.body.enabled)
      const saved = metadataStore.setEnabled(existing.accountId, req.body.enabled)
      if (!saved) throw Object.assign(new Error('metadata update failed'), { code: 'PERSONAL_WECHAT_METADATA_UPDATE_FAILED' })
      const { accounts: runtimeAccounts, available } = await loadAccountSnapshot()
      const [account] = mergeAccounts([saved], runtimeAccounts, available)
        .filter((item) => item.accountId === existing.accountId)
      if (!account) {
        throw Object.assign(new Error('account snapshot missing'), { code: 'PERSONAL_WECHAT_ACCOUNT_STATE_FAILED' })
      }
      recordAudit?.(
        req.user,
        req.body.enabled ? '启用个人微信账号' : '停用个人微信账号',
        existing.accountId,
        `账户名称：${existing.displayName}`,
      )
      return sendOk(res, { account })
    } catch (error) {
      return sendSafeRuntimeError(
        res,
        error,
        'PERSONAL_WECHAT_ACCOUNT_STATE_FAILED',
        '个人微信账号状态修改失败',
      )
    }
  })

  router.delete('/accounts/:accountId', adminMiddleware, async (req, res) => {
    const existing = metadataStore.get(req.params.accountId)
    if (!existing) {
      return sendError(res, {
        status: 404,
        code: 'PERSONAL_WECHAT_ACCOUNT_NOT_FOUND',
        message: '个人微信账号不存在',
      })
    }
    try {
      await runtime.deleteAccount(existing.accountId)
      const removed = metadataStore.deleteAccount(existing.accountId)
      if (!removed) throw Object.assign(new Error('metadata delete failed'), { code: 'PERSONAL_WECHAT_METADATA_DELETE_FAILED' })
      recordAudit?.(
        req.user,
        '删除个人微信账号',
        existing.accountId,
        `账户名称：${existing.displayName}；仅删除该账号，未卸载个人微信插件`,
      )
      return sendOk(res, { deleted: true, accountId: existing.accountId })
    } catch (error) {
      return sendSafeRuntimeError(
        res,
        error,
        'PERSONAL_WECHAT_ACCOUNT_DELETE_FAILED',
        '个人微信账号删除失败',
      )
    }
  })

  return router
}

export const __test__ = { mergeAccounts, runtimeAccountStatus }
