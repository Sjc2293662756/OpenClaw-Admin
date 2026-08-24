import type { ChatMessage } from '@/api/types'

export type ChatReportStatus = 'ready' | 'missing' | 'failed'

export type ChatReportFile = {
  id: string
  name: string
  mimeType: string
  size: number
  status: ChatReportStatus
  sourceSessionId?: string | null
  sourceMessageId?: string | null
  createdAt: number
}

const DOCX_REFERENCE_PATTERN = /\.docx(?![a-z0-9_])/i

function messageText(message: ChatMessage): string {
  const parts = [message.content || '']
  for (const part of message.rawContent || []) {
    if (typeof part.text === 'string') parts.push(part.text)
    if (typeof part.content === 'string') parts.push(part.content)
  }
  return parts.join('\n')
}

export function hasReportDocumentReference(message: ChatMessage): boolean {
  return message.role === 'assistant' && DOCX_REFERENCE_PATTERN.test(messageText(message))
}

function messageTimestamp(message: ChatMessage): number | null {
  const value = Date.parse(message.timestamp || '')
  return Number.isFinite(value) ? value : null
}

/**
 * Associate session-owned report records with the assistant reply that announced
 * them. Source message id is authoritative. Filename and time are placement-only
 * hints after the BFF has already filtered reports by the authenticated session.
 */
export function mapReportsToAssistantMessages(
  messages: ChatMessage[],
  reports: ChatReportFile[],
): Map<ChatMessage, ChatReportFile[]> {
  const result = new Map<ChatMessage, ChatReportFile[]>()
  const candidates = messages
    .map((message, index) => ({ message, index, text: messageText(message) }))
    .filter(({ message }) => hasReportDocumentReference(message))

  if (candidates.length === 0) return result

  const messageIndexById = new Map<string, number>()
  messages.forEach((message, index) => {
    if (message.id) messageIndexById.set(message.id, index)
  })

  const sortedReports = [...reports].sort((left, right) => left.createdAt - right.createdAt)
  for (const report of sortedReports) {
    let target: (typeof candidates)[number] | undefined
    const sourceIndex = report.sourceMessageId
      ? messageIndexById.get(report.sourceMessageId)
      : undefined

    if (sourceIndex !== undefined) {
      const following = candidates.filter((candidate) => candidate.index > sourceIndex)
      target = following.find((candidate) => candidate.text.includes(report.name)) || following[0]
    }

    if (!target) {
      target = candidates.find((candidate) => candidate.text.includes(report.name))
    }

    if (!target && Number.isFinite(report.createdAt)) {
      const nearby = candidates
        .map((candidate) => ({
          candidate,
          distance: Math.abs((messageTimestamp(candidate.message) ?? Number.POSITIVE_INFINITY) - report.createdAt),
        }))
        .filter(({ distance }) => distance <= 30 * 60 * 1000)
        .sort((left, right) => left.distance - right.distance)[0]
      target = nearby?.candidate
    }

    if (!target && candidates.length === 1 && reports.length === 1) {
      target = candidates[0]
    }

    if (!target) continue
    const attached = result.get(target.message) || []
    attached.push(report)
    result.set(target.message, attached)
  }

  return result
}
