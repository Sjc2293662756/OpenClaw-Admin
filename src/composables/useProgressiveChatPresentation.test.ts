import { effectScope, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/api/types'
import { useProgressiveChatPresentation } from './useProgressiveChatPresentation'

describe('useProgressiveChatPresentation', () => {
  let nextFrameId = 1
  let frames = new Map<number, FrameRequestCallback>()

  beforeEach(() => {
    nextFrameId = 1
    frames = new Map()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId
      nextFrameId += 1
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id)
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function flushFrame() {
    const entry = frames.entries().next().value as [number, FrameRequestCallback] | undefined
    if (!entry) return false
    const [id, callback] = entry
    frames.delete(id)
    callback(performance.now())
    return true
  }

  function flushAllFrames() {
    let guard = 500
    while (guard > 0 && flushFrame()) guard -= 1
    expect(guard).toBeGreaterThan(0)
  }

  it('shows persisted history immediately without replaying a typing animation', () => {
    const sessionKey = ref('agent:main:main:dm:webchat-history')
    const history: ChatMessage[] = [{
      id: 'persisted-reply',
      role: 'assistant',
      content: '这是一条已经落盘的完整历史回复。',
    }]
    const messages = ref(history)
    const scope = effectScope()
    const result = scope.run(() => useProgressiveChatPresentation(sessionKey, messages))!

    expect(result.presentedMessages.value).toStrictEqual(history)
    expect(frames.size).toBe(0)
    scope.stop()
  })

  it('progressively presents a canonical chat stream without changing source messages', () => {
    const sessionKey = ref('agent:main:main:dm:webchat-live')
    const messages = ref<ChatMessage[]>([])
    const scope = effectScope()
    const result = scope.run(() => useProgressiveChatPresentation(sessionKey, messages))!
    const fullContent = '报告数据已采集完成，正在快速生成最近七天的业务综述报告。'

    messages.value = [{
      id: 'chat-stream:run-1',
      role: 'assistant',
      content: fullContent,
    }]

    expect(result.presentedMessages.value[0]?.content).toBe('报')
    expect(messages.value[0]?.content).toBe(fullContent)
    flushFrame()
    const afterOneFrame = result.presentedMessages.value[0]?.content || ''
    expect(afterOneFrame.length).toBeGreaterThan(1)
    expect(afterOneFrame.length).toBeLessThan(fullContent.length)

    flushAllFrames()
    expect(result.presentedMessages.value[0]?.content).toBe(fullContent)
    expect(messages.value[0]?.content).toBe(fullContent)
    scope.stop()
  })

  it('extends the same stream target without duplicating cumulative snapshots', () => {
    const sessionKey = ref('agent:main:main:dm:webchat-cumulative')
    const messages = ref<ChatMessage[]>([])
    const scope = effectScope()
    const result = scope.run(() => useProgressiveChatPresentation(sessionKey, messages))!
    const firstSnapshot = '正在查询最近七天的数据。'
    const finalSnapshot = `${firstSnapshot}数据已经返回，正在生成报告。`

    messages.value = [{ id: 'chat-stream:run-2', role: 'assistant', content: firstSnapshot }]
    flushFrame()
    messages.value = [{ id: 'chat-stream:run-2', role: 'assistant', content: finalSnapshot }]
    flushAllFrames()

    expect(result.presentedMessages.value[0]?.content).toBe(finalSnapshot)
    expect(result.presentedMessages.value).toHaveLength(1)
    scope.stop()
  })

  it('keeps smoothing when the temporary stream is replaced by persisted history', () => {
    const sessionKey = ref('agent:main:main:dm:webchat-converge')
    const messages = ref<ChatMessage[]>([])
    const scope = effectScope()
    const result = scope.run(() => useProgressiveChatPresentation(sessionKey, messages))!
    const streamContent = '报告已生成，正在整理最终摘要和报告附件。'
    const persistedContent = `${streamContent}您可以从下方直接下载。`

    messages.value = [{ id: 'chat-stream:run-3', role: 'assistant', content: streamContent }]
    flushFrame()
    const partialContent = result.presentedMessages.value[0]?.content || ''
    messages.value = [{
      id: 'persisted-final',
      role: 'assistant',
      content: persistedContent,
      rawContent: [{ type: 'text', text: persistedContent }],
    }]

    expect(result.presentedMessages.value[0]?.id).toBe('persisted-final')
    expect(result.presentedMessages.value[0]?.content).toBe(partialContent)
    expect(result.presentedMessages.value[0]?.rawContent).toBeUndefined()
    flushAllFrames()
    expect(result.presentedMessages.value[0]?.content).toBe(persistedContent)
    expect(messages.value[0]?.rawContent).toBeDefined()
    scope.stop()
  })

  it('cancels presentation on session switch and shows the selected history in full', () => {
    const sessionKey = ref('agent:main:main:dm:webchat-a')
    const messages = ref<ChatMessage[]>([])
    const scope = effectScope()
    const result = scope.run(() => useProgressiveChatPresentation(sessionKey, messages))!
    messages.value = [{
      id: 'chat-stream:run-4',
      role: 'assistant',
      content: '这条实时消息还没有完成逐字展示。',
    }]

    const persistedHistory: ChatMessage[] = [{
      id: 'history-b',
      role: 'assistant',
      content: '另一会话的历史消息必须立即完整显示。',
    }]
    messages.value = persistedHistory
    sessionKey.value = 'agent:main:main:dm:webchat-b'

    expect(result.presentedMessages.value).toStrictEqual(persistedHistory)
    expect(frames.size).toBe(0)
    scope.stop()
  })
})
