import { describe, expect, it } from 'vitest'
import {
  PAGE_ACCESS_MATRIX,
  MANAGEMENT_ACCESS_DENIED_NOTICE,
  canAccessPage,
  canAccessInitialAdminRoute,
  canAccessRoute,
  canUseConversation,
  getPageAccess,
  resolveConfigManagementRedirect,
  resolvePasswordChangeReturn,
  type PageAccessKey,
  type UserRole,
} from './access-control'

const roles: UserRole[] = ['basic', 'auditor', 'standard', 'admin']

const expected: Record<PageAccessKey, UserRole[]> = {
  dashboard: ['auditor', 'standard', 'admin'],
  alerts: roles,
  chat: roles,
  sessions: ['auditor', 'standard', 'admin'],
  reports: roles,
  cron: ['auditor', 'admin'],
  memory: ['admin'],
  models: ['admin'],
  channels: ['auditor', 'standard', 'admin'],
  skills: ['auditor', 'standard', 'admin'],
  system: ['auditor', 'standard', 'admin'],
  agents: ['admin'],
  office: ['admin'],
  users: ['auditor', 'admin'],
  userAdministration: ['admin'],
  audit: ['auditor', 'admin'],
  settings: ['auditor', 'standard', 'admin'],
  systemConfiguration: ['admin'],
  systemUpgrade: ['admin'],
  platformBranding: ['admin'],
}

describe('four-role page access matrix', () => {
  it('matches the approved first-stage matrix for every formal module', () => {
    for (const [key, allowedRoles] of Object.entries(expected) as Array<[PageAccessKey, UserRole[]]>) {
      expect(PAGE_ACCESS_MATRIX[key].roles).toEqual(allowedRoles)
      for (const role of roles) {
        expect(canAccessPage(role, key)).toBe(allowedRoles.includes(role))
      }
    }
  })

  it('applies the same decision to direct and hidden child routes', () => {
    expect(canAccessRoute('standard', 'Memory')).toBe(false)
    expect(canAccessRoute('standard', 'UserCreate')).toBe(false)
    expect(canAccessRoute('auditor', 'UserManagement')).toBe(true)
    expect(canAccessRoute('auditor', 'UserCreate')).toBe(false)
    expect(canAccessRoute('auditor', 'DataSourceEdit')).toBe(false)
    expect(canAccessRoute('auditor', 'Cron')).toBe(true)
    expect(canAccessRoute('basic', 'ChatWorkspace')).toBe(true)
    expect(canAccessRoute('basic', 'Dashboard')).toBe(false)
    expect(canAccessRoute('basic', 'Sessions')).toBe(false)
    expect(canAccessRoute('basic', 'AlertNotifications')).toBe(true)
    expect(canAccessRoute('basic', 'Files')).toBe(true)
    expect(getPageAccess('SystemUpgrade')?.moduleName).toBe('系统升级')
    expect(getPageAccess('PlatformBranding')?.moduleName).toBe('平台品牌配置')
  })

  it('allows basic users to converse while auditors remain read-only', () => {
    expect(canUseConversation('basic')).toBe(true)
    expect(canUseConversation('standard')).toBe(true)
    expect(canUseConversation('admin')).toBe(true)
    expect(canUseConversation('auditor')).toBe(false)
  })

  it('reserves hidden branding configuration for the initial administrator', () => {
    expect(canAccessInitialAdminRoute('admin', true)).toBe(true)
    expect(canAccessInitialAdminRoute('admin', false)).toBe(false)
    expect(canAccessInitialAdminRoute('standard', true)).toBe(false)
    expect(canAccessInitialAdminRoute(undefined, undefined)).toBe(false)
  })

  it('returns a basic user from the configuration-management login to the workspace', () => {
    expect(resolveConfigManagementRedirect('basic', '/')).toEqual({
      name: 'ChatWorkspace',
      query: { notice: MANAGEMENT_ACCESS_DENIED_NOTICE },
    })
    expect(resolveConfigManagementRedirect('admin', '/')).toBe('/')
    expect(resolveConfigManagementRedirect('standard', '/dashboard?range=today')).toBe('/dashboard?range=today')
  })

  it('returns password change to the page that opened it without trusting an unauthorized management target', () => {
    for (const role of roles) {
      expect(resolvePasswordChangeReturn(role, '/workspace?session=owned')).toBe('/workspace?session=owned')
    }
    expect(resolvePasswordChangeReturn('auditor', '/users')).toEqual({ name: 'UserManagement' })
    expect(resolvePasswordChangeReturn('admin', '/users')).toEqual({ name: 'UserManagement' })
    expect(resolvePasswordChangeReturn('basic', '/users')).toEqual({ name: 'ChatWorkspace' })
    expect(resolvePasswordChangeReturn('standard')).toEqual({ name: 'ChatWorkspace' })
  })
})
