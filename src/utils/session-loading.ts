/**
 * A selected conversation's transcript is the navigation-critical request.
 * Start it before the supplementary session list refresh and resolve as soon
 * as history is ready; the list continues independently in the background.
 */
export function loadSelectedSessionWithBackgroundList(
  sessionKey: string,
  loadHistory: (sessionKey: string) => Promise<void>,
  refreshSessions: () => Promise<void>,
): Promise<void> {
  const historyRequest = loadHistory(sessionKey)
  void refreshSessions()
  return historyRequest
}
