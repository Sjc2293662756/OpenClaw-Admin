export type UserRole = 'basic' | 'auditor' | 'standard' | 'admin'

export type ModulePermissionKey =
  | 'data.allUsers'
  | 'dashboard'
  | 'alerts.records'
  | 'alerts.notifications'
  | 'sessions'
  | 'reports'
  | 'cron'
  | 'memory'
  | 'models'
  | 'channels'
  | 'skills'
  | 'system'
  | 'agents'
  | 'office'
  | 'users'
  | 'userAdministration'
  | 'audit'
  | 'settings'
  | 'systemConfiguration'
  | 'systemUpgrade'
  | 'platformBranding'

export type EffectiveModules = Partial<Record<ModulePermissionKey, boolean>>
export type PageAccessKey = Exclude<ModulePermissionKey, 'data.allUsers'> | 'chat'
type PageAccessDefinition = { moduleName: string }

export const ROLE_LABELS: Record<UserRole, string> = {
  basic: '基础用户',
  auditor: '审计用户',
  standard: '标准用户',
  admin: '管理员',
}

export const MANAGEMENT_ACCESS_DENIED_NOTICE = 'management-access-denied'

// Presentation metadata only. The browser never reconstructs access from a
// role: every decision below consumes the server's effectiveModules projection.
export const PAGE_ACCESS_MATRIX: Record<PageAccessKey, PageAccessDefinition> = {
  dashboard: { moduleName: '仪表盘' },
  'alerts.records': { moduleName: '告警记录' },
  'alerts.notifications': { moduleName: '告警通知/弹窗' },
  chat: { moduleName: '对话工作台' },
  sessions: { moduleName: '会话管理' },
  reports: { moduleName: '报告文件管理' },
  cron: { moduleName: '任务计划' },
  memory: { moduleName: '记忆管理' },
  models: { moduleName: '模型管理' },
  channels: { moduleName: '频道管理' },
  skills: { moduleName: 'Skills管理' },
  system: { moduleName: '系统监视器' },
  agents: { moduleName: '多智能体' },
  office: { moduleName: '智能体工坊' },
  users: { moduleName: '账户列表' },
  userAdministration: { moduleName: '账户管理' },
  audit: { moduleName: '审计信息' },
  settings: { moduleName: '系统设置' },
  systemConfiguration: { moduleName: '高级配置' },
  systemUpgrade: { moduleName: '系统升级' },
  platformBranding: { moduleName: '平台品牌配置' },
}

export const ROUTE_ACCESS_KEYS: Record<string, PageAccessKey> = {
  Dashboard: 'dashboard',
  AlertNotifications: 'alerts.records',
  ChatWorkspace: 'chat',
  Sessions: 'sessions',
  SessionDetail: 'sessions',
  Files: 'reports',
  Cron: 'cron',
  Memory: 'memory',
  Models: 'models',
  Channels: 'channels',
  Skills: 'skills',
  System: 'system',
  Agents: 'agents',
  Office: 'office',
  UserManagement: 'users',
  UserCreate: 'userAdministration',
  UserEdit: 'userAdministration',
  AuditLogs: 'audit',
  Settings: 'settings',
  BasicSettings: 'settings',
  SessionManagement: 'settings',
  ReportStorage: 'settings',
  SystemConfiguration: 'systemConfiguration',
  GAIOPServiceConfiguration: 'systemConfiguration',
  DataSourceManagement: 'systemConfiguration',
  AlertIngestionConfiguration: 'systemConfiguration',
  DataSourceCreate: 'systemConfiguration',
  DataSourceEdit: 'systemConfiguration',
  EnvironmentManagement: 'systemConfiguration',
  AlertForwardingConfiguration: 'systemConfiguration',
  SystemUpgrade: 'systemUpgrade',
  PlatformBranding: 'platformBranding',
}

export function getPageAccess(routeName: string | symbol | null | undefined) {
  const key = typeof routeName === 'string' ? ROUTE_ACCESS_KEYS[routeName] : undefined
  return key ? { key, ...PAGE_ACCESS_MATRIX[key] } : null
}

export function canAccessPage(effectiveModules: EffectiveModules | null | undefined, key: PageAccessKey): boolean {
  return key === 'chat' || effectiveModules?.[key] === true
}

export function canUseConversation(role: UserRole | null | undefined): boolean {
  return role === 'basic' || role === 'standard' || role === 'admin'
}

export function canModifySession(
  user: { id?: string; role?: UserRole } | null | undefined,
  session: { ownerUserId?: string | null } | null | undefined,
): boolean {
  if (user?.role === 'admin') return true
  if (user?.role !== 'basic' && user?.role !== 'standard') return false
  const userId = String(user.id || '').trim()
  return Boolean(userId && session?.ownerUserId === userId)
}

export function resolveConfigManagementRedirect(
  effectiveModules: EffectiveModules | null | undefined,
  requestedRedirect: string,
) {
  if (canAccessPage(effectiveModules, 'dashboard')) return requestedRedirect
  return { name: 'ChatWorkspace', query: { notice: MANAGEMENT_ACCESS_DENIED_NOTICE } }
}

export function resolvePasswordChangeReturn(
  effectiveModules: EffectiveModules | null | undefined,
  returnTo?: string,
) {
  const requestedPath = returnTo?.trim() || ''
  if (requestedPath === '/workspace' || requestedPath.startsWith('/workspace?')) return requestedPath
  if ((requestedPath === '/users' || requestedPath.startsWith('/users?')) && canAccessPage(effectiveModules, 'users')) {
    return { name: 'UserManagement' }
  }
  return canAccessPage(effectiveModules, 'users') ? { name: 'UserManagement' } : { name: 'ChatWorkspace' }
}

export function canAccessRoute(
  effectiveModules: EffectiveModules | null | undefined,
  routeName: string | symbol | null | undefined,
): boolean {
  const access = getPageAccess(routeName)
  return !access || canAccessPage(effectiveModules, access.key)
}

export function canAccessInitialAdminRoute(
  role: UserRole | null | undefined,
  isInitialAdmin: boolean | null | undefined,
): boolean {
  return role === 'admin' && isInitialAdmin === true
}
