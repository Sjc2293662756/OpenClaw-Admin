export type LiveChatProcessStatus = {
  phase: string
  sessionKey: string | null
}

const ACTIVE_PROCESS_PHASES = new Set([
  'sending',
  'waiting',
  'thinking',
  'tool',
  'replying',
  'aborting',
])

export function isLiveChatProcessForSession(
  status: LiveChatProcessStatus,
  sessionKey: string | null | undefined,
): boolean {
  return Boolean(sessionKey) && status.sessionKey === sessionKey && ACTIVE_PROCESS_PHASES.has(status.phase)
}
