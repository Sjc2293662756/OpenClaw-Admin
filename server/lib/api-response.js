/**
 * 管理服务统一响应工具。
 *
 * 保留 `error` 字符串字段，兼容现有前端；新增 `code` 供后续接口和日志稳定识别。
 */
export function sendOk(res, payload = {}, status = 200) {
  return res.status(status).json({ ok: true, ...payload })
}

export function sendError(res, {
  status = 500,
  code = 'INTERNAL_ERROR',
  message = '服务处理失败',
  details,
} = {}) {
  const body = { ok: false, error: message, code }
  if (details !== undefined) body.details = details
  return res.status(status).json(body)
}
