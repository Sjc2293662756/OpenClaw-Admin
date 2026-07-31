import { describe, expect, it } from 'vitest'
import {
  PAGE_ACCESS_MATRIX,
  canAccessPage,
  canAccessRoute,
  getPageAccess,
  type PageAccessKey,
  type UserRole,
} from './access-control'

const roles: UserRole[] = ['basic', 'auditor', 'standard', 'admin']

const expected: Record<PageAccessKey, UserRole[]> = {
  dashboard: roles,
  alerts: roles,
  chat: roles,
  sessions: roles,
  reports: roles,
  cron: ['auditor', 'admin'],
  memory: ['admin'],
  models: ['admin'],
  channels: roles,
  skills: ['auditor', 'standard', 'admin'],
  system: ['auditor', 'standard', 'admin'],
  agents: ['admin'],
  office: ['admin'],
  users: ['auditor', 'admin'],
  userAdministration: ['admin'],
  audit: ['auditor', 'admin'],
  settings: roles,
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
    expect(getPageAccess('SystemUpgrade')?.moduleName).toBe('系统升级')
  })
})
