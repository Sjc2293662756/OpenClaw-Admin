import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/api/types'
import { useChatReportAttachments } from './useChatReportAttachments'

vi.mock('naive-ui', () => ({
  useMessage: () => ({ error: vi.fn() }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ getToken: () => 'test-token' }),
}))

function response(reports: unknown[]) {
  return new Response(JSON.stringify({ ok: true, reports }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useChatReportAttachments', () => {
  it('retries the current session when production output only labels the docx format', async () => {
    const readyReports = [{
      id: '238web_业务综述报告_20260825_095513',
      name: '238web_业务综述报告.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 18256,
      status: 'ready',
      sourceSessionId: 'agent:main:main:dm:webchat-test',
      sourceMessageId: 'web-local-id',
      sourceMessagePreview: '给我回溯238web 最近3天的综述报告！',
      createdAt: 1787622913043,
    }]
    let requestCount = 0
    const fetchMock = vi.fn(async () => {
      requestCount += 1
      return response(requestCount === 1 ? [] : readyReports)
    })
    vi.stubGlobal('fetch', fetchMock)

    const sessionKey = ref('agent:main:main:dm:webchat-test')
    const messages = ref<ChatMessage[]>([{
      role: 'user',
      content: '给我回溯238web 最近3天的综述报告！',
      timestamp: '1787622904849',
    }])
    const scope = effectScope()
    const attachments = scope.run(() => useChatReportAttachments(sessionKey, messages))!
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const completed: ChatMessage = {
      role: 'assistant',
      content: '报告已生成：238web_业务综述报告\n格式：docx\n完整报告将以附件形式发送。',
      timestamp: '1787622913234',
    }
    messages.value = [...messages.value, completed]
    await nextTick()
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/reports?sourceSessionId=agent%3Amain%3Amain%3Adm%3Awebchat-test',
      expect.objectContaining({ headers: { Authorization: 'Bearer test-token' }, cache: 'no-store' }),
    )
    await vi.waitFor(() => expect(
      attachments.reportsForMessageIndex(1).map((item) => item.name)
    ).toEqual(['238web_业务综述报告.docx']))
    scope.stop()
  })

  it('cancels old-session retries when the user switches conversations', async () => {
    const fetchMock = vi.fn(async () => response([]))
    vi.stubGlobal('fetch', fetchMock)
    const sessionKey = ref('agent:main:main:dm:webchat-old')
    const messages = ref<ChatMessage[]>([])
    const scope = effectScope()
    scope.run(() => useChatReportAttachments(sessionKey, messages))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    messages.value = [{ role: 'assistant', content: '报告已生成，格式：docx。' }]
    await nextTick()
    sessionKey.value = 'agent:main:main:dm:webchat-new'
    await nextTick()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(20000)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/reports?sourceSessionId=agent%3Amain%3Amain%3Adm%3Awebchat-new',
      expect.anything(),
    )
    scope.stop()
  })

  it('keeps a report available across an empty retry and an older history snapshot', async () => {
    const readyReport = {
      id: 'stable-report-id',
      name: '稳定报告.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 4096,
      status: 'ready',
      sourceSessionId: 'agent:main:main:dm:webchat-stable',
      sourceMessageId: 'user-source',
      sourceMessagePreview: '生成稳定报告',
      createdAt: 1787622913043,
    }
    let requestCount = 0
    const fetchMock = vi.fn(async () => {
      requestCount += 1
      if (requestCount === 2) return response([readyReport])
      return response([])
    })
    vi.stubGlobal('fetch', fetchMock)

    const sessionKey = ref('agent:main:main:dm:webchat-stable')
    const source: ChatMessage = { id: 'user-source', role: 'user', content: '生成稳定报告' }
    const completed: ChatMessage = { role: 'assistant', content: '报告已生成，格式：docx。' }
    const messages = ref<ChatMessage[]>([source])
    const scope = effectScope()
    const attachments = scope.run(() => useChatReportAttachments(sessionKey, messages))!
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    messages.value = [source, completed]
    await nextTick()
    await vi.advanceTimersByTimeAsync(250)
    await vi.waitFor(() => expect(
      attachments.reportsForMessageIndex(1).map((item) => item.id)
    ).toEqual(['stable-report-id']))

    // A later registration retry must not erase a report which was already
    // returned for this exact session.
    await vi.advanceTimersByTimeAsync(1250)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(attachments.reportsForMessageIndex(1).map((item) => item.id)).toEqual(['stable-report-id'])

    // A lagging history snapshot temporarily has no completion anchor, so no
    // card is appended at the conversation tail.
    messages.value = [{ ...source }]
    await nextTick()
    expect(attachments.reportsForMessageIndex(0)).toEqual([])

    const persistedReply: ChatMessage = { role: 'assistant', content: '报告已生成，格式：docx。' }
    messages.value = [{ ...source }, persistedReply]
    await nextTick()
    expect(attachments.reportsForMessageIndex(1).map((item) => item.id)).toEqual(['stable-report-id'])
    scope.stop()
  })

  it('preserves attachment list identity when a retry returns identical report metadata', async () => {
    const readyReport = {
      id: 'stable-retry-report',
      name: '稳定重试报告.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 8192,
      status: 'ready',
      sourceSessionId: 'agent:main:main:dm:webchat-stable-retry',
      sourceMessageId: 'stable-source',
      sourceMessagePreview: '生成稳定重试报告',
      createdAt: 1787622913043,
    }
    const fetchMock = vi.fn(async () => response([readyReport]))
    vi.stubGlobal('fetch', fetchMock)

    const sessionKey = ref('agent:main:main:dm:webchat-stable-retry')
    const source: ChatMessage = { id: 'stable-source', role: 'user', content: '生成稳定重试报告' }
    const completed: ChatMessage = { role: 'assistant', content: '报告已生成，格式：docx。' }
    const messages = ref<ChatMessage[]>([source, completed])
    const scope = effectScope()
    const attachments = scope.run(() => useChatReportAttachments(sessionKey, messages))!

    await attachments.refreshReports(sessionKey.value)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(attachments.reportsForMessageIndex(1)).toHaveLength(1))
    const initialReports = attachments.reportsForMessageIndex(1)

    await attachments.refreshReports(sessionKey.value, { preserveExisting: true })
    await nextTick()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(attachments.reportsForMessageIndex(1)).toBe(initialReports)
    scope.stop()
  })

  it('rejects wrong-session records and deduplicates the current report id', async () => {
    const currentSession = 'agent:main:main:dm:webchat-current'
    const currentReport = {
      id: 'current-report',
      name: '当前会话报告.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 2048,
      status: 'ready',
      sourceSessionId: currentSession,
      sourceMessageId: 'user-current',
      sourceMessagePreview: '生成当前报告',
      createdAt: 1787622913043,
    }
    vi.stubGlobal('fetch', vi.fn(async () => response([
      currentReport,
      { ...currentReport },
      { ...currentReport, id: 'other-report', sourceSessionId: 'agent:main:main:dm:webchat-other' },
    ])))
    const sessionKey = ref(currentSession)
    const messages = ref<ChatMessage[]>([
      { id: 'user-current', role: 'user', content: '生成当前报告' },
      { id: 'assistant-current', role: 'assistant', content: '报告已生成，格式：docx。' },
    ])
    const scope = effectScope()
    const attachments = scope.run(() => useChatReportAttachments(sessionKey, messages))!

    await vi.waitFor(() => expect(attachments.reportsForMessageIndex(1).map((item) => item.id)).toEqual([
      'current-report',
    ]))
    expect(attachments.reportsForMessageIndex(0)).toEqual([])
    scope.stop()
  })
})
