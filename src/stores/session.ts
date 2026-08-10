import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useWebSocketStore } from './websocket'
import { useAuthStore } from './auth'
import type { Session, SessionDetail, SessionExport } from '@/api/types'

export const useSessionStore = defineStore('session', () => {
  const sessions = ref<Session[]>([])
  const currentSession = ref<SessionDetail | null>(null)
  const loading = ref(false)
  const usageLoading = ref(false)

  const wsStore = useWebSocketStore()
  const authStore = useAuthStore()
  let listRequestId = 0
  let usageRequestId = 0
  let activeListRequest: Promise<void> | null = null
  const pendingWorkspaceSessions = new Map<string, {
    session: Session
    expiresAt: number
  }>()

  async function createWorkspaceSession(): Promise<string> {
    const response = await fetch('/api/workspace/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authStore.getToken() || ''}`,
      },
    })
    const data = await response.json()
    const sessionKey = typeof data?.sessionKey === 'string' ? data.sessionKey.trim() : ''
    if (!response.ok || !data?.ok || !sessionKey) {
      throw new Error(data?.error?.message || data?.error || '创建工作台会话失败')
    }
    return sessionKey
  }

  function parseUsageNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value))
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed))
    }
    return undefined
  }

  function mergeUsageIntoSessions(baseSessions: Session[], usage: unknown): Session[] {
    if (!Array.isArray(baseSessions) || baseSessions.length === 0) return baseSessions
    if (!usage || typeof usage !== 'object') return baseSessions

    const usageRow = usage as { sessions?: unknown[] }
    const usageList = Array.isArray(usageRow.sessions) ? usageRow.sessions : []
    if (usageList.length === 0) return baseSessions

    const usageMap = new Map<
      string,
      {
        messageCount?: number
        input?: number
        output?: number
        totalTokens?: number
        label?: string
      }
    >()

    for (const item of usageList) {
      if (!item || typeof item !== 'object') continue
      const row = item as {
        key?: unknown
        sessionKey?: unknown
        id?: unknown
        label?: unknown
        usage?: {
          input?: unknown
          output?: unknown
          totalTokens?: unknown
          tokens?: unknown
          total?: unknown
          messageCounts?: { total?: unknown }
        }
      }
      const keyCandidate = row.key ?? row.sessionKey ?? row.id
      const key = typeof keyCandidate === 'string' ? keyCandidate.trim() : ''
      if (!key) continue

      const usageData = row.usage || {}
      const labelValue = row.label
      usageMap.set(key, {
        messageCount: parseUsageNumber(usageData.messageCounts?.total),
        input: parseUsageNumber(usageData.input),
        output: parseUsageNumber(usageData.output),
        totalTokens: parseUsageNumber(usageData.totalTokens ?? usageData.tokens ?? usageData.total),
        label: typeof labelValue === 'string' ? labelValue.trim() : undefined,
      })
    }

    if (usageMap.size === 0) return baseSessions

    return baseSessions.map((session) => {
      const usageData = usageMap.get(session.key)
      if (!usageData) return session

      let changed = false
      const next: Session = { ...session }

      if (usageData.messageCount !== undefined && usageData.messageCount > session.messageCount) {
        next.messageCount = usageData.messageCount
        changed = true
      }

      const hasTokenData =
        usageData.input !== undefined ||
        usageData.output !== undefined ||
        usageData.totalTokens !== undefined

      if (hasTokenData) {
        const currentUsage = session.tokenUsage
        let totalInput = usageData.input ?? currentUsage?.totalInput
        let totalOutput = usageData.output ?? currentUsage?.totalOutput

        if (totalInput === undefined && totalOutput === undefined && usageData.totalTokens !== undefined) {
          totalInput = usageData.totalTokens
          totalOutput = 0
        }

        if (totalInput !== undefined || totalOutput !== undefined) {
          const normalizedInput = Math.max(0, Math.floor(totalInput ?? 0))
          const normalizedOutput = Math.max(0, Math.floor(totalOutput ?? 0))
          const currentInput = currentUsage?.totalInput ?? -1
          const currentOutput = currentUsage?.totalOutput ?? -1
          if (normalizedInput !== currentInput || normalizedOutput !== currentOutput) {
            next.tokenUsage = {
              totalInput: normalizedInput,
              totalOutput: normalizedOutput,
            }
            changed = true
          }
        }
      }

      if (usageData.label && usageData.label !== session.label) {
        next.label = usageData.label
        changed = true
      }

      return changed ? next : session
    })
  }

  function preserveExistingUsage(list: Session[]): Session[] {
    if (list.length === 0 || sessions.value.length === 0) return list
    const previous = new Map(sessions.value.map((session) => [session.key, session]))
    return list.map((session) => {
      const cached = previous.get(session.key)
      if (!cached) return session
      const nextMessageCount = Math.max(session.messageCount, cached.messageCount)
      const nextTokenUsage = session.tokenUsage || cached.tokenUsage
      if (nextMessageCount === session.messageCount && nextTokenUsage === session.tokenUsage) {
        return session
      }
      return {
        ...session,
        messageCount: nextMessageCount,
        tokenUsage: nextTokenUsage,
      }
    })
  }

  function mergePendingWorkspaceSessions(list: Session[]): Session[] {
    if (pendingWorkspaceSessions.size === 0) return list
    const now = Date.now()
    const serverKeys = new Set(list.map((session) => session.key))
    const merged = [...list]

    for (const [key, pending] of pendingWorkspaceSessions) {
      if (serverKeys.has(key)) {
        pendingWorkspaceSessions.delete(key)
        continue
      }
      if (pending.expiresAt <= now) {
        pendingWorkspaceSessions.delete(key)
        continue
      }
      merged.push(pending.session)
    }
    return merged
  }

  function deriveWorkspaceSessionTitle(value: string): string {
    const normalized = value.replace(/\s+/gu, ' ').trim()
    if (!normalized || /^\/[a-z][\w-]*(?:\s|$)/iu.test(normalized)) return ''
    const characters = Array.from(normalized)
    return characters.length > 24
      ? `${characters.slice(0, 24).join('')}…`
      : normalized
  }

  function registerSuccessfulWorkspaceSession(
    key: string,
    firstMessage: string,
    now = Date.now(),
  ) {
    const normalizedKey = key.trim()
    if (!normalizedKey) return
    const existing = sessions.value.find((session) => session.key === normalizedKey)
    const agentId = normalizedKey.match(/^agent:([^:]+):/)?.[1] || 'main'
    const session: Session = {
      ...existing,
      key: normalizedKey,
      agentId,
      channel: 'web',
      peer: existing?.peer || 'webchat',
      messageCount: Math.max(1, existing?.messageCount || 0),
      lastActivity: new Date(now).toISOString(),
      sessionTitle: existing?.sessionTitle || deriveWorkspaceSessionTitle(firstMessage) || null,
      originKind: 'web',
      sourceChannel: 'web',
    }

    // The BFF has registered the key and chat.send has succeeded, so expose
    // the real conversation immediately. Keep it through a possibly stale
    // Gateway list response until the server list confirms it.
    pendingWorkspaceSessions.set(normalizedKey, {
      session,
      expiresAt: now + 30_000,
    })
    sessions.value = [
      session,
      ...sessions.value.filter((item) => item.key !== normalizedKey),
    ]
  }

  function shouldLoadUsage(list: Session[]): boolean {
    if (list.length === 0) return false
    const hasMessageCount = list.some((item) => item.messageCount > 0)
    const hasMissingTokenUsage = list.some((item) => !item.tokenUsage)
    return !hasMessageCount || hasMissingTokenUsage
  }

  function loadUsageInBackground(list: Session[], sourceListRequestId: number) {
    if (!shouldLoadUsage(list)) {
      usageLoading.value = false
      return
    }

    const requestId = ++usageRequestId
    usageLoading.value = true
    void wsStore.rpc.getSessionsUsage({
      limit: Math.max(200, list.length * 4),
    }).then((usage) => {
      if (requestId !== usageRequestId || sourceListRequestId !== listRequestId) return
      sessions.value = mergeUsageIntoSessions(sessions.value, usage)
    }).catch(() => {
      // Usage is supplementary. The already-visible session list remains valid.
    }).finally(() => {
      if (requestId === usageRequestId && sourceListRequestId === listRequestId) {
        usageLoading.value = false
      }
    })
  }

  function fetchSessions(options?: { force?: boolean }): Promise<void> {
    if (activeListRequest && !options?.force) {
      return activeListRequest
    }

    const requestId = ++listRequestId
    // A forced/new list request retires any usage response derived from an
    // older list snapshot. The RPC may still complete, but cannot overwrite it.
    usageRequestId += 1
    usageLoading.value = false
    loading.value = true

    let request!: Promise<void>
    request = (async () => {
      try {
        const list = await wsStore.rpc.listSessions()
        if (requestId !== listRequestId) return

        const visibleList = preserveExistingUsage(mergePendingWorkspaceSessions(list))
        // First paint is driven only by sessions.list. Slow usage statistics
        // are merged progressively without holding the table or callers open.
        sessions.value = visibleList
        loadUsageInBackground(visibleList, requestId)
      } catch (error) {
        if (requestId === listRequestId) {
          console.error('[SessionStore] fetchSessions failed:', error)
        }
      } finally {
        if (requestId === listRequestId) {
          loading.value = false
        }
        if (activeListRequest === request) {
          activeListRequest = null
        }
      }
    })()

    activeListRequest = request
    return request
  }

  async function fetchSession(key: string) {
    loading.value = true
    try {
      currentSession.value = await wsStore.rpc.getSession(key)
    } catch (error) {
      currentSession.value = null
      console.error('[SessionStore] fetchSession failed:', error)
    } finally {
      loading.value = false
    }
  }

  async function resetSession(key: string) {
    await wsStore.rpc.resetSession(key)
    await fetchSessions()
  }

  async function newSession(key: string) {
    await wsStore.rpc.newSession(key)
    await fetchSessions()
  }

  async function deleteSession(key: string) {
    await wsStore.rpc.deleteSession(key)
    pendingWorkspaceSessions.delete(key)
    sessions.value = sessions.value.filter((s) => s.key !== key)
  }

  async function deleteSessions(keys: string[]) {
    const results = await Promise.allSettled(
      keys.map((key) => wsStore.rpc.deleteSession(key))
    )
    const deletedKeys = new Set<string>()
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const key = keys[index]
        if (key) {
          deletedKeys.add(key)
          pendingWorkspaceSessions.delete(key)
        }
      }
    })
    sessions.value = sessions.value.filter((s) => !deletedKeys.has(s.key))
    const failedCount = keys.length - deletedKeys.size
    return { deletedCount: deletedKeys.size, failedCount }
  }

  async function updateSessionRetention(
    key: string,
    request: { method: 'POST' | 'PUT'; path: string; body?: Record<string, unknown> }
  ) {
    const response = await fetch(`/api/session-retention${request.path}`, {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authStore.getToken() || ''}`,
      },
      body: JSON.stringify({ sessionKey: key, ...(request.body || {}) }),
    })
    const data = await response.json()
    if (!response.ok || !data?.ok || !data?.retention) {
      throw new Error(data?.error || '会话留存状态更新失败')
    }
    sessions.value = sessions.value.map((session) => session.key === key
      ? { ...session, retention: data.retention }
      : session)
    return data.retention
  }

  function cancelPendingDeletion(key: string) {
    return updateSessionRetention(key, { method: 'POST', path: '/cancel' })
  }

  function setLongTermRetention(key: string, enabled: boolean) {
    return updateSessionRetention(key, { method: 'PUT', path: '/long-term', body: { enabled } })
  }

  async function spawnSession(params: {
    agentId?: string
    channel?: string
    peer?: string
    label?: string
    thread?: boolean
  }): Promise<string> {
    const result = await wsStore.rpc.spawnSession(params)
    return result.sessionKey
  }

  async function createSession(params: {
    agentId?: string
    channel?: string
    peer?: string
    label?: string
  }): Promise<string> {
    // Gateway 会话键只能由 Admin BFF 签发并登记归属。保留旧页面传入的
    // agent/channel/peer 字段，仅兼容其表单调用；它们不再参与会话键拼接。
    const sessionKey = await createWorkspaceSession()
    const idempotencyKey = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

    await wsStore.rpc.sendChatMessage({
      sessionKey,
      message: '/new',
      idempotencyKey,
    })

    if (params.label) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await wsStore.rpc.patchSession({ sessionKey, label: params.label })
    }

    await fetchSessions()
    return sessionKey
  }

  async function patchSessionLabel(sessionKey: string, label: string): Promise<void> {
    await wsStore.rpc.patchSession({ sessionKey, label })
    await fetchSessions()
  }

  async function exportSession(key: string): Promise<SessionExport> {
    return await wsStore.rpc.exportSession(key)
  }

  return {
    sessions,
    currentSession,
    loading,
    usageLoading,
    fetchSessions,
    registerSuccessfulWorkspaceSession,
    fetchSession,
    resetSession,
    newSession,
    deleteSession,
    deleteSessions,
    cancelPendingDeletion,
    setLongTermRetention,
    spawnSession,
    createWorkspaceSession,
    createSession,
    patchSessionLabel,
    exportSession,
  }
})
