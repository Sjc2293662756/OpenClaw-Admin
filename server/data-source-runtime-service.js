import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const developmentDefaultFile = resolve(__dirname, '../../GAIOP/config/runtime-active-data-source.json')

function resolveRuntimeTarget() {
  // GAIOP 智能体核心和管理服务统一使用同一正式变量名；保留旧变量作为部署兼容别名。
  const configured = String(
    process.env.GAIOP_ACTIVE_DATA_SOURCE_FILE
    || process.env.GAIOP_DATA_SOURCE_RUNTIME_FILE
    || '',
  ).trim()
  if (configured) return { filePath: resolve(configured), mode: 'configured' }
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return null
  return { filePath: developmentDefaultFile, mode: 'development-default' }
}

function buildNapmHost(ip) {
  const value = String(ip || '').trim()
  if (!value) throw new Error('活动数据源缺少 IP 地址')
  return value.includes(':') ? `https://[${value}]` : `https://${value}`
}

export function getDataSourceRuntimeStatus() {
  const target = resolveRuntimeTarget()
  return {
    ready: !!target,
    mode: target?.mode || 'not-configured',
    generated: !!target?.filePath && existsSync(target.filePath),
  }
}

/**
 * 只在管理员明确启用数据源时写入。文件包含运行必需凭据，必须放在 Git 忽略路径并限制权限。
 */
export function writeActiveDataSourceRuntime(source) {
  const target = resolveRuntimeTarget()
  if (!target) {
    const error = new Error('生产环境未配置 GAIOP_ACTIVE_DATA_SOURCE_FILE，无法启用运行数据源')
    error.code = 'DATA_SOURCE_RUNTIME_TARGET_MISSING'
    throw error
  }

  const password = String(source?.password || '')
  if (!password) throw new Error('活动数据源缺少访问密码')

  const payload = {
    schema: 'gaiop_active_data_source.v1',
    updatedAt: Date.now(),
    activeDataSource: {
      id: String(source.id || ''),
      host: buildNapmHost(source.ip),
      username: String(source.username || '').trim(),
      password,
      tlsInsecure: source.tls_mode === 'napm_self_signed',
    },
  }
  if (!payload.activeDataSource.id || !payload.activeDataSource.username) throw new Error('活动数据源信息不完整')

  const directory = dirname(target.filePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = `${target.filePath}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, target.filePath)
    try { chmodSync(target.filePath, 0o600) } catch { /* Windows 开发环境不支持 POSIX 文件权限 */ }
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }

  return { mode: target.mode, updatedAt: payload.updatedAt }
}

export function removeActiveDataSourceRuntime() {
  const target = resolveRuntimeTarget()
  if (!target) return { removed: false, mode: 'not-configured' }
  if (existsSync(target.filePath)) unlinkSync(target.filePath)
  return { removed: true, mode: target.mode }
}
