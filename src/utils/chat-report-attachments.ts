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

function normalizedSourcePreview(value: string): string {
  return value
    .replace(TRANSPORT_TIMESTAMP_PREFIX_PATTERN, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function uniqueCompletionTarget(
  messages: ChatMessage[],
  sourceIndex: number,
): number | undefined {
  const nextUserIndex = messages.findIndex((message, index) =>
    index > sourceIndex && message.role === 'user'
  )
  const turnEnd = nextUserIndex >= 0 ? nextUserIndex : messages.length
  const candidates = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) =>
      index > sourceIndex
      && index < turnEnd
      && hasReportCompletionSignal(message)
    )
  return candidates.length === 1 ? candidates[0]?.index : undefined
}

/**
 * Associate session-owned reports with one explicit completion reply in their
 * source user turn. A source id is authoritative; a unique normalized preview
 * is the only fallback when Gateway persistence replaces the browser id.
 */
export function mapReportsToAssistantMessageIndexes(
  messages: ChatMessage[],
  reports: ChatReportFile[],
): Map<number, ChatReportFile[]> {
  const result = new Map<number, ChatReportFile[]>()
  const messageIndexesById = new Map<string, number[]>()
  messages.forEach((message, index) => {
    if (!message.id) return
    const indexes = messageIndexesById.get(message.id) || []
    indexes.push(index)
    messageIndexesById.set(message.id, indexes)
  })

  const sortedReports = [...reports].sort((left, right) => left.createdAt - right.createdAt)
  const attachedReportIds = new Set<string>()
  for (const report of sortedReports) {
    if (!report.id || attachedReportIds.has(report.id)) continue
    let targetIndex: number | undefined
    const exactSourceIndexes = report.sourceMessageId
      ? messageIndexesById.get(report.sourceMessageId) || []
      : []
    const sourcePreview = String(report.sourceMessagePreview || '').trim()

    if (exactSourceIndexes.length === 1) {
      const exactSourceIndex = exactSourceIndexes[0]!
      targetIndex = hasReportCompletionSignal(messages[exactSourceIndex]!)
        ? exactSourceIndex
        : uniqueCompletionTarget(messages, exactSourceIndex)
    }

    if (targetIndex === undefined && sourcePreview) {
      const normalizedPreview = normalizedSourcePreview(sourcePreview)
      const previewTargets = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) =>
          message.role === 'user'
          && normalizedSourcePreview(messageText(message).slice(0, 1000)) === normalizedPreview
        )
        .map(({ index }) => uniqueCompletionTarget(messages, index))
        .filter((index): index is number => index !== undefined)
      const uniqueTargets = [...new Set(previewTargets)]
      if (uniqueTargets.length === 1) targetIndex = uniqueTargets[0]
    }

    if (targetIndex === undefined) continue
    const attached = result.get(targetIndex) || []
    attached.push(report)
    result.set(targetIndex, attached)
    attachedReportIds.add(report.id)
  }

  return result
}

export type ReportTranscriptEntry<T extends { key: string; messageIndex: number }> = T & {
  transcriptType: 'message' | 'report'
  reports: ChatReportFile[]
}

export function interleaveReportTranscriptItems<T extends { key: string; messageIndex: number }>(
  messages: T[],
  reportsForMessageIndex: (messageIndex: number) => ChatReportFile[],
): ReportTranscriptEntry<T>[] {
  const result: ReportTranscriptEntry<T>[] = []
  for (const message of messages) {
    result.push({ ...message, transcriptType: 'message', reports: [] })
    const reports = reportsForMessageIndex(message.messageIndex)
    if (reports.length === 0) continue
    result.push({
      ...message,
      key: `reports-after:${message.key}:${reports.map((report) => report.id).join(',')}`,
      transcriptType: 'report',
      reports,
    })
  }
  return result
}
