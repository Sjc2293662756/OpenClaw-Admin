type ErrorPayload = {
  code?: unknown
  error?: unknown
  message?: unknown
}

const translations: Record<string, { zhCN: string, enUS: string }> = {
  INVALID_CREDENTIALS: { zhCN: '用户名或密码错误', enUS: 'Incorrect username or password' },
  LOGIN_INPUT_REQUIRED: { zhCN: '请输入用户名和密码', enUS: 'Enter your username and password' },
  UNAUTHORIZED: { zhCN: '登录已失效，请重新登录', enUS: 'Your sign-in has expired. Please sign in again.' },
  PASSWORD_CHANGE_REQUIRED: { zhCN: '请先修改密码', enUS: 'Change your password before continuing' },
  PASSWORD_POLICY_VIOLATION: { zhCN: '密码至少 8 位，且必须同时包含英文字母和数字', enUS: 'Password must be at least 8 characters and include both a letter and a number' },
  CURRENT_PASSWORD_INCORRECT: { zhCN: '当前密码不正确', enUS: 'Current password is incorrect' },
  PASSWORD_CONFIRMATION_MISMATCH: { zhCN: '两次输入的密码不一致', enUS: 'The two passwords do not match' },
  PERMISSION_DENIED: { zhCN: '无权执行此操作', enUS: 'You do not have permission to perform this action' },
  AUDITOR_READ_ONLY: { zhCN: '审计用户仅可查看', enUS: 'Audit users have read-only access' },
  BASIC_READ_ONLY: { zhCN: '当前用户仅可查看', enUS: 'The current user has read-only access' },
  STANDARD_ROLE_RESTRICTED: { zhCN: '当前角色无权执行此操作', enUS: 'Your role cannot perform this action' },
  USER_NOT_FOUND: { zhCN: '用户不存在', enUS: 'User not found' },
  USERNAME_EXISTS: { zhCN: '用户名已存在', enUS: 'Username already exists' },
  INVALID_USER_INPUT: { zhCN: '用户信息不完整或格式不正确', enUS: 'User information is incomplete or invalid' },
  ADMIN_MANAGEMENT_FORBIDDEN: { zhCN: '无权管理该管理员账户', enUS: 'You cannot manage this administrator account' },
  CURRENT_USER_DELETE_FORBIDDEN: { zhCN: '不能删除当前登录账户', enUS: 'You cannot delete the current account' },
  CURRENT_USER_SECURITY_UPDATE_FORBIDDEN: { zhCN: '不能修改当前登录账户的角色或状态', enUS: 'You cannot change the current account role or status' },
  LAST_ADMIN_DELETE_FORBIDDEN: { zhCN: '至少需要保留一个已激活的管理员账户', enUS: 'At least one active administrator account must remain' },
  LAST_ADMIN_UPDATE_FORBIDDEN: { zhCN: '至少需要保留一个已激活的管理员账户', enUS: 'At least one active administrator account must remain' },
  DATA_SOURCE_NOT_FOUND: { zhCN: '数据源不存在', enUS: 'Data source not found' },
  INVALID_DATA_SOURCE_INPUT: { zhCN: '数据源信息不完整或格式不正确', enUS: 'Data source information is incomplete or invalid' },
  DATA_SOURCE_DISABLED: { zhCN: '数据源已停用', enUS: 'Data source is disabled' },
  ACTIVE_DATA_SOURCE_CANNOT_DELETE: { zhCN: '不能删除当前运行数据源', enUS: 'The active runtime data source cannot be deleted' },
  ACTIVE_DATA_SOURCE_CANNOT_DISABLE: { zhCN: '不能停用当前运行数据源', enUS: 'The active runtime data source cannot be disabled' },
  DATA_SOURCE_RUNTIME_TARGET_MISSING: { zhCN: '运行数据源桥接未配置', enUS: 'Runtime data-source bridge is not configured' },
  GATEWAY_UNAVAILABLE: { zhCN: 'GAIOP 服务暂不可用', enUS: 'GAIOP service is unavailable' },
  DASHBOARD_SUMMARY_FAILED: { zhCN: '仪表盘摘要请求失败', enUS: 'Failed to load dashboard summary' },
  DASHBOARD_USAGE_RANGE_INVALID: { zhCN: '仪表盘时间范围无效', enUS: 'Dashboard time range is invalid' },
  REPORT_NOT_FOUND: { zhCN: '报告不存在', enUS: 'Report not found' },
  REPORT_LIST_FAILED: { zhCN: '获取报告列表失败', enUS: 'Failed to load reports' },
  REPORT_DELETE_FAILED: { zhCN: '报告删除失败', enUS: 'Failed to delete report' },
  ALERT_SOURCE_UNAVAILABLE: { zhCN: '告警数据源暂不可用', enUS: 'Alert source is unavailable' },
  ALERT_TIME_RANGE_INVALID: { zhCN: '告警时间范围无效', enUS: 'Alert time range is invalid' },
  ALERT_INGESTION_CONFIG_INVALID: { zhCN: '告警接入配置无效', enUS: 'Alert ingestion configuration is invalid' },
  ALERT_INGESTION_CONFIG_SAVE_FAILED: { zhCN: '保存告警接入配置失败', enUS: 'Failed to save alert ingestion configuration' },
  SESSION_SETTINGS_INVALID: { zhCN: '会话设置无效', enUS: 'Session settings are invalid' },
  SESSION_SETTINGS_PERSIST_FAILED: { zhCN: '保存会话设置失败', enUS: 'Failed to save session settings' },
  GAIOP_SERVICE_CONFIG_INVALID: { zhCN: 'GAIOP 服务配置无效', enUS: 'GAIOP service configuration is invalid' },
  GAIOP_SERVICE_CONFIG_SAVE_FAILED: { zhCN: '保存 GAIOP 服务配置失败', enUS: 'Failed to save GAIOP service configuration' },
  INVALID_SENSITIVE_CONFIG_INPUT: { zhCN: '环境与敏感配置无效', enUS: 'Environment or sensitive configuration is invalid' },
  SENSITIVE_CONFIG_NOT_FOUND: { zhCN: '环境与敏感配置不存在', enUS: 'Environment or sensitive configuration not found' },
  SENSITIVE_CONFIG_SAVE_FAILED: { zhCN: '保存环境与敏感配置失败', enUS: 'Failed to save environment or sensitive configuration' },
  UPGRADE_PACKAGE_REQUIRED: { zhCN: '请选择 ZIP 格式升级包', enUS: 'Select a ZIP upgrade package' },
  UPGRADE_SERVICE_UNAVAILABLE: { zhCN: '升级服务暂不可用或尚未部署', enUS: 'Upgrade service is unavailable or has not been deployed' },
  UPGRADE_PACKAGE_REJECTED: { zhCN: '升级包校验请求被拒绝', enUS: 'Upgrade-package validation was rejected' },
  UPGRADE_EXECUTION_CONFIRMATION_REQUIRED: { zhCN: '请输入 EXECUTE 确认执行升级', enUS: 'Enter EXECUTE to confirm the upgrade' },
  UPGRADE_EXECUTION_REJECTED: { zhCN: '升级任务当前不能执行', enUS: 'The upgrade task cannot be executed now' },
  UPGRADE_TASK_NOT_FOUND: { zhCN: '升级任务不存在', enUS: 'Upgrade task not found' },
  UPGRADE_BACKUP_NOT_FOUND: { zhCN: '备份不存在或已被清理', enUS: 'Backup not found or has been cleaned up' },
}

function currentLocale() {
  return typeof document !== 'undefined' && document.documentElement.lang === 'en-US' ? 'en-US' : 'zh-CN'
}

function payloadCode(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  return typeof (payload as ErrorPayload).code === 'string' ? (payload as ErrorPayload).code as string : ''
}

function payloadMessage(payload: unknown) {
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object') return ''
  const value = payload as ErrorPayload
  if (typeof value.error === 'string') return value.error
  if (value.error && typeof value.error === 'object' && typeof (value.error as ErrorPayload).message === 'string') return (value.error as ErrorPayload).message as string
  return typeof value.message === 'string' ? value.message : ''
}

export function localizeApiError(payload: unknown, fallback: string, locale = currentLocale()) {
  const translation = translations[payloadCode(payload)]
  if (translation) return locale === 'en-US' ? translation.enUS : translation.zhCN
  const message = payloadMessage(payload).trim()
  if (!message) return fallback
  return locale === 'en-US' && /[\u3400-\u9fff]/u.test(message) ? fallback : message
}
