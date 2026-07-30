import { describe, expect, it } from 'vitest'
import { isValidPassword, PASSWORD_POLICY_MESSAGE } from './password-policy'

describe('password policy', () => {
  it('rejects short passwords and passwords missing English letters or numbers', () => {
    expect(isValidPassword('Abc1234')).toBe(false)
    expect(isValidPassword('abcdefgh')).toBe(false)
    expect(isValidPassword('12345678')).toBe(false)
  })

  it('accepts spaces, Chinese text, and special characters when the required classes exist', () => {
    expect(isValidPassword('中文与 空格A1')).toBe(true)
    expect(isValidPassword('Special!9')).toBe(true)
    expect(PASSWORD_POLICY_MESSAGE).toBe('密码至少8位，必须同时包含英文字母和数字')
  })
})
