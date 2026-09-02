export function isAlertAccountOnlineAt(clients, userId, receivedAt) {
  const eventTime = Number(receivedAt)
  if (!Number.isFinite(eventTime)) return false
  for (const client of clients.values()) {
    if (String(client.user?.id || '') !== String(userId)) continue
    if (client.res?.writableEnded || client.res?.destroyed) continue
    const connectedAt = Number(client.connectedAt)
    if (Number.isFinite(connectedAt) && connectedAt <= eventTime) return true
  }
  return false
}
