export type UserRole = 'basic' | 'auditor' | 'standard' | 'admin'

export type PageAccessKey =
  | 'dashboard'
  | 'alerts'
  | 'chat'
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

type PageAccessDefinition = {
  moduleName: string
  roles: readonly UserRole[]
}

const ALL_ROLES: readonly UserRole[] = ['basic', 'auditor', 'standard', 'admin']
const NON_BASIC_ROLES: readonly UserRole[] = ['auditor', 'standard', 'admin']
const AUDIT_AND_ADMIN: readonly UserRole[] = ['auditor', 'admin']
const STATUS_VIEWERS: readonly UserRole[] = ['auditor', 'standard', 'admin']
const ADMIN_ONLY: readonly UserRole[] = ['admin']

export const ROLE_LABELS: Record<UserRole, string> = {
  basic: '基础用户',
  auditor: '审计用户',
  standard: '标准用户',
  admin: '管理员',
}

export const MANAGEMENT_ACCESS_DENIED_NOTICE = 'management-access-denied'

export const PAGE_ACCESS_MATRIX: Record<PageAccessKey, PageAccessDefinition> = {
  dashboard: { moduleName: '仪表盘', roles: NON_BASIC_ROLES },
  alerts: { moduleName: '告警通知', roles: NON_BASIC_ROLES },
  chat: { moduleName: '对话工作台', roles: ALL_ROLES },
  sessions: { moduleName: '会话管理', roles: NON_BASIC_ROLES },
  reports: { moduleName: '报告文件管理', roles: NON_BASIC_ROLES },
  cron: { moduleName: '任务计划', roles: AUDIT_AND_ADMIN },
  memory: { moduleName: '记忆管理', roles: ADMIN_ONLY },
  models: { moduleName: '模型管理', roles: ADMIN_ONLY },
  channels: { moduleName: '频道管理', roles: NON_BASIC_ROLES },
  skills: { moduleName: 'Skills管理', roles: STATUS_VIEWERS },
  system: { moduleName: '系统监视器', roles: STATUS_VIEWERS },
  agents: { moduleName: '多智能体', roles: ADMIN_ONLY },
  office: { moduleName: '智能体工坊', roles: ADMIN_ONLY },
  users: { moduleName: '账户管理', roles: AUDIT_AND_ADMIN },
  userAdministration: { moduleName: '账户管理', roles: ADMIN_ONLY },
  audit: { moduleName: '审计信息', roles: AUDIT_AND_ADMIN },
  settings: { moduleName: '系统设置', roles: NON_BASIC_ROLES },
  systemConfiguration: { moduleName: '高级配置', roles: ADMIN_ONLY },
  systemUpgrade: { moduleName: '系统升级', roles: ADMIN_ONLY },
}

export const ROUTE_ACCESS_KEYS: Record<string, PageAccessKey> = {
  Dashboard: 'dashboard',
  AlertNotifications: 'alerts',
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
}

export function getPageAccess(routeName: string | symbol | null | undefined) {
  const key = typeof routeName === 'string' ? ROUTE_ACCESS_KEYS[routeName] : undefined
  return key ? { key, ...PAGE_ACCESS_MATRIX[key] } : null
}

export function canAccessPage(role: UserRole | null | undefined, key: PageAccessKey): boolean {
  return Boolean(role && PAGE_ACCESS_MATRIX[key].roles.includes(role))
}

export function canUseConversation(role: UserRole | null | undefined): boolean {
  return role === 'basic' || role === 'standard' || role === 'admin'
}

export function resolveConfigManagementRedirect(
  role: UserRole | null | undefined,
  requestedRedirect: string,
) {
  if (canAccessPage(role, 'dashboard')) return requestedRedirect

  return {
    name: 'ChatWorkspace',
    query: { notice: MANAGEMENT_ACCESS_DENIED_NOTICE },
  }
}

export function resolvePasswordChangeReturn(
  role: UserRole | null | undefined,
  returnTo?: string,
) {
  const requestedPath = returnTo?.trim() || ''
  if (requestedPath === '/workspace' || requestedPath.startsWith('/workspace?')) {
    return requestedPath
  }
  if ((requestedPath === '/users' || requestedPath.startsWith('/users?')) && canAccessPage(role, 'users')) {
    return { name: 'UserManagement' }
  }

  return canAccessPage(role, 'users')
    ? { name: 'UserManagement' }
    : { name: 'ChatWorkspace' }
}

export function canAccessRoute(role: UserRole | null | undefined, routeName: string | symbol | null | undefined): boolean {
  const access = getPageAccess(routeName)
  return !access || canAccessPage(role, access.key)
}
