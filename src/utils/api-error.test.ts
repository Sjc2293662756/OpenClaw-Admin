import { describe, expect, it } from 'vitest'
import { localizeApiError } from './api-error'

describe('localizeApiError', () => {
  it('uses stable error codes for login failures', () => {
    expect(localizeApiError({ code: 'INVALID_CREDENTIALS', error: '用户名或密码错误' }, 'Login failed', 'en-US')).toBe('Incorrect username or password')
  })

  it('does not expose an unknown Chinese server message in English mode', () => {
    expect(localizeApiError({ code: 'FUTURE_CODE', error: '服务处理失败' }, 'Request failed', 'en-US')).toBe('Request failed')
  })

  it('keeps the server message as the Chinese compatibility fallback', () => {
    expect(localizeApiError({ code: 'FUTURE_CODE', error: '服务处理失败' }, '请求失败', 'zh-CN')).toBe('服务处理失败')
  })
})
