export const PASSWORD_POLICY_MESSAGE = '密码至少8位，必须同时包含英文字母和数字'

export function isValidPassword(password: string) {
  return password.length >= 8 && /[A-Za-z]/.test(password) && /\d/.test(password)
}
