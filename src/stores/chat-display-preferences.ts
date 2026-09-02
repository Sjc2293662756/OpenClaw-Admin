import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useAuthStore, type AuthUser } from '@/stores/auth'

export type ChatDisplayPreferences = {
  showThinkingProcess: boolean
  updatedAt: number | null
}

export const DEFAULT_CHAT_DISPLAY_PREFERENCES: ChatDisplayPreferences = Object.freeze({
  showThinkingProcess: true,
  updatedAt: null,
})

function readPreferences(value: unknown): ChatDisplayPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.showThinkingProcess !== 'boolean') return null
  const updatedAt = row.updatedAt === null || row.updatedAt === undefined
    ? null
    : Number(row.updatedAt)
  if (updatedAt !== null && !Number.isFinite(updatedAt)) return null
  return { showThinkingProcess: row.showThinkingProcess, updatedAt }
}

export const useChatDisplayPreferencesStore = defineStore('chat-display-preferences', () => {
  const activeAccount = ref<string | null>(null)
  const preferences = ref<ChatDisplayPreferences>({ ...DEFAULT_CHAT_DISPLAY_PREFERENCES })
  const preferencesReady = ref(false)
  const preferencesLoading = ref(false)
  const preferencesLoadError = ref<string | null>(null)
  const preferencesSaving = ref(false)
  const preferencesSaveError = ref<string | null>(null)

  let generation = 0
  let loadController: AbortController | null = null
  let saveController: AbortController | null = null
  let loadingPromise: Promise<boolean> | null = null

  function resetPreferences() {
    preferences.value = { ...DEFAULT_CHAT_DISPLAY_PREFERENCES }
    preferencesReady.value = false
    preferencesLoading.value = false
    preferencesLoadError.value = null
    preferencesSaving.value = false
    preferencesSaveError.value = null
  }

  function activate(user: Pick<AuthUser, 'id'> | null | undefined) {
    const nextAccount = String(user?.id || '').trim() || null
    if (nextAccount === activeAccount.value) return false
    generation += 1
    loadController?.abort()
    saveController?.abort()
    loadController = null
    saveController = null
    loadingPromise = null
    activeAccount.value = nextAccount
    resetPreferences()
    return true
  }

  function isCurrent(account: string, requestGeneration: number) {
    return activeAccount.value === account && generation === requestGeneration
  }

  async function loadPreferences({ retry = false }: { retry?: boolean } = {}): Promise<boolean> {
    if (!activeAccount.value) return false
    if (loadingPromise && !retry) return loadingPromise
    if (retry) loadController?.abort()

    const account = activeAccount.value
    const requestGeneration = generation
    const controller = new AbortController()
    loadController = controller
    preferencesLoading.value = true
    preferencesLoadError.value = null

    const request = (async () => {
      try {
        const token = useAuthStore().getToken()
        const response = await fetch('/api/chat/preferences', {
          headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          signal: controller.signal,
        })
        const body = await response.json().catch(() => null)
        const loaded = response.ok && body?.ok ? readPreferences(body.preferences) : null
        if (!loaded) throw new Error(String(body?.error?.message || body?.error || body?.code || 'CHAT_PREFERENCES_LOAD_FAILED'))
        if (!isCurrent(account, requestGeneration)) return false
        preferences.value = loaded
        preferencesReady.value = true
        return true
      } catch (error) {
        if (!controller.signal.aborted && isCurrent(account, requestGeneration)) {
          preferencesLoadError.value = error instanceof Error ? error.message : 'CHAT_PREFERENCES_LOAD_FAILED'
        }
        return false
      } finally {
        if (isCurrent(account, requestGeneration)) preferencesLoading.value = false
        if (loadController === controller) loadController = null
      }
    })()
    loadingPromise = request
    void request.finally(() => {
      if (loadingPromise === request) loadingPromise = null
    })
    return request
  }

  function retryPreferences() {
    return loadPreferences({ retry: true })
  }

  async function savePreferences(showThinkingProcess: boolean): Promise<ChatDisplayPreferences> {
    if (typeof showThinkingProcess !== 'boolean' || !activeAccount.value) {
      throw new Error('CHAT_PREFERENCES_INVALID')
    }
    saveController?.abort()
    const account = activeAccount.value
    const requestGeneration = generation
    const controller = new AbortController()
    saveController = controller
    preferencesSaving.value = true
    preferencesSaveError.value = null
    try {
      const token = useAuthStore().getToken()
      const response = await fetch('/api/chat/preferences', {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ showThinkingProcess }),
        signal: controller.signal,
      })
      const body = await response.json().catch(() => null)
      const saved = response.ok && body?.ok ? readPreferences(body.preferences) : null
      if (!saved) throw new Error(String(body?.error?.message || body?.error || body?.code || 'CHAT_PREFERENCES_SAVE_FAILED'))
      if (!isCurrent(account, requestGeneration)) throw new Error('CHAT_PREFERENCES_ACCOUNT_CHANGED')
      preferences.value = saved
      preferencesReady.value = true
      return saved
    } catch (error) {
      if (!controller.signal.aborted && isCurrent(account, requestGeneration)) {
        preferencesSaveError.value = error instanceof Error ? error.message : 'CHAT_PREFERENCES_SAVE_FAILED'
      }
      throw error
    } finally {
      if (isCurrent(account, requestGeneration)) preferencesSaving.value = false
      if (saveController === controller) saveController = null
    }
  }

  async function syncAccount(user: Pick<AuthUser, 'id'> | null | undefined) {
    activate(user)
    if (!activeAccount.value) return false
    if (preferencesReady.value) return true
    return loadPreferences()
  }

  function clearForLogout() {
    activate(null)
  }

  return {
    activeAccount,
    preferences,
    preferencesReady,
    preferencesLoading,
    preferencesLoadError,
    preferencesSaving,
    preferencesSaveError,
    activate,
    loadPreferences,
    retryPreferences,
    savePreferences,
    syncAccount,
    clearForLogout,
  }
})
