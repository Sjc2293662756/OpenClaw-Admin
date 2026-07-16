import { existsSync, readFileSync } from 'fs'
import { Client } from 'ssh2'
import { parseSyslogAlerts } from './syslog-alerts.js'

const DEFAULT_LOG_PATH = '/var/log/netinside/syslog.log'
const MAX_REMOTE_BYTES = 12 * 1024 * 1024
const CACHE_TTL_MS = 60 * 1000
const SSH_READ_TIMEOUT_MS = 45 * 1000
const MIN_REMOTE_LINES = 10
const sourceCache = new Map()

function requiredEnv(env, key) {
  const value = String(env[key] || '').trim()
  if (!value) throw new Error(`missing ${key}`)
  return value
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function readSyslogAlertSourceConfig(env = process.env) {
  const password = String(env.GAIOP_ALERT_SSH_PASSWORD || '')
  const privateKeyPath = String(env.GAIOP_ALERT_SSH_PRIVATE_KEY_PATH || '').trim()
  if (!password && !privateKeyPath) throw new Error('missing SSH authentication')
  if (privateKeyPath && !existsSync(privateKeyPath)) throw new Error('SSH private key path is unavailable')
  const logPath = String(env.GAIOP_ALERT_SYSLOG_PATH || DEFAULT_LOG_PATH).trim()
  if (!logPath.startsWith('/') || /[\r\n\0]/.test(logPath)) throw new Error('invalid syslog path')
  return {
    host: requiredEnv(env, 'GAIOP_ALERT_SSH_HOST'),
    port: Math.min(Math.max(Number(env.GAIOP_ALERT_SSH_PORT) || 22, 1), 65535),
    username: requiredEnv(env, 'GAIOP_ALERT_SSH_USERNAME'),
    password: password || undefined,
    privateKey: privateKeyPath ? readFileSync(privateKeyPath) : undefined,
    logPath,
  }
}

function readRemoteTail(config, lineCount = 2000) {
  return new Promise((resolve, reject) => {
    const connection = new Client()
    const timer = setTimeout(() => {
      connection.end()
      reject(new Error('SSH read timed out'))
    }, SSH_READ_TIMEOUT_MS)
    const done = (callback) => (value) => {
      clearTimeout(timer)
      connection.end()
      callback(value)
    }
    connection.on('ready', () => {
      const command = `tail -n ${lineCount} -- ${shellQuote(config.logPath)}`
      connection.exec(command, (error, stream) => {
        if (error) return done(reject)(new Error('remote syslog read failed'))
        const chunks = []
        let size = 0
        stream.on('data', (chunk) => {
          size += chunk.length
          if (size <= MAX_REMOTE_BYTES) chunks.push(Buffer.from(chunk))
          else stream.close()
        })
        stream.stderr.on('data', () => {})
        stream.on('close', (code) => {
          if (size > MAX_REMOTE_BYTES) return done(reject)(new Error('remote syslog response is too large'))
          if (code !== 0) return done(reject)(new Error('remote syslog read failed'))
          done(resolve)(Buffer.concat(chunks))
        })
      })
    }).on('error', () => done(reject)(new Error('SSH alert source is unavailable'))).connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      privateKey: config.privateKey,
      readyTimeout: 10_000,
      keepaliveInterval: 5_000,
    })
  })
}

export async function readSyslogAlerts(env = process.env, lineCount = 5000) {
  const config = readSyslogAlertSourceConfig(env)
  const boundedLineCount = Math.min(Math.max(Number(lineCount) || 5000, MIN_REMOTE_LINES), 50_000)
  const cacheKey = `${config.host}:${config.port}:${config.username}:${config.logPath}`
  const cached = sourceCache.get(cacheKey)
  const now = Date.now()
  if (cached && now - cached.readAt < CACHE_TTL_MS && cached.lineCount >= boundedLineCount) {
    return { ...cached.parsed, readAt: cached.readAt, cached: true }
  }
  try {
    const parsed = parseSyslogAlerts(await readRemoteTail(config, boundedLineCount))
    sourceCache.set(cacheKey, { parsed, readAt: now, lineCount: boundedLineCount })
    return { ...parsed, readAt: now, cached: false, stale: false }
  } catch (error) {
    // 远端 SSH 短暂抖动时保留最近一次成功快照，避免页面退化为空白或 503。
    if (cached) return { ...cached.parsed, readAt: cached.readAt, cached: true, stale: true }
    throw error
  }
}
