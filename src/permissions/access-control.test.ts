import { describe, expect, it } from 'vitest'
import {
  MANAGEMENT_ACCESS_DENIED_NOTICE,
  PAGE_ACCESS_MATRIX,
  canAccessInitialAdminRoute,
  canAccessPage,
  canAccessRoute,
  canModifySession,
  canUseConversation,
  getPageAccess,
  resolveConfigManagementRedirect,
  resolvePasswordChangeReturn,
  type EffectiveModules,
  type ModulePermissionKey,
} from './access-control'

const moduleKeys = Object.keys(PAGE_ACCESS_MATRIX).filter((key) => key !== 'chat') as ModulePermissionKey[]
function projection(...allowed: ModulePermissionKey[]): EffectiveModules {
  return Object.fromEntries(moduleKeys.map((key) => [key, allowed.includes(key)]))
}

describe('server-projected page access', () => {
  it('uses effectiveModules and never derives a module decision from role', () => {
    const effective = projection('alerts.records', 'alerts.notifications', 'reports', 'cron')
    expect(canAccessPage(effective, 'alerts.records')).toBe(true)
    expect(canAccessPage(effective, 'dashboard')).toBe(false)
    expect(canAccessPage(undefined, 'dashboard')).toBe(false)
    expect(canAccessPage(undefined, 'chat')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(PAGE_ACCESS_MATRIX, 'data.allUsers')).toBe(false)
  })

  it('applies the same projection to direct and hidden child routes', () => {
    const effective = projection('alerts.records', 'reports', 'users', 'cron')
    expect(canAccessRoute(effective, 'Memory')).toBe(false)
    expect(canAccessRoute(effective, 'UserCreate')).toBe(false)
    expect(canAccessRoute(effective, 'UserManagement')).toBe(true)
    expect(canAccessRoute(effective, 'DataSourceEdit')).toBe(false)
    expect(canAccessRoute(effective, 'Cron')).toBe(true)
    expect(canAccessRoute(effective, 'ChatWorkspace')).toBe(true)
    expect(canAccessRoute(effective, 'AlertNotifications')).toBe(true)
    expect(canAccessRoute(effective, 'Files')).toBe(true)
    expect(getPageAccess('SystemUpgrade')?.moduleName).toBe('系统升级')
    expect(getPageAccess('PlatformBranding')?.moduleName).toBe('平台品牌配置')
  })

  it('keeps conversation capability outside configurable modules', () => {
    expect(canUseConversation('basic')).toBe(true)
    expect(canUseConversation('standard')).toBe(true)
    expect(canUseConversation('admin')).toBe(true)
    expect(canUseConversation('auditor')).toBe(false)
  })

  it('keeps session writes on the original role and ownership boundary', () => {
    const ownSession = { ownerUserId: 'user-1' }
    const otherSession = { ownerUserId: 'user-2' }
    expect(canModifySession({ id: 'user-1', role: 'basic' }, ownSession)).toBe(true)
    expect(canModifySession({ id: 'user-1', role: 'standard' }, otherSession)).toBe(false)
    expect(canModifySession({ id: 'auditor-1', role: 'auditor' }, ownSession)).toBe(false)
    expect(canModifySession({ id: 'admin-1', role: 'admin' }, otherSession)).toBe(true)
    expect(canModifySession({ id: 'user-1', role: 'standard' }, { ownerUserId: null })).toBe(false)
  })

  it('reserves branding identity in addition to its projected module', () => {
    expect(canAccessInitialAdminRoute('admin', true)).toBe(true)
    expect(canAccessInitialAdminRoute('admin', false)).toBe(false)
    expect(canAccessInitialAdminRoute('standard', true)).toBe(false)
  })

  it('uses projected dashboard and users access for safe return targets', () => {
    expect(resolveConfigManagementRedirect(projection(), '/')).toEqual({
      name: 'ChatWorkspace',
      query: { notice: MANAGEMENT_ACCESS_DENIED_NOTICE },
    })
    expect(resolveConfigManagementRedirect(projection('dashboard'), '/')).toBe('/')
    expect(resolvePasswordChangeReturn(projection(), '/workspace?session=owned')).toBe('/workspace?session=owned')
    expect(resolvePasswordChangeReturn(projection('users'), '/users')).toEqual({ name: 'UserManagement' })
    expect(resolvePasswordChangeReturn(projection(), '/users')).toEqual({ name: 'ChatWorkspace' })
  })
})
