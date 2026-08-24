import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@/api/types'
import { useSessionStore } from './session'

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  listChatHistory: vi.fn(),
  getSessionsUsage: vi.fn(),
  sendChatMessage: vi.fn(),
}))

vi.mock('./websocket', () => ({
  useWebSocketStore: () => ({
    rpc: {
      listSessions: mocks.listSessions,
      listChatHistory: mocks.listChatHistory,
      getSessionsUsage: mocks.getSessionsUsage,
      sendChatMessage: mocks.sendChatMessage,
    },
  }),
}))

vi.mock('./auth', () => ({
  useAuthStore: () => ({
    getToken: () => 'test-only',
  }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function session(key: string, overrides: Partial<Session> = {}): Session {
  return {
    key,
    agentId: 'main',
    channel: 'main',
    peer: key,
    messageCount: 0,
    lastActivity: '2026-07-30T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.listSessions.mockReset()
  mocks.listChatHistory.mockReset()
  mocks.getSessionsUsage.mockReset()
  mocks.sendChatMessage.mockReset()
  mocks.getSessionsUsage.mockResolvedValue({ sessions: [] })
  vi.unstubAllGlobals()
})

describe('session list progressive loading', () => {
  it('shows sessions.list results without waiting for usage', async () => {
    const usage = deferred<unknown>()
    mocks.listSessions.mockResolvedValue([session('alpha')])
    mocks.getSessionsUsage.mockReturnValue(usage.promise)
    const store = useSessionStore()

    await store.fetchSessions()

    expect(store.sessions.map((item) => item.key)).toEqual(['alpha'])
    expect(store.loading).toBe(false)
    expect(store.usageLoading).toBe(true)

    usage.resolve({ sessions: [] })
    await vi.waitFor(() => expect(store.usageLoading).toBe(false))
  })

  it('merges usage after the visible list is ready', async () => {
    const usage = deferred<unknown>()
    mocks.listSessions.mockResolvedValue([session('alpha')])
    mocks.getSessionsUsage.mockReturnValue(usage.promise)
    const store = useSessionStore()

    await store.fetchSessions()
    usage.resolve({
      sessions: [{
        key: 'alpha',
        usage: {
          input: 30,
          output: 12,
          messageCounts: { total: 7 },
        },
      }],
    })

    await vi.waitFor(() => expect(store.usageLoading).toBe(false))
    expect(store.sessions[0]?.messageCount).toBe(7)
    expect(store.sessions[0]?.tokenUsage).toEqual({ totalInput: 30, totalOutput: 12 })
  })

  it('keeps the list when usage fails', async () => {
    const usage = deferred<unknown>()
    mocks.listSessions.mockResolvedValue([session('alpha')])
    mocks.getSessionsUsage.mockReturnValue(usage.promise)
    const store = useSessionStore()

    await store.fetchSessions()
    usage.reject(new Error('usage unavailable'))

    await vi.waitFor(() => expect(store.usageLoading).toBe(false))
    expect(store.sessions.map((item) => item.key)).toEqual(['alpha'])
  })

  it('reuses an in-flight refresh and prevents an older forced response from overwriting the latest list', async () => {
    const first = deferred<Session[]>()
    const second = deferred<Session[]>()
    mocks.listSessions
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const store = useSessionStore()

    const firstRequest = store.fetchSessions()
    const reusedRequest = store.fetchSessions()
    expect(mocks.listSessions).toHaveBeenCalledTimes(1)
    const secondRequest = store.fetchSessions({ force: true })

    second.resolve([session('newer', {
      messageCount: 1,
      tokenUsage: { totalInput: 1, totalOutput: 1 },
    })])
    await secondRequest
    first.resolve([session('older', {
      messageCount: 1,
      tokenUsage: { totalInput: 1, totalOutput: 1 },
    })])
    await firstRequest
    await reusedRequest

    expect(store.sessions.map((item) => item.key)).toEqual(['newer'])
    expect(store.loading).toBe(false)
  })

  it('shows a newly sent workspace session immediately and keeps it through an early stale list response', async () => {
    mocks.listSessions.mockResolvedValue([])
    const store = useSessionStore()
    const key = 'agent:main:main:dm:webchat-new-session'

    store.registerSuccessfulWorkspaceSession(
      key,
      '分析新问题并给出修复建议',
      Date.now(),
    )

    expect(store.sessions).toMatchObject([{
      key,
      sessionTitle: '分析新问题并给出修复建议',
      originKind: 'web',
      sourceChannel: 'web',
      messageCount: 1,
    }])

    await store.fetchSessions({ force: true })
    expect(store.sessions.map((item) => item.key)).toContain(key)
  })

  it('replaces the optimistic workspace row with the confirmed server row', async () => {
    const store = useSessionStore()
    const key = 'agent:main:main:dm:webchat-confirmed'
    store.registerSuccessfulWorkspaceSession(key, '本地标题')
    mocks.listSessions.mockResolvedValue([session(key, {
      channel: 'web',
      peer: 'webchat-confirmed',
      messageCount: 2,
      sessionTitle: '服务端固定标题',
      originKind: 'web',
      sourceChannel: 'web',
    })])

    await store.fetchSessions({ force: true })

    expect(store.sessions).toHaveLength(1)
    expect(store.sessions[0]).toMatchObject({
      key,
      sessionTitle: '服务端固定标题',
      messageCount: 2,
    })
  })

  it('initializes an explicitly empty session before returning it', async () => {
    const key = 'agent:main:main:dm:webchat-initialized'
    mocks.listSessions.mockResolvedValue([])
    mocks.listChatHistory.mockResolvedValue([{
      role: 'assistant',
      content: '✅ New session started.',
    }])
    mocks.sendChatMessage.mockResolvedValue({})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, sessionKey: key }),
    }))
    const store = useSessionStore()

    await expect(store.createInitializedSession({})).resolves.toBe(key)
    expect(mocks.sendChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: key,
      message: '/new',
    }))
  })

  it('issues a workspace conversation key without sending a reset command', async () => {
    const key = 'agent:main:main:dm:webchat-direct-first-turn'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, sessionKey: key }),
    }))
    const store = useSessionStore()

    await expect(store.createWorkspaceSession()).resolves.toBe(key)
    expect(mocks.sendChatMessage).not.toHaveBeenCalled()
    expect(mocks.listChatHistory).not.toHaveBeenCalled()
  })

  it('requests an atomic Gateway conversation for the first workspace message', async () => {
    const key = 'agent:main:main:dm:webchat-atomic-first-turn'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        sessionKey: key,
        runStarted: true,
        runId: 'gateway-run-1',
        idempotencyKey: 'web-request-1',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const store = useSessionStore()

    await expect(store.createWorkspaceConversation('生成最近七天的综述报告')).resolves.toEqual({
      sessionKey: key,
      runStarted: true,
      runId: 'gateway-run-1',
      idempotencyKey: 'web-request-1',
    })
    const request = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(request?.body))).toMatchObject({
      message: '生成最近七天的综述报告',
    })
    expect(mocks.sendChatMessage).not.toHaveBeenCalled()
  })
})
