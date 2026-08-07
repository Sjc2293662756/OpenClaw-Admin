import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useAuthStore } from './auth'
import { byLocale, getActiveLocale } from '@/i18n/text'

export type PersonalWechatPlugin = {
  installed: boolean
  available: boolean
  version?: string
  reasonCode?: string
}

export type PersonalWechatChannel = {
  configured: boolean
  enabled: boolean | null
}

export type PersonalWechatAccountStatus = 'online' | 'offline' | 'disabled' | 'error' | 'unknown'

export type PersonalWechatAccount = {
  accountId: string
  displayName: string
  note?: string
  nickname?: string
  wechatIdentifier: string
  enabled: boolean
  status: PersonalWechatAccountStatus
  errorCode?: string
}

export type PersonalWechatOnboardingStatus =
  | 'starting'
  | 'waiting_for_scan'
  | 'scanned'
  | 'verification_required'
  | 'success'
  | 'expired'
  | 'failed'
  | 'cancelled'

export type PersonalWechatOnboardingSession = {
  id: string
  status: PersonalWechatOnboardingStatus
  displayName: string
  note?: string
  qrDataUrl?: string
  expiresAt?: number
  accountId?: string
  nickname?: string
  wechatIdentifier?: string
  errorCode?: string
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as JsonRecord
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function safeCode(value: unknown): string | undefined {
  const code = asString(value)
  return /^[A-Z0-9_.-]{1,80}$/i.test(code) ? code : undefined
}

function asTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function normalizeAccountStatus(value: unknown, enabled: boolean): PersonalWechatAccountStatus {
  if (!enabled) return 'disabled'
  const normalized = asString(value).toLowerCase()
  if (['online', 'running', 'connected', 'ready'].includes(normalized)) return 'online'
  if (['offline', 'disconnected'].includes(normalized)) return 'offline'
  if (['disabled', 'stopped', 'inactive'].includes(normalized)) return 'disabled'
  if (['error', 'failed', 'abnormal', 'unavailable'].includes(normalized)) return 'error'
  return 'unknown'
}

export function normalizePersonalWechatAccount(value: unknown): PersonalWechatAccount | null {
  const row = asRecord(value)
  const accountId = asString(row.accountId || row.id)
  if (!accountId) return null
  const enabled = row.enabled !== false
  const displayName = asString(row.displayName || row.name) || accountId
  const nickname = asString(row.nickname || row.wechatNickname) || undefined
  const wechatIdentifier = asString(row.wechatIdentifier || row.wechatId || row.userId || row.stableId) || accountId
  return {
    accountId,
    displayName,
    note: asString(row.note) || undefined,
    nickname,
    wechatIdentifier,
    enabled,
    status: normalizeAccountStatus(row.status, enabled),
    errorCode: safeCode(row.errorCode),
  }
}

function normalizeOnboardingStatus(value: unknown): PersonalWechatOnboardingStatus {
  const status = asString(value).toLowerCase()
  if (['starting', 'creating', 'initializing'].includes(status)) return 'starting'
  if (['waiting_for_scan', 'waiting', 'qr_ready'].includes(status)) return 'waiting_for_scan'
  if (['scanned', 'configuring', 'confirming'].includes(status)) return 'scanned'
  if (['verification_required', 'need_verify', 'code_required', 'waiting_for_verification'].includes(status)) {
    return 'verification_required'
  }
  if (['success', 'connected', 'configured', 'completed'].includes(status)) return 'success'
  if (status === 'expired') return 'expired'
  if (['cancelled', 'canceled'].includes(status)) return 'cancelled'
  return 'failed'
}

export function normalizePersonalWechatOnboarding(value: unknown): PersonalWechatOnboardingSession | null {
  const row = asRecord(value)
  const id = asString(row.id || row.sessionId)
  if (!id) return null
  return {
    id,
    status: normalizeOnboardingStatus(row.status),
    displayName: asString(row.displayName || row.name),
    note: asString(row.note) || undefined,
    qrDataUrl: asString(row.qrDataUrl || row.qrCodeDataUrl) || undefined,
    expiresAt: asTimestamp(row.expiresAt),
    accountId: asString(row.accountId) || undefined,
    nickname: asString(row.nickname || row.wechatNickname) || undefined,
    wechatIdentifier: asString(row.wechatIdentifier || row.wechatId || row.userId || row.stableId) || undefined,
    errorCode: safeCode(row.errorCode),
  }
}

function fallbackMessage(zh: string, en: string): string {
  return byLocale(zh, en, getActiveLocale())
}

function apiError(result: JsonRecord, fallback: string): Error {
  const code = safeCode(result.errorCode || result.code)
  return new Error(code ? `${fallback} (${code})` : fallback)
}

export const usePersonalWechatStore = defineStore('personal-wechat', () => {
  const authStore = useAuthStore()
  const loading = ref(false)
  const mutating = ref(false)
  const operationAccountId = ref<string | null>(null)
  const plugin = ref<PersonalWechatPlugin>({ installed: false, available: false })
  const channel = ref<PersonalWechatChannel>({ configured: false, enabled: null })
  const accounts = ref<PersonalWechatAccount[]>([])
  const onboarding = ref<PersonalWechatOnboardingSession | null>(null)
  const lastError = ref<string | null>(null)

  const pluginReady = computed(() => plugin.value.installed && plugin.value.available)
  const channelConfigured = computed(() => channel.value.configured)

  function headers(json = false): Record<string, string> {
    const result: Record<string, string> = {
      Authorization: `Bearer ${authStore.getToken() || ''}`,
    }
    if (json) result['Content-Type'] = 'application/json'
    return result
  }

  async function parseResponse(response: Response, fallback: string): Promise<JsonRecord> {
    const result = asRecord(await response.json().catch(() => ({})))
    if (!response.ok || result.ok !== true) throw apiError(result, fallback)
    return result
  }

  function normalizeCollection(result: JsonRecord): void {
    const pluginRow = asRecord(result.plugin)
    const installed = pluginRow.installed === true || result.pluginInstalled === true
    const available = pluginRow.available === true || result.pluginAvailable === true
    plugin.value = {
      installed,
      available: installed && available,
      version: asString(pluginRow.version || result.pluginVersion) || undefined,
      reasonCode: safeCode(pluginRow.reasonCode || result.reasonCode),
    }
    const rows = Array.isArray(result.accounts) ? result.accounts : []
    accounts.value = rows
      .map(normalizePersonalWechatAccount)
      .filter((account): account is PersonalWechatAccount => account !== null)
    const channelRow = asRecord(result.channel)
    channel.value = {
      configured: channelRow.configured === true || accounts.value.length > 0,
      enabled: typeof channelRow.enabled === 'boolean' ? channelRow.enabled : null,
    }
  }

  async function refresh(): Promise<void> {
    loading.value = true
    lastError.value = null
    try {
      const response = await fetch('/api/channels/personal-wechat', { headers: headers() })
      const result = await parseResponse(
        response,
        fallbackMessage('个人微信状态暂时无法读取', 'Personal WeChat status is unavailable'),
      )
      normalizeCollection(result)
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      loading.value = false
    }
  }

  async function startOnboarding(input: { displayName: string; note?: string }): Promise<PersonalWechatOnboardingSession> {
    const displayName = input.displayName.trim()
    const note = input.note?.trim() || undefined
    if (!displayName) throw new Error(fallbackMessage('账户名称不能为空', 'Account name is required'))
    mutating.value = true
    lastError.value = null
    try {
      const response = await fetch('/api/channels/personal-wechat/onboarding', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ displayName, note }),
      })
      const result = await parseResponse(
        response,
        fallbackMessage('个人微信二维码暂时无法生成', 'The Personal WeChat QR code could not be generated'),
      )
      const session = normalizePersonalWechatOnboarding(result.session)
      if (!session) throw new Error(fallbackMessage('扫码会话响应无效', 'The onboarding session response is invalid'))
      session.displayName ||= displayName
      session.note ||= note
      onboarding.value = session
      return session
    } finally {
      mutating.value = false
    }
  }

  async function refreshOnboarding(): Promise<PersonalWechatOnboardingSession | null> {
    const sessionId = onboarding.value?.id
    if (!sessionId) return null
    const response = await fetch(`/api/channels/personal-wechat/onboarding/${encodeURIComponent(sessionId)}`, {
      headers: headers(),
    })
    const result = await parseResponse(
      response,
      fallbackMessage('扫码状态暂时无法读取', 'The onboarding status is unavailable'),
    )
    const session = normalizePersonalWechatOnboarding(result.session)
    if (!session) throw new Error(fallbackMessage('扫码会话响应无效', 'The onboarding session response is invalid'))
    const current = onboarding.value
    session.displayName ||= current?.displayName || ''
    session.note ||= current?.note
    onboarding.value = session
    return session
  }

  async function verifyOnboarding(code: string): Promise<PersonalWechatOnboardingSession> {
    const sessionId = onboarding.value?.id
    const normalizedCode = code.trim()
    if (!sessionId || !normalizedCode) throw new Error(fallbackMessage('请输入微信验证码', 'Enter the WeChat verification code'))
    mutating.value = true
    try {
      const response = await fetch(`/api/channels/personal-wechat/onboarding/${encodeURIComponent(sessionId)}/verify`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ code: normalizedCode }),
      })
      const result = await parseResponse(
        response,
        fallbackMessage('验证码提交失败', 'Failed to submit the verification code'),
      )
      const session = normalizePersonalWechatOnboarding(result.session)
      if (!session) throw new Error(fallbackMessage('扫码会话响应无效', 'The onboarding session response is invalid'))
      const current = onboarding.value
      session.displayName ||= current?.displayName || ''
      session.note ||= current?.note
      onboarding.value = session
      return session
    } finally {
      mutating.value = false
    }
  }

  async function cancelOnboarding(): Promise<void> {
    const sessionId = onboarding.value?.id
    if (!sessionId) {
      onboarding.value = null
      return
    }
    mutating.value = true
    try {
      const response = await fetch(`/api/channels/personal-wechat/onboarding/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: headers(),
      })
      await parseResponse(
        response,
        fallbackMessage('扫码会话无法取消', 'The onboarding session could not be cancelled'),
      )
      onboarding.value = null
    } finally {
      mutating.value = false
    }
  }

  async function setAccountEnabled(accountId: string, enabled: boolean): Promise<void> {
    operationAccountId.value = accountId
    lastError.value = null
    const index = accounts.value.findIndex((item) => item.accountId === accountId)
    const previousAccount = index >= 0 ? accounts.value[index] : null
    if (index >= 0 && previousAccount) {
      accounts.value[index] = {
        ...previousAccount,
        enabled,
        status: enabled ? 'unknown' : 'disabled',
        errorCode: undefined,
      }
    }
    try {
      const response = await fetch(`/api/channels/personal-wechat/accounts/${encodeURIComponent(accountId)}/enabled`, {
        method: 'PUT',
        headers: headers(true),
        body: JSON.stringify({ enabled }),
      })
      const result = await parseResponse(
        response,
        fallbackMessage('个人微信账号状态更新失败', 'Failed to update the Personal WeChat account'),
      )
      const account = normalizePersonalWechatAccount(result.account)
      if (account) {
        const currentIndex = accounts.value.findIndex((item) => item.accountId === account.accountId)
        if (currentIndex >= 0) accounts.value[currentIndex] = account
        else accounts.value.push(account)
      } else {
        await refresh()
      }
    } catch (error) {
      if (previousAccount) {
        const currentIndex = accounts.value.findIndex((item) => item.accountId === accountId)
        if (currentIndex >= 0) accounts.value[currentIndex] = previousAccount
        else accounts.value.push(previousAccount)
      }
      lastError.value = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      operationAccountId.value = null
    }
  }

  async function setChannelEnabled(enabled: boolean): Promise<void> {
    mutating.value = true
    lastError.value = null
    try {
      const response = await fetch('/api/channels/personal-wechat/channel-enabled', {
        method: 'PUT',
        headers: headers(true),
        body: JSON.stringify({ enabled }),
      })
      await parseResponse(
        response,
        fallbackMessage('个人微信渠道状态更新失败', 'Failed to update the Personal WeChat channel'),
      )
      channel.value = { ...channel.value, enabled }
      accounts.value = accounts.value.map((account) => ({
        ...account,
        enabled,
        status: enabled ? 'unknown' : 'disabled',
        errorCode: undefined,
      }))
      await refresh().catch(() => {})
    } finally {
      mutating.value = false
    }
  }

  async function deleteAccount(accountId: string): Promise<void> {
    operationAccountId.value = accountId
    lastError.value = null
    // Optimistic removal: hide the account immediately and restore it if the
    // server-side delete fails.
    const previousAccounts = accounts.value
    accounts.value = accounts.value.filter((item) => item.accountId !== accountId)
    try {
      const response = await fetch(`/api/channels/personal-wechat/accounts/${encodeURIComponent(accountId)}`, {
        method: 'DELETE',
        headers: headers(),
      })
      await parseResponse(
        response,
        fallbackMessage('个人微信账号删除失败', 'Failed to delete the Personal WeChat account'),
      )
    } catch (error) {
      accounts.value = previousAccounts
      lastError.value = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      operationAccountId.value = null
    }
  }

  function clearOnboarding(): void {
    onboarding.value = null
  }

  return {
    loading,
    mutating,
    operationAccountId,
    plugin,
    channel,
    pluginReady,
    channelConfigured,
    accounts,
    onboarding,
    lastError,
    refresh,
    startOnboarding,
    refreshOnboarding,
    verifyOnboarding,
    cancelOnboarding,
    setAccountEnabled,
    setChannelEnabled,
    deleteAccount,
    clearOnboarding,
  }
})
