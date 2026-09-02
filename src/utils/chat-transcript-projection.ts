import type { ChatMessage } from '@/api/types'

export interface ProcessAwareStructuredMessage {
  toolCalls: unknown[]
  thinkings: unknown[]
  toolResults: unknown[]
  validationErrors: unknown[]
  plainTexts: string[]
  images: unknown[]
}

export function isConversationTranscriptRole(role: string): boolean {
  return role !== 'tool' && role !== 'toolResult'
}

export function isConversationTranscriptMessage(message: ChatMessage): boolean {
  if (!isConversationTranscriptRole(message.role)) return false
  if (message.process?.kind === 'user_visible_process') {
    return message.process.visible && message.process.safe && Boolean(message.process.publicText.trim())
  }
  // Canonical live chat events are not yet covered by the BFF history
  // projection. Suppress structured tool turns until their safe persisted
  // process metadata arrives; ordinary final streaming replies remain visible.
  if (
    message.id?.startsWith('chat-stream:')
    && message.rawContent?.some((part) => part.type === 'tool_call')
  ) {
    return false
  }
  return true
}

export function projectConversationStructuredMessage<T extends ProcessAwareStructuredMessage>(
  structured: T,
): T | null {
  const plainTexts = structured.plainTexts.filter((text) => text.trim().length > 0)
  const images = [...structured.images]
  if (plainTexts.length === 0 && images.length === 0) return null

  return {
    ...structured,
    toolCalls: [],
    thinkings: [],
    toolResults: [],
    validationErrors: [],
    plainTexts,
    images,
  }
}
