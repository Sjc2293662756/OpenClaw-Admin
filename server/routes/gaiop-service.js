import { Router } from 'express'
import { sendError, sendOk } from '../lib/api-response.js'

function validateEndpoint(value) {
  const endpoint = String(value || '').trim()
  if (!endpoint || endpoint.length > 512) return { ok: false, error: '服务接入地址不能为空且不能超过 512 个字符' }

  try {
    const url = new URL(endpoint)
    if (!['ws:', 'wss:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      return { ok: false, error: '服务接入地址仅支持不含账号、查询参数和片段的 ws:// 或 wss:// 地址' }
    }
  } catch {
    return { ok: false, error: '服务接入地址格式不正确' }
  }

  return { ok: true, value: endpoint }
}

function validateInput(input) {
  const endpoint = validateEndpoint(input?.endpoint)
  if (!endpoint.ok) return endpoint

  const hasAccessToken = Object.prototype.hasOwnProperty.call(input || {}, 'accessToken')
  const accessToken = hasAccessToken ? String(input.accessToken || '') : undefined
  if (accessToken !== undefined && accessToken.length > 4096) {
    return { ok: false, error: '服务访问令牌不能超过 4096 个字符' }
  }

  return { ok: true, value: { endpoint: endpoint.value, accessToken } }
}

export function createGAIOPServiceRouter({ adminMiddleware, recordAudit, getServiceConfig, saveServiceConfig }) {
  const router = Router()

  router.get('/', adminMiddleware, (_req, res) => {
    sendOk(res, { service: getServiceConfig() })
  })

  router.put('/', adminMiddleware, (req, res) => {
    const validated = validateInput(req.body)
    if (!validated.ok) {
      return sendError(res, { status: 400, code: 'GAIOP_SERVICE_CONFIG_INVALID', message: validated.error })
    }

    try {
      const service = saveServiceConfig(validated.value)
      recordAudit(
        req.user,
        '保存 GAIOP 服务配置',
        '系统配置',
        `服务地址已更新；访问令牌：${validated.value.accessToken ? '已更新' : '保持不变'}；已发起重新连接`,
      )
      return sendOk(res, { service })
    } catch {
      return sendError(res, { code: 'GAIOP_SERVICE_CONFIG_SAVE_FAILED', message: 'GAIOP 服务配置保存失败' })
    }
  })

  return router
}
