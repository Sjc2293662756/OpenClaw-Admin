import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import https from 'https'
import { isIP } from 'net'

const DATA_SOURCE_TYPES = new Set(['local', 'remote'])
const DATA_SOURCE_STATUSES = new Set(['success', 'failed', 'untested', 'disabled'])

function getEncryptionKey() {
  const secret = String(process.env.DATA_SOURCE_ENCRYPTION_KEY || '')
  if (!secret) return null
  return createHash('sha256').update(secret, 'utf8').digest()
}

export function isDataSourceEncryptionReady() {
  return !!getEncryptionKey()
}

export function encryptDataSourcePassword(password) {
  const key = getEncryptionKey()
  if (!key) throw new Error('数据源加密密钥未配置')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decryptDataSourcePassword(payload) {
  const key = getEncryptionKey()
  if (!key) throw new Error('数据源加密密钥未配置')
  const [version, ivText, tagText, cipherText] = String(payload || '').split(':')
  if (version !== 'v1' || !ivText || !tagText || !cipherText) throw new Error('数据源密码格式无效')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64')), decipher.final()]).toString('utf8')
}

export function validateDataSourceInput(input, { passwordRequired = true } = {}) {
  const ip = String(input?.ip || '').trim()
  const description = String(input?.description || '').trim()
  const type = String(input?.type || '')
  const username = String(input?.username || '').trim()
  const password = input?.password === undefined ? undefined : String(input.password)
  const status = String(input?.status || 'untested')

  if (!isIP(ip)) return { ok: false, error: '请输入有效的 IPv4 或 IPv6 地址' }
  if (!DATA_SOURCE_TYPES.has(type)) return { ok: false, error: '数据源类型仅支持本机或远程' }
  if (!username || username.length > 128) return { ok: false, error: '请输入有效的 NAPM 访问账号' }
  if (passwordRequired && !password) return { ok: false, error: '请输入 NAPM 访问密码' }
  if (password !== undefined && password.length > 1024) return { ok: false, error: '密码长度不符合要求' }
  if (!['untested', 'disabled'].includes(status)) return { ok: false, error: '状态仅可设置为未测试或停用' }
  if (description.length > 300) return { ok: false, error: '描述不能超过 300 个字符' }

  return { ok: true, value: { ip, description, type, username, password, status } }
}

export function toPublicDataSource(row) {
  return {
    id: row.id,
    ip: row.ip,
    description: row.description || '',
    type: row.type,
    username: row.username,
    status: row.status,
    isActive: !!row.is_active,
    passwordConfigured: !!row.password_encrypted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTestedAt: row.last_tested_at || null,
    lastTestMessage: row.last_test_message || '',
  }
}

function buildNapmTestUrl(ip, username, password) {
  const host = isIP(ip) === 6 ? `[${ip}]` : ip
  const url = new URL(`https://${host}/webservice/NetInside`)
  url.searchParams.set('UserName', username)
  url.searchParams.set('Password', password)
  url.searchParams.set('type', 'applianceInfo')
  url.searchParams.set('json', 'true')
  return url
}

function isNapmSelfSignedError(error) {
  const code = String(error?.code || '').toUpperCase()
  const message = String(error?.message || '').toLowerCase()
  return code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
    || code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || message.includes('self-signed certificate')
}

function requestNapmApplianceInfo(url, { rejectUnauthorized }) {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const request = https.get(url, { timeout: 15000, rejectUnauthorized, headers: { Accept: 'application/json,text/plain,*/*' } }, (response) => {
      let received = 0
      response.on('data', (chunk) => { received += chunk.length })
      response.on('end', () => {
        const durationMs = Date.now() - startedAt
        if (response.statusCode >= 200 && response.statusCode < 300 && received > 0) {
          resolve({ ok: true, durationMs, message: `NAPM 接口响应正常（HTTP ${response.statusCode}）` })
        } else {
          resolve({ ok: false, durationMs, message: `NAPM 接口返回异常（HTTP ${response.statusCode || '无响应'}）` })
        }
      })
    })
    request.on('timeout', () => request.destroy(new Error('连接超时')))
    request.on('error', (error) => {
      resolve({
        ok: false,
        durationMs: Date.now() - startedAt,
        selfSignedCertificate: isNapmSelfSignedError(error),
        message: `连接失败：${String(error.message || '未知错误').slice(0, 160)}`,
      })
    })
  })
}

export async function testNapmDataSource({ ip, username, password, tlsMode = 'strict' }) {
  const url = buildNapmTestUrl(ip, username, password)
  if (tlsMode === 'napm_self_signed') {
    const result = await requestNapmApplianceInfo(url, { rejectUnauthorized: false })
    return { ...result, tlsMode: 'napm_self_signed', compatibilityMode: true }
  }

  const strictResult = await requestNapmApplianceInfo(url, { rejectUnauthorized: true })
  if (!strictResult.selfSignedCertificate) return { ...strictResult, tlsMode: 'strict', compatibilityMode: false }

  // NAPM 与 GAIOP 同厂部署时，对这一条数据源自动采用自签名证书兼容模式；不影响全局 HTTPS 策略。
  const compatibilityResult = await requestNapmApplianceInfo(url, { rejectUnauthorized: false })
  return {
    ...compatibilityResult,
    tlsMode: compatibilityResult.ok ? 'napm_self_signed' : 'strict',
    compatibilityMode: compatibilityResult.ok,
  }
}
