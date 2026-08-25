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
