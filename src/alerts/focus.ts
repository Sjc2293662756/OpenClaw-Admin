export function focusAlertId(value: unknown): string | null {
  const text = Array.isArray(value) ? value[0] : value
  const id = typeof text === 'string' ? text.trim() : ''
  return id && id.length <= 240 ? id : null
}

export function findAlertById<T extends { id?: unknown }>(alerts: T[], id: string) {
  return alerts.find((alert) => String(alert.id || '') === id) || null
}
