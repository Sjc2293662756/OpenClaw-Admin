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

beforeEach(() => {
  setActivePinia(createPinia())
  mocks.listChatHistory.mockReset()
  mocks.sendChatMessage.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
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
})

describe('realtime event routing', () => {
  it('accepts a nested report event for the selected session', () => {
    const store = useChatStore()
    const sessionKey = 'agent:main:main:dm:webchat-report-1'
    store.setSessionKey(sessionKey)

    store.handleRealtimeEvent({
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

    store.handleRealtimeEvent({
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
})

describe('post-send history fallback', () => {
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
})
