import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/api/types'
import { useChatStore } from './chat'

const mocks = vi.hoisted(() => ({
  listChatHistory: vi.fn(),
}))

vi.mock('./websocket', () => ({
  useWebSocketStore: () => ({
    rpc: {
      listChatHistory: mocks.listChatHistory,
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
