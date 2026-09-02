import { describe, expect, it } from 'vitest'
import {
  isConversationTranscriptRole,
  isConversationTranscriptMessage,
  projectConversationStructuredMessage,
} from './chat-transcript-projection'

describe('chat transcript projection', () => {
  it('keeps process-only roles out of the default conversation', () => {
    expect(isConversationTranscriptRole('user')).toBe(true)
    expect(isConversationTranscriptRole('assistant')).toBe(true)
    expect(isConversationTranscriptRole('system')).toBe(true)
    expect(isConversationTranscriptRole('tool')).toBe(false)
    expect(isConversationTranscriptRole('toolResult')).toBe(false)
  })

  it('applies the execution snapshot only to explicitly projected process turns', () => {
    const base = {
      id: 'gateway-process-1',
      role: 'assistant' as const,
      content: '正在查询最近 7 天的数据。',
    }
    expect(isConversationTranscriptMessage(base)).toBe(true)
    expect(isConversationTranscriptMessage({
      ...base,
      process: {
        kind: 'user_visible_process',
        sessionKey: 'session-1',
        runId: 'run-1',
        stepId: 'step-1',
        sequence: 1,
        publicText: base.content,
        status: 'completed',
        visible: false,
        safe: true,
      },
    })).toBe(false)
    expect(isConversationTranscriptMessage({
      ...base,
      process: {
        kind: 'user_visible_process',
        sessionKey: 'session-1',
        runId: 'run-1',
        stepId: 'step-1',
        sequence: 1,
        publicText: base.content,
        status: 'completed',
        visible: true,
        safe: true,
      },
    })).toBe(true)
  })

  it('holds an unprojected live tool turn until safe Gateway history arrives', () => {
    expect(isConversationTranscriptMessage({
      id: 'chat-stream:run-1',
      role: 'assistant',
      content: '正在查询数据。',
      rawContent: [
        { type: 'text', text: '正在查询数据。' },
        { type: 'tool_call', id: 'call-1', name: 'query' },
      ],
    })).toBe(false)
    expect(isConversationTranscriptMessage({
      id: 'chat-stream:run-1',
      role: 'assistant',
      content: '最终结果',
      rawContent: [{ type: 'text', text: '最终结果' }],
    })).toBe(true)
  })

  it('drops a process-only structured assistant message', () => {
    expect(projectConversationStructuredMessage({
      toolCalls: [{ name: 'napm-skill-query' }],
      thinkings: [{ text: 'internal' }],
      toolResults: [{ content: 'large result' }],
      validationErrors: [],
      plainTexts: [],
      images: [],
    })).toBeNull()
  })

  it('keeps formal text and images while removing process fields', () => {
    const source = {
      toolCalls: [{ name: 'napm-report-export' }],
      thinkings: [{ text: 'internal' }],
      toolResults: [{ content: 'raw report result' }],
      validationErrors: [{ issues: ['bad args'] }],
      plainTexts: ['  ', '报告已生成'],
      images: [{ mediaPath: 'report.png' }],
    }

    expect(projectConversationStructuredMessage(source)).toEqual({
      toolCalls: [],
      thinkings: [],
      toolResults: [],
      validationErrors: [],
      plainTexts: ['报告已生成'],
      images: [{ mediaPath: 'report.png' }],
    })
    expect(source.toolCalls).toHaveLength(1)
    expect(source.toolResults).toHaveLength(1)
  })
})
