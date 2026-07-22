import { describe, expect, it } from 'vitest'
import { LEGACY_THEME_STORAGE_KEY, THEME_STORAGE_KEY, normalizeThemeMode, resolveInitialTheme } from './theme'

function storage(values: Record<string, string | null>) {
  return { getItem: (key: string) => values[key] ?? null }
}

describe('theme initialization', () => {
  it('defaults every new browser profile to light mode', () => {
    expect(resolveInitialTheme(storage({}))).toBe('light')
  })

  it('preserves an explicit GAIOP theme selection', () => {
    expect(resolveInitialTheme(storage({ [THEME_STORAGE_KEY]: 'dark' }))).toBe('dark')
  })

  it('migrates a valid legacy theme selection', () => {
    expect(resolveInitialTheme(storage({ [LEGACY_THEME_STORAGE_KEY]: 'dark' }))).toBe('dark')
  })

  it('rejects invalid persisted values instead of enabling dark mode', () => {
    expect(normalizeThemeMode('system')).toBeNull()
    expect(resolveInitialTheme(storage({ [THEME_STORAGE_KEY]: 'system' }))).toBe('light')
  })
})
