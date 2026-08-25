import { describe, expect, it } from 'vitest'
import {
  isConversationTranscriptRole,
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
