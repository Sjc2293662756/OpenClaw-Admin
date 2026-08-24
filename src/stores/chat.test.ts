import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/api/types'
import { useChatStore } from './chat'

const mocks = vi.hoisted(() => ({
  listChatHistory: vi.fn(),
  sendChatMessage: vi.fn(),
}))

vi.mock('./websocket', () => ({
  useWebSocketStore: () => ({
    rpc: {
      listChatHistory: mocks.listChatHistory,
      sendChatMessage: mocks.sendChatMessage,
    },
  }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function message(content: string): ChatMessage {
  return { role: 'assistant', content }
}

function stubAnimationFrames() {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  return () => frames.shift()?.(0)
}

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.listChatHistory.mockReset()
  mocks.sendChatMessage.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('chat history request coordination', () => {
  it('reuses an in-flight request for the same session', async () => {
    const history = deferred<ChatMessage[]>()
    mocks.listChatHistory.mockReturnValue(history.promise)
    const store = useChatStore()

    const first = store.fetchHistory('session-a')
    const second = store.fetchHistory('session-a')

    expect(mocks.listChatHistory).toHaveBeenCalledTimes(1)
    history.resolve([message('ready')])
    await first
    await second
    expect(store.messages.map((item) => item.content)).toEqual(['ready'])
  })

  it('does not let an older session response overwrite a fast switch', async () => {
    const first = deferred<ChatMessage[]>()
    const second = deferred<ChatMessage[]>()
    mocks.listChatHistory
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const store = useChatStore()

    const firstRequest = store.fetchHistory('session-a')
    const secondRequest = store.fetchHistory('session-b')
    expect(store.sessionKey).toBe('session-b')
    expect(store.loading).toBe(true)
    expect(store.messages).toEqual([])

    second.resolve([message('session-b history')])
    await secondRequest
    first.resolve([message('stale session-a history')])
    await firstRequest

    expect(store.sessionKey).toBe('session-b')
    expect(store.messages.map((item) => item.content)).toEqual(['session-b history'])
    expect(store.loading).toBe(false)
  })

  it('does not let a route history race clear a locally submitted report request', async () => {
    const history = deferred<ChatMessage[]>()
    mocks.listChatHistory.mockReturnValue(history.promise)
    mocks.sendChatMessage.mockResolvedValue(undefined)
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-report-race'

    store.setSessionKey(sessionKey)
    const historyRequest = store.fetchHistory(sessionKey)
    await store.sendMessage('生成最近七天的综述报告')

    history.resolve([])
    await historyRequest

    expect(store.messages.map((item) => item.content)).toEqual(['生成最近七天的综述报告'])
  })
})

describe('realtime event routing', () => {
  it('keeps agent assistant telemetry out of transcript text', () => {
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-agent-telemetry'
    store.setSessionKey(sessionKey)

    store.handleAgentStatusEvent('agent', {
      runId: 'run-agent-1',
      sessionKey,
      stream: 'assistant',
      data: {
        text: '模型内部实时文本',
        delta: '实时文本',
        replace: false,
      },
    })
    store.handleRealtimeEvent('agent', {
      runId: 'run-agent-1',
      sessionKey,
      stream: 'assistant',
      data: {
        text: '模型内部实时文本',
        delta: '实时文本',
        replace: false,
      },
    }, { refreshHistory: false, streaming: true })

    expect(store.messages).toEqual([])
    expect(store.getOrCreateAgentStatus('main').lastMessage).toBe('模型内部实时文本')
  })

  it('uses one chat projection bubble across a multi-tool report run', () => {
    const flush = stubAnimationFrames()

    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-report-stream'
    const runId = 'run-report-stream'
    store.setSessionKey(sessionKey)

    const sendChatSnapshot = (content: string) => {
      store.handleRealtimeEvent('chat', {
        runId,
        sessionKey,
        state: 'delta',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: content }],
        },
      }, { refreshHistory: false })
      flush()
    }
    const sendAgentTelemetry = (text: string) => {
      store.handleRealtimeEvent('agent', {
        runId,
        sessionKey,
        stream: 'assistant',
        data: { text, delta: text, replace: false },
      }, { refreshHistory: false, streaming: true })
    }

    sendChatSnapshot("I'll generate the report.")
    sendAgentTelemetry('报告数据已采集完成。')
    sendChatSnapshot("I'll generate the report.报告数据已采集完成。")
    sendAgentTelemetry('✅ 报告已生成。')
    sendChatSnapshot("I'll generate the report.报告数据已采集完成。✅ 报告已生成。")
    sendAgentTelemetry('✅ 报告已生成。需要的话我也可以导出 PDF。')
    sendChatSnapshot("I'll generate the report.报告数据已采集完成。✅ 报告已生成。需要的话我也可以导出 PDF。")

    expect(store.messages).toEqual([expect.objectContaining({
      id: `chat-stream:${runId}`,
      role: 'assistant',
      content: "I'll generate the report.报告数据已采集完成。✅ 报告已生成。需要的话我也可以导出 PDF。",
    })])
    expect(store.messages[0]?.content.match(/✅ 报告已生成。/gu)).toHaveLength(1)
  })

  it('uses the cumulative message from a wrapped chat event instead of its short delta field', () => {
    const flush = stubAnimationFrames()
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-wrapped-chat'
    store.setSessionKey(sessionKey)

    const sendWrappedSnapshot = (content: string, delta: string) => {
      store.handleRealtimeEvent('chat', {
        payload: {
          data: {
            runId: 'run-wrapped-chat',
            state: 'delta',
            delta,
            message: {
              sessionKey,
              role: 'assistant',
              content: [{ type: 'text', text: content }],
            },
          },
        },
      }, { refreshHistory: false })
      flush()
    }

    sendWrappedSnapshot('238web 最近 3 天的业务综述报告', '报告')
    sendWrappedSnapshot('238web 最近 3 天的业务综述报告已生成 ✅', ' ✅')

    expect(store.messages).toEqual([expect.objectContaining({
      id: 'chat-stream:run-wrapped-chat',
      content: '238web 最近 3 天的业务综述报告已生成 ✅',
    })])
  })

  it('replaces non-prefix chat snapshots even when transport metadata is absent', () => {
    const flush = stubAnimationFrames()
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-snapshot-reset'
    store.setSessionKey(sessionKey)

    const sendSnapshot = (content: string) => {
      store.handleRealtimeEvent('chat', {
        message: { sessionKey, role: 'assistant', content },
      }, { refreshHistory: false, streaming: true })
      flush()
    }

    sendSnapshot("I'll generate a 3-day summary report.")
    sendSnapshot('The summary data is collected.')
    sendSnapshot('238web 最近 3 天的业务综述报告已生成 ✅')

    expect(store.messages).toEqual([expect.objectContaining({
      id: `chat-stream:${sessionKey}`,
      content: '238web 最近 3 天的业务综述报告已生成 ✅',
    })])
  })

  it('does not append a new chat stream to the previous persisted assistant turn', async () => {
    const flush = stubAnimationFrames()
    const sessionKey = 'agent:main:main:dm:webchat-stream-boundary'
    mocks.listChatHistory.mockResolvedValue([
      { id: 'persisted-user', role: 'user', content: '生成报告' },
      { id: 'persisted-assistant', role: 'assistant', content: '报告数据已采集完成。' },
      { id: 'persisted-tool', role: 'tool', content: '报告文件已生成。' },
    ])

    const store = useChatStore()
    store.setSessionKey(sessionKey)
    await store.fetchHistory(sessionKey, { silent: true, clearError: false })
    store.handleRealtimeEvent('chat', {
      runId: 'run-stream-boundary',
      sessionKey,
      state: 'delta',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '✅ 报告已生成。' }],
      },
    }, { refreshHistory: false })
    flush()

    expect(store.messages).toHaveLength(4)
    expect(store.messages[1]?.content).toBe('报告数据已采集完成。')
    expect(store.messages[3]).toEqual(expect.objectContaining({
      id: 'chat-stream:run-stream-boundary',
      content: '✅ 报告已生成。',
    }))
  })

  it('drops the temporary chat projection after a terminal event and authoritative refresh', async () => {
    const flush = stubAnimationFrames()

    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-report-final'
    const runId = 'run-report-final'
    const history = [
      { id: 'persisted-user', role: 'user' as const, content: '生成报告' },
      { id: 'persisted-assistant', role: 'assistant' as const, content: '报告已生成' },
    ]
    mocks.listChatHistory.mockResolvedValue(history)
    store.setSessionKey(sessionKey)
    store.handleRealtimeEvent('chat', {
      runId,
      sessionKey,
      state: 'delta',
      message: { role: 'assistant', content: [{ type: 'text', text: '实时累计正文' }] },
    }, { refreshHistory: false })
    flush()

    await store.fetchHistory(sessionKey, { silent: true, clearError: false })
    expect(store.messages.some((item) => item.id === `chat-stream:${runId}`)).toBe(true)

    store.handleRealtimeEvent('chat', {
      runId,
      sessionKey,
      state: 'final',
    }, { refreshHistory: false })
    await store.fetchHistory(sessionKey, { silent: true, clearError: false })

    expect(store.messages).toEqual(history)
    expect(store.messages.some((item) => item.id?.startsWith('chat-stream:'))).toBe(false)
  })

  it('accepts a nested report event for the selected session', () => {
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-report-1'
    store.setSessionKey(sessionKey)

    store.handleRealtimeEvent('chat', {
      payload: {
        message: {
          sessionKey,
          id: 'assistant-report-1',
          role: 'assistant',
          content: '238web 最近7天综述报告',
        },
      },
    }, { refreshHistory: false })

    expect(store.messages).toEqual([{
      id: 'assistant-report-1',
      role: 'assistant',
      content: '238web 最近7天综述报告',
      timestamp: undefined,
      name: undefined,
    }])
  })

  it('keeps nested events from another session out of the open transcript', () => {
    const store = useChatStore()
    store.setSessionKey('agent:main:main:dm:webchat-selected')

    store.handleRealtimeEvent('chat', {
      data: {
        result: {
          message: {
            sessionKey: 'agent:main:main:dm:webchat-other',
            role: 'assistant',
            content: '不应显示',
          },
        },
      },
    }, { refreshHistory: false })

    expect(store.messages).toEqual([])
  })

  it('accepts report events wrapped beyond the original four levels', () => {
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-deep-report'
    store.setSessionKey(sessionKey)

    store.handleRealtimeEvent('chat', {
      payload: {
        data: {
          event: {
            result: {
              message: {
                payload: {
                  sessionKey,
                  role: 'assistant',
                  content: '最近七天综述报告已生成',
                },
              },
            },
          },
        },
      },
    }, { refreshHistory: false })

    expect(store.messages.map((item) => item.content)).toEqual(['最近七天综述报告已生成'])
  })

  it('routes a report event through context and envelope wrappers', () => {
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-context-report'
    store.setSessionKey(sessionKey)

    store.handleRealtimeEvent('chat', {
      context: {
        envelope: {
          body: {
            message: {
              sessionKey,
              role: 'assistant',
              content: '报告正文',
            },
          },
        },
      },
    }, { refreshHistory: false })

    expect(store.messages.map((item) => item.content)).toEqual(['报告正文'])
  })
})

describe('post-send history fallback', () => {
  it('adopts an atomically created first turn without sending it twice', async () => {
    vi.useFakeTimers()
    mocks.listChatHistory.mockResolvedValue([])
    const store = useChatStore()
    store.setSessionKey('agent:main:main:dm:webchat-atomic')

    store.adoptCreatedSessionMessage('生成最近七天的综述报告', {
      idempotencyKey: 'web-request-1',
      runId: 'gateway-run-1',
    })

    expect(store.messages).toMatchObject([{
      id: 'web-request-1',
      role: 'user',
      content: '生成最近七天的综述报告',
    }])
    expect(mocks.sendChatMessage).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1400)
    expect(mocks.listChatHistory).toHaveBeenCalledWith('agent:main:main:dm:webchat-atomic')
  })

  it('keeps the local user turn when an early history refresh is still empty', async () => {
    vi.useFakeTimers()
    mocks.sendChatMessage.mockResolvedValue(undefined)
    mocks.listChatHistory.mockResolvedValue([])

    const store = useChatStore()
    store.setSessionKey('agent:main:main:dm:webchat-report-2')
    await store.sendMessage('给我回溯238web 最近7天的综述报告！')

    expect(store.messages).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1400)

    expect(mocks.listChatHistory).toHaveBeenCalledWith('agent:main:main:dm:webchat-report-2')
    expect(store.messages.map((item) => item.content)).toEqual(['给我回溯238web 最近7天的综述报告！'])
  })

  it('starts fallback history refresh before a long report send resolves', async () => {
    vi.useFakeTimers()
    const send = deferred<undefined>()
    mocks.sendChatMessage.mockReturnValue(send.promise)
    mocks.listChatHistory.mockResolvedValue([])

    const store = useChatStore()
    store.setSessionKey('agent:main:main:dm:webchat-long-report')
    const request = store.sendMessage('生成最近七天的综述报告')

    await vi.advanceTimersByTimeAsync(1400)
    expect(mocks.listChatHistory).toHaveBeenCalledWith('agent:main:main:dm:webchat-long-report')
    expect(store.messages.map((item) => item.content)).toEqual(['生成最近七天的综述报告'])

    send.resolve(undefined)
    await request
  })

  it('keeps a realtime report reply while Gateway history is still user-only', async () => {
    vi.useFakeTimers()
    const flush = stubAnimationFrames()
    const sessionKey = 'agent:main:main:dm:webchat-report-history-lag'
    mocks.sendChatMessage.mockResolvedValue(undefined)
    mocks.listChatHistory.mockResolvedValue([
      { role: 'user', content: '生成最近七天的综述报告' },
    ])

    const store = useChatStore()
    store.setSessionKey(sessionKey)
    await store.sendMessage('生成最近七天的综述报告')
    store.handleRealtimeEvent('chat', {
      runId: 'run-report-history-lag',
      sessionKey,
      state: 'delta',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '报告已生成：NAPM 系统综述报告' }],
      },
    }, { refreshHistory: false })
    flush()

    await store.fetchHistory(sessionKey, { silent: true, clearError: false })

    expect(store.messages.map((item) => item.content)).toEqual([
      '生成最近七天的综述报告',
      '报告已生成：NAPM 系统综述报告',
    ])
  })
})
