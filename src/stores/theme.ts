import { ref, watch } from 'vue'
import { defineStore } from 'pinia'

export type ThemeMode = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'gaiop_theme'
export const LEGACY_THEME_STORAGE_KEY = 'openclaw_theme'

export function normalizeThemeMode(value: string | null): ThemeMode | null {
  return value === 'light' || value === 'dark' ? value : null
}

export function resolveInitialTheme(storage: Pick<Storage, 'getItem'>): ThemeMode {
  return normalizeThemeMode(storage.getItem(THEME_STORAGE_KEY))
    || normalizeThemeMode(storage.getItem(LEGACY_THEME_STORAGE_KEY))
    || 'light'
}

export const useThemeStore = defineStore('theme', () => {
  // 首次访问始终以浅色为产品默认；只保留用户明确保存过的合法主题值。
  const mode = ref<ThemeMode>(resolveInitialTheme(localStorage))

  watch(mode, (val) => {
    localStorage.setItem(THEME_STORAGE_KEY, val)
    document.documentElement.setAttribute('data-theme', val)
    document.documentElement.style.colorScheme = val
  }, { immediate: true })

  function toggle() {
    mode.value = mode.value === 'light' ? 'dark' : 'light'
  }

  function setMode(m: ThemeMode) {
    mode.value = m
  }

  return { mode, toggle, setMode }
})
