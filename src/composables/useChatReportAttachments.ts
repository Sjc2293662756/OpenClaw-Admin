import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import type { ChatMessage } from '@/api/types'
import {
  mapReportsToAssistantMessages,
  reportGenerationSignalSignature,
  type ChatReportFile,
} from '@/utils/chat-report-attachments'

type ReportsResponse = {
  ok?: boolean
  reports?: ChatReportFile[]
  error?: string
  message?: string
}

const REGISTRATION_RETRY_DELAYS = [250, 1500, 3500, 7000, 15000]
const EMPTY_REPORTS: ChatReportFile[] = []

function areReportListsEquivalent(left: ChatReportFile[], right: ChatReportFile[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const current = left[index]
    const next = right[index]
    if (!current || !next) return false
    if (
      current.id !== next.id
      || current.name !== next.name
      || current.mimeType !== next.mimeType
      || current.size !== next.size
      || current.status !== next.status
      || current.sourceSessionId !== next.sourceSessionId
      || current.sourceMessageId !== next.sourceMessageId
      || current.sourceMessagePreview !== next.sourceMessagePreview
      || current.createdAt !== next.createdAt
    ) return false
  }
  return true
}

export function useChatReportAttachments(
  sessionKey: Readonly<Ref<string | null | undefined>>,
  messages: Readonly<Ref<ChatMessage[]>>,
  completionSignal?: Readonly<Ref<unknown>>,
) {
  const authStore = useAuthStore()
  const notice = useMessage()
  const { t } = useI18n()
  const reports = ref<ChatReportFile[]>([])
  const downloadingReportId = ref('')
  const scheduledRefreshes = new Set<ReturnType<typeof setTimeout>>()
  let requestGeneration = 0
  let retryGeneration = 0

  const reportsByMessage = computed(() =>
    mapReportsToAssistantMessages(messages.value, reports.value)
  )

  const reportMessageSignature = computed(() =>
    reportGenerationSignalSignature(messages.value)
  )

  function currentSessionKey(): string {
    return String(sessionKey.value || '').trim()
  }

  function authorizationHeaders() {
    return { Authorization: `Bearer ${authStore.getToken()}` }
  }

  function clearScheduledRefreshes() {
    retryGeneration += 1
    for (const timer of scheduledRefreshes) clearTimeout(timer)
    scheduledRefreshes.clear()
  }

  async function refreshReports(
    rawSessionKey = sessionKey.value,
    options?: { preserveExisting?: boolean },
  ) {
    const key = String(rawSessionKey || '').trim()
    const generation = ++requestGeneration
    if (!key) {
      reports.value = []
      return
    }

    try {
      const response = await fetch(`/api/reports?sourceSessionId=${encodeURIComponent(key)}`, {
        headers: authorizationHeaders(),
        cache: 'no-store',
      })
      const data = await response.json().catch(() => null) as ReportsResponse | null
      if (!response.ok || !data?.ok || !Array.isArray(data.reports)) {
        throw new Error(data?.error || data?.message || t('pages.chat.reportAttachment.loadFailed'))
      }
      if (generation === requestGeneration && key === currentSessionKey()) {
        let nextReports: ChatReportFile[]
        if (options?.preserveExisting) {
          const merged = new Map(reports.value.map((report) => [report.id, report]))
          for (const report of data.reports) merged.set(report.id, report)
          nextReports = [...merged.values()].sort((left, right) => left.createdAt - right.createdAt)
        } else {
          nextReports = data.reports
        }
        if (!areReportListsEquivalent(reports.value, nextReports)) {
          reports.value = nextReports
        }
      }
    } catch (error) {
      if (generation === requestGeneration) {
        console.warn('[WebChat] Failed to load session reports:', error)
      }
    }
  }

  function scheduleRegistrationRefresh() {
    clearScheduledRefreshes()
    const generation = retryGeneration
    const key = currentSessionKey()
    if (!key) return

    for (const delay of REGISTRATION_RETRY_DELAYS) {
      const timer = setTimeout(() => {
        scheduledRefreshes.delete(timer)
        if (generation !== retryGeneration || key !== currentSessionKey()) return
        void refreshReports(key, { preserveExisting: true })
      }, delay)
      scheduledRefreshes.add(timer)
    }
  }

  function reportsForMessage(message: ChatMessage): ChatReportFile[] {
    return reportsByMessage.value.get(message) || EMPTY_REPORTS
  }

  async function downloadReport(report: ChatReportFile) {
    if (report.status !== 'ready' || downloadingReportId.value) return
    downloadingReportId.value = report.id
    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(report.id)}/download`, {
        headers: authorizationHeaders(),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null) as ReportsResponse | null
        throw new Error(data?.error || data?.message || t('pages.chat.reportAttachment.downloadFailed'))
      }
      const objectUrl = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = report.name
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(objectUrl)
    } catch (error) {
      notice.error(error instanceof Error ? error.message : t('pages.chat.reportAttachment.downloadFailed'))
    } finally {
      downloadingReportId.value = ''
    }
  }

  watch(
    sessionKey,
    (key) => {
      clearScheduledRefreshes()
      reports.value = []
      void refreshReports(key)
    },
    // Clear the old session's attachments before Vue renders the new session.
    // This also prevents a one-frame flash when entering a blank conversation.
    { immediate: true, flush: 'sync' },
  )

  watch(reportMessageSignature, (next, previous) => {
    if (next && next !== previous) scheduleRegistrationRefresh()
  })

  if (completionSignal) {
    watch(completionSignal, (next, previous) => {
      if (next && next !== previous) scheduleRegistrationRefresh()
    })
  }

  onScopeDispose(() => {
    clearScheduledRefreshes()
    requestGeneration += 1
  })

  return {
    downloadingReportId,
    downloadReport,
    refreshReports,
    reportsForMessage,
  }
}
