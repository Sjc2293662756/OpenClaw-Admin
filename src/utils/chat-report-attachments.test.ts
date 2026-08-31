import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/api/types'
import {
  hasReportDocumentReference,
  interleaveReportTranscriptItems,
  mapReportsToAssistantMessageIndexes,
  reportGenerationSignalSignature,
  type ChatReportFile,
} from './chat-report-attachments'

function report(overrides: Partial<ChatReportFile> = {}): ChatReportFile {
  return {
    id: 'report-1',
    name: '系统巡检报告.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 1024,
    status: 'ready',
    sourceSessionId: 'session-1',
    sourceMessageId: 'user-1',
    sourceMessagePreview: '生成巡检报告',
    createdAt: Date.parse('2026-08-24T02:00:05Z'),
    ...overrides,
  }
}

it('recognizes docx references in assistant text and raw content', () => {
  expect(hasReportDocumentReference({ role: 'assistant', content: '已生成：系统巡检报告.docx' })).toBe(true)
  expect(hasReportDocumentReference({
    role: 'assistant',
    content: '',
    rawContent: [{ type: 'text', text: 'MEDIA:/srv/reports/系统巡检报告.docx' }],
  })).toBe(true)
  expect(hasReportDocumentReference({ role: 'user', content: '系统巡检报告.docx' })).toBe(false)
})

it('recognizes report generation without depending on a literal .docx path', () => {
  expect(reportGenerationSignalSignature([{
    role: 'assistant',
    content: '报告已生成：238web_业务综述报告\n格式：docx\n完整报告将以附件形式发送。',
  }])).not.toBe('')
  expect(reportGenerationSignalSignature([{
    role: 'assistant',
    content: '',
    rawContent: [{ type: 'tool_call', name: 'napm-report-export', arguments: {} }],
  }])).not.toBe('')
  expect(reportGenerationSignalSignature([{
    role: 'assistant',
    content: '',
    rawContent: [{ type: 'toolCall' as never, name: 'napm-report-export', arguments: {} }],
  }])).not.toBe('')
  expect(reportGenerationSignalSignature([{
    role: 'assistant',
    content: '下面介绍如何设计报告模板。',
  }])).toBe('')
})
describe('mapReportsToAssistantMessageIndexes', () => {
  it('uses the signed source message id to attach a report to the following reply', () => {
    const user: ChatMessage = { id: 'user-1', role: 'user', content: '生成巡检报告', timestamp: '2026-08-24T02:00:00Z' }
    const assistant: ChatMessage = { id: 'assistant-1', role: 'assistant', content: '已生成：系统巡检报告.docx', timestamp: '2026-08-24T02:00:08Z' }
    const mapping = mapReportsToAssistantMessageIndexes([user, assistant], [report()])

    expect(mapping.get(1)?.map((item) => item.id)).toEqual(['report-1'])
  })

  it('places the card after the final assistant reply even when it omits the filename', () => {
    const user: ChatMessage = { id: 'user-1', role: 'user', content: '生成巡检报告', timestamp: '2026-08-24T02:00:00Z' }
    const preparing: ChatMessage = { role: 'assistant', content: '正在整理数据。', timestamp: '2026-08-24T02:00:02Z' }
    const completed: ChatMessage = { role: 'assistant', content: '报告已经生成完成，可以下载查看。', timestamp: '2026-08-24T02:00:08Z' }
    const mapping = mapReportsToAssistantMessageIndexes([user, preparing, completed], [report()])

    expect(mapping.get(1)).toBeUndefined()
    expect(mapping.get(2)?.map((item) => item.id)).toEqual(['report-1'])
  })

  it('does not carry a source report card into the next user turn', () => {
    const source: ChatMessage = { id: 'user-1', role: 'user', content: '生成巡检报告' }
    const completed: ChatMessage = { role: 'assistant', content: '报告已经生成完成。' }
    const nextUser: ChatMessage = { id: 'user-2', role: 'user', content: '谢谢' }
    const nextReply: ChatMessage = { role: 'assistant', content: '不客气。' }
    const mapping = mapReportsToAssistantMessageIndexes([source, completed, nextUser, nextReply], [report()])

    expect(mapping.get(1)?.[0]?.id).toBe('report-1')
    expect(mapping.get(3)).toBeUndefined()
  })

  it('uses the signed source preview when Gateway history assigns a different message id', () => {
    const user: ChatMessage = { id: 'gateway-user-9', role: 'user', content: '生成巡检报告' }
    const completed: ChatMessage = { role: 'assistant', content: '报告已经生成完成。' }
    const mapping = mapReportsToAssistantMessageIndexes([user, completed], [report({ sourceMessageId: 'web-local-id' })])

    expect(mapping.get(1)?.[0]?.id).toBe('report-1')
  })

  it('recovers a persisted turn when the exact optimistic source is appended after the reply', () => {
    const prompt = '给我回溯238web 最近3天的综述报告！'
    const persistedUser: ChatMessage = {
      id: 'gateway-user-9',
      role: 'user',
      content: `[Sun 2026-08-24 20:26 GMT+8] ${prompt}`,
      timestamp: '1787574389661',
    }
    const preparing: ChatMessage = { role: 'assistant', content: '正在生成报告。', timestamp: '1787574393561' }
    const completed: ChatMessage = { role: 'assistant', content: '报告已经生成完成，可以下载查看。', timestamp: '1787574395847' }
    const optimisticUser: ChatMessage = {
      id: 'web-1787574383916-k806hibc',
      role: 'user',
      content: prompt,
      timestamp: '2026-08-24T12:26:23.916Z',
    }
    const mapping = mapReportsToAssistantMessageIndexes(
      [persistedUser, preparing, completed, optimisticUser],
      [report({
        name: '238web 最近3天综述报告',
        sourceMessageId: optimisticUser.id,
        sourceMessagePreview: prompt,
        createdAt: 1787574395092,
      })],
    )

    expect(mapping.get(1)).toBeUndefined()
    expect(mapping.get(2)?.[0]?.id).toBe('report-1')
  })

  it('does not use report time to guess between repeated source previews', () => {
    const prompt = '生成巡检报告'
    const firstUser: ChatMessage = { role: 'user', content: prompt }
    const firstReply: ChatMessage = { role: 'assistant', content: '第一份报告已生成。', timestamp: '1787570000000' }
    const secondUser: ChatMessage = { role: 'user', content: `[Sun 2026-08-24 20:20 GMT+8] ${prompt}` }
    const secondReply: ChatMessage = { role: 'assistant', content: '第二份报告已生成。', timestamp: '1787574300000' }
    const trailingSource: ChatMessage = { id: 'web-local-id', role: 'user', content: prompt }
    const mapping = mapReportsToAssistantMessageIndexes(
      [firstUser, firstReply, secondUser, secondReply, trailingSource],
      [report({ sourceMessageId: trailingSource.id, sourceMessagePreview: prompt, createdAt: 1787574299000 })],
    )

    expect(mapping.size).toBe(0)
  })

  it('maps the production format-only reply after the report list refreshes', () => {
    const prompt = '给我回溯238web 最近3天的综述报告！'
    const user: ChatMessage = { role: 'user', content: prompt, timestamp: '1787622904849' }
    const completed: ChatMessage = {
      role: 'assistant',
      content: '报告已生成：238web_业务综述报告\n格式：docx\n完整报告将以附件形式发送。',
      timestamp: '1787622913234',
    }
    const mapping = mapReportsToAssistantMessageIndexes([user, completed], [report({
      id: '238web_业务综述报告_20260825_095513',
      name: '238web_业务综述报告.docx',
      sourceMessageId: 'web-1787622899420-v4tcu5te',
      sourceMessagePreview: prompt,
      createdAt: 1787622913043,
    })])

    expect(mapping.get(1)?.map((item) => item.id)).toEqual(['238web_业务综述报告_20260825_095513'])
  })

  it('does not use a filename as a placement fallback', () => {
    const first: ChatMessage = { role: 'assistant', content: '旧报告.docx', timestamp: '2026-08-24T01:00:00Z' }
    const second: ChatMessage = { role: 'assistant', content: '新报告.docx', timestamp: '2026-08-24T02:00:00Z' }
    const mapping = mapReportsToAssistantMessageIndexes([first, second], [report({ name: '新报告.docx', sourceMessageId: null, sourceMessagePreview: null })])

    expect(mapping.size).toBe(0)
  })

  it('does not guess when multiple replies and reports have no correlation evidence', () => {
    const first: ChatMessage = { role: 'assistant', content: '报告一.docx' }
    const second: ChatMessage = { role: 'assistant', content: '报告二.docx' }
    const ambiguous = report({ name: '未出现在消息中的文件.docx', sourceMessageId: null, createdAt: Number.NaN })

    expect(mapReportsToAssistantMessageIndexes([first, second], [ambiguous]).size).toBe(0)
  })

  it('does not place an unattributed legacy report by time or at the conversation tail', () => {
    const reportPrompt: ChatMessage = {
      role: 'user',
      content: '生成业务综述报告',
      timestamp: '2026-08-25T05:20:00Z',
    }
    const reportReply: ChatMessage = {
      role: 'assistant',
      content: '业务综述报告已生成，可以下载查看。',
      timestamp: '2026-08-25T05:20:08Z',
    }
    const laterUser: ChatMessage = {
      role: 'user',
      content: '你是？',
      timestamp: '2026-08-25T05:32:56Z',
    }
    const laterReply: ChatMessage = {
      role: 'assistant',
      content: '我是观枢AI。',
      timestamp: '2026-08-25T05:32:57Z',
    }
    const legacyReport = report({
      name: '业务综述报告.docx',
      sourceMessageId: null,
      sourceMessagePreview: null,
      createdAt: Date.parse('2026-08-25T05:20:07Z'),
    })
    const mapping = mapReportsToAssistantMessageIndexes(
      [reportPrompt, reportReply, laterUser, laterReply],
      [legacyReport],
    )

    expect(mapping.size).toBe(0)
  })

  it('requires one unique completion signal inside the source user turn', () => {
    const source: ChatMessage = { id: 'user-1', role: 'user', content: '生成巡检报告' }
    const firstCompletion: ChatMessage = { role: 'assistant', content: '报告已生成，格式：docx。' }
    const secondCompletion: ChatMessage = { role: 'assistant', content: '完整报告已经生成，可以下载。' }

    expect(mapReportsToAssistantMessageIndexes(
      [source, firstCompletion, secondCompletion],
      [report()],
    ).size).toBe(0)
  })

  it('deduplicates a report id and keeps later messages after its independent transcript item', () => {
    const source: ChatMessage = { id: 'user-1', role: 'user', content: '生成巡检报告' }
    const completed: ChatMessage = { id: 'assistant-1', role: 'assistant', content: '报告已生成，格式：docx。' }
    const laterUser: ChatMessage = { id: 'user-2', role: 'user', content: '谢谢' }
    const mapping = mapReportsToAssistantMessageIndexes(
      [source, completed, laterUser],
      [report(), report({ createdAt: Date.parse('2026-08-24T02:00:06Z') })],
    )
    const messageRows = [
      { key: 'user-1', messageIndex: 0 },
      { key: 'assistant-1', messageIndex: 1 },
      { key: 'user-2', messageIndex: 2 },
    ]
    const transcript = interleaveReportTranscriptItems(
      messageRows,
      (messageIndex) => mapping.get(messageIndex) || [],
    )

    expect(mapping.get(1)?.map((item) => item.id)).toEqual(['report-1'])
    expect(transcript.map((item) => [item.transcriptType, item.messageIndex])).toEqual([
      ['message', 0],
      ['message', 1],
      ['report', 1],
      ['message', 2],
    ])
  })

})
