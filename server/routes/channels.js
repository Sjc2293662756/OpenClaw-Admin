import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'
import { patchGatewayChannelConfig, readGatewayChannelConfig, validateChannelPatches } from '../lib/gateway-channel-config.js'
import { createFeishuAppOnboarding } from '../lib/feishu-app-onboarding.js'

function safeChannelStatusConfig(config) {
  const channels = config?.channels && typeof config.channels === 'object' && !Array.isArray(config.channels)
    ? config.channels
    : {}
  return {
    channels: Object.fromEntries(Object.entries(channels).map(([key, value]) => {
      const row = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      return [key, {
        configured: true,
        enabled: row.enabled !== false,
      }]
    })),
  }
}

export function createChannelsRouter({ authMiddleware, adminMiddleware, recordAudit, gateway, getGateway, feishuOnboarding }) {
  const router = Router()
  const currentGateway = () => typeof getGateway === 'function' ? getGateway() : gateway
  const onboarding = feishuOnboarding || createFeishuAppOnboarding({
    provision: async ({ appId, appSecret, dmPolicy }, session) => {
      const result = await patchGatewayChannelConfig(currentGateway(), [
        { path: 'channels.feishu.appId', value: appId },
        { path: 'channels.feishu.appSecret', value: appSecret },
        { path: 'channels.feishu.enabled', value: true },
        { path: 'channels.feishu.dmPolicy', value: dmPolicy },
      ])
      recordAudit(
        session.actor,
        '完成飞书扫码开通',
        '频道管理',
        `飞书应用已写入 Gateway；私聊访问策略：${dmPolicy}；配置写入方式：${result.mode}`,
      )
    },
  })

  router.get('/config', authMiddleware, async (req, res) => {
    try {
      const config = await readGatewayChannelConfig(currentGateway())
      return sendOk(res, {
        config: req.user?.role === 'admin' ? config : safeChannelStatusConfig(config),
      })
    } catch (error) {
      return sendError(res, {
        status: error?.code === 'GATEWAY_UNAVAILABLE' ? 503 : 502,
        code: error?.code || 'CHANNEL_CONFIG_READ_FAILED',
        message: '频道配置暂时无法读取',
      })
    }
  })

  router.put('/config', adminMiddleware, async (req, res) => {
    const validated = validateChannelPatches(req.body?.patches)
    if (!validated.ok) {
      return sendError(res, { status: 400, code: 'CHANNEL_CONFIG_INVALID', message: validated.error })
    }

    try {
      const patches = validated.value.map((item) => {
        const channelKey = item.path.split('.')[1]
        if (['feishu', 'wecom', 'dingtalk-connector'].includes(channelKey) && item.path === `channels.${channelKey}.dmPolicy`) {
          return { ...item, value: 'open' }
        }
        if (['feishu', 'wecom', 'dingtalk-connector'].includes(channelKey) && item.path === `channels.${channelKey}` && item.value && typeof item.value === 'object' && !Array.isArray(item.value)) {
          return { ...item, value: { ...item.value, dmPolicy: 'open' } }
        }
        return item
      })
      const result = await patchGatewayChannelConfig(currentGateway(), patches)
      const channelKeys = Array.from(new Set(patches.map((item) => item.path.split('.')[1]))).sort()
      recordAudit(req.user, '保存频道配置', '频道管理', `频道：${channelKeys.join('、')}；变更项：${patches.length}`)
      return sendOk(res, { saved: true, patchMode: result.mode })
    } catch (error) {
      return sendError(res, {
        status: error?.code === 'GATEWAY_UNAVAILABLE' ? 503 : 502,
        code: error?.code || 'CHANNEL_CONFIG_SAVE_FAILED',
        message: '频道配置保存失败',
      })
    }
  })

  router.post('/feishu/onboarding', adminMiddleware, async (req, res) => {
    try {
      const currentConfig = await readGatewayChannelConfig(currentGateway())
      const currentFeishu = currentConfig?.channels?.feishu
      const hasExistingFeishuApp = typeof currentFeishu?.appId === 'string' && currentFeishu.appId.trim().length > 0
      if (hasExistingFeishuApp) {
        return sendError(res, {
          status: 409,
          code: 'FEISHU_ONBOARDING_EXISTING_APP_MANUAL_CONFIG_REQUIRED',
          message: '当前已有飞书应用配置；请保留现有机器人并使用手工配置更新凭据',
        })
      }
      const session = await onboarding.start({
        ownerId: req.user.id,
        actor: req.user,
        appName: req.body?.appName,
        dmPolicy: 'open',
      })
      recordAudit(req.user, '启动飞书扫码开通', '频道管理', `飞书应用名称：${session.appName}；私聊访问策略：${session.dmPolicy}`)
      return sendOk(res, { session })
    } catch {
      return sendError(res, {
        status: 502,
        code: 'FEISHU_ONBOARDING_START_FAILED',
        message: '飞书扫码开通暂时无法启动',
      })
    }
  })

  router.get('/feishu/onboarding/:id', adminMiddleware, (req, res) => {
    const session = onboarding.getForOwner(req.params.id, req.user.id)
    if (!session) {
      return sendError(res, { status: 404, code: 'FEISHU_ONBOARDING_NOT_FOUND', message: '飞书扫码开通会话不存在或已过期' })
    }
    return sendOk(res, { session })
  })

  router.delete('/feishu/onboarding/:id', adminMiddleware, (req, res) => {
    const cancelled = onboarding.cancel({ id: req.params.id, ownerId: req.user.id })
    if (!cancelled) {
      return sendError(res, { status: 409, code: 'FEISHU_ONBOARDING_NOT_CANCELLABLE', message: '飞书扫码开通会话无法取消' })
    }
    recordAudit(req.user, '取消飞书扫码开通', '频道管理', '未写入飞书应用凭据')
    return sendOk(res, { cancelled: true })
  })

  return router
}
