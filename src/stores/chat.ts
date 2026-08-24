import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useWebSocketStore } from './websocket'
import { shouldApplyRealtimeEvent } from '@/utils/session-presentation'
import type { ChatMessage } from '@/api/types'
import { byLocale, getActiveLocale } from '@/i18n/text'

type AgentPhase =
  | 'idle'
  | 'sending'
  | 'waiting'
  | 'thinking'
  | 'tool'
  | 'replying'
  | 'aborting'
  | 'done'
  | 'aborted'
  | 'error'

interface AgentStatus {
  phase: AgentPhase
  runId: string | null
  detail: string | null
  updatedAtMs: number
  sinceMs: number
  sessionKey: string | null
  lastMessage: string | null
  finishedAtMs: number | null
}

interface AgentStep {
  ts: number
  phase: AgentPhase
  label: string
}

interface ToolProgress {
  toolCallId: string
  name: string
  phase: 'start' | 'update' | 'result'
  meta: string | null
  isError: boolean | null
  argsPreview: string | null
  partialPreview: string | null
  resultPreview: string | null
  startedAtMs: number
  updatedAtMs: number
}

const MAX_AGENT_STEPS = 30
const TOOL_PREVIEW_MAX_CHARS = 6000
const FINALIZED_RUN_TTL_MS = 5 * 60 * 1000
// Report/tool events can carry the message inside several protocol envelopes.
// Keep traversal bounded while covering the deepest Gateway envelopes seen in
// production.
const MAX_EVENT_NESTING = 8
const EVENT_WRAPPER_KEYS = [
  'payload',
  'data',
  'event',
  'session',
  'message',
  'result',
  'context',
  'meta',
  'request',
  'response',
  'envelope',
  'body',
] as const
const MESSAGE_CONTAINER_KEYS = ['messages', 'items', 'transcript', 'history', 'events', 'turns'] as const

export const useChatStore = defineStore('chat', () => {
  const CONTEXT_COMPACTION_DETAIL_ZH = '上下文压缩中...'
  const CONTEXT_COMPACTION_DETAIL_EN = 'Compacting context...'

  const sessionKey = ref('')
  const messages = ref<ChatMessage[]>([])
  const loading = ref(false)
  const syncing = ref(false)
  const sending = ref(false)
  const lastError = ref<string | null>(null)
  const lastSyncedAt = ref<number | null>(null)
  
  // 支持多个智能体的状态管理
  const agentStatuses = ref<Map<string, AgentStatus>>(new Map())
  const agentSteps = ref<Map<string, AgentStep[]>>(new Map())
  const toolProgress = ref<Map<string, ToolProgress | null>>(new Map())
  
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let pollTimers: Array<ReturnType<typeof setTimeout>> = []
  let streamFlushRaf: number | null = null
  let pendingStreamMessages: ChatMessage[] = []
  let activeRealtimeMessageId: string | null = null
  let lastToolPreviewUpdateAtMs = 0
  const finalizedRuns = new Map<string, number>()
  let historyRequestId = 0
  let activeHistoryKey = ''
  let activeHistoryRequest: Promise<void> | null = null

  // 获取或创建智能体状态
  function getOrCreateAgentStatus(agentId: string): AgentStatus {
    if (!agentStatuses.value.has(agentId)) {
      agentStatuses.value.set(agentId, {
        phase: 'idle',
        runId: null,
        detail: null,
        updatedAtMs: Date.now(),
        sinceMs: Date.now(),
        sessionKey: null,
        lastMessage: null,
        finishedAtMs: null,
      })
    }
    return agentStatuses.value.get(agentId)!  
  }

  // 获取或创建智能体步骤
  function getOrCreateAgentSteps(agentId: string): AgentStep[] {
    if (!agentSteps.value.has(agentId)) {
      agentSteps.value.set(agentId, [])
    }
    return agentSteps.value.get(agentId)!  
  }

  // 获取或创建工具进度
  function getOrCreateToolProgress(agentId: string): ToolProgress | null {
    if (!toolProgress.value.has(agentId)) {
      toolProgress.value.set(agentId, null)
    }
    return toolProgress.value.get(agentId)!  
  }

  const wsStore = useWebSocketStore()

  function toolCompletedDetail(toolName: string): string {
    const locale = getActiveLocale()
    return byLocale(`工具完成：${toolName}`, `Tool done: ${toolName}`, locale)
  }

  function contextCompactionDetail(): string {
    const locale = getActiveLocale()
    return byLocale(CONTEXT_COMPACTION_DETAIL_ZH, CONTEXT_COMPACTION_DETAIL_EN, locale)
  }

  function isContextCompactionDetail(value: string | null): boolean {
    if (!value) return false
    return value === CONTEXT_COMPACTION_DETAIL_ZH || value === CONTEXT_COMPACTION_DETAIL_EN
  }

  function markRunFinal(runId: string) {
    const normalized = runId.trim()
    if (!normalized) return

    const now = Date.now()
    finalizedRuns.set(normalized, now)

    for (const [key, ts] of finalizedRuns) {
      if (now - ts > FINALIZED_RUN_TTL_MS) {
        finalizedRuns.delete(key)
      }
    }
  }

  function isRunFinalized(runId: string): boolean {
    const normalized = runId.trim()
    if (!normalized) return false

    const ts = finalizedRuns.get(normalized)
    if (!ts) return false

    const now = Date.now()
    if (now - ts > FINALIZED_RUN_TTL_MS) {
      finalizedRuns.delete(normalized)
      return false
    }
    return true
  }

  function truncatePreview(value: string, maxChars = TOOL_PREVIEW_MAX_CHARS): string {
    const text = value.trim()
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}...`
  }

  function redactSensitive(value: unknown, depth = 0): unknown {
    if (depth > 4) return value
    if (!value) return value
    if (typeof value !== 'object') return value

    if (Array.isArray(value)) {
      return value.map((item) => redactSensitive(item, depth + 1))
    }

    const row = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(row)) {
      if (/token|password|secret|api[_-]?key|authorization|cookie/i.test(key)) {
        next[key] = '[REDACTED]'
        continue
      }
      next[key] = redactSensitive(raw, depth + 1)
    }
    return next
  }

  function toJsonPreview(value: unknown): string | null {
    if (value === undefined || value === null) return null
    if (typeof value === 'string') {
      const trimmed = value.trim()
      return trimmed ? truncatePreview(trimmed) : null
    }

    try {
      const redacted = redactSensitive(value)
      const json = JSON.stringify(redacted, null, 2)
      return json ? truncatePreview(json) : null
    } catch {
      const fallback = String(value)
      return fallback.trim() ? truncatePreview(fallback) : null
    }
  }

  function stepLabel(phase: AgentPhase, detail: string | null): string {
    const locale = getActiveLocale()
    if (phase === 'sending') return byLocale('消息发送中', 'Sending', locale)
    if (phase === 'waiting') return byLocale('等待响应', 'Waiting', locale)
    if (phase === 'thinking') return detail?.trim() ? detail.trim() : byLocale('思考中', 'Thinking', locale)
    if (phase === 'tool') {
      return detail?.trim()
        ? byLocale(`调用工具：${detail.trim()}`, `Calling tool: ${detail.trim()}`, locale)
        : byLocale('调用工具中', 'Running tool', locale)
    }
    if (phase === 'replying') return byLocale('回复中', 'Replying', locale)
    if (phase === 'aborting') return byLocale('停止中...', 'Stopping...', locale)
    if (phase === 'done') return byLocale('本轮完成', 'Done', locale)
    if (phase === 'aborted') return byLocale('已停止', 'Stopped', locale)
    if (phase === 'error') return detail?.trim() ? byLocale(`错误：${detail.trim()}`, `Error: ${detail.trim()}`, locale) : byLocale('错误', 'Error', locale)
    return byLocale('空闲', 'Idle', locale)
  }

  function appendAgentStep(agentId: string, phase: AgentPhase, detail: string | null) {
    if (phase === 'idle') return

    const label = stepLabel(phase, detail)
    const now = Date.now()
    const steps = getOrCreateAgentSteps(agentId)
    const last = steps[steps.length - 1]
    if (last && last.phase === phase && last.label === label) {
      return
    }

    agentSteps.value.set(agentId, [...steps, { ts: now, phase, label }].slice(-MAX_AGENT_STEPS))
  }

  function resetAgentProgress(agentId: string) {
    agentSteps.value.set(agentId, [])
    toolProgress.value.set(agentId, null)
    lastToolPreviewUpdateAtMs = 0
  }

  function setAgentStatusPhase(agentId: string, phase: AgentPhase, patch?: { runId?: string | null; detail?: string | null; sessionKey?: string | null; lastMessage?: string | null }) {
    const now = Date.now()
    const prev = getOrCreateAgentStatus(agentId)
    
    const isTerminalPhase = phase === 'done' || phase === 'aborted' || phase === 'error' || phase === 'idle'
    const wasActivePhase = prev.phase !== 'idle' && prev.phase !== 'done' && prev.phase !== 'aborted' && prev.phase !== 'error'
    
    const next: AgentStatus = {
      ...prev,
      phase,
      runId: patch?.runId === undefined ? prev.runId : patch.runId,
      detail: patch?.detail === undefined ? prev.detail : patch.detail,
      sessionKey: patch?.sessionKey === undefined ? prev.sessionKey : patch.sessionKey,
      lastMessage: patch?.lastMessage === undefined ? prev.lastMessage : patch.lastMessage,
      updatedAtMs: now,
      sinceMs: prev.phase === phase ? prev.sinceMs : now,
      finishedAtMs: isTerminalPhase && wasActivePhase ? now : prev.finishedAtMs,
    }

    const unchanged =
      prev.phase === next.phase &&
      prev.runId === next.runId &&
      prev.detail === next.detail &&
      prev.sessionKey === next.sessionKey &&
      prev.lastMessage === next.lastMessage
    if (unchanged) return

    agentStatuses.value.set(agentId, next)

    const phaseChanged = prev.phase !== next.phase
    const detailChanged = prev.detail !== next.detail
    if (
      phaseChanged ||
      (next.phase === 'tool' && detailChanged) ||
      (next.phase === 'thinking' && detailChanged && !!next.detail)
    ) {
      appendAgentStep(agentId, next.phase, next.detail)
    }
  }

  function touchAgentStatus(agentId: string) {
    const now = Date.now()
    const agentStatus = getOrCreateAgentStatus(agentId)
    if (!agentStatus.updatedAtMs || now - agentStatus.updatedAtMs >= 50) {
      agentStatuses.value.set(agentId, {
        ...agentStatus,
        updatedAtMs: now,
      })
    }
  }

  function extractNestedStringField(
    payload: unknown,
    fieldNames: readonly string[],
    depth = 0,
    visited = new Set<object>()
  ): string {
    if (!payload || typeof payload !== 'object' || depth > MAX_EVENT_NESTING) return ''
    if (visited.has(payload)) return ''
    visited.add(payload)

    if (Array.isArray(payload)) {
      for (const item of payload) {
        const value = extractNestedStringField(item, fieldNames, depth + 1, visited)
        if (value) return value
      }
      return ''
    }

    const row = payload as Record<string, unknown>
    for (const fieldName of fieldNames) {
      const value = asString(row[fieldName]).trim()
      if (value) return value
    }
    for (const key of EVENT_WRAPPER_KEYS) {
      const value = extractNestedStringField(row[key], fieldNames, depth + 1, visited)
      if (value) return value
    }
    for (const [key, value] of Object.entries(row)) {
      if (fieldNames.includes(key) || EVENT_WRAPPER_KEYS.includes(key as typeof EVENT_WRAPPER_KEYS[number])) continue
      if (!value || typeof value !== 'object') continue
      const nested = extractNestedStringField(value, fieldNames, depth + 1, visited)
      if (nested) return nested
    }
    return ''
  }

  function resolveChatEventState(normalizedEvent: string, payload?: unknown): string {
    const direct = extractNestedStringField(payload, ['state', 'status', 'phase']).toLowerCase()
    if (direct) return direct

    if (normalizedEvent === 'chat.delta' || normalizedEvent.endsWith('.delta')) return 'delta'
    if (normalizedEvent === 'chat.final' || normalizedEvent.endsWith('.final') || normalizedEvent === 'chat.done') return 'final'
    if (normalizedEvent === 'chat.aborted' || normalizedEvent.endsWith('.aborted') || normalizedEvent === 'chat.stop') return 'aborted'
    if (normalizedEvent === 'chat.error' || normalizedEvent.endsWith('.error')) return 'error'
    return ''
  }

  function resetAgentStatus(agentId: string) {
    agentStatuses.value.set(agentId, {
      phase: 'idle',
      runId: null,
      detail: null,
      updatedAtMs: Date.now(),
      sinceMs: Date.now(),
      sessionKey: null,
      lastMessage: null,
      finishedAtMs: null,
    })
  }

  function setSessionKey(key: string) {
    const normalizedKey = key.trim()
    const changed = normalizedKey !== sessionKey.value
    if (changed) {
      historyRequestId += 1
      activeHistoryKey = ''
      activeHistoryRequest = null
      messages.value = []
      loading.value = false
      syncing.value = false
      lastError.value = null
      lastSyncedAt.value = null
    }
    sessionKey.value = normalizedKey
    const match = normalizedKey.match(/^agent:([^:]+):/)
    if (match && match[1]) {
      const agentId = match[1]
      resetAgentStatus(agentId)
      resetAgentProgress(agentId)
    }
    finalizedRuns.clear()
    pendingStreamMessages = []
    activeRealtimeMessageId = null
    if (streamFlushRaf !== null) {
      cancelAnimationFrame(streamFlushRaf)
      streamFlushRaf = null
    }
  }

  async function fetchHistory(
    key = sessionKey.value,
    options?: {
      silent?: boolean
      clearError?: boolean
    }
  ) {
    const normalizedKey = key.trim()
    if (!normalizedKey) {
      setSessionKey('')
      messages.value = []
      return
    }

    if (normalizedKey !== sessionKey.value) {
      setSessionKey(normalizedKey)
    }
    if (activeHistoryRequest && activeHistoryKey === normalizedKey) {
      return activeHistoryRequest
    }

    const silent = options?.silent ?? false
    const clearError = options?.clearError ?? !silent
    if (silent) {
      syncing.value = true
    } else {
      loading.value = true
    }
    if (clearError) {
      lastError.value = null
    }

    const requestId = ++historyRequestId
    activeHistoryKey = normalizedKey

    let request!: Promise<void>
    request = (async () => {
      try {
        const history = await wsStore.rpc.listChatHistory(normalizedKey)
        if (requestId !== historyRequestId || sessionKey.value !== normalizedKey) return
        // Gateway can acknowledge a send before its transcript is visible to
        // chat.history. Keep optimistic local turns during every refresh so a
        // temporary empty/partial response cannot blank a running conversation.
        messages.value = mergePendingMessages(history)
        lastSyncedAt.value = Date.now()
      } catch (error) {
        if (requestId !== historyRequestId || sessionKey.value !== normalizedKey) return
        if (!silent || clearError) {
          lastError.value = error instanceof Error ? error.message : String(error)
        }
        console.error('[ChatStore] fetchHistory failed:', error)
      } finally {
        if (requestId === historyRequestId && sessionKey.value === normalizedKey) {
          if (silent) {
            syncing.value = false
          } else {
            loading.value = false
          }
        }
        if (activeHistoryRequest === request) {
          activeHistoryKey = ''
          activeHistoryRequest = null
        }
      }
    })()

    activeHistoryRequest = request
    return request
  }

  function clearTimers() {
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    for (const timer of pollTimers) {
      clearTimeout(timer)
    }
    pollTimers = []
    if (streamFlushRaf !== null) {
      cancelAnimationFrame(streamFlushRaf)
      streamFlushRaf = null
    }
    pendingStreamMessages = []
  }

  function scheduleHistoryRefresh(delay = 250) {
    const key = sessionKey.value.trim()
    if (!key) return
    if (refreshTimer) {
      clearTimeout(refreshTimer)
      refreshTimer = null
    }
    refreshTimer = setTimeout(() => {
      fetchHistory(key, { silent: true, clearError: false })
    }, delay)
  }

  function schedulePostSendRefreshes() {
    const key = sessionKey.value.trim()
    if (!key) return
    clearTimers()
    // 发送后做低频兜底刷新，避免高频回拉导致列表抖动
    for (const delay of [1400, 4200, 10000]) {
      const timer = setTimeout(() => {
        fetchHistory(key, { silent: true, clearError: false })
      }, delay)
      pollTimers.push(timer)
    }
  }

  function extractSessionKey(payload: unknown, depth = 0, visited = new Set<object>()): string {
    if (!payload || typeof payload !== 'object' || depth > MAX_EVENT_NESTING) return ''
    if (visited.has(payload)) return ''
    visited.add(payload)

    if (Array.isArray(payload)) {
      for (const item of payload) {
        const key = extractSessionKey(item, depth + 1, visited)
        if (key) return key
      }
      return ''
    }

    const row = payload as Record<string, unknown>
    const direct = [row.sessionKey, row.key, row.session]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (direct) return direct.trim()

    for (const key of EVENT_WRAPPER_KEYS) {
      const nested = extractSessionKey(row[key], depth + 1, visited)
      if (nested) return nested
    }
    // Gateway/plugin versions may introduce a new envelope name. After the
    // protocol-known keys, inspect other object fields within the same bound
    // instead of silently dropping the event.
    for (const [key, value] of Object.entries(row)) {
      if (key === 'sessionKey' || key === 'key' || key === 'session' || EVENT_WRAPPER_KEYS.includes(key as typeof EVENT_WRAPPER_KEYS[number])) continue
      if (!value || typeof value !== 'object') continue
      const nested = extractSessionKey(value, depth + 1, visited)
      if (nested) return nested
    }
    return ''
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
    return null
  }

  function asString(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return ''
  }

  function asText(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (Array.isArray(value)) {
      return value
        .map((item) => asText(item))
        .filter((item) => item.trim().length > 0)
        .join('\n')
    }
    const row = asRecord(value)
    if (!row) return ''

    if ('text' in row) return asText(row.text)
    if ('content' in row) return asText(row.content)
    if ('message' in row) return asText(row.message)
    if ('output' in row) return asText(row.output)
    if ('delta' in row) return asText(row.delta)
    return ''
  }

  function normalizeRole(value: unknown): ChatMessage['role'] {
    if (value === 'user' || value === 'assistant' || value === 'tool' || value === 'system') return value
    if (value === 'toolResult') return 'tool'
    return 'assistant'
  }

  function normalizeRealtimeMessage(value: unknown): ChatMessage | null {
    const row = asRecord(value)
    if (!row) return null

    const content = asText(
      row.content ?? row.text ?? row.message ?? row.output ?? row.delta ?? row.payload ?? row.input
    ).trim()
    if (!content) return null

    const id = typeof row.id === 'string' ? row.id : typeof row.messageId === 'string' ? row.messageId : undefined
    const timestamp =
      typeof row.timestamp === 'string'
        ? row.timestamp
        : typeof row.createdAt === 'string'
          ? row.createdAt
          : typeof row.time === 'string'
            ? row.time
            : undefined
    const name =
      typeof row.name === 'string' ? row.name : typeof row.model === 'string' ? row.model : undefined

    return {
      id,
      role: normalizeRole(row.role ?? row.type),
      content,
      timestamp,
      name,
    }
  }

  function extractRealtimeMessages(payload: unknown, depth = 0, visited = new Set<object>()): ChatMessage[] {
    if (!payload || typeof payload !== 'object' || depth > MAX_EVENT_NESTING) return []
    if (visited.has(payload)) return []
    visited.add(payload)

    if (Array.isArray(payload)) {
      return payload.flatMap((item) => extractRealtimeMessages(item, depth + 1, visited))
    }

    const row = payload as Record<string, unknown>
    const messages: ChatMessage[] = []
    const hasDirectMessageFields =
      row.role || row.type || row.content || row.text || row.output || row.delta || row.input || typeof row.message === 'string'
    if (hasDirectMessageFields) {
      const ownMessage = normalizeRealtimeMessage(row)
      if (ownMessage) messages.push(ownMessage)
    }

    for (const key of MESSAGE_CONTAINER_KEYS) {
      const nested = row[key]
      if (nested && typeof nested === 'object') {
        messages.push(...extractRealtimeMessages(nested, depth + 1, visited))
      }
    }

    for (const key of EVENT_WRAPPER_KEYS) {
      const nested = row[key]
      if (nested && typeof nested === 'object') {
        messages.push(...extractRealtimeMessages(nested, depth + 1, visited))
      }
    }

    for (const [key, nested] of Object.entries(row)) {
      if (MESSAGE_CONTAINER_KEYS.includes(key as typeof MESSAGE_CONTAINER_KEYS[number]) || EVENT_WRAPPER_KEYS.includes(key as typeof EVENT_WRAPPER_KEYS[number])) continue
      if (nested && typeof nested === 'object') {
        messages.push(...extractRealtimeMessages(nested, depth + 1, visited))
      }
    }

    const seen = new Set<string>()
    return messages.filter((item) => {
      const signature = item.id ? `id:${item.id}` : `${item.role}:${item.content}`
      if (seen.has(signature)) return false
      seen.add(signature)
      return true
    })
  }

  function mergePendingMessages(history: ChatMessage[]): ChatMessage[] {
    // Only preserve explicit local user placeholders and the one active chat
    // stream. Agent telemetry and completed realtime projections must never
    // outlive the authoritative Gateway transcript.
    const merged = [...history]
    const pending = messages.value.filter((item) => {
      const id = item.id || ''
      return id.startsWith('web-') || id.startsWith('local-') || id === activeRealtimeMessageId
    })
    for (const item of pending) {
      const existingIndex = item.id
        ? merged.findIndex((existing) => existing.id && existing.id === item.id)
        : -1
      if (existingIndex >= 0) {
        const existing = merged[existingIndex]
        if (existing && item.content.length > existing.content.length) {
          merged[existingIndex] = { ...existing, ...item }
        }
        continue
      }

      const alreadyPresent = merged.some((existing) =>
        existing.role === item.role && existing.content === item.content
      )
      if (!alreadyPresent) merged.push(item)
    }
    return merged
  }

  function extractRunId(payload: unknown): string {
    return extractNestedStringField(payload, ['runId'])
  }

  function extractChatProjectionMessage(payload: unknown): ChatMessage | null {
    // A chat event may contain both a cumulative message and a short `delta`
    // field inside one or more transport wrappers. The cumulative assistant
    // message is the canonical browser projection; low-level fragments must
    // not become separate transcript bubbles.
    const candidates = extractRealtimeMessages(payload).filter((item) => item.role === 'assistant')
    return candidates.reduce<ChatMessage | null>((selected, item) => {
      if (!selected || item.content.length > selected.content.length) return item
      return selected
    }, null)
  }

  function mergeRealtimeMessages(
    nextMessages: ChatMessage[],
    options?: {
      streaming?: boolean
      replaceExisting?: boolean
    }
  ) {
    if (nextMessages.length === 0) return

    const streaming = options?.streaming ?? false
    const list = [...messages.value]
    for (const next of nextMessages) {
      if (next.id) {
        const existingIndex = list.findIndex((item) => item.id && item.id === next.id)
        if (existingIndex >= 0) {
          const existing = list[existingIndex]
          if (!existing) continue
          list[existingIndex] =
            options?.replaceExisting || next.content.length >= existing.content.length
              ? { ...existing, ...next }
              : existing
          continue
        }
        if (next.id.startsWith('chat-stream:')) {
          // A live chat projection is its own temporary bubble. Never merge it
          // into a persisted assistant turn that happened before a tool call.
          list.push(next)
          continue
        }
      }

      const last = list[list.length - 1]
      if (last && last.role === next.role && last.content === next.content) {
        const lastId = last.id || ''
        if (lastId.startsWith('web-') || lastId.startsWith('local-')) {
          list[list.length - 1] = { ...last, ...next }
          continue
        }
      }
      if (streaming && last && last.role === next.role) {
        if (next.content.startsWith(last.content)) {
          list[list.length - 1] = { ...last, ...next }
          continue
        }
        if (last.content.endsWith(next.content)) {
          continue
        }
        list[list.length - 1] = {
          ...last,
          ...next,
          content: `${last.content}${next.content}`,
        }
        continue
      }

      if (!next.id && last && !last.id && last.role === next.role) {
        if (next.content.startsWith(last.content)) {
          list[list.length - 1] = { ...last, ...next }
          continue
        }
      }

      list.push(next)
    }

    messages.value = list
  }

  function flushPendingStreamMessages() {
    if (streamFlushRaf !== null) {
      cancelAnimationFrame(streamFlushRaf)
      streamFlushRaf = null
    }
    if (pendingStreamMessages.length === 0) return
    const batch = pendingStreamMessages
    pendingStreamMessages = []
    mergeRealtimeMessages(batch, { streaming: true, replaceExisting: true })
  }

  function handleRealtimeEvent(
    eventName: string,
    payload: unknown,
    options?: {
      refreshHistory?: boolean
      streaming?: boolean
    }
  ) {
    const normalizedEvent = eventName.trim().toLowerCase()
    // OpenClaw emits both high-level chat projections and low-level agent
    // telemetry. Only chat events own transcript text; agent events are handled
    // separately by handleAgentStatusEvent.
    if (normalizedEvent !== 'chat' && !normalizedEvent.startsWith('chat.')) return

    const keyInEvent = extractSessionKey(payload)
    // Administrators receive events from every Gateway channel. Only the
    // exact selected session may update this transcript; an external-channel
    // event must never appear inside an open WebChat conversation.
    if (!shouldApplyRealtimeEvent(sessionKey.value, keyInEvent)) return

    const state = resolveChatEventState(normalizedEvent, payload)
    const runId = extractRunId(payload)
    const isTerminal = state === 'final' || state === 'done' || state === 'aborted' || state === 'error'
    const streaming = state === 'delta' || (options?.streaming ?? false)
    const needsProjectionId = streaming || isTerminal
    const streamMessageId = needsProjectionId
      ? activeRealtimeMessageId
        || `chat-stream:${runId || keyInEvent || sessionKey.value}`
      : ''
    const projection = extractChatProjectionMessage(payload)
    const realtimeMessages = projection
      ? [{ ...projection, id: streamMessageId || projection.id }]
      : []

    if (streaming && streamMessageId) {
      activeRealtimeMessageId = streamMessageId
    }
    if (isTerminal) {
      // Commit any queued delta before the terminal snapshot, then stop
      // preserving the temporary bubble. The next history refresh replaces it
      // with the authoritative persisted turns.
      flushPendingStreamMessages()
    }

    if (streaming && !isTerminal) {
      pendingStreamMessages.push(...realtimeMessages)
      if (streamFlushRaf === null) {
        // 对齐浏览器绘制帧合并流式增量，减少滚动“抖动/跳帧”观感
        streamFlushRaf = requestAnimationFrame(() => {
          streamFlushRaf = null
          if (pendingStreamMessages.length === 0) return
          const batch = pendingStreamMessages
          pendingStreamMessages = []
          mergeRealtimeMessages(batch, { streaming: true, replaceExisting: true })
        })
      }
    } else {
      mergeRealtimeMessages(realtimeMessages, { streaming: false, replaceExisting: Boolean(streamMessageId) })
    }

    if (isTerminal) {
      activeRealtimeMessageId = null
    }

    if (options?.refreshHistory ?? true) {
      scheduleHistoryRefresh(200)
    }
  }

  function handleAgentStatusEvent(eventName: string, payload: unknown) {
    const normalizedEvent = eventName.trim().toLowerCase()
    if (!normalizedEvent) return

    const keyInEvent = extractSessionKey(payload)
    const payloadRow = asRecord(payload)

    // 从 sessionKey 中提取 agentId
    let agentId = 'default'
    if (keyInEvent) {
      const match = keyInEvent.match(/^agent:([^:]+):/)
      if (match && match[1]) {
        agentId = match[1]
      }
    } else if (sessionKey.value) {
      const match = sessionKey.value.match(/^agent:([^:]+):/)
      if (match && match[1]) {
        agentId = match[1]
      }
    }

    // 处理所有智能体的会话事件，不局限于当前 sessionKey

    const runIdInEvent = extractRunId(payload)
    const agentStatus = getOrCreateAgentStatus(agentId)
    const activeRunId = agentStatus.runId

    // 更新 sessionKey
    if (keyInEvent && agentStatus.sessionKey !== keyInEvent) {
      agentStatuses.value.set(agentId, {
        ...agentStatus,
        sessionKey: keyInEvent,
        updatedAtMs: Date.now(),
      })
    }

    if (normalizedEvent === 'chat' || normalizedEvent.startsWith('chat.')) {
      const state = resolveChatEventState(normalizedEvent, payload)
      const isTerminal = state === 'final' || state === 'done' || state === 'aborted' || state === 'error'
      if (!isTerminal && runIdInEvent && isRunFinalized(runIdInEvent)) {
        return
      }
      if (activeRunId && runIdInEvent && runIdInEvent !== activeRunId && !isTerminal) {
        return
      }
      if (state === 'delta') {
        // touchAgentStatus(agentId)
        if (agentStatus.phase !== 'replying') {
          setAgentStatusPhase(agentId, 'replying', {
            runId: activeRunId || runIdInEvent || null,
            detail: null,
            sessionKey: keyInEvent,
          })
        }
        return
      }
      if (state === 'final' || state === 'done') {
        if (runIdInEvent) markRunFinal(runIdInEvent)
        setAgentStatusPhase(agentId, 'done', { runId: null, detail: null })
        scheduleHistoryRefresh(100)
        return
      }
      if (state === 'aborted') {
        if (runIdInEvent) markRunFinal(runIdInEvent)
        setAgentStatusPhase(agentId, 'aborted', { runId: null, detail: null })
        scheduleHistoryRefresh(100)
        return
      }
      if (state === 'error') {
        if (runIdInEvent) markRunFinal(runIdInEvent)
        const errorMessage = asString(payloadRow?.errorMessage).trim() || null
        setAgentStatusPhase(agentId, 'error', { runId: null, detail: errorMessage })
        scheduleHistoryRefresh(100)
        return
      }
      return
    }

    if (normalizedEvent === 'agent' || normalizedEvent.startsWith('agent.')) {
      // 新版 gateway 统一用 event=agent，payload.stream=lifecycle|assistant|tool|compaction
      if (normalizedEvent === 'agent') {
        const stream = asString(payloadRow?.stream).trim().toLowerCase()
        const data = asRecord(payloadRow?.data) || {}
        if (runIdInEvent && isRunFinalized(runIdInEvent) && stream !== 'lifecycle') {
          return
        }
        if (stream === 'lifecycle') {
          const phase = asString(data.phase).trim().toLowerCase()
          if (phase === 'start') {
            const prevPhase = agentStatus.phase
            if (prevPhase === 'idle' || prevPhase === 'done' || prevPhase === 'aborted' || prevPhase === 'error') {
              resetAgentProgress(agentId)
            }
            if (agentStatus.phase !== 'thinking') {
              setAgentStatusPhase(agentId, 'thinking', { runId: runIdInEvent || activeRunId || null, detail: null })
            }
            return
          }
          if (phase === 'end') {
            if (runIdInEvent) markRunFinal(runIdInEvent)
            setAgentStatusPhase(agentId, 'done', { runId: null, detail: null })
            scheduleHistoryRefresh(100)
            return
          }
          if (phase === 'error') {
            if (runIdInEvent) markRunFinal(runIdInEvent)
            const errorText = asText(data.error).trim() || null
            setAgentStatusPhase(agentId, 'error', { runId: null, detail: errorText })
            scheduleHistoryRefresh(100)
            return
          }
        }

        if (stream === 'tool') {
          // touchAgentStatus(agentId)
          const toolName = asString(data.name || data.tool || data.toolName).trim()
          const toolCallId = asString(data.toolCallId || data.callId || data.id).trim()
          const toolPhase = asString(data.phase || data.state).trim().toLowerCase()

          if (toolName && toolCallId) {
            const now = Date.now()
            if (toolPhase === 'start') {
              toolProgress.value.set(agentId, {
                toolCallId,
                name: toolName,
                phase: 'start',
                meta: null,
                isError: null,
                argsPreview: toJsonPreview(data.args),
                partialPreview: null,
                resultPreview: null,
                startedAtMs: now,
                updatedAtMs: now,
              })
            } else if (toolPhase === 'update') {
              if (now - lastToolPreviewUpdateAtMs >= 120) {
                lastToolPreviewUpdateAtMs = now
                const partialPreview = toJsonPreview(data.partialResult)
                const prevProgress = getOrCreateToolProgress(agentId)
                toolProgress.value.set(agentId, {
                  toolCallId,
                  name: toolName,
                  phase: 'update',
                  meta: prevProgress?.meta || null,
                  isError: prevProgress?.isError ?? null,
                  argsPreview: prevProgress?.argsPreview || null,
                  partialPreview: partialPreview || prevProgress?.partialPreview || null,
                  resultPreview: null,
                  startedAtMs: prevProgress?.startedAtMs || now,
                  updatedAtMs: now,
                })
              }
            } else if (toolPhase === 'result') {
              const prevProgress = getOrCreateToolProgress(agentId)
              toolProgress.value.set(agentId, {
                toolCallId,
                name: toolName,
                phase: 'result',
                meta: asString(data.meta).trim() || prevProgress?.meta || null,
                isError: typeof data.isError === 'boolean' ? data.isError : prevProgress?.isError ?? null,
                argsPreview: prevProgress?.argsPreview || null,
                partialPreview: prevProgress?.partialPreview || null,
                resultPreview: toJsonPreview(data.result),
                startedAtMs: prevProgress?.startedAtMs || now,
                updatedAtMs: now,
              })
            }
          }

          if (toolPhase === 'start' || toolPhase === 'update') {
            if (agentStatus.phase !== 'tool' || agentStatus.detail !== (toolName || null)) {
              setAgentStatusPhase(agentId, 'tool', {
                runId: runIdInEvent || activeRunId || null,
                detail: toolName || null,
              })
            }
            return
          }
          if (toolPhase === 'result') {
            // 工具结束后通常会继续思考/生成；这里只做一次轻量状态回落
            if (agentStatus.phase === 'tool') {
              setAgentStatusPhase(agentId, 'thinking', { runId: runIdInEvent || activeRunId || null, detail: toolName ? toolCompletedDetail(toolName) : null })
            }
            return
          }
        }

        if (stream === 'compaction') {
          const phase = asString((data as Record<string, unknown>).phase).trim().toLowerCase()
          if (phase === 'start') {
            setAgentStatusPhase(agentId, 'thinking', { runId: runIdInEvent || activeRunId || null, detail: contextCompactionDetail() })
            return
          }
          if (phase === 'end') {
            if (agentStatus.phase === 'thinking' && isContextCompactionDetail(agentStatus.detail)) {
              setAgentStatusPhase(agentId, 'thinking', { runId: runIdInEvent || activeRunId || null, detail: null })
            }
            return
          }
        }

        if (stream === 'assistant') {
          // touchAgentStatus(agentId)
          // 提取消息内容
          const rawContent = asString(data.content || data.text || data.delta)
          const content = rawContent.replace(/\n{3,}/g, '\n\n').trim()
          const lastMessage = content || agentStatus.lastMessage
          
          if (agentStatus.phase !== 'replying' && agentStatus.phase !== 'tool') {
            // chat delta 可能因节流略晚于 agent assistant stream，这里做兜底提示
            setAgentStatusPhase(agentId, 'replying', { 
              runId: runIdInEvent || activeRunId || null, 
              detail: null,
              sessionKey: keyInEvent,
              lastMessage,
            })
          } else if (lastMessage && lastMessage !== agentStatus.lastMessage) {
            // 更新消息内容
            agentStatuses.value.set(agentId, {
              ...agentStatus,
              lastMessage,
              updatedAtMs: Date.now(),
            })
          }
          return
        }

        return
      }

      // 旧版/兼容事件名：agent.started / agent.thinking / agent.done
      if (normalizedEvent === 'agent.started') {
        setAgentStatusPhase(agentId, 'thinking', { runId: activeRunId || runIdInEvent || null, detail: null })
        return
      }
      if (normalizedEvent === 'agent.thinking') {
        setAgentStatusPhase(agentId, 'thinking', { runId: activeRunId || runIdInEvent || null, detail: null })
        return
      }
      if (normalizedEvent === 'agent.done') {
        setAgentStatusPhase(agentId, 'done', { runId: null, detail: null })
        scheduleHistoryRefresh(100)
        return
      }
    }

    if (normalizedEvent.startsWith('tool.')) {
      if (normalizedEvent === 'tool.call') {
        const data = asRecord(payloadRow?.payload ?? payloadRow) || {}
        const toolName = asString(data.name || data.tool || data.toolName).trim() || null
        setAgentStatusPhase(agentId, 'tool', { runId: activeRunId || runIdInEvent || null, detail: toolName })
        return
      }
      if (normalizedEvent === 'tool.result') {
        setAgentStatusPhase(agentId, 'thinking', { runId: activeRunId || runIdInEvent || null, detail: null })
        return
      }
      return
    }

    if (normalizedEvent.startsWith('model.')) {
      if (normalizedEvent === 'model.streaming') {
        if (agentStatus.phase !== 'replying') {
          setAgentStatusPhase(agentId, 'replying', { runId: activeRunId || runIdInEvent || null, detail: null })
        }
      }
    }
  }

  async function sendMessage(content: string, model?: string) {
    const text = content.trim()
    if (!text) return
    if (!sessionKey.value.trim()) {
      throw new Error(byLocale('请先填写会话 Key', 'Please enter the session key', getActiveLocale()))
    }

    // 从 sessionKey 中提取 agentId
    let agentId = 'default'
    const match = sessionKey.value.match(/^agent:([^:]+):/)
    if (match && match[1]) {
      agentId = match[1]
    }

    const idempotencyKey = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    resetAgentProgress(agentId)
    setAgentStatusPhase(agentId, 'sending', { runId: idempotencyKey, detail: null })
    const localMessage: ChatMessage = {
      id: idempotencyKey,
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    }
    messages.value = [...messages.value, localMessage]
    // Start the fallback while the Gateway is still running the request. Long
    // report/tool runs may not resolve chat.send until after their transcript
    // is complete, so waiting for that RPC would leave the UI with no recovery
    // path if an intermediate event is missed.
    schedulePostSendRefreshes()

    sending.value = true
    lastError.value = null
    try {
      await wsStore.rpc.sendChatMessage({
        sessionKey: sessionKey.value.trim(),
        message: text,
        model: model?.trim() || undefined,
        idempotencyKey,
      })
      const agentStatus = getOrCreateAgentStatus(agentId)
      if (agentStatus.phase === 'sending' && agentStatus.runId === idempotencyKey) {
        setAgentStatusPhase(agentId, 'waiting', { runId: idempotencyKey, detail: null })
      }
      // Keep a second short polling window after the RPC resolves so the final
      // assistant turn is picked up even when Gateway transcript persistence is
      // slightly behind the send acknowledgement.
      schedulePostSendRefreshes()
    } catch (error) {
      clearTimers()
      lastError.value = error instanceof Error ? error.message : String(error)
      messages.value = messages.value.filter((item) => item.id !== idempotencyKey)
      const agentStatus = getOrCreateAgentStatus(agentId)
      if (agentStatus.runId === idempotencyKey) {
        setAgentStatusPhase(agentId, 'error', { runId: null, detail: lastError.value })
      }
      throw error
    } finally {
      sending.value = false
    }
  }

  function adoptCreatedSessionMessage(
    content: string,
    options: { idempotencyKey: string; runId?: string },
  ) {
    const text = content.trim()
    if (!text || !sessionKey.value.trim()) return
    const match = sessionKey.value.match(/^agent:([^:]+):/)
    const agentId = match?.[1] || 'default'
    const runId = options.runId?.trim() || options.idempotencyKey
    resetAgentProgress(agentId)
    setAgentStatusPhase(agentId, 'waiting', { runId, detail: null })
    const alreadyVisible = messages.value.some((item) => item.role === 'user' && item.content === text)
    if (!alreadyVisible) {
      messages.value = [...messages.value, {
        id: options.idempotencyKey,
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      }]
    }
    schedulePostSendRefreshes()
  }

  async function abortActiveRun() {
    if (!sessionKey.value.trim()) {
      throw new Error(byLocale('请先填写会话 Key', 'Please enter the session key', getActiveLocale()))
    }

    // 从 sessionKey 中提取 agentId
    let agentId = 'default'
    const match = sessionKey.value.match(/^agent:([^:]+):/)
    if (match && match[1]) {
      agentId = match[1]
    }

    const agentStatus = getOrCreateAgentStatus(agentId)
    const phase = agentStatus.phase
    if (phase === 'idle' || phase === 'done' || phase === 'aborted' || phase === 'error') {
      return
    }

    setAgentStatusPhase(agentId, 'aborting', { detail: byLocale('停止中...', 'Stopping...', getActiveLocale()) })
    try {
      await wsStore.rpc.abortChat(undefined, sessionKey.value.trim())
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setAgentStatusPhase(agentId, 'error', { runId: null, detail: reason })
      throw error
    }
  }

  return {
    sessionKey,
    messages,
    loading,
    syncing,
    sending,
    lastError,
    lastSyncedAt,
    agentStatuses,
    agentSteps,
    toolProgress,
    getOrCreateAgentStatus,
    setSessionKey,
    fetchHistory,
    handleRealtimeEvent,
    handleAgentStatusEvent,
    clearTimers,
    sendMessage,
    adoptCreatedSessionMessage,
    abortActiveRun,
  }
})
