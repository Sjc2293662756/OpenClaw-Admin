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
  sourceMessagePreview?: string | null
  createdAt: number
}

const DOCX_REFERENCE_PATTERN = /\.docx(?![a-z0-9_])/i
const TRANSPORT_TIMESTAMP_PREFIX_PATTERN = /^\[[A-Z][a-z]{2}\s+\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?:\s+[A-Z]{2,5}(?:[+-]\d{1,2}(?::\d{2})?)?)?\]\s*/u

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
  const raw = String(message.timestamp || '').trim()
  const numeric = Number(raw)
  const value = raw && Number.isFinite(numeric) && numeric > 0
    ? numeric
    : Date.parse(raw)
  return Number.isFinite(value) ? value : null
}

function normalizedSourcePreview(value: string): string {
  return value
    .replace(TRANSPORT_TIMESTAMP_PREFIX_PATTERN, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function followingAssistantMessages(
  messages: ChatMessage[],
  assistantMessages: Array<{ message: ChatMessage; index: number; text: string }>,
  sourceIndex: number,
) {
  const nextUserIndex = messages.findIndex((message, index) =>
    index > sourceIndex && message.role === 'user'
  )
  const turnEnd = nextUserIndex >= 0 ? nextUserIndex : messages.length
  return assistantMessages.filter((candidate) =>
    candidate.index > sourceIndex && candidate.index < turnEnd
  )
}

function pickFollowingTarget(
  following: Array<{ message: ChatMessage; index: number; text: string }>,
  report: ChatReportFile,
) {
  return following.find((candidate) => candidate.text.includes(report.name))
    || [...following].reverse().find(({ message }) => hasReportDocumentReference(message))
    || [...following].reverse().find((candidate) => {
      const timestamp = messageTimestamp(candidate.message)
      return timestamp !== null && timestamp >= report.createdAt
    })
    || following[following.length - 1]
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
  const assistantMessages = messages
    .map((message, index) => ({ message, index, text: messageText(message) }))
    .filter(({ message, text }) => message.role === 'assistant' && text.trim().length > 0)
  const reportCandidates = assistantMessages.filter(({ message }) => hasReportDocumentReference(message))

  if (assistantMessages.length === 0) return result

  const messageIndexById = new Map<string, number>()
  messages.forEach((message, index) => {
    if (message.id) messageIndexById.set(message.id, index)
  })

  const sortedReports = [...reports].sort((left, right) => left.createdAt - right.createdAt)
  for (const report of sortedReports) {
    let target: (typeof assistantMessages)[number] | undefined
    const exactSourceIndex = report.sourceMessageId
      ? messageIndexById.get(report.sourceMessageId)
      : undefined
    const sourcePreview = String(report.sourceMessagePreview || '').trim()

    if (exactSourceIndex !== undefined) {
      target = pickFollowingTarget(
        followingAssistantMessages(messages, assistantMessages, exactSourceIndex),
        report,
      )
    }

    // A Gateway history refresh can preserve the browser's optimistic `web-*`
    // source message at the end of the list while the persisted user turn has a
    // new id and an inbound timestamp envelope.  An exact id with no following
    // assistant is therefore not a usable turn boundary; fall back to the
    // signed source preview and choose the nearest completed persisted turn.
    if (!target && sourcePreview) {
      const normalizedPreview = normalizedSourcePreview(sourcePreview)
      const previewTurns = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) =>
          message.role === 'user'
          && normalizedSourcePreview(messageText(message).slice(0, 1000)) === normalizedPreview
        )
        .map(({ index }) => ({
          index,
          following: followingAssistantMessages(messages, assistantMessages, index),
        }))
        .filter(({ following }) => following.length > 0)
        .map(({ index, following }) => ({
          index,
          target: pickFollowingTarget(following, report),
        }))
        .filter((candidate): candidate is { index: number; target: (typeof assistantMessages)[number] } => Boolean(candidate.target))

      previewTurns.sort((left, right) => {
        const leftTimestamp = messageTimestamp(left.target.message)
        const rightTimestamp = messageTimestamp(right.target.message)
        if (leftTimestamp !== null && rightTimestamp !== null && Number.isFinite(report.createdAt)) {
          return Math.abs(leftTimestamp - report.createdAt) - Math.abs(rightTimestamp - report.createdAt)
        }
        return right.index - left.index
      })
      target = previewTurns[0]?.target
    }

    if (!target) {
      target = reportCandidates.find((candidate) => candidate.text.includes(report.name))
    }

    if (!target && Number.isFinite(report.createdAt)) {
      const nearby = reportCandidates
        .map((candidate) => ({
          candidate,
          distance: Math.abs((messageTimestamp(candidate.message) ?? Number.POSITIVE_INFINITY) - report.createdAt),
        }))
        .filter(({ distance }) => distance <= 30 * 60 * 1000)
        .sort((left, right) => left.distance - right.distance)[0]
      target = nearby?.candidate
    }

    if (!target && reportCandidates.length === 1 && reports.length === 1) {
      target = reportCandidates[0]
    }

    if (!target) continue
    const attached = result.get(target.message) || []
    attached.push(report)
    result.set(target.message, attached)
  }

  return result
}
