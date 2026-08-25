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
const REPORT_EXPORT_TOOL_NAMES = new Set(['napm-report-export'])
const REPORT_COMPLETION_TEXT_PATTERN = /(?:报告(?:文件)?(?:已经|已)?生成|report\s+(?:file\s+)?(?:is\s+)?(?:ready|generated)|格式\s*[:：]\s*(?:docx|word)|完整报告.{0,20}(?:附件|attachment))/iu
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

function hasReportExportToolCall(message: ChatMessage): boolean {
  return message.role === 'assistant' && (message.rawContent || []).some((part) =>
    REPORT_EXPORT_TOOL_NAMES.has(String(part.name || '').trim().toLowerCase())
  )
}

function hasReportCompletionSignal(message: ChatMessage): boolean {
  if (message.role !== 'assistant') return false
  const text = messageText(message).trim()
  return DOCX_REFERENCE_PATTERN.test(text)
    || REPORT_COMPLETION_TEXT_PATTERN.test(text)
}

function hasReportGenerationSignal(message: ChatMessage): boolean {
  return hasReportExportToolCall(message) || hasReportCompletionSignal(message)
}

/**
 * Produce a stable, session-local signal when a report export starts or its
 * assistant reply completes. The report Skill may omit a literal `.docx`
 * path, so the browser must not depend on one exact wording.
 */
export function reportGenerationSignalSignature(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    const text = messageText(message).trim()
    if (
      !hasReportGenerationSignal(message)
    ) continue
    return [
      index,
      message.id || '',
      message.timestamp || '',
      message.stopReason || '',
      text.length,
      text.slice(0, 120),
      text.slice(-120),
    ].join('|')
  }
  return ''
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
    || [...following].reverse().find(({ message }) => hasReportCompletionSignal(message))
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
  const reportCandidates = assistantMessages.filter(({ message }) => hasReportCompletionSignal(message))

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

/**
 * An independent attachment is only a short-lived bridge while the report
 * completion turn is missing from a lagging history snapshot. It must not
 * follow later ordinary user turns at the bottom of the conversation.
 */
export function shouldDisplayUnplacedReport(
  messages: ChatMessage[],
  report: ChatReportFile,
): boolean {
  const createdAt = Number(report.createdAt)
  if (Number.isFinite(createdAt)) {
    const hasLaterUserTurn = messages.some((message) => {
      if (message.role !== 'user') return false
      const timestamp = messageTimestamp(message)
      return timestamp !== null && timestamp > createdAt
    })
    if (hasLaterUserTurn) return false
  }

  const sourcePreview = normalizedSourcePreview(String(report.sourceMessagePreview || ''))
  let reportTurnIndex = -1
  messages.forEach((message, index) => {
    if (message.role === 'user') {
      const exactId = Boolean(report.sourceMessageId && message.id === report.sourceMessageId)
      const exactPreview = Boolean(
        sourcePreview
        && normalizedSourcePreview(messageText(message).slice(0, 1000)) === sourcePreview
      )
      if (exactId || exactPreview) reportTurnIndex = index
      return
    }
    if (hasReportCompletionSignal(message)) {
      const timestamp = messageTimestamp(message)
      if (
        !Number.isFinite(createdAt)
        || (timestamp !== null && Math.abs(timestamp - createdAt) <= 30 * 60 * 1000)
      ) {
        reportTurnIndex = index
      }
    }
  })

  if (reportTurnIndex < 0) return true
  return !messages.some((message, index) =>
    index > reportTurnIndex && message.role === 'user'
  )
}
