import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/api/types'
import {
  hasReportDocumentReference,
  mapReportsToAssistantMessages,
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
describe('mapReportsToAssistantMessages', () => {
  it('uses the signed source message id to attach a report to the following reply', () => {
    const user: ChatMessage = { id: 'user-1', role: 'user', content: '生成巡检报告', timestamp: '2026-08-24T02:00:00Z' }
    const assistant: ChatMessage = { id: 'assistant-1', role: 'assistant', content: '已生成：系统巡检报告.docx', timestamp: '2026-08-24T02:00:08Z' }
    const mapping = mapReportsToAssistantMessages([user, assistant], [report()])

    expect(mapping.get(assistant)?.map((item) => item.id)).toEqual(['report-1'])
  })

  it('places the card after the final assistant reply even when it omits the filename', () => {
    const user: ChatMessage = { id: 'user-1', role: 'user', content: '生成巡检报告', timestamp: '2026-08-24T02:00:00Z' }
    const preparing: ChatMessage = { role: 'assistant', content: '正在整理数据。', timestamp: '2026-08-24T02:00:02Z' }
    const completed: ChatMessage = { role: 'assistant', content: '报告已经生成完成，可以下载查看。', timestamp: '2026-08-24T02:00:08Z' }
    const mapping = mapReportsToAssistantMessages([user, preparing, completed], [report()])

    expect(mapping.get(preparing)).toBeUndefined()
    expect(mapping.get(completed)?.map((item) => item.id)).toEqual(['report-1'])
  })

  it('does not carry a source report card into the next user turn', () => {
    const source: ChatMessage = { id: 'user-1', role: 'user', content: '生成巡检报告' }
    const completed: ChatMessage = { role: 'assistant', content: '报告已经生成完成。' }
    const nextUser: ChatMessage = { id: 'user-2', role: 'user', content: '谢谢' }
    const nextReply: ChatMessage = { role: 'assistant', content: '不客气。' }
    const mapping = mapReportsToAssistantMessages([source, completed, nextUser, nextReply], [report()])

    expect(mapping.get(completed)?.[0]?.id).toBe('report-1')
    expect(mapping.get(nextReply)).toBeUndefined()
  })

  it('uses the signed source preview when Gateway history assigns a different message id', () => {
    const user: ChatMessage = { id: 'gateway-user-9', role: 'user', content: '生成巡检报告' }
    const completed: ChatMessage = { role: 'assistant', content: '报告已经生成完成。' }
    const mapping = mapReportsToAssistantMessages([user, completed], [report({ sourceMessageId: 'web-local-id' })])

    expect(mapping.get(completed)?.[0]?.id).toBe('report-1')
  })

  it('uses the exact name only as a placement fallback within the fetched session reports', () => {
    const first: ChatMessage = { role: 'assistant', content: '旧报告.docx', timestamp: '2026-08-24T01:00:00Z' }
    const second: ChatMessage = { role: 'assistant', content: '新报告.docx', timestamp: '2026-08-24T02:00:00Z' }
    const mapping = mapReportsToAssistantMessages([first, second], [report({ name: '新报告.docx', sourceMessageId: null })])

    expect(mapping.get(first)).toBeUndefined()
    expect(mapping.get(second)?.[0]?.name).toBe('新报告.docx')
  })

  it('does not guess when multiple replies and reports have no correlation evidence', () => {
    const first: ChatMessage = { role: 'assistant', content: '报告一.docx' }
    const second: ChatMessage = { role: 'assistant', content: '报告二.docx' }
    const ambiguous = report({ name: '未出现在消息中的文件.docx', sourceMessageId: null, createdAt: Number.NaN })

    expect(mapReportsToAssistantMessages([first, second], [ambiguous]).size).toBe(0)
  })
})
