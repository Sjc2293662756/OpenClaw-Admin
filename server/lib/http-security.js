import { sendError } from './api-response.js'

const DEVELOPMENT_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1'])

function normalizeAddress(value) {
  const address = String(value || '').trim()
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

export function isLoopbackAddress(value) {
  return LOOPBACK_ADDRESSES.has(normalizeAddress(value))
}

export function configureTrustedProxy(app) {
  app.set('trust proxy', address => isLoopbackAddress(address))
}

export function parseAllowedOrigins(value) {
  const origins = new Set()
  for (const candidate of String(value || '').split(',')) {
    const trimmed = candidate.trim()
    if (!trimmed) continue
    if (trimmed === '*') throw new Error('GAIOP_ALLOWED_ORIGINS cannot contain a wildcard.')
    let parsed
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new Error(`Invalid GAIOP_ALLOWED_ORIGINS entry: ${trimmed}`)
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== trimmed) {
      throw new Error(`GAIOP_ALLOWED_ORIGINS must contain exact HTTP origins: ${trimmed}`)
    }
    origins.add(parsed.origin)
  }
  return origins
}

export function createCorsMiddleware({ allowedOrigins = '', isDevelopment = false } = {}) {
  const configuredOrigins = parseAllowedOrigins(allowedOrigins)
  if (!isDevelopment && configuredOrigins.size === 0) {
    throw new Error('GAIOP_ALLOWED_ORIGINS is required in production.')
  }

  return (req, res, next) => {
    const origin = String(req.headers.origin || '').trim()
    if (!origin) return next()

    const allowed = configuredOrigins.has(origin) || (isDevelopment && DEVELOPMENT_ORIGIN_PATTERN.test(origin))
    if (!allowed) {
      return sendError(res, {
        status: 403,
        code: 'CORS_ORIGIN_DENIED',
        message: '当前请求来源不允许访问GAIOP',
      })
    }

    res.vary('Origin')
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-GAIOP-Session-Key')
    res.setHeader('Access-Control-Max-Age', '600')
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  }
}
