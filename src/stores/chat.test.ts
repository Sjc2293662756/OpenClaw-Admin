import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/api/types'
import { isLiveChatProcessForSession } from '@/utils/chat-live-process'
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

  it('keeps the same message array when a background history refresh is unchanged', async () => {
    const largeToolResult = 'x'.repeat(16_000)
    const history: ChatMessage[] = [
      { id: 'user-1', role: 'user', content: '生成综述报告' },
      {
        id: 'tool-1',
        role: 'tool',
        content: largeToolResult,
        toolCallId: 'call-1',
        toolName: 'napm-skill-query',
        rawContent: [{ type: 'text', text: largeToolResult }],
      },
      { id: 'assistant-1', role: 'assistant', content: '报告已生成' },
    ]
    mocks.listChatHistory.mockImplementation(async () => history.map((item) => ({
      ...item,
      rawContent: item.rawContent?.map((part) => ({ ...part })),
    })))
    const store = useChatStore()

    await store.fetchHistory('session-stable-history')
    const appliedMessages = store.messages
    await store.fetchHistory('session-stable-history', { silent: true, clearError: false })

    expect(store.messages).toBe(appliedMessages)
    expect(mocks.listChatHistory).toHaveBeenCalledTimes(2)
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
  it('keeps exact-session agent assistant text out of the transcript', () => {
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
    const stableStatus = store.getOrCreateAgentStatus('main')
    store.handleAgentStatusEvent('agent', {
      runId: 'run-agent-1',
      sessionKey,
      stream: 'assistant',
      data: {
        text: '模型内部实时文本已经完成',
        delta: '已经完成',
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
    expect(store.getOrCreateAgentStatus('main')).toBe(stableStatus)
    expect(store.getOrCreateAgentStatus('main').phase).toBe('replying')
    expect(store.getOrCreateAgentStatus('main').lastMessage).toBe('模型内部实时文本已经完成')
  })

  it('updates tool previews without replacing the progress object', () => {
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-tool-preview'
    store.setSessionKey(sessionKey)

    store.handleAgentStatusEvent('agent', {
      runId: 'run-tool-preview',
      sessionKey,
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'napm-skill-query',
        toolCallId: 'tool-preview-1',
        args: { target: '238web' },
      },
    })
    const stableProgress = store.toolProgress.get('main')

    store.handleAgentStatusEvent('agent', {
      runId: 'run-tool-preview',
      sessionKey,
      stream: 'tool',
      data: {
        phase: 'update',
        name: 'napm-skill-query',
        toolCallId: 'tool-preview-1',
        partialResult: { collected: 8 },
      },
    })

    expect(store.toolProgress.get('main')).toBe(stableProgress)
    expect(stableProgress).toEqual(expect.objectContaining({
      phase: 'update',
      partialPreview: expect.stringContaining('collected'),
    }))
  })

  it('drives the current session live process through lifecycle, tool, and terminal events', () => {
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-live-process'
    store.setSessionKey(sessionKey)

    store.handleAgentStatusEvent('agent', {
      runId: 'run-live-process',
      sessionKey,
      stream: 'lifecycle',
      data: { phase: 'start' },
    })
    expect(isLiveChatProcessForSession(store.getOrCreateAgentStatus('main'), sessionKey)).toBe(true)

    store.handleAgentStatusEvent('agent', {
      runId: 'run-live-process',
      sessionKey,
      stream: 'tool',
      data: { phase: 'start', name: 'napm-skill-query', toolCallId: 'call-live-process' },
    })
    expect(store.getOrCreateAgentStatus('main').phase).toBe('tool')
    expect(isLiveChatProcessForSession(store.getOrCreateAgentStatus('main'), sessionKey)).toBe(true)

    store.handleAgentStatusEvent('agent', {
      runId: 'run-live-process',
      sessionKey,
      stream: 'lifecycle',
      data: { phase: 'end' },
    })
    expect(isLiveChatProcessForSession(store.getOrCreateAgentStatus('main'), sessionKey)).toBe(false)
    store.clearTimers()
  })

  it('uses only the canonical chat snapshot for the visible transcript', () => {
    const flush = stubAnimationFrames()
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-agent-handoff'
    const runId = 'run-agent-handoff'
    store.setSessionKey(sessionKey)

    store.handleAgentStatusEvent('agent', {
      runId,
      sessionKey,
      stream: 'assistant',
      data: { text: 'agent 运行遥测' },
    })
    store.handleRealtimeEvent('chat', {
      runId,
      sessionKey,
      state: 'delta',
      message: { role: 'assistant', content: 'chat 权威正文' },
    }, { refreshHistory: false })
    flush()
    store.handleAgentStatusEvent('agent', {
      runId,
      sessionKey,
      stream: 'assistant',
      data: { text: '不应进入对话正文' },
    })

    expect(store.messages).toEqual([expect.objectContaining({
      id: `chat-stream:${runId}`,
      content: 'chat 权威正文',
    })])
  })

  it('does not project another session agent stream into the selected conversation', () => {
    const store = useChatStore()
    store.setSessionKey('agent:main:main:dm:webchat-selected-agent')

    store.handleAgentStatusEvent('agent', {
      runId: 'run-other-agent',
      sessionKey: 'agent:main:main:dm:webchat-other-agent',
      stream: 'assistant',
      data: { text: '不应显示' },
    })

    expect(store.messages).toEqual([])
  })

  it('does not pull the full history for a nonterminal chat snapshot', async () => {
    vi.useFakeTimers()
    const flush = stubAnimationFrames()
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-stream-without-polling'
    store.setSessionKey(sessionKey)

    store.handleRealtimeEvent('chat', {
      runId: 'run-stream-without-polling',
      sessionKey,
      state: 'delta',
      message: { role: 'assistant', content: '实时回复' },
    })
    flush()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(store.messages.map((item) => item.content)).toEqual(['实时回复'])
    expect(mocks.listChatHistory).not.toHaveBeenCalled()
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
  it('keeps the local first question before assistant-only Gateway history and converges', async () => {
    vi.useFakeTimers()
    const sessionKey = 'agent:main:main:dm:webchat-assistant-only-history'
    const persistedReply: ChatMessage = {
      id: 'gateway-assistant-1',
      role: 'assistant',
      content: '未找到性能对象，请确认名称后重试。',
    }
    mocks.sendChatMessage.mockResolvedValue(undefined)
    mocks.listChatHistory.mockResolvedValue([persistedReply])
    const store = useChatStore()
    store.setSessionKey(sessionKey)
    await store.sendMessage('生成性能综述报告')
    store.handleRealtimeEvent('chat', {
      runId: 'run-assistant-only-history',
      sessionKey,
      state: 'final',
      message: { role: 'assistant', content: persistedReply.content },
    }, { refreshHistory: false })

    await store.fetchHistory(sessionKey, { silent: true, clearError: false })
    expect(store.messages.map((item) => [item.role, item.content])).toEqual([
      ['user', '生成性能综述报告'],
      ['assistant', '未找到性能对象，请确认名称后重试。'],
    ])
    expect(store.messages.some((item) => item.id?.startsWith('chat-stream:'))).toBe(false)

    const convergedMessages = store.messages
    await store.fetchHistory(sessionKey, { silent: true, clearError: false })
    expect(store.messages).toBe(convergedMessages)
    store.clearTimers()
  })

  it('keeps later persisted conversation turns after an assistant-only first reply', async () => {
    vi.useFakeTimers()
    const sessionKey = 'agent:main:main:dm:webchat-assistant-only-followup'
    const firstReply: ChatMessage = {
      id: 'gateway-assistant-1',
      role: 'assistant',
      content: '第一轮回复',
    }
    mocks.sendChatMessage.mockResolvedValue(undefined)
    mocks.listChatHistory.mockResolvedValueOnce([firstReply])
    const store = useChatStore()
    store.setSessionKey(sessionKey)
    await store.sendMessage('第一轮问题')
    store.handleRealtimeEvent('chat', {
      runId: 'run-assistant-only-followup',
      sessionKey,
      state: 'final',
      message: { role: 'assistant', content: firstReply.content },
    }, { refreshHistory: false })
    await store.fetchHistory(sessionKey, { silent: true, clearError: false })

    mocks.listChatHistory.mockResolvedValueOnce([
      firstReply,
      { id: 'gateway-user-2', role: 'user', content: '第二轮问题' },
      { id: 'gateway-assistant-2', role: 'assistant', content: '第二轮回复' },
    ])
    await store.fetchHistory(sessionKey, { silent: true, clearError: false })

    expect(store.messages.map((item) => item.content)).toEqual([
      '第一轮问题',
      '第一轮回复',
      '第二轮问题',
      '第二轮回复',
    ])
    store.clearTimers()
  })

  it('replaces the local first question with a timestamp-wrapped persisted user turn', async () => {
    vi.useFakeTimers()
    const sessionKey = 'agent:main:main:dm:webchat-persisted-user-envelope'
    const prompt = '生成最近七天综述报告'
    const history: ChatMessage[] = [
      { id: 'gateway-user-1', role: 'user', content: `[Sun 2026-08-31 16:30 GMT+8] ${prompt}` },
      { id: 'gateway-assistant-1', role: 'assistant', content: '报告已生成，格式：docx。' },
    ]
    mocks.sendChatMessage.mockResolvedValue(undefined)
    mocks.listChatHistory.mockResolvedValue(history)
    const store = useChatStore()
    store.setSessionKey(sessionKey)
    await store.sendMessage(prompt)
    store.handleRealtimeEvent('chat', {
      runId: 'run-persisted-user-envelope',
      sessionKey,
      state: 'final',
      message: { role: 'assistant', content: history[1]?.content },
    }, { refreshHistory: false })

    await store.fetchHistory(sessionKey, { silent: true, clearError: false })

    expect(store.messages).toEqual(history)
    expect(store.messages.filter((item) => item.role === 'user')).toHaveLength(1)
    store.clearTimers()
  })

  it('uses one terminal convergence run and stops after authoritative history arrives', async () => {
    vi.useFakeTimers()
    const sessionKey = 'agent:main:main:dm:webchat-smooth-convergence'
    const authoritativeHistory: ChatMessage[] = [
      { role: 'user', content: '生成最近三天的综述报告' },
      { role: 'assistant', content: '报告已生成' },
    ]
    mocks.sendChatMessage.mockResolvedValue(undefined)
    mocks.listChatHistory.mockResolvedValue(authoritativeHistory)
    const store = useChatStore()
    store.setSessionKey(sessionKey)
    await store.sendMessage('生成最近三天的综述报告')

    const terminalEvent = {
      runId: 'run-smooth-convergence',
      sessionKey,
      stream: 'lifecycle',
      data: { phase: 'end' },
    }
    store.handleAgentStatusEvent('agent', terminalEvent)
    store.handleAgentStatusEvent('agent', terminalEvent)

    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.listChatHistory).toHaveBeenCalledTimes(1)
    const appliedMessages = store.messages

    store.handleAgentStatusEvent('agent', terminalEvent)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mocks.listChatHistory).toHaveBeenCalledTimes(1)
    expect(store.messages).toBe(appliedMessages)
    store.clearTimers()
  })

  it('runs a fresh terminal refresh after an older history request settles', async () => {
    vi.useFakeTimers()
    const firstHistory = deferred<ChatMessage[]>()
    const authoritativeHistory: ChatMessage[] = [
      { role: 'user', content: '当前系统流量趋势怎么样？' },
      { role: 'assistant', content: '系统流量整体平稳。' },
    ]
    mocks.listChatHistory
      .mockReturnValueOnce(firstHistory.promise)
      .mockResolvedValue(authoritativeHistory)
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-terminal-refresh'
    store.setSessionKey(sessionKey)

    const initialRequest = store.fetchHistory(sessionKey)
    store.handleAgentStatusEvent('agent', {
      runId: 'run-terminal-refresh',
      sessionKey,
      stream: 'assistant',
      data: { text: '系统流量整体平稳。' },
    })
    store.handleAgentStatusEvent('agent', {
      runId: 'run-terminal-refresh',
      sessionKey,
      stream: 'lifecycle',
      data: { phase: 'end' },
    })

    vi.advanceTimersByTime(100)
    expect(mocks.listChatHistory).toHaveBeenCalledTimes(1)
    firstHistory.resolve([{ role: 'user', content: '当前系统流量趋势怎么样？' }])
    await initialRequest
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(600)

    expect(mocks.listChatHistory).toHaveBeenCalledTimes(2)
    expect(store.messages).toEqual(authoritativeHistory)
    store.clearTimers()
  })

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
    expect(store.getOrCreateAgentStatus('main').sessionKey).toBe('agent:main:main:dm:webchat-atomic')
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

    expect(store.getOrCreateAgentStatus('main').sessionKey).toBe('agent:main:main:dm:webchat-long-report')

    await vi.advanceTimersByTimeAsync(1400)
    expect(mocks.listChatHistory).toHaveBeenCalledWith('agent:main:main:dm:webchat-long-report')
    expect(store.messages.map((item) => item.content)).toEqual(['生成最近七天的综述报告'])

    send.resolve(undefined)
    await request
  })

  it('restarts persisted process refreshes when a long run reaches a tool boundary', async () => {
    vi.useFakeTimers()
    const sessionKey = 'agent:main:main:dm:webchat-long-process'
    mocks.sendChatMessage.mockResolvedValue(undefined)
    mocks.listChatHistory.mockResolvedValue([])

    const store = useChatStore()
    store.setSessionKey(sessionKey)
    await store.sendMessage('生成最近七天的综述报告')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.listChatHistory).toHaveBeenCalledTimes(3)

    store.handleAgentStatusEvent('agent', {
      sessionKey,
      stream: 'tool',
      data: {
        phase: 'result',
        name: 'report-generator',
        toolCallId: 'tool-call-1',
      },
    })
    await vi.advanceTimersByTimeAsync(1_400)

    expect(mocks.listChatHistory).toHaveBeenCalledTimes(4)
    expect(mocks.listChatHistory).toHaveBeenLastCalledWith(sessionKey)
    store.clearTimers()
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
