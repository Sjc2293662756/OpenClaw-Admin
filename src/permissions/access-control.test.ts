import { describe, expect, it } from 'vitest'
import {
  PAGE_ACCESS_MATRIX,
  canAccessPage,
  canAccessRoute,
  canUseConversation,
  getPageAccess,
  type PageAccessKey,
  type UserRole,
} from './access-control'

const roles: UserRole[] = ['basic', 'auditor', 'standard', 'admin']

const expected: Record<PageAccessKey, UserRole[]> = {
  dashboard: ['auditor', 'standard', 'admin'],
  alerts: ['auditor', 'standard', 'admin'],
  chat: roles,
  sessions: ['auditor', 'standard', 'admin'],
  reports: ['auditor', 'standard', 'admin'],
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
    expect(canAccessRoute('basic', 'Files')).toBe(false)
    expect(getPageAccess('SystemUpgrade')?.moduleName).toBe('系统升级')
  })

  it('allows basic users to converse while auditors remain read-only', () => {
    expect(canUseConversation('basic')).toBe(true)
    expect(canUseConversation('standard')).toBe(true)
    expect(canUseConversation('admin')).toBe(true)
    expect(canUseConversation('auditor')).toBe(false)
  })
})
